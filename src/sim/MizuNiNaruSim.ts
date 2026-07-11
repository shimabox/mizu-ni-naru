import type {
  SimCounts,
  SimInitOptions,
  SimLike,
  SkyRenderView,
} from '../contract/RenderView';
import {
  BUBBLE_CAPACITY,
  BUBBLE_STATE,
  DT,
  KIND_INDEX,
  SLOT_COUNT_MOBILE,
} from '../contract/WorldSpec';
import { BubbleFsm, FSM_EVENT } from './bubble/BubbleFsm';
import {
  BubbleWorld,
  SPAWNER_MODE,
  type WorldEvents,
  type WorldShared,
} from './bubble/BubbleWorld';
import { SlotField } from './bubble/SlotField';
import {
  type SlotPlacement,
  SlotRing,
  emptyPlacement,
} from './bubble/SlotRing';
import { AtomFactory } from './chem/AtomFactory';
import { Spawner } from './chem/Spawner';
import {
  BOB_AMP,
  BOB_PERIOD_S,
  INITIAL_FILL_JITTER,
  INITIAL_FILL_MAX,
  NEAR_RING_COUNT_DESKTOP,
  NEAR_RING_COUNT_MOBILE,
  SAG_MAX,
  SPAWN_INTERVAL_STEPS_DESKTOP,
  SPAWN_INTERVAL_STEPS_MOBILE,
  SPLASH_STRENGTH_V_REF,
} from './config';
import { Mulberry32, type Random } from './core/Random';
import { GridDetector } from './physics/GridDetector';
import { ReactionRegistry } from './reactions/ReactionRegistry';
import { HHFusion } from './reactions/rules/HHFusion';
import { OxidationToDroplet } from './reactions/rules/OxidationToDroplet';
import { AggregatePacker, type PackSlot } from './view/AggregatePacker';

/** 質量台帳のスナップショット(テスト・校正用の契約外デバッグ API — §7.3)。 */
export interface MassLedger {
  spawnedH: number;
  spawnedO: number;
  h: number;
  o: number;
  h2: number;
  liveDroplets: number;
  absorbedDroplets: number;
  droppedDroplets: number;
  dissolvedH: number;
  dissolvedO: number;
  dissolvedH2: number;
  clearedH: number;
  clearedO: number;
  clearedH2: number;
  clearedDroplets: number;
  volumeFromDroplets: number;
  volumeFromDissolve: number;
}

interface Slot extends PackSlot {
  placement: SlotPlacement;
  fsm: BubbleFsm;
  world: BubbleWorld;
}

const TWO_PI = Math.PI * 2;

/**
 * mizu-ni-naru の本体シミュレーション(SimLike 実装 — design-sim 全編)。
 * スロット走査(昇順)→ FSM → 球内化学 → 集約パックの指揮。
 * 決定論: 単一 mulberry32 ストリーム + step カウンタのみの時計。
 * RNG 呼び順規約は chem/AtomFactory.ts の doc コメントが唯一の正(§7.1)。
 */
export class MizuNiNaruSim implements SimLike {
  private rng: Random = new Mulberry32(1);
  private factory = new AtomFactory(this.rng);
  private slots: Slot[] = [];
  private slotCount = 0;
  private stepCount = 0;
  private spawnIntervalSteps = SPAWN_INTERVAL_STEPS_DESKTOP;
  private splashesTotal = 0;
  private readonly packer = new AggregatePacker();
  /** 近リング(SlotRing、不変)+ 外側環状フィールド(SlotField、A32)。 */
  private readonly ring: {
    near: SlotRing | null;
    field: SlotField | null;
    nearCount: number;
  } = { near: null, field: null, nearCount: 0 };
  private shared: WorldShared | null = null;
  /** rollInto の others 引数(自スロットを除いた配置の使い回しバッファ)。 */
  private readonly othersBuf: (SlotPlacement | null)[] = [];
  /** 球内イベントの配線(使い回し — 定常アロケーションゼロ)。 */
  private readonly worldEvents: WorldEvents & { slot: Slot | null } = {
    slot: null,
    emitRipple: (bubbleIndex, x, z, strength) => {
      this.packer.emitRipple(bubbleIndex, x, z, strength);
    },
    onDropletAbsorbed: () => {
      this.worldEvents.slot?.fsm.addWobblePulse();
    },
  };

  public init(options: SimInitOptions): void {
    const rng = new Mulberry32(options.seed);
    this.rng = rng;
    this.factory = new AtomFactory(rng);
    const registry = new ReactionRegistry();
    registry.register(new HHFusion());
    registry.register(new OxidationToDroplet());
    this.shared = {
      rng,
      factory: this.factory,
      spawner: new Spawner(rng, this.factory),
      detector: new GridDetector(),
      registry,
    };
    this.slotCount = Math.max(1, Math.min(options.slotCount, BUBBLE_CAPACITY));
    const pacing =
      options.pacing ??
      (this.slotCount <= SLOT_COUNT_MOBILE ? 'mobile' : 'desktop');
    this.spawnIntervalSteps =
      pacing === 'mobile'
        ? SPAWN_INTERVAL_STEPS_MOBILE
        : SPAWN_INTERVAL_STEPS_DESKTOP;
    this.stepCount = 0;
    this.splashesTotal = 0;
    // 近リングの総数(A32): pacing に連動(mobile 7 / desktop 12)。debug の
    // ?slots= で小さい総数を指定された場合はフィールドを空にして丸める
    const nearTarget =
      pacing === 'mobile' ? NEAR_RING_COUNT_MOBILE : NEAR_RING_COUNT_DESKTOP;
    const nearCount = Math.min(nearTarget, this.slotCount);
    const fieldCount = this.slotCount - nearCount;
    this.ring.nearCount = nearCount;
    this.ring.near = new SlotRing(nearCount);
    this.ring.field = fieldCount > 0 ? new SlotField(fieldCount) : null;

    // スロット生成(2 パス: 全オブジェクト確保 → 昇順ロール。
    // RNG 順は init 規約どおり: スロット昇順に配置一式 → 初期 fill ジッター — §7.1)
    this.slots = [];
    this.othersBuf.length = 0;
    for (let i = 0; i < this.slotCount; i++) {
      const world = new BubbleWorld(this.shared);
      this.slots.push({
        placement: emptyPlacement(),
        fsm: new BubbleFsm(),
        world,
        ax: 0,
        ay: 0,
        az: 0,
        prevAx: 0,
        prevAy: 0,
        prevAz: 0,
        r: 1,
        waterY: 0,
        fill01: 0,
        wobble: 0,
        statePacked: 0,
        justRespawned: true,
        atoms: world.atoms,
        droplets: world.droplets,
      });
      this.othersBuf.push(null);
    }
    for (let i = 0; i < this.slotCount; i++) {
      this.rollSlot(i, true);
    }
    this.packSlots();
  }

  public step(): void {
    this.stepCount++;
    this.packer.beginStep();
    const rng = this.rng;

    for (let i = 0; i < this.slotCount; i++) {
      const slot = this.slots[i];
      const fsm = slot.fsm;
      slot.justRespawned = false;
      slot.prevAx = slot.ax;
      slot.prevAy = slot.ay;
      slot.prevAz = slot.az;

      // ── FSM(RNG: Dead 遷移の遅延ロール / Dead 満了の再ロール — §7.1)
      const events = fsm.advance(rng, slot, slot.world.water.fill01, slot.r);
      if ((events & FSM_EVENT.Splashed) !== 0) {
        this.packer.emitSplash(
          slot.ax,
          slot.az,
          slot.r,
          Math.min(1, fsm.impactV / SPLASH_STRENGTH_V_REF),
        );
        this.splashesTotal++;
        slot.world.clearContents(); // 「弾けて中身ごと水になる」(fill01 は保持)
      }
      if ((events & FSM_EVENT.EnteredDead) !== 0) {
        slot.world.drainWater(); // Dead 進入で fill01 → 0(§2.2)
      }
      if ((events & FSM_EVENT.RespawnDue) !== 0) {
        this.rollSlot(i, false); // 再ロール一式(RNG — §7.1)
      }

      // ── アンカー(bob + サグ。Falling は FSM が積分済み、Splashing/Dead は固定)
      if (fsm.state <= BUBBLE_STATE.Straining) {
        this.applyBob(slot);
      }

      // ── 球内化学(§3.7 の段順)
      if (fsm.isWorldAlive()) {
        const mode =
          fsm.state === BUBBLE_STATE.Spawning
            ? SPAWNER_MODE.Burst
            : fsm.state === BUBBLE_STATE.Drifting
              ? SPAWNER_MODE.Steady
              : SPAWNER_MODE.Off;
        this.worldEvents.slot = slot;
        slot.world.step(
          i,
          this.stepCount,
          mode,
          fsm.stateStep,
          this.spawnIntervalSteps,
          this.worldEvents,
        );
        this.worldEvents.slot = null;
      }
    }

    this.packSlots();
  }

  public view(): SkyRenderView {
    return this.packer.view();
  }

  public counts(): SimCounts {
    let h = 0;
    let o = 0;
    let h2 = 0;
    let droplets = 0;
    let active = 0;
    let fillSum = 0;
    let absorbed = 0;
    let dissolved = 0;
    for (let i = 0; i < this.slotCount; i++) {
      const slot = this.slots[i];
      const w = slot.world;
      h += w.countKind(KIND_INDEX.H);
      o += w.countKind(KIND_INDEX.O);
      h2 += w.countKind(KIND_INDEX.H2);
      droplets += w.droplets.count;
      absorbed += w.absorbedDroplets;
      dissolved += w.dissolvedH + w.dissolvedO + w.dissolvedH2;
      if (slot.fsm.state !== BUBBLE_STATE.Dead) {
        active++;
        fillSum += w.water.fill01;
      }
    }
    return {
      h,
      o,
      h2,
      droplets,
      bubblesActive: active,
      splashesTotal: this.splashesTotal,
      dropletsAbsorbedTotal: absorbed,
      dissolvedTotal: dissolved,
      meanFill01: active > 0 ? fillSum / active : 0,
    };
  }

  /** 質量台帳(契約外デバッグ API — 保存則テスト §7.3 と校正 §7.5 が使う)。 */
  public ledger(): MassLedger {
    const out: MassLedger = {
      spawnedH: 0,
      spawnedO: 0,
      h: 0,
      o: 0,
      h2: 0,
      liveDroplets: 0,
      absorbedDroplets: 0,
      droppedDroplets: 0,
      dissolvedH: 0,
      dissolvedO: 0,
      dissolvedH2: 0,
      clearedH: 0,
      clearedO: 0,
      clearedH2: 0,
      clearedDroplets: 0,
      volumeFromDroplets: 0,
      volumeFromDissolve: 0,
    };
    for (let i = 0; i < this.slotCount; i++) {
      const w = this.slots[i].world;
      out.spawnedH += w.spawnedH;
      out.spawnedO += w.spawnedO;
      out.h += w.countKind(KIND_INDEX.H);
      out.o += w.countKind(KIND_INDEX.O);
      out.h2 += w.countKind(KIND_INDEX.H2);
      out.liveDroplets += w.droplets.count;
      out.absorbedDroplets += w.absorbedDroplets;
      out.droppedDroplets += w.droplets.droppedTotal;
      out.dissolvedH += w.dissolvedH;
      out.dissolvedO += w.dissolvedO;
      out.dissolvedH2 += w.dissolvedH2;
      out.clearedH += w.clearedH;
      out.clearedO += w.clearedO;
      out.clearedH2 += w.clearedH2;
      out.clearedDroplets += w.clearedDroplets;
      out.volumeFromDroplets += w.volumeFromDroplets;
      out.volumeFromDissolve += w.volumeFromDissolve;
    }
    return out;
  }

  /* ── 内部 ─────────────────────────────────────────────── */

  /** スロットの(再)ロール。initial のみ起動スタッガーの初期 fill(§2.5)。 */
  private rollSlot(index: number, initial: boolean): void {
    const slot = this.slots[index];
    const { near, field, nearCount } = this.ring;
    if (!near) return;
    for (let j = 0; j < this.slotCount; j++) {
      const other = this.slots[j];
      // init 中は未ロールのスロット(placement.r === 1 の空配置)を除外する
      this.othersBuf[j] =
        j === index || (initial && j > index) ? null : other.placement;
    }
    // 近リング(index < nearCount)は SlotRing、外側フィールドは SlotField(A32)。
    // others は境界を跨いで全スロットを含む(分離チェックの拡張適用)
    if (index < nearCount) {
      near.rollInto(this.rng, index, this.othersBuf, slot.placement);
    } else if (field) {
      field.rollInto(
        this.rng,
        index - nearCount,
        this.othersBuf,
        slot.placement,
      );
    }
    let fill = 0;
    if (initial) {
      const n = this.slotCount;
      const stagger =
        n > 1 ? (INITIAL_FILL_MAX * (n - 1 - index)) / (n - 1) : 0;
      fill = Math.max(
        0,
        stagger + (2 * this.rng.next() - 1) * INITIAL_FILL_JITTER,
      );
    }
    slot.r = slot.placement.r;
    slot.world.reset(slot.placement.r, fill);
    slot.fsm.enterSpawning();
    slot.justRespawned = true;
    this.applyBob(slot); // 現在時刻の bob を適用(スポーンフレームの連続性)
    slot.prevAx = slot.ax;
    slot.prevAy = slot.ay;
    slot.prevAz = slot.az;
  }

  /** bob(漂い §2.3)+ fill 荷重サグ(§2.2)。 */
  private applyBob(slot: Slot): void {
    const p = slot.placement;
    const t = this.stepCount * DT;
    const w = TWO_PI / BOB_PERIOD_S;
    slot.ay =
      p.baseY +
      BOB_AMP * Math.sin(w * t + p.bobPhaseY) -
      slot.world.water.fill01 * SAG_MAX;
    slot.ax = p.baseX + BOB_AMP * 0.5 * Math.sin(w * 0.8 * t + p.bobPhaseX);
    slot.az = p.baseZ;
  }

  /** スロットのパック用レーンを確定し packer.pack を呼ぶ。 */
  private packSlots(): void {
    for (let i = 0; i < this.slotCount; i++) {
      const slot = this.slots[i];
      const water = slot.world.water;
      slot.waterY = water.waterY;
      slot.fill01 = water.fill01;
      slot.wobble = slot.fsm.wobble;
      slot.statePacked = slot.fsm.statePacked(water.fill01, slot.ay, slot.r);
    }
    this.packer.pack(this.slots, this.stepCount);
  }
}
