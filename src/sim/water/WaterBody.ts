import { WATER_EASE_K } from '../config';
import { capU } from '../core/CapLut';

const FOUR_THIRDS_PI = (4 / 3) * Math.PI;

/**
 * 球内の水の体積台帳(design-sim §4.3、A53 で二層化)。
 * - V_ledger += VOLUME_GAIN·(4/3)πr³(雫吸収・原子/H2 溶解)— 加算は step 段 6
 *   でまとめて即時確定する(質量保存の正。台帳の単調増加はここで保証)
 * - V_eased は毎 commit で V_eased += (V_ledger − V_eased)·WATER_EASE_K
 *   だけ V_ledger を追いかける(τ≈0.6s の指数追従 — A53「もっと自然に」)。
 *   **fill01 / waterY(契約に出る値)と球内の物理相互作用(吸収・バウンド・
 *   F_FULL 判定)はすべて V_eased 基準**(見た目と挙動を一致させる)
 * - fill01 = min(V_eased / V_inner, 1)。**分母は V_inner(内殻球 — 裁定 A12)**
 * - waterLevelYLocal = (2·capU(fill01) − 1)·R_inner
 * - fill01 / waterY は Drifting/Straining で単調非減少(不変条件 §7.3):
 *   V_ledger は加算のみ(減少しない)、V_eased は常に V_ledger 以下から
 *   その差を正の係数で縮める片側追従なので非減少が保たれる
 */
export class WaterBody {
  private rInner = 1;
  private vInner = FOUR_THIRDS_PI;
  private vLedger = 0;
  private vEased = 0;
  private pending = 0;
  public fill01 = 0;
  public waterY = -1;

  /**
   * 台帳基準(V_ledger)の即時 fill01(表示には使わない — 質量保存の検証・
   * テスト専用の読み取り)。
   */
  public get ledgerFill01(): number {
    const f = this.vLedger / this.vInner;
    return f < 1 ? f : 1;
  }

  /** スロット再ロール時の初期化。initialFill01 は起動スタッガー(§2.5)用。
   * V_eased = V_ledger で即座に初期化する(起動時に水がゼロから満ちてくる
   * 演出にはしない — 従来どおり初期水位で立ち上がる)。 */
  public reset(rInner: number, initialFill01: number): void {
    this.rInner = rInner;
    this.vInner = FOUR_THIRDS_PI * rInner * rInner * rInner;
    this.vLedger = initialFill01 * this.vInner;
    this.vEased = this.vLedger;
    this.pending = 0;
    this.recompute();
  }

  /** 体積の加算予約(u³ — VOLUME_GAIN 適用済みの値を渡す)。commit まで水位は不変。 */
  public addVolume(v: number): void {
    this.pending += v;
  }

  /**
   * step 段 6: 予約分を V_ledger へ確定し、V_eased を 1 step 分だけ追従させ、
   * fill01 / waterY を再計算する。予約ゼロ & 追従済み(差分なし)なら
   * 何もしない(再計算スキップ)。
   */
  public commit(): void {
    if (this.pending === 0 && this.vEased === this.vLedger) return;
    if (this.pending !== 0) {
      this.vLedger += this.pending;
      this.pending = 0;
    }
    if (this.vEased !== this.vLedger) {
      this.vEased += (this.vLedger - this.vEased) * WATER_EASE_K;
    }
    this.recompute();
  }

  private recompute(): void {
    const f = this.vEased / this.vInner;
    this.fill01 = f < 1 ? f : 1;
    this.waterY = (2 * capU(this.fill01) - 1) * this.rInner;
  }
}
