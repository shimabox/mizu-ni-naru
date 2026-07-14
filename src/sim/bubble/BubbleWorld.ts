import { KIND_INDEX } from '../../contract/WorldSpec';
import type { Atom } from '../chem/Atom';
import type { AtomFactory } from '../chem/AtomFactory';
import {
  WATER_INTERACTION,
  interactWater,
  reflectSphere,
  walk,
} from '../chem/BoundedWalk';
import type { Spawner } from '../chem/Spawner';
import {
  ATOM_MAX_SPEED_RATIO,
  BOUNCE_RIPPLE_RATE_LIMIT_STEPS,
  BOUNCE_RIPPLE_STRENGTH,
  BURST_SPAWN_INTERVAL_STEPS,
  DISSOLVE_RIPPLE_STRENGTH,
  DROPLET_RADIUS_RATIO_MAX,
  DROPLET_RIPPLE_BASE,
  DROPLET_RIPPLE_SPAN,
  SHELL_RATIO,
  SPAWN_SLOT_PHASE_STEPS,
  VOLUME_GAIN,
} from '../config';
import type { Random } from '../core/Random';
import { DropletColumn } from '../droplets/DropletColumn';
import type { CollisionDetector } from '../physics/CollisionDetector';
import type { ReactionRegistry } from '../reactions/ReactionRegistry';
import type { ReactionContext } from '../reactions/ReactionRule';
import { WaterBody } from '../water/WaterBody';

const FOUR_THIRDS_PI = (4 / 3) * Math.PI;

/** スポナーモード(§2.2 の表)。 */
export const SPAWNER_MODE = {
  Off: 0, // Straining / Falling(以降停止)
  Burst: 1, // Spawning: 6 step 毎(stateStep クロック)
  Steady: 2, // Drifting: SPAWN_INTERVAL_STEPS 毎(グローバルクロック + スロット位相)
} as const;

/** 球内イベントの通知先(MizuNiNaruSim が packer / FSM へ配線する)。 */
export interface WorldEvents {
  emitRipple(slotIndex: number, x: number, z: number, strength: number): void;
  onDropletAbsorbed(): void; // wobble パルス(§2.2)
}

/** 全球で共有する重量級ヘルパ(グリッドは 1 個を使い回す — §3.4)。 */
export interface WorldShared {
  readonly rng: Random;
  readonly factory: AtomFactory;
  readonly spawner: Spawner;
  readonly detector: CollisionDetector;
  readonly registry: ReactionRegistry;
}

/**
 * 球 1 個の独立した化学小宇宙(design-sim §3 — 座標は球ローカル・中心原点)。
 * step() の段順(§3.7 — Mizu-ts → Mizu-threejs のパイプライン段順の知見):
 *   0. prev 記録 → 1. 原子更新 → 2. 雫カーネル → 3. 衝突検出 → 4. 反応適用
 *   → 5. sweep → 6. 水位更新 → 7. スポナー
 *
 * 実装ノート:
 * - 溶解・反応どちらの消滅も dead マーク + 段 5 の安定 in-place filter に統一
 *   (§3.3 の「即時 swap-remove」と観測等価で、走査順が保たれ推論が単純)
 * - 段 6 で水位が上がった直後の整合(裁定 A25 の不変条件を厳密に守る):
 *   雫は「水没したら吸収」(体積は次 step の commit へ)、原子は「浮力で
 *   水面上へ押し上げ」(RNG なしの決定的処理。原子が自分から入水した訳では
 *   ないので溶解判定は適用しない — §3.3 は粒子起因の交差の規約)
 * - 質量台帳(§7.3)のカウンタを世代横断で保持し、保存則テストの対象にする
 */
export class BubbleWorld {
  public readonly atoms: Atom[] = [];
  public readonly droplets = new DropletColumn();
  public readonly water = new WaterBody();
  public bubbleR = 1;
  public rInner = SHELL_RATIO;

  // 質量台帳(累計 — 世代をまたいで単調増加)
  public spawnedH = 0;
  public spawnedO = 0;
  public dissolvedH = 0;
  public dissolvedO = 0;
  public dissolvedH2 = 0;
  public absorbedDroplets = 0;
  public clearedH = 0;
  public clearedO = 0;
  public clearedH2 = 0;
  public clearedDroplets = 0;
  // 体積シェア(校正 §7.5 用)
  public volumeFromDroplets = 0;
  public volumeFromDissolve = 0;

  private readonly shared: WorldShared;
  private readonly pairBuf: number[] = [];
  private readonly reactionCtx: {
    factory: AtomFactory;
    bubbleR: number;
    nowStep: number;
  };
  private slotIndex = 0;
  // 跳ね返り「ポチャ」の球ごとレート制限(裁定 A34 — 決定的・世代跨ぎで reset() が再初期化)
  private lastBounceRippleStep = -BOUNCE_RIPPLE_RATE_LIMIT_STEPS;
  // 雫吸収シンク(事前束縛 — 定常アロケーションゼロ)
  private readonly absorbSink = {
    onAbsorb: (x: number, z: number, r: number): void => {
      const vol = VOLUME_GAIN * FOUR_THIRDS_PI * r * r * r;
      this.water.addVolume(vol);
      this.volumeFromDroplets += vol;
      this.absorbedDroplets++;
      const rMax = DROPLET_RADIUS_RATIO_MAX * this.bubbleR;
      this.events?.emitRipple(
        this.slotIndex,
        x,
        z,
        DROPLET_RIPPLE_BASE + DROPLET_RIPPLE_SPAN * (r / rMax),
      );
      this.events?.onDropletAbsorbed();
    },
  };
  private events: WorldEvents | null = null;

  constructor(shared: WorldShared) {
    this.shared = shared;
    this.reactionCtx = { factory: shared.factory, bubbleR: 1, nowStep: 0 };
  }

  /** スロット(再)ロール時の初期化。initialFill01 は起動スタッガー(init のみ)。 */
  public reset(bubbleR: number, initialFill01: number): void {
    this.bubbleR = bubbleR;
    this.rInner = SHELL_RATIO * bubbleR;
    this.atoms.length = 0;
    this.droplets.clear();
    this.water.reset(this.rInner, initialFill01);
    this.lastBounceRippleStep = -BOUNCE_RIPPLE_RATE_LIMIT_STEPS;
  }

  /** Splashing 進入: 「弾けて中身ごと水になる」— 原子・雫を全消去(台帳へ計上)。 */
  public clearContents(): void {
    for (let i = 0; i < this.atoms.length; i++) {
      const a = this.atoms[i];
      if (a.dead) continue;
      if (a.kindIndex === KIND_INDEX.H) this.clearedH++;
      else if (a.kindIndex === KIND_INDEX.O) this.clearedO++;
      else this.clearedH2++;
    }
    this.atoms.length = 0;
    this.clearedDroplets += this.droplets.count;
    this.droplets.clear();
  }

  /** Dead 進入: fill01 を 0 へ(§2.2 — Splashing 中は保持)。 */
  public drainWater(): void {
    this.water.reset(this.rInner, 0);
  }

  /** 生存 H 数(dead 除外)。 */
  public countKind(kindIndex: number): number {
    let n = 0;
    for (let i = 0; i < this.atoms.length; i++) {
      const a = this.atoms[i];
      if (!a.dead && a.kindIndex === kindIndex) n++;
    }
    return n;
  }

  /**
   * 1 step(§3.7 の段順)。呼び出しは FSM が世界生存中(Spawning〜Falling)のみ。
   * @param spawnerMode  SPAWNER_MODE(状態に応じ MizuNiNaruSim が選ぶ)
   * @param stateStep    FSM の状態内 step(バーストクロック用)
   * @param spawnIntervalSteps 定常スポナー間隔(pacing 依存 — §5.6)
   */
  public step(
    slotIndex: number,
    globalStep: number,
    spawnerMode: number,
    stateStep: number,
    spawnIntervalSteps: number,
    events: WorldEvents,
  ): void {
    this.slotIndex = slotIndex;
    this.events = events;
    const atoms = this.atoms;
    const rng = this.shared.rng;
    const rInner = this.rInner;
    const waterY = this.water.waterY;
    const vMax = ATOM_MAX_SPEED_RATIO * this.bubbleR;

    // ── 段 0–1: prev 記録 + 原子更新(ウォーク → 球面反射 → 水面)— 挿入順
    for (let i = 0; i < atoms.length; i++) {
      const a = atoms[i];
      a.px = a.x;
      a.py = a.y;
      a.pz = a.z;
      if (a.dead) continue;
      walk(a, rng, vMax);
      reflectSphere(a, rInner - a.r);
      const interaction = interactWater(a, waterY, rInner - a.r, rng);
      if (interaction === WATER_INTERACTION.Dissolved) {
        this.dissolveAtom(a);
      } else if (interaction === WATER_INTERACTION.Bounced) {
        this.maybeEmitBounceRipple(a, globalStep);
      }
    }

    // ── 段 2: 雫カーネル(RNG フリー)
    this.droplets.step(waterY, rInner, this.absorbSink);

    // ── 段 3: 衝突検出(列挙順は i → cell(j) → j を維持)
    const pairCount = this.shared.detector.findPairs(
      atoms,
      rInner,
      this.pairBuf,
    );

    // ── 段 4: 反応適用(死亡ペアガード — Mizu-threejs 段 4 の verbatim 知見)
    if (pairCount > 0) {
      const registry = this.shared.registry;
      const ctx = this.reactionCtx;
      ctx.bubbleR = this.bubbleR;
      ctx.nowStep = globalStep;
      for (let p = 0; p < pairCount; p++) {
        const a = atoms[this.pairBuf[p * 2]];
        const b = atoms[this.pairBuf[p * 2 + 1]];
        if (a.dead || b.dead) continue;
        const rule = registry.find(a.kindIndex, b.kindIndex);
        if (!rule) continue;
        const result = rule.react(a, b, ctx as ReactionContext);
        for (let i = 0; i < result.consumed.length; i++) {
          result.consumed[i].dead = true;
        }
        for (let i = 0; i < result.produced.length; i++) {
          const produced = result.produced[i];
          this.clampAtomIntoAir(produced, waterY);
          atoms.push(produced); // 生成フレームには動かない(段 1 は通過済み)
        }
        for (let i = 0; i < result.droplets.length; i++) {
          const d = result.droplets[i];
          this.spawnDroplet(
            d.x,
            d.y,
            d.z,
            d.r,
            d.phase,
            d.swayAmp,
            d.seed,
            globalStep,
            waterY,
          );
        }
      }
    }

    // ── 段 5: sweep(dead 原子の安定 in-place filter)
    let w = 0;
    for (let i = 0; i < atoms.length; i++) {
      const a = atoms[i];
      if (!a.dead) {
        if (w !== i) atoms[w] = a;
        w++;
      }
    }
    atoms.length = w;

    // ── 段 6: 水位更新 + 上昇後の整合(A25)
    this.water.commit();
    if (this.water.waterY > waterY) {
      this.reconcileWithRisenWater(this.water.waterY);
    }

    // ── 段 7: スポナー(クロック該当 step のみ試行)
    if (spawnerMode !== SPAWNER_MODE.Off) {
      const due =
        spawnerMode === SPAWNER_MODE.Burst
          ? stateStep % BURST_SPAWN_INTERVAL_STEPS === 0
          : (globalStep + slotIndex * SPAWN_SLOT_PHASE_STEPS) %
              spawnIntervalSteps ===
            0;
      if (due) {
        const spawned = this.shared.spawner.trySpawn(
          atoms,
          this.countKind(KIND_INDEX.H),
          this.countKind(KIND_INDEX.O),
          this.water.waterY,
          rInner,
          this.bubbleR,
          globalStep,
        );
        if (spawned) {
          atoms.push(spawned); // 生成フレームには動かない(§3.6)
          if (spawned.kindIndex === KIND_INDEX.H) this.spawnedH++;
          else this.spawnedO++;
        }
      }
    }
    this.events = null;
  }

  /** 溶解(§3.3): dead マーク + 体積加算 + InnerRipple(strength 0.3)。 */
  private dissolveAtom(a: Atom): void {
    a.dead = true;
    if (a.kindIndex === KIND_INDEX.H) this.dissolvedH++;
    else if (a.kindIndex === KIND_INDEX.O) this.dissolvedO++;
    else this.dissolvedH2++;
    const vol = VOLUME_GAIN * FOUR_THIRDS_PI * a.r * a.r * a.r;
    this.water.addVolume(vol);
    this.volumeFromDissolve += vol;
    this.events?.emitRipple(this.slotIndex, a.x, a.z, DISSOLVE_RIPPLE_STRENGTH);
  }

  /**
   * 跳ね返り(§3.3 拡張 — 裁定 A34): 「ポチャ」InnerRipple(strength 0.15)を
   * 球ごとに BOUNCE_RIPPLE_RATE_LIMIT_STEPS(18 step = 0.3s)未満の連続発火を
   * 抑止して発火する。判定は globalStep の差分のみ(決定的・RNG 消費なし)。
   */
  private maybeEmitBounceRipple(a: Atom, globalStep: number): void {
    if (
      globalStep - this.lastBounceRippleStep <
      BOUNCE_RIPPLE_RATE_LIMIT_STEPS
    ) {
      return;
    }
    this.lastBounceRippleStep = globalStep;
    this.events?.emitRipple(this.slotIndex, a.x, a.z, BOUNCE_RIPPLE_STRENGTH);
  }

  /**
   * 生成粒子(H2 中点)の球内・水面上クランプ: 親より半径が大きいため、
   * 殻・水面に僅かに食い込みうる。y を水面上へ持ち上げ、水平射影で殻内へ
   * (決定的・RNG なし)。
   */
  private clampAtomIntoAir(a: Atom, waterY: number): void {
    const rEff = this.rInner - a.r;
    if (a.y - a.r < waterY) a.y = waterY + a.r;
    if (a.y > rEff) a.y = rEff;
    if (a.y < -rEff) a.y = -rEff;
    const l2 = Math.max(rEff * rEff - a.y * a.y, 0);
    const h2 = a.x * a.x + a.z * a.z;
    if (h2 > l2 && h2 > 0) {
      const k = Math.sqrt(l2 / h2);
      a.x *= k;
      a.z *= k;
    }
    a.px = a.x;
    a.py = a.y;
    a.pz = a.z;
  }

  /** 雫スポーン(O 座標)を殻内・水面上へクランプして列に積む。 */
  private spawnDroplet(
    x: number,
    y: number,
    z: number,
    r: number,
    phase: number,
    swayAmp: number,
    seed: number,
    nowStep: number,
    waterY: number,
  ): void {
    const rEff = this.rInner - r;
    let cy = y;
    if (cy - r < waterY) cy = waterY + r + 1e-4; // 水面すれすれ生成は僅かに持ち上げ
    if (cy > rEff) cy = rEff;
    if (cy < -rEff) cy = -rEff;
    let cx = x;
    let cz = z;
    const l2 = Math.max(rEff * rEff - cy * cy, 0);
    const h2 = cx * cx + cz * cz;
    if (h2 > l2 && h2 > 0) {
      const k = Math.sqrt(l2 / h2);
      cx *= k;
      cz *= k;
    }
    this.droplets.spawn(cx, cy, cz, r, phase, swayAmp, seed, nowStep);
  }

  /**
   * 段 6 の整合(A25): 水位上昇で水没した雫は吸収(体積は次 step commit)、
   * 原子は浮力で水面上へ押し上げ(y のみ + 水平射影)。
   */
  private reconcileWithRisenWater(waterY: number): void {
    const droplets = this.droplets;
    const posr = droplets.posr;
    for (let i = 0; i < droplets.count; i++) {
      const o = i * 4;
      if (posr[o + 1] <= waterY + posr[o + 3]) {
        this.absorbSink.onAbsorb(posr[o], posr[o + 2], posr[o + 3]);
        const last = (droplets.count - 1) * 4;
        for (let k = 0; k < 4; k++) {
          posr[o + k] = posr[last + k];
          droplets.prevPosr[o + k] = droplets.prevPosr[last + k];
          droplets.aux[o + k] = droplets.aux[last + k];
        }
        droplets.count--;
        i--;
      }
    }
    const atoms = this.atoms;
    for (let i = 0; i < atoms.length; i++) {
      const a = atoms[i];
      if (a.dead) continue;
      if (a.y - a.r < waterY) {
        a.y = waterY + a.r;
        const rEff = this.rInner - a.r;
        const l2 = Math.max(rEff * rEff - a.y * a.y, 0);
        const h2 = a.x * a.x + a.z * a.z;
        if (h2 > l2 && h2 > 0) {
          const k = Math.sqrt(l2 / h2);
          a.x *= k;
          a.z *= k;
        }
      }
    }
  }
}
