import {
  ANGLE_JITTER,
  RADIAL_JITTER,
  RING_RADIUS,
  RING_Y_MAX,
  RING_Y_MIN,
  R_MAX,
  R_MIN,
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
 * リング配置とスポーン時の決定的分離チェック(design-sim §2.3)。
 * - スロット i の基準角 θᵢ = 2πi/slotCount。アンカーは中心軸まわりの緩いリング
 *   (半径 4.5 u、y ∈ [2.8, 5.2]、角 ±0.06 rad・半径 ±0.25 u ジッター)
 * - 分離チェック: 他スロットとの中心距離 ≥ R_a + R_b + 0.1 になるまで
 *   (角, 半径, y)を再ロール(最大 8 回)。全滅時はジッターなし基準位置 +
 *   帯中央の y(決定的フォールバック)
 * - RNG 呼び順(§7.1): R → (角, 半径, y) × 試行 → bob 位相 ×2。
 *   初期 fill ジッターは呼び出し側(init のみ)
 */
export class SlotRing {
  private readonly slotCount: number;
  /** 候補点の使い回しバッファ(定常アロケーションゼロ)。 */
  private readonly candidate: Vec3 = vec3();

  constructor(slotCount: number) {
    this.slotCount = slotCount;
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
    const theta0 = (2 * Math.PI * slotIndex) / this.slotCount;
    const r = R_MIN + rng.next() * (R_MAX - R_MIN);
    // フォールバック: ジッターなし基準位置 + 帯中央 y(全試行失敗時 — 決定的)
    const p = this.candidate;
    p.x = RING_RADIUS * Math.cos(theta0);
    p.y = (RING_Y_MIN + RING_Y_MAX) / 2;
    p.z = RING_RADIUS * Math.sin(theta0);
    for (let t = 0; t < SEPARATION_MAX_TRIES; t++) {
      const theta = theta0 + (2 * rng.next() - 1) * ANGLE_JITTER;
      const radius = RING_RADIUS + (2 * rng.next() - 1) * RADIAL_JITTER;
      const cy = RING_Y_MIN + rng.next() * (RING_Y_MAX - RING_Y_MIN);
      const cx = radius * Math.cos(theta);
      const cz = radius * Math.sin(theta);
      if (this.separated(cx, cy, cz, r, others)) {
        p.x = cx;
        p.y = cy;
        p.z = cz;
        break;
      }
    }
    out.r = r;
    out.baseX = p.x;
    out.baseY = p.y;
    out.baseZ = p.z;
    out.bobPhaseY = rng.next() * 2 * Math.PI;
    out.bobPhaseX = rng.next() * 2 * Math.PI;
  }

  private separated(
    x: number,
    y: number,
    z: number,
    r: number,
    others: readonly (SlotPlacement | null)[],
  ): boolean {
    for (let i = 0; i < others.length; i++) {
      const o = others[i];
      if (o === null) continue;
      const dx = o.baseX - x;
      const dy = o.baseY - y;
      const dz = o.baseZ - z;
      const min = o.r + r + SEPARATION_MARGIN;
      if (dx * dx + dy * dy + dz * dz < min * min) return false;
    }
    return true;
  }
}
