import { capU } from '../core/CapLut';

const FOUR_THIRDS_PI = (4 / 3) * Math.PI;

/**
 * 球内の水の体積台帳(design-sim §4.3)。
 * - V_water += VOLUME_GAIN·(4/3)πr³(雫吸収・原子/H2 溶解)— 加算は step 段 6
 *   でまとめて適用(水位が step 内で動かないことで、同 step 内の吸収判定が
 *   全粒子に対して一貫する)
 * - fill01 = min(V_water / V_inner, 1)。**分母は V_inner(内殻球 — 裁定 A12)**
 * - waterLevelYLocal = (2·capU(fill01) − 1)·R_inner
 * - fill01 / waterY は Drifting/Straining で単調非減少(不変条件 §7.3)
 */
export class WaterBody {
  private rInner = 1;
  private vInner = FOUR_THIRDS_PI;
  private volume = 0;
  private pending = 0;
  public fill01 = 0;
  public waterY = -1;

  /** スロット再ロール時の初期化。initialFill01 は起動スタッガー(§2.5)用。 */
  public reset(rInner: number, initialFill01: number): void {
    this.rInner = rInner;
    this.vInner = FOUR_THIRDS_PI * rInner * rInner * rInner;
    this.volume = initialFill01 * this.vInner;
    this.pending = 0;
    this.recompute();
  }

  /** 体積の加算予約(u³ — VOLUME_GAIN 適用済みの値を渡す)。commit まで水位は不変。 */
  public addVolume(v: number): void {
    this.pending += v;
  }

  /** step 段 6: 予約分を確定し fill01 / waterY を再計算する。 */
  public commit(): void {
    if (this.pending === 0) return;
    this.volume += this.pending;
    this.pending = 0;
    this.recompute();
  }

  private recompute(): void {
    const f = this.volume / this.vInner;
    this.fill01 = f < 1 ? f : 1;
    this.waterY = (2 * capU(this.fill01) - 1) * this.rInner;
  }
}
