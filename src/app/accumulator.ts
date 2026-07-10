import { MAX_STEPS_PER_FRAME, STEP_HZ } from '../contract/WorldSpec';

const STEP_MS = 1000 / STEP_HZ;

export interface AccumulateResult {
  /** このフレームで実行する sim.step() の回数(0..MAX_STEPS_PER_FRAME) */
  readonly steps: number;
  /** 補間係数 ∈ [0, 1)(= remainder / STEP_MS) */
  readonly alpha: number;
  /** 次フレームへ持ち越す残余時間(ms) */
  readonly remainder: number;
}

/**
 * 固定タイムステップのアキュムレータ(純関数 — design-sim §7.1)。
 * 120Hz 端末でも世界速度が壁時計に一致する(rAF 毎 1 step の旧問題への回答)。
 * MAX_STEPS_PER_FRAME 超過分は残余ごと捨てる(タブ復帰時の
 * スパイラル・オブ・デス防止 — 世界時間ごと破棄)。
 */
export const accumulate = (
  prevRemainder: number,
  frameDtMs: number,
): AccumulateResult => {
  const acc = prevRemainder + Math.max(frameDtMs, 0);
  let steps = Math.floor(acc / STEP_MS);
  let remainder = acc - steps * STEP_MS;
  if (steps > MAX_STEPS_PER_FRAME) {
    steps = MAX_STEPS_PER_FRAME;
    remainder = 0;
  }
  return { steps, alpha: remainder / STEP_MS, remainder };
};
