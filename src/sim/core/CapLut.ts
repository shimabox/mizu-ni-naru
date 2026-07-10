/**
 * 球冠体積 ↔ 水位の変換(design-sim §4.2)。
 * 水は内殻球(半径 R̂)の底に溜まる球冠。u = h/(2R̂) とすると
 *   fill01 = u²(3 − 2u)(smoothstep そのもの)
 * の逆関数 u(f) が毎 step 必要(3 次方程式)。三角閉形式
 *   u = 1/2 − sin(asin(1 − 2f)/3)
 * を **LUT の生成器 + テストオラクル**に使い、実行時は LUT + 線形補間で引く
 * (分岐なし・trig なし。asin の端点精度クリフも回避)。
 *
 * - LUT: CAP_LUT[i] = u_exact(i/256)、i ∈ [0, 256](257 エントリ、1KB)
 * - 端点の特異性: du/df = 1/(6u(1−u)) は f→0,1 で発散(√ 特異性)。
 *   f < 1/64 は漸近式 u = √(f/3)、f > 63/64 は対称式 u = 1 − √((1−f)/3)
 * - 誤差帯(プロパティテストで固定): 中央 |u_lut − u_exact| ≤ 5×10⁻⁴、
 *   端点帯 ≤ 2×10⁻³(境界 f=1/64 で漸近式誤差 ≈1.7×10⁻³)
 *
 * 定数はここで定義する(sim/core は sim の最下層で config に依存できない —
 * depcruise の sim-core-is-base)。config.ts 側の CAP_LUT_SIZE /
 * CAP_LUT_ENDPOINT_F は本値の文書化ミラーで、一致はテストで固定する。
 */

/** LUT の分割数(257 エントリ、1KB)= config.CAP_LUT_SIZE。 */
export const CAP_LUT_SIZE = 256;
/** 漸近式との接続点(誤差最小の交点)= config.CAP_LUT_ENDPOINT_F。 */
export const CAP_LUT_ENDPOINT_F = 1 / 64;

/** オラクル(三角閉形式)。検算: f=0 → u=0、f=1/2 → u=1/2、f=1 → u=1。 */
export const capUExact = (fill01: number): number => {
  const f = fill01 < 0 ? 0 : fill01 > 1 ? 1 : fill01;
  return 0.5 - Math.sin(Math.asin(1 - 2 * f) / 3);
};

const LUT = new Float64Array(CAP_LUT_SIZE + 1);
for (let i = 0; i <= CAP_LUT_SIZE; i++) {
  LUT[i] = capUExact(i / CAP_LUT_SIZE);
}

// hot path: ローカル束縛(design-sim §8 の知見)
const SIZE = CAP_LUT_SIZE;
const ENDPOINT_F = CAP_LUT_ENDPOINT_F;

/** 実行時参照: fill01 → u = h/(2R̂)。水位は (2u − 1)·R̂。 */
export const capU = (fill01: number): number => {
  const f = fill01 < 0 ? 0 : fill01 > 1 ? 1 : fill01;
  if (f < ENDPOINT_F) return Math.sqrt(f / 3);
  if (f > 1 - ENDPOINT_F) return 1 - Math.sqrt((1 - f) / 3);
  const s = f * SIZE;
  const i = Math.floor(s);
  const t = s - i;
  return LUT[i] + (LUT[i + 1] - LUT[i]) * t;
};

/** 順方向(検算・往復テスト用): u → fill01 = 3u² − 2u³。 */
export const capF = (u: number): number => u * u * (3 - 2 * u);
