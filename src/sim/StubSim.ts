import type {
  SimCounts,
  SimInitOptions,
  SimLike,
  SkyRenderView,
} from '../contract/RenderView';
import {
  ATOM_VIEW_CAPACITY,
  BUBBLE_STATE,
  DROPLET_VIEW_CAPACITY,
  DT,
  RIPPLE_VIEW_CAPACITY,
  SLOT_COUNT_DESKTOP,
  SPLASH_VIEW_CAPACITY,
} from '../contract/WorldSpec';
import { Mulberry32, type Random } from './core/Random';

/*
 * FSM の演技台本(design-sim §2 の縮約 — Drifting だけ実 sim の ≈120 s を
 * 約 20 s に圧縮し、render 開発が全状態を短周期で観察できるようにする)。
 * それ以外の持続・数値は実 sim の設計値をそのまま使う。
 */
const SPAWNING_STEPS = 120; // 2.0 s
const STRAINING_STEPS = 90; // 1.5 s
const SPLASHING_STEPS = 48; // 0.8 s
const DEAD_STEPS = 240; // 4 s(stub は固定 — 位相分散は初期 fill スタッガーで足りる)
const F_FULL = 0.875; // A40: 本 sim の帯 [0.8,0.95] の中央値(stub は固定で足りる)
const FILL_PER_STEP = F_FULL / (20 * 60); // Drifting で 0 → 0.875 を約 20 s
const INITIAL_FILL_MAX = 0.75; // 初期スタッガー(design-sim §2.5、A40 追従)

// 二重リングの簡易近似(A30 — 本 sim の SlotRing と違い偶奇で振り分けるだけ)
const RING_RADIUS_INNER = 3.5;
const RING_RADIUS_OUTER = 6.5;
const RING_Y_MIN = 2.6;
const RING_Y_MAX = 6.0;
const R_MIN = 1.1;
const R_MAX = 1.7;
const SHELL_RATIO = 0.94; // R_inner = 0.94R(A13)
const BOB_AMP = 0.12;
const BOB_PERIOD_S = 9;

const FALL_G = 3.0; // u/s²(design-sim §2.4)
const FALL_DRAG_K = 0.4; // /s

const ATOMS_PER_BUBBLE = 6;
const ATOM_SPAWN_INTERVAL_STEPS = 15; // Spawning 中に 6 体を段階投入
const ATOM_RADIUS_RATIO = [0.06, 0.073, 0.09] as const; // H / O / H2(×R)
const ATOM_KIND_CYCLE = [0, 0, 1, 0, 1, 2] as const; // H,H,O,H,O,H2

const DROPLET_SPAWN_INTERVAL_STEPS = 150; // ≈2.5 s ごと(スロット位相ずらし)
const DROPLET_CAP = 8; // stub の球ごと上限(契約容量 512 に対し十分小)
const DROPLET_FALL_SPEED_PER_R = 4.0; // /s
const SWAY_FREQ = 12; // /u

const BUBBLE_STRIDE = 8;
const V4 = 4;

/** 球冠の逆関数(三角閉形式): fill01 → u = h/(2R̂)。waterY = (2u−1)·R̂。 */
const capU = (fill01: number): number => {
  const f = Math.min(Math.max(fill01, 0), 1);
  return 0.5 - Math.sin(Math.asin(1 - 2 * f) / 3);
};

interface StubAtom {
  kindIndex: number;
  r: number;
  seed: number;
  spawnStep: number;
  colR: number;
  colG: number;
  colB: number;
  // パラメトリック周回(球内ランダムウォーク風)の位相と角速度
  ph1: number;
  ph2: number;
  ph3: number;
  w1: number;
  w2: number;
  w3: number;
  x: number;
  y: number;
  z: number;
  px: number;
  py: number;
  pz: number;
}

interface Slot {
  state: number;
  stateStep: number;
  r: number;
  rInner: number;
  baseX: number;
  baseZ: number;
  baseY: number;
  bobPhase: number;
  ax: number;
  ay: number;
  az: number;
  prevAx: number;
  prevAy: number;
  prevAz: number;
  fill: number;
  waterY: number;
  wobble: number;
  wobblePulse: number;
  fallV: number;
  fallY0: number;
  justRespawned: boolean;
  atoms: StubAtom[];
  atomSpawned: number;
  // 雫列(球ローカル SoA — swap-remove は posr/prev/aux の 3 本同時)
  dPosr: Float32Array;
  dPrev: Float32Array;
  dAux: Float32Array;
  dCount: number;
  prevPacked: Float32Array; // 前 step の BubbleView stride8(prevData 用)
  hasPrevPacked: boolean;
}

/**
 * StubSim — 本物の view 型・本物の契約不変条件(prev/curr 同 index 同一
 * エンティティ、スポーン時 prev=curr、count==SLOT_COUNT 恒常、dense prefix、
 * 原子・雫は常に球内水面より上)を守った合成アニメを放出する SimLike 実装。
 * render を Phase 1(実 sim)完了前に解放するためのマイルストーン戦略。
 * 決定論: 同 seed 同結果。コア内に Math.random() / Date.now() は無い。
 */
export class StubSim implements SimLike {
  private rng: Random = new Mulberry32(1);
  private slots: Slot[] = [];
  private slotCount = SLOT_COUNT_DESKTOP;
  private stepCount = 0;

  private splashesTotal = 0;
  private dropletsAbsorbedTotal = 0;

  private readonly bubbleData = new Float32Array(8 * BUBBLE_STRIDE);
  private readonly bubblePrev = new Float32Array(8 * BUBBLE_STRIDE);
  private readonly atomPosr = new Float32Array(ATOM_VIEW_CAPACITY * V4);
  private readonly atomPrev = new Float32Array(ATOM_VIEW_CAPACITY * V4);
  private readonly atomColorKind = new Float32Array(ATOM_VIEW_CAPACITY * V4);
  private readonly atomAux = new Float32Array(ATOM_VIEW_CAPACITY * V4);
  private readonly dropPosr = new Float32Array(DROPLET_VIEW_CAPACITY * V4);
  private readonly dropPrev = new Float32Array(DROPLET_VIEW_CAPACITY * V4);
  private readonly dropAux = new Float32Array(DROPLET_VIEW_CAPACITY * V4);
  private readonly splashData = new Float32Array(SPLASH_VIEW_CAPACITY * V4);
  private readonly rippleData = new Float32Array(RIPPLE_VIEW_CAPACITY * V4);

  // 安定 view オブジェクト(毎フレーム同一参照、count のみ更新)
  private readonly viewObj = {
    step: 0,
    bubbles: {
      data: this.bubbleData,
      prevData: this.bubblePrev,
      count: 0,
      version: 0,
    },
    atoms: {
      posr: this.atomPosr,
      prevPosr: this.atomPrev,
      colorKind: this.atomColorKind,
      aux: this.atomAux,
      count: 0,
      version: 0,
    },
    droplets: {
      posr: this.dropPosr,
      prevPosr: this.dropPrev,
      aux: this.dropAux,
      count: 0,
      version: 0,
    },
    splashes: { data: this.splashData, count: 0 },
    ripples: { data: this.rippleData, count: 0 },
  };

  public init(options: SimInitOptions): void {
    this.rng = new Mulberry32(options.seed);
    this.slotCount = Math.min(options.slotCount, 8);
    this.stepCount = 0;
    this.splashesTotal = 0;
    this.dropletsAbsorbedTotal = 0;
    this.slots = [];
    for (let i = 0; i < this.slotCount; i++) {
      this.slots.push(this.rollSlot(i, true));
    }
    this.pack();
  }

  public step(): void {
    this.stepCount++;
    this.viewObj.splashes.count = 0;
    this.viewObj.ripples.count = 0;

    for (let i = 0; i < this.slotCount; i++) {
      let s = this.slots[i];
      s.justRespawned = false;
      s.prevAx = s.ax;
      s.prevAy = s.ay;
      s.prevAz = s.az;
      this.advanceFsm(s, i);
      s = this.slots[i]; // Dead 満了時は rollSlot で差し替わっている
      this.updateAnchor(s);
      s.waterY = (2 * capU(s.fill) - 1) * s.rInner;
      if (this.isWorldAlive(s.state)) {
        this.updateAtoms(s);
        this.updateDroplets(s, i);
        this.spawnDropletMaybe(s, i);
      }
      // 雫着水パルスの減衰(Straining のランプ・Falling の維持はランプ側が上書き)
      s.wobblePulse *= 0.97;
    }

    this.pack();
  }

  public view(): SkyRenderView {
    return this.viewObj;
  }

  public counts(): SimCounts {
    let h = 0;
    let o = 0;
    let h2 = 0;
    let droplets = 0;
    let active = 0;
    let fillSum = 0;
    for (const s of this.slots) {
      if (s.state !== BUBBLE_STATE.Dead) {
        active++;
        fillSum += s.fill;
      }
      for (const a of s.atoms) {
        if (a.kindIndex === 0) h++;
        else if (a.kindIndex === 1) o++;
        else h2++;
      }
      droplets += s.dCount;
    }
    return {
      h,
      o,
      h2,
      droplets,
      bubblesActive: active,
      splashesTotal: this.splashesTotal,
      dropletsAbsorbedTotal: this.dropletsAbsorbedTotal,
      dissolvedTotal: 0,
      meanFill01: active > 0 ? fillSum / active : 0,
    };
  }

  /* ── FSM ──────────────────────────────────────────────── */

  private isWorldAlive(state: number): boolean {
    return (
      state === BUBBLE_STATE.Spawning ||
      state === BUBBLE_STATE.Drifting ||
      state === BUBBLE_STATE.Straining ||
      state === BUBBLE_STATE.Falling
    );
  }

  private advanceFsm(s: Slot, slotIndex: number): void {
    s.stateStep++;
    switch (s.state) {
      case BUBBLE_STATE.Spawning: {
        if (
          s.atomSpawned < ATOMS_PER_BUBBLE &&
          s.stateStep % ATOM_SPAWN_INTERVAL_STEPS === 0
        ) {
          s.atoms.push(this.rollAtom(s));
          s.atomSpawned++;
        }
        if (s.stateStep >= SPAWNING_STEPS) {
          this.transition(s, BUBBLE_STATE.Drifting);
        }
        break;
      }
      case BUBBLE_STATE.Drifting: {
        s.fill = Math.min(s.fill + FILL_PER_STEP, F_FULL);
        s.wobble = Math.min(s.wobblePulse, 1);
        if (s.fill >= F_FULL) {
          this.transition(s, BUBBLE_STATE.Straining);
        }
        break;
      }
      case BUBBLE_STATE.Straining: {
        // wobble 0→1 線形ランプ(遷移時の連続性 — design-sim §2.2)
        s.wobble = Math.min(s.stateStep / STRAINING_STEPS + s.wobblePulse, 1);
        if (s.stateStep >= STRAINING_STEPS) {
          s.fallV = 0;
          s.fallY0 = s.ay;
          this.transition(s, BUBBLE_STATE.Falling);
        }
        break;
      }
      case BUBBLE_STATE.Falling: {
        s.wobble = 1;
        s.fallV += (FALL_G - FALL_DRAG_K * s.fallV) * DT;
        s.ay -= s.fallV * DT;
        if (s.ay <= s.r) {
          s.ay = s.r;
          this.emitSplash(s.ax, s.az, s.r, Math.min(1, s.fallV / 4));
          // 「弾けて中身ごと水になる」— 進入フレームに全消去
          s.atoms.length = 0;
          s.dCount = 0;
          this.transition(s, BUBBLE_STATE.Splashing);
        }
        break;
      }
      case BUBBLE_STATE.Splashing: {
        if (s.stateStep >= SPLASHING_STEPS) {
          s.fill = 0;
          s.wobble = 0;
          this.transition(s, BUBBLE_STATE.Dead);
        }
        break;
      }
      default: {
        // Dead: 満了でスロット再利用(R / ジッター / bob 位相を再ロール)
        if (s.stateStep >= DEAD_STEPS) {
          this.slots[slotIndex] = this.rollSlot(slotIndex, false);
        }
        break;
      }
    }
  }

  private transition(s: Slot, state: number): void {
    s.state = state;
    s.stateStep = 0;
  }

  private updateAnchor(s: Slot): void {
    if (
      s.state === BUBBLE_STATE.Falling ||
      s.state === BUBBLE_STATE.Splashing
    ) {
      return; // 落下積分 / 着水固定(bob なし)
    }
    const t = this.stepCount * DT;
    const w = (2 * Math.PI) / BOB_PERIOD_S;
    s.ay = s.baseY + BOB_AMP * Math.sin(w * t + s.bobPhase);
    s.ax = s.baseX + BOB_AMP * 0.5 * Math.sin(w * 0.8 * t + s.bobPhase + 1.7);
    s.az = s.baseZ;
  }

  private statePacked(s: Slot): number {
    let progress: number;
    switch (s.state) {
      case BUBBLE_STATE.Spawning:
        progress = s.stateStep / SPAWNING_STEPS;
        break;
      case BUBBLE_STATE.Drifting:
        progress = s.fill / F_FULL;
        break;
      case BUBBLE_STATE.Straining:
        progress = s.stateStep / STRAINING_STEPS;
        break;
      case BUBBLE_STATE.Falling:
        progress = (s.fallY0 - s.ay) / Math.max(s.fallY0 - s.r, 1e-6);
        break;
      case BUBBLE_STATE.Splashing:
        progress = s.stateStep / SPLASHING_STEPS;
        break;
      default:
        progress = s.stateStep / DEAD_STEPS;
        break;
    }
    return s.state + Math.min(Math.max(progress, 0), 0.999);
  }

  /* ── スロット / 原子 / 雫の生成(RNG 消費はスロット昇順に決定的)──── */

  private rollSlot(index: number, initial: boolean): Slot {
    const rng = this.rng;
    const n = this.slotCount;
    const r = R_MIN + rng.next() * (R_MAX - R_MIN);
    const theta = (2 * Math.PI * index) / n + (rng.next() - 0.5) * 0.12;
    const radius =
      (index % 2 === 0 ? RING_RADIUS_INNER : RING_RADIUS_OUTER) +
      (rng.next() - 0.5) * 0.5;
    const baseY = RING_Y_MIN + rng.next() * (RING_Y_MAX - RING_Y_MIN);
    const bobPhase = rng.next() * 2 * Math.PI;
    // 初期 fill スタッガー(design-sim §2.5)。再生成時は 0 から
    let fill = 0;
    if (initial) {
      const stagger =
        n > 1 ? (INITIAL_FILL_MAX * (n - 1 - index)) / (n - 1) : 0;
      fill = Math.max(0, stagger + (rng.next() - 0.5) * 0.06);
    }
    const rInner = SHELL_RATIO * r;
    const slot: Slot = {
      state: BUBBLE_STATE.Spawning,
      stateStep: 0,
      r,
      rInner,
      baseX: radius * Math.cos(theta),
      baseZ: radius * Math.sin(theta),
      baseY,
      bobPhase,
      ax: 0,
      ay: 0,
      az: 0,
      prevAx: 0,
      prevAy: 0,
      prevAz: 0,
      fill,
      waterY: (2 * capU(fill) - 1) * rInner,
      wobble: 0,
      wobblePulse: 0,
      fallV: 0,
      fallY0: 0,
      justRespawned: true,
      atoms: [],
      atomSpawned: 0,
      dPosr: new Float32Array(DROPLET_CAP * V4),
      dPrev: new Float32Array(DROPLET_CAP * V4),
      dAux: new Float32Array(DROPLET_CAP * V4),
      dCount: 0,
      prevPacked: new Float32Array(BUBBLE_STRIDE),
      hasPrevPacked: false,
    };
    this.updateAnchor(slot); // 現在時刻の bob を適用(スポーンフレームの連続性)
    slot.prevAx = slot.ax;
    slot.prevAy = slot.ay;
    slot.prevAz = slot.az;
    return slot;
  }

  private rollAtom(s: Slot): StubAtom {
    const rng = this.rng;
    const kindIndex = ATOM_KIND_CYCLE[s.atomSpawned % ATOM_KIND_CYCLE.length];
    const atom: StubAtom = {
      kindIndex,
      r: ATOM_RADIUS_RATIO[kindIndex] * s.r,
      seed: rng.next(),
      spawnStep: this.stepCount,
      colR: 0.4 + rng.next() * 0.6,
      colG: 0.4 + rng.next() * 0.6,
      colB: 0.4 + rng.next() * 0.6,
      ph1: rng.next() * 2 * Math.PI,
      ph2: rng.next() * 2 * Math.PI,
      ph3: rng.next() * 2 * Math.PI,
      w1: 0.4 + rng.next() * 0.5,
      w2: 0.3 + rng.next() * 0.4,
      w3: 0.2 + rng.next() * 0.3,
      x: 0,
      y: 0,
      z: 0,
      px: 0,
      py: 0,
      pz: 0,
    };
    this.evalAtom(atom, s);
    atom.px = atom.x;
    atom.py = atom.y;
    atom.pz = atom.z;
    return atom;
  }

  /**
   * 原子のパラメトリック周回。構成的に不変条件を満たす:
   * y ∈ [waterY + r + 0.03, 0.92·R_eff](常に球内水面より上 — A25)、
   * x²+z² ≤ (0.85·L)² かつ y²+L² = R_eff²(常に内殻内)。
   */
  private evalAtom(a: StubAtom, s: Slot): void {
    const rEff = s.rInner - a.r;
    const t = (this.stepCount - a.spawnStep) * DT;
    const u1 = a.ph1 + a.w1 * t;
    const u2 = a.ph2 + a.w2 * t;
    const u3 = a.ph3 + a.w3 * t;
    const yLow = Math.max(s.waterY, -rEff * 0.92) + a.r + 0.03;
    const ySpan = Math.max(rEff * 0.92 - yLow, 0);
    const y = yLow + ySpan * (0.5 + 0.45 * Math.sin(u2));
    const l = Math.sqrt(Math.max(rEff * rEff - y * y, 0));
    const f = l * (0.35 + 0.5 * (0.5 + 0.5 * Math.sin(u3)));
    a.x = f * Math.cos(u1);
    a.y = y;
    a.z = f * Math.sin(u1);
  }

  private updateAtoms(s: Slot): void {
    for (const a of s.atoms) {
      a.px = a.x;
      a.py = a.y;
      a.pz = a.z;
      this.evalAtom(a, s);
    }
  }

  /* ── 雫カーネル(swap-remove は 3 本同時 — 契約 §1.4 規約 2)──── */

  private updateDroplets(s: Slot, slotIndex: number): void {
    const posr = s.dPosr;
    const prev = s.dPrev;
    const aux = s.dAux;
    for (let i = 0; i < s.dCount; i++) {
      const o = i * V4;
      prev[o] = posr[o];
      prev[o + 1] = posr[o + 1];
      prev[o + 2] = posr[o + 2];
      prev[o + 3] = posr[o + 3];

      const r = posr[o + 3];
      const phase = aux[o];
      const swayAmp = aux[o + 1];
      let x = posr[o];
      const y = posr[o + 1] - DROPLET_FALL_SPEED_PER_R * r * DT;
      let z = posr[o + 2];
      const sw = (y + phase) * SWAY_FREQ;
      x += Math.cos(sw) * swayAmp * DT;
      z += Math.cos(sw * 0.9 + Math.PI / 2) * swayAmp * 0.7 * DT;

      // 球内クランプ(sway が球殻を突き抜けない)
      const rEff = s.rInner - r;
      const l2 = Math.max(rEff * rEff - y * y, 0);
      const h2 = x * x + z * z;
      if (h2 > l2 && h2 > 0) {
        const k = Math.sqrt(l2 / h2);
        x *= k;
        z *= k;
      }

      if (y <= s.waterY + r) {
        // 吸収: InnerRipple 発火 + wobble パルス、3 本同時 swap-remove(i 再処理)
        this.emitRipple(slotIndex, x, z, 0.8);
        s.wobblePulse = Math.min(s.wobblePulse + 0.15, 1);
        this.dropletsAbsorbedTotal++;
        const last = (s.dCount - 1) * V4;
        for (let k = 0; k < V4; k++) {
          posr[o + k] = posr[last + k];
          prev[o + k] = prev[last + k];
          aux[o + k] = aux[last + k];
        }
        s.dCount--;
        i--;
        continue;
      }
      posr[o] = x;
      posr[o + 1] = y;
      posr[o + 2] = z;
    }
  }

  private spawnDropletMaybe(s: Slot, slotIndex: number): void {
    const inChem =
      s.state === BUBBLE_STATE.Drifting || s.state === BUBBLE_STATE.Straining;
    if (!inChem || s.dCount >= DROPLET_CAP) return;
    if (
      (this.stepCount + slotIndex * 37) % DROPLET_SPAWN_INTERVAL_STEPS !==
      0
    ) {
      return;
    }
    const rng = this.rng;
    const r = (0.065 + rng.next() * 0.03) * s.r;
    const rEff = s.rInner - r;
    // A25(球内水面より上)を構成的に保証: 既定は rEff*0.55 だが、A40 で
    // fill 帯が [0.8,0.95] へ上がり水面が高い球では既定点が水没しうるため、
    // 水面 + マージンと球殻上限 0.92·rEff の間へクランプする(evalAtom と同じ考え方)。
    const yLow = Math.max(s.waterY, -rEff * 0.92) + r + 0.03;
    const yHigh = rEff * 0.92;
    const y = Math.min(Math.max(rEff * 0.55, yLow), yHigh);
    const lMax = Math.sqrt(Math.max(rEff * rEff - y * y, 0)) * 0.6;
    const angle = rng.next() * 2 * Math.PI;
    const rho = lMax * Math.sqrt(rng.next());
    const o = s.dCount * V4;
    s.dPosr[o] = rho * Math.cos(angle);
    s.dPosr[o + 1] = y;
    s.dPosr[o + 2] = rho * Math.sin(angle);
    s.dPosr[o + 3] = r;
    // スポーンフレームは prev = curr
    s.dPrev[o] = s.dPosr[o];
    s.dPrev[o + 1] = s.dPosr[o + 1];
    s.dPrev[o + 2] = s.dPosr[o + 2];
    s.dPrev[o + 3] = s.dPosr[o + 3];
    s.dAux[o] = rng.next() * 2 * Math.PI;
    s.dAux[o + 1] = (0.25 + rng.next() * 0.2) * r;
    s.dAux[o + 2] = this.stepCount;
    s.dAux[o + 3] = rng.next();
    s.dCount++;
  }

  /* ── イベント ─────────────────────────────────────────── */

  private emitSplash(
    x: number,
    z: number,
    radius: number,
    strength: number,
  ): void {
    const view = this.viewObj.splashes;
    if (view.count >= SPLASH_VIEW_CAPACITY) return;
    const o = view.count * V4;
    this.splashData[o] = x;
    this.splashData[o + 1] = z;
    this.splashData[o + 2] = radius;
    this.splashData[o + 3] = strength;
    view.count++;
    this.splashesTotal++;
  }

  private emitRipple(
    bubbleIndex: number,
    localX: number,
    localZ: number,
    strength: number,
  ): void {
    const view = this.viewObj.ripples;
    if (view.count >= RIPPLE_VIEW_CAPACITY) return;
    const o = view.count * V4;
    this.rippleData[o] = bubbleIndex;
    this.rippleData[o + 1] = localX;
    this.rippleData[o + 2] = localZ;
    this.rippleData[o + 3] = strength;
    view.count++;
  }

  /* ── 集約パッカー(dense prefix・prev/curr 同順序・world = anchor+local)── */

  private pack(): void {
    let atomCount = 0;
    let dropCount = 0;
    for (let i = 0; i < this.slotCount; i++) {
      const s = this.slots[i];
      const bo = i * BUBBLE_STRIDE;
      this.bubbleData[bo] = s.ax;
      this.bubbleData[bo + 1] = s.ay;
      this.bubbleData[bo + 2] = s.az;
      this.bubbleData[bo + 3] = s.r;
      this.bubbleData[bo + 4] = s.waterY;
      this.bubbleData[bo + 5] = s.fill;
      this.bubbleData[bo + 6] = s.wobble;
      this.bubbleData[bo + 7] = this.statePacked(s);
      // スポーン(再ロール)フレームは prev = curr — 補間ワープなし
      if (s.hasPrevPacked && !s.justRespawned) {
        this.bubblePrev.set(s.prevPacked, bo);
      } else {
        this.bubblePrev.set(
          this.bubbleData.subarray(bo, bo + BUBBLE_STRIDE),
          bo,
        );
      }
      s.prevPacked.set(this.bubbleData.subarray(bo, bo + BUBBLE_STRIDE));
      s.hasPrevPacked = true;

      for (const a of s.atoms) {
        if (atomCount >= ATOM_VIEW_CAPACITY) break;
        const o = atomCount * V4;
        this.atomPosr[o] = s.ax + a.x;
        this.atomPosr[o + 1] = s.ay + a.y;
        this.atomPosr[o + 2] = s.az + a.z;
        this.atomPosr[o + 3] = a.r;
        const spawnedNow = a.spawnStep === this.stepCount;
        this.atomPrev[o] = spawnedNow ? this.atomPosr[o] : s.prevAx + a.px;
        this.atomPrev[o + 1] = spawnedNow
          ? this.atomPosr[o + 1]
          : s.prevAy + a.py;
        this.atomPrev[o + 2] = spawnedNow
          ? this.atomPosr[o + 2]
          : s.prevAz + a.pz;
        this.atomPrev[o + 3] = a.r;
        this.atomColorKind[o] = a.colR;
        this.atomColorKind[o + 1] = a.colG;
        this.atomColorKind[o + 2] = a.colB;
        this.atomColorKind[o + 3] = a.kindIndex;
        this.atomAux[o] = a.spawnStep;
        this.atomAux[o + 1] = a.seed;
        this.atomAux[o + 2] = 0;
        this.atomAux[o + 3] = 0;
        atomCount++;
      }

      for (let d = 0; d < s.dCount; d++) {
        if (dropCount >= DROPLET_VIEW_CAPACITY) break;
        const src = d * V4;
        const o = dropCount * V4;
        this.dropPosr[o] = s.ax + s.dPosr[src];
        this.dropPosr[o + 1] = s.ay + s.dPosr[src + 1];
        this.dropPosr[o + 2] = s.az + s.dPosr[src + 2];
        this.dropPosr[o + 3] = s.dPosr[src + 3];
        const spawnedNow = s.dAux[src + 2] === this.stepCount;
        this.dropPrev[o] = spawnedNow
          ? this.dropPosr[o]
          : s.prevAx + s.dPrev[src];
        this.dropPrev[o + 1] = spawnedNow
          ? this.dropPosr[o + 1]
          : s.prevAy + s.dPrev[src + 1];
        this.dropPrev[o + 2] = spawnedNow
          ? this.dropPosr[o + 2]
          : s.prevAz + s.dPrev[src + 2];
        this.dropPrev[o + 3] = s.dPosr[src + 3];
        this.dropAux[o] = s.dAux[src];
        this.dropAux[o + 1] = s.dAux[src + 1];
        this.dropAux[o + 2] = s.dAux[src + 2];
        this.dropAux[o + 3] = s.dAux[src + 3];
        dropCount++;
      }
    }
    this.viewObj.step = this.stepCount;
    this.viewObj.bubbles.count = this.slotCount; // 恒常(Dead 含む — A18)
    this.viewObj.atoms.count = atomCount;
    this.viewObj.droplets.count = dropCount;
  }
}
