/**
 * SplatScheduler(design-render §2.2 — レンダー内の遅延スプラットキュー)。
 *
 * 球の着水 1 イベントを「主スプラット + 遅延サブスプラット(+8/+14/+22 step、
 * 強度 ×0.4/0.25/0.15、位置 ±0.3R ジッタ)」に展開する。単発ガウスより
 * 着水が「ドプン」と多段に読める。スプレー粒子(§6)の落着点にも
 * 微小スプラットを予約する(弾道は閉形式 — spawn 時に確定計算)。
 *
 * 純ロジック(three 非依存・割付は構築時のみ)— テスト対象。
 */

/** キュー内部エントリ: [dueStep, x, z, quadRadius, strength, ringR0, tintGain]。 */
export const SPLAT_STRIDE = 7;
/** collectDue の出力: [x, z, quadRadius, strength, ringR0, tintGain]。 */
export const SPLAT_OUT_STRIDE = 6;

/** 遅延サブスプラットの step オフセットと強度スケール(§2.2)。 */
export const SUB_SPLAT_STEP_OFFSETS: readonly number[] = [8, 14, 22];
export const SUB_SPLAT_STRENGTH_SCALE: readonly number[] = [0.4, 0.25, 0.15];
/** サブスプラットの位置ジッタ半径(×R)。 */
export const SUB_SPLAT_JITTER_RATIO = 0.3;

/** スプラット quad 半径 = 2.6 × R(ガウスの実効幅 ≈ 0.9R)。 */
export const SPLASH_QUAD_RADIUS_SCALE = 2.6;
/** フォームリング位置(quad-local)≈ クラウン半径 1.15R / 2.6R。 */
export const SPLASH_RING_R0 = 1.15 / SPLASH_QUAD_RADIUS_SCALE;

const DEFAULT_CAPACITY = 256;

/** 決定論ジッタ(イベントデータから導出 — 乱数状態を持たない)。 */
export const splatJitter01 = (
  x: number,
  z: number,
  strength: number,
  salt: number,
): number => {
  const v =
    Math.sin(x * 12.9898 + z * 78.233 + strength * 37.719 + salt * 4.581) *
    43758.5453;
  return v - Math.floor(v);
};

export class SplatScheduler {
  private readonly entries: Float32Array;
  private readonly capacity: number;
  private count = 0;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = capacity;
    this.entries = new Float32Array(capacity * SPLAT_STRIDE);
  }

  public get size(): number {
    return this.count;
  }

  /** 単発スプラットの予約(満杯時は黙って捨てる — FX なので損失可)。 */
  public schedule(
    dueStep: number,
    x: number,
    z: number,
    quadRadius: number,
    strength: number,
    ringR0: number,
    tintGain: number,
  ): void {
    if (this.count >= this.capacity) return;
    const o = this.count * SPLAT_STRIDE;
    const e = this.entries;
    e[o] = dueStep;
    e[o + 1] = x;
    e[o + 2] = z;
    e[o + 3] = quadRadius;
    e[o + 4] = strength;
    e[o + 5] = ringR0;
    e[o + 6] = tintGain;
    this.count++;
  }

  /**
   * 球の着水(SplashEventView: radius = R、strength = min(1, v/4) — A10)
   * → 主スプラット(即時・tint あり)+ 遅延サブスプラット 3 発。
   */
  public addSplash(
    step: number,
    x: number,
    z: number,
    radius: number,
    strength: number,
  ): void {
    const quadRadius = radius * SPLASH_QUAD_RADIUS_SCALE;
    this.schedule(step, x, z, quadRadius, strength, SPLASH_RING_R0, 1);
    for (let k = 0; k < SUB_SPLAT_STEP_OFFSETS.length; k++) {
      const jr = SUB_SPLAT_JITTER_RATIO * radius;
      const jx = (splatJitter01(x, z, strength, k * 2 + 1) * 2 - 1) * jr;
      const jz = (splatJitter01(x, z, strength, k * 2 + 2) * 2 - 1) * jr;
      this.schedule(
        step + SUB_SPLAT_STEP_OFFSETS[k],
        x + jx,
        z + jz,
        quadRadius * (0.85 - 0.15 * k),
        strength * SUB_SPLAT_STRENGTH_SCALE[k],
        SPLASH_RING_R0 * (0.9 - 0.12 * k),
        0, // 刻印は主スプラットのみ
      );
    }
  }

  /** スプレー粒子の落着点への微小スプラット(§6 — tint / フォームは僅か)。 */
  public addMicroSplat(
    dueStep: number,
    x: number,
    z: number,
    strength: number,
  ): void {
    this.schedule(dueStep, x, z, 0.45, strength, 0.5, 0);
  }

  /**
   * 期日到来(dueStep ≤ step)のエントリを out へ詰めて除去する
   * (swap-remove)。返り値は書き出した個数(maxOut で打ち切り)。
   * out のストライドは SPLAT_OUT_STRIDE。
   */
  public collectDue(step: number, out: Float32Array, maxOut: number): number {
    const e = this.entries;
    let written = 0;
    let i = 0;
    while (i < this.count) {
      const o = i * SPLAT_STRIDE;
      if (e[o] <= step && written < maxOut) {
        const w = written * SPLAT_OUT_STRIDE;
        out[w] = e[o + 1];
        out[w + 1] = e[o + 2];
        out[w + 2] = e[o + 3];
        out[w + 3] = e[o + 4];
        out[w + 4] = e[o + 5];
        out[w + 5] = e[o + 6];
        written++;
        // swap-remove(末尾を i へ)— i は再検査
        const last = (this.count - 1) * SPLAT_STRIDE;
        for (let k = 0; k < SPLAT_STRIDE; k++) {
          e[o + k] = e[last + k];
        }
        this.count--;
      } else {
        i++;
      }
    }
    return written;
  }
}
