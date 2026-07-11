import {
  ANGLE_JITTER,
  FALLBACK_Y_INNER,
  FALLBACK_Y_OUTER,
  INNER_RING_SHARE,
  RADIAL_JITTER,
  RING_INNER_RADIUS,
  RING_OUTER_RADIUS,
  RING_Y_MAX,
  RING_Y_MIN,
  R_MIN,
  R_NEAR_RING_MAX,
  SEPARATION_MARGIN,
  SEPARATION_MAX_TRIES,
} from '../config';
import type { Random } from '../core/Random';
import { type Vec3, vec3 } from '../core/Vec3';

/** スロットの配置パラメータ(世代ごとに再ロール)。 */
export interface SlotPlacement {
  r: number; // 球半径 R
  baseX: number;
  baseY: number;
  baseZ: number;
  bobPhaseY: number;
  bobPhaseX: number;
}

export const emptyPlacement = (): SlotPlacement => ({
  r: 1,
  baseX: 0,
  baseY: 0,
  baseZ: 0,
  bobPhaseY: 0,
  bobPhaseX: 0,
});

/**
 * 緩い二重リング配置とスポーン時の決定的分離チェック(design-sim §2.3、A30)。
 * - スロットは前詰めで内リング(innerCount = round(slotCount·5/12))と
 *   外リングに分割: desktop 12 = 内 5 + 外 7、mobile 7 = 内 3 + 外 4
 * - 内リング i: 基準角 θᵢ = 2πi/innerCount(半径 3.5)。
 *   外リング j: θⱼ = 2πj/outerCount + π/outerCount(半径 6.5 — 半ステップ
 *   オフセットで格子の重なりを最小化)。y ∈ [2.6, 6.0]、
 *   角 ±0.06 rad・半径 ±0.25 u ジッター
 * - 分離チェック: 他スロット(リング横断)との中心距離 ≥ R_a + R_b + 0.1 に
 *   なるまで(角, 半径, y)を再ロール(最大 SEPARATION_MAX_TRIES 回)。
 *   全滅時は**全試行中で最も分離マージンが良い候補**にフォールバック
 *   (A42: 単純な「ジッターなし基準位置」だと、たまたま試行の方が優れて
 *   いる場合に採用し損ねる ── 大径球混在時代の safety net。ジッターなし
 *   基準位置 + リング別 y は初期比較対象として残す)
 * - R は `R_MIN + (R_NEAR_RING_MAX − R_MIN) · u²`(A42「身の丈ロール」—
 *   近リングは R_MAX より低い R_NEAR_RING_MAX=1.8 が上限。u² シェーピングで
 *   小径寄りに偏る)
 * - RNG 呼び順(§7.1): R → (角, 半径, y) × 試行 → bob 位相 ×2。
 *   初期 fill ジッターは呼び出し側(init のみ)
 */
export class SlotRing {
  private readonly innerCount: number;
  private readonly outerCount: number;
  /** 候補点の使い回しバッファ(定常アロケーションゼロ)。 */
  private readonly candidate: Vec3 = vec3();

  constructor(slotCount: number) {
    this.innerCount = Math.round(slotCount * INNER_RING_SHARE);
    this.outerCount = slotCount - this.innerCount;
  }

  /**
   * スロット slotIndex の配置を out に書き込む。others は分離チェック対象の
   * 既存配置(null = 未ロール。自スロットは含めない)。
   */
  public rollInto(
    rng: Random,
    slotIndex: number,
    others: readonly (SlotPlacement | null)[],
    out: SlotPlacement,
  ): void {
    const inner = slotIndex < this.innerCount;
    const ringCount = inner ? this.innerCount : this.outerCount;
    const ringIndex = inner ? slotIndex : slotIndex - this.innerCount;
    const ringRadius = inner ? RING_INNER_RADIUS : RING_OUTER_RADIUS;
    const theta0 =
      (2 * Math.PI * ringIndex) / ringCount +
      (inner ? 0 : Math.PI / this.outerCount);
    const uR = rng.next();
    const r = R_MIN + (R_NEAR_RING_MAX - R_MIN) * uR * uR;
    // フォールバック基準: ジッターなし基準位置 + リング別 y(初期比較対象)
    const p = this.candidate;
    p.x = ringRadius * Math.cos(theta0);
    p.y = inner ? FALLBACK_Y_INNER : FALLBACK_Y_OUTER;
    p.z = ringRadius * Math.sin(theta0);
    let bestScore = minMargin(p.x, p.y, p.z, r, others);
    let bestX = p.x;
    let bestY = p.y;
    let bestZ = p.z;
    let solved = bestScore >= 0;
    for (let t = 0; t < SEPARATION_MAX_TRIES && !solved; t++) {
      const theta = theta0 + (2 * rng.next() - 1) * ANGLE_JITTER;
      const radius = ringRadius + (2 * rng.next() - 1) * RADIAL_JITTER;
      const cy = RING_Y_MIN + rng.next() * (RING_Y_MAX - RING_Y_MIN);
      const cx = radius * Math.cos(theta);
      const cz = radius * Math.sin(theta);
      const score = minMargin(cx, cy, cz, r, others);
      if (score > bestScore) {
        bestScore = score;
        bestX = cx;
        bestY = cy;
        bestZ = cz;
        solved = score >= 0;
      }
    }
    out.r = r;
    out.baseX = bestX;
    out.baseY = bestY;
    out.baseZ = bestZ;
    out.bobPhaseY = rng.next() * 2 * Math.PI;
    out.bobPhaseX = rng.next() * 2 * Math.PI;
  }
}

/**
 * 候補位置の分離マージン(= min over others of (距離 − 必要距離))。
 * 0 以上ならその他全スロットと分離済み。others が空/全 null なら +Infinity
 * (A42 のベスト候補フォールバックで SlotField.ts と共用)。
 */
export const minMargin = (
  x: number,
  y: number,
  z: number,
  r: number,
  others: readonly (SlotPlacement | null)[],
): number => {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < others.length; i++) {
    const o = others[i];
    if (o === null) continue;
    const dx = o.baseX - x;
    const dy = o.baseY - y;
    const dz = o.baseZ - z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const margin = d - (o.r + r + SEPARATION_MARGIN);
    if (margin < best) best = margin;
  }
  return best;
};
