import { BUBBLE_STATE, DT, STEP_HZ } from '../../contract/WorldSpec';
import {
  FALL_DRAG_K,
  FALL_G,
  F_FULL_MAX,
  RESPAWN_DELAY_MAX_S,
  RESPAWN_DELAY_MIN_S,
  SPAWNING_DURATION_S,
  SPLASHING_DURATION_S,
  STRAINING_DURATION_S,
  WOBBLE_DECAY,
  WOBBLE_PULSE,
} from '../config';
import type { Random } from '../core/Random';

export const SPAWNING_STEPS = Math.round(SPAWNING_DURATION_S * STEP_HZ); // 120
export const STRAINING_STEPS = Math.round(STRAINING_DURATION_S * STEP_HZ); // 90
export const SPLASHING_STEPS = Math.round(SPLASHING_DURATION_S * STEP_HZ); // 48

/** advance() が返すイベントフラグ(ビット和)。 */
export const FSM_EVENT = {
  None: 0,
  /** Falling→Splashing 遷移(SplashEvent 発火 + 中身クリアを呼び出し側が行う)。 */
  Splashed: 1,
  /** Splashing→Dead 遷移(fill01 を 0 へ — §2.2)。 */
  EnteredDead: 2,
  /** Dead 満了(スロット再ロールを呼び出し側が行う)。 */
  RespawnDue: 4,
} as const;

/** FSM が落下積分で変異させるアンカー(y のみ — x/z は落下中固定 §2.2)。 */
export interface FsmAnchor {
  ay: number;
}

/**
 * 球体 FSM(design-sim §2.1–2.2、状態名は裁定 A3)。
 *
 *             2.0s          fill01 ≥ fullThreshold      1.5s
 *  Spawning ───────▶ Drifting ────────────▶ Straining ───────▶ Falling
 *     ▲                                                           │ ay ≤ R
 *     │ 4〜10s(一様)                                            ▼
 *    Dead ◀──────────────────── 0.8s ──────────────────────── Splashing
 *
 * - RNG 消費: Splashing→Dead 遷移時に再生成遅延 1 回のみ(§7.1)
 * - wobble: Straining で 0→1 線形ランプ、Falling で 1 維持、雫着水パルス
 *   +0.15(毎 step ×0.97 減衰、上限 1)。遷移時に wobble / fill01 が
 *   跳ばないことが statePacked の lerp 禁止(§1.3)の視覚連続性を担保する
 * - 落下(§2.4): v' = v + (G − K·v)·DT、ay' = ay − v·DT(v は下向き正)。
 *   着水判定 ay ≤ R は step 末尾、遷移即 SplashEvent
 */
export class BubbleFsm {
  public state: number = BUBBLE_STATE.Spawning;
  public stateStep = 0;
  public wobble = 0;
  public wobblePulse = 0;
  public fallV = 0;
  public fallY0 = 0;
  /** 直近の着水速度(SplashEvent の strength 導出用)。 */
  public impactV = 0;
  public deadDurationSteps = 1;
  /**
   * この世代の落下トリガ fill01(A40: 世代ごとに [F_FULL_MIN, F_FULL_MAX] の
   * 一様乱数 — rollSlot が設定)。既定は上限(単体テスト等、未設定でも
   * fill01 = F_FULL_MAX を与えれば必ず遷移する)。
   */
  public fullThreshold: number = F_FULL_MAX;

  /** スロット(再)ロール時に呼ぶ。 */
  public enterSpawning(): void {
    this.state = BUBBLE_STATE.Spawning;
    this.stateStep = 0;
    this.wobble = 0;
    this.wobblePulse = 0;
    this.fallV = 0;
    this.fallY0 = 0;
  }

  /**
   * 初期化時の段階湧き(A65)専用: rollSlot が設定した Spawning を Dead へ
   * 上書きする。Splashing→Dead 通常遷移(RNG 消費は呼び出し側が既に済ませ、
   * deadDurationSteps を引数で渡す)と同じ着地状態にする — wobble/wobblePulse
   * は Splashing 満了時と同様 0 にリセットする。
   */
  public enterDead(deadDurationSteps: number): void {
    this.state = BUBBLE_STATE.Dead;
    this.stateStep = 0;
    this.wobble = 0;
    this.wobblePulse = 0;
    this.fallV = 0;
    this.fallY0 = 0;
    this.deadDurationSteps = deadDurationSteps;
  }

  /** 雫着水の wobble パルス(§2.2)。 */
  public addWobblePulse(): void {
    this.wobblePulse = Math.min(this.wobblePulse + WOBBLE_PULSE, 1);
  }

  /** 化学世界が生きている状態か(Spawning / Drifting / Straining / Falling)。 */
  public isWorldAlive(): boolean {
    return this.state <= BUBBLE_STATE.Falling;
  }

  /**
   * 1 step 進める。fill01 は前 step 末の値(Drifting→Straining 判定)。
   * Falling 中は anchor.ay を積分する。返り値は FSM_EVENT のビット和。
   */
  public advance(
    rng: Random,
    anchor: FsmAnchor,
    fill01: number,
    bubbleR: number,
  ): number {
    this.stateStep++;
    this.wobblePulse *= WOBBLE_DECAY;
    let events: number = FSM_EVENT.None;
    switch (this.state) {
      case BUBBLE_STATE.Spawning: {
        this.wobble = Math.min(this.wobblePulse, 1);
        if (this.stateStep >= SPAWNING_STEPS) {
          this.transition(BUBBLE_STATE.Drifting);
        }
        break;
      }
      case BUBBLE_STATE.Drifting: {
        this.wobble = Math.min(this.wobblePulse, 1);
        if (fill01 >= this.fullThreshold) {
          this.transition(BUBBLE_STATE.Straining);
        }
        break;
      }
      case BUBBLE_STATE.Straining: {
        // wobble 0→1 線形ランプ(遷移時の連続性 — §2.2)
        this.wobble = Math.min(
          this.stateStep / STRAINING_STEPS + this.wobblePulse,
          1,
        );
        if (this.stateStep >= STRAINING_STEPS) {
          this.fallV = 0;
          this.fallY0 = anchor.ay;
          this.transition(BUBBLE_STATE.Falling);
        }
        break;
      }
      case BUBBLE_STATE.Falling: {
        this.wobble = 1;
        this.fallV += (FALL_G - FALL_DRAG_K * this.fallV) * DT;
        anchor.ay -= this.fallV * DT;
        if (anchor.ay <= bubbleR) {
          anchor.ay = bubbleR;
          this.impactV = this.fallV;
          events |= FSM_EVENT.Splashed;
          this.transition(BUBBLE_STATE.Splashing);
        }
        break;
      }
      case BUBBLE_STATE.Splashing: {
        if (this.stateStep >= SPLASHING_STEPS) {
          this.wobble = 0;
          this.wobblePulse = 0;
          // 再生成遅延の一様ロール(RNG 1 回 — §7.1)
          this.deadDurationSteps = Math.round(
            (RESPAWN_DELAY_MIN_S +
              rng.next() * (RESPAWN_DELAY_MAX_S - RESPAWN_DELAY_MIN_S)) *
              STEP_HZ,
          );
          events |= FSM_EVENT.EnteredDead;
          this.transition(BUBBLE_STATE.Dead);
        }
        break;
      }
      default: {
        if (this.stateStep >= this.deadDurationSteps) {
          events |= FSM_EVENT.RespawnDue;
        }
        break;
      }
    }
    return events;
  }

  /**
   * statePacked = stateIndex + min(progress01, 0.999)(§1.3)。
   * progress の意味: Spawning/Straining/Splashing = 経過/持続、
   * Drifting = fill01/fullThreshold、Falling = 落下距離正規化、Dead = 再生成待ち進捗。
   */
  public statePacked(fill01: number, anchorY: number, bubbleR: number): number {
    let progress: number;
    switch (this.state) {
      case BUBBLE_STATE.Spawning:
        progress = this.stateStep / SPAWNING_STEPS;
        break;
      case BUBBLE_STATE.Drifting:
        progress = fill01 / this.fullThreshold;
        break;
      case BUBBLE_STATE.Straining:
        progress = this.stateStep / STRAINING_STEPS;
        break;
      case BUBBLE_STATE.Falling:
        progress =
          (this.fallY0 - anchorY) / Math.max(this.fallY0 - bubbleR, 1e-6);
        break;
      case BUBBLE_STATE.Splashing:
        progress = this.stateStep / SPLASHING_STEPS;
        break;
      default:
        progress = this.stateStep / this.deadDurationSteps;
        break;
    }
    return this.state + Math.min(Math.max(progress, 0), 0.999);
  }

  private transition(state: number): void {
    this.state = state;
    this.stateStep = 0;
  }
}
