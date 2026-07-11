import {
  FIELD_ANGLE_JITTER,
  FIELD_RADIAL_JITTER,
  FIELD_RADIUS_MAX,
  FIELD_RADIUS_MIN,
  RING_Y_MAX,
  RING_Y_MIN,
  R_MAX,
  R_MIN,
  SEPARATION_MARGIN,
  SEPARATION_MAX_TRIES,
} from '../config';
import type { Random } from '../core/Random';
import { type Vec3, vec3 } from '../core/Vec3';
import type { SlotPlacement } from './SlotRing';

/** ひまわり配列の黄金角(rad)— 均等・非周期な角配分(リング分割の帳簿不要)。 */
const GOLDEN_ANGLE = 2.399963229728653;

/**
 * 外側環状フィールドの配置(design-sim §2.3 拡張、裁定 A32)。
 *
 * `SlotRing`(近リング、緩い二重リング — 不変)の外側に薄く広がる追加スロット群。
 * - 半径は幾何スパイラル r(t) = FIELD_RADIUS_MIN·(FIELD_RADIUS_MAX/FIELD_RADIUS_MIN)^t
 *   (t = フィールド内インデックス fieldIndex / fieldCount ∈ [0,1))。
 *   等間隔 t に対し外側ほど半径間隔が開く(dr/dt ∝ r)ため密度 ∝ 1/r —
 *   「外へ薄くなる」密度を固定サイト方式のまま実現する
 * - 角は黄金角スパイラル(θ = fieldIndex · GOLDEN_ANGLE)。角/半径ジッター付き
 * - y ∈ [RING_Y_MIN, RING_Y_MAX](近リングと共通の高さ帯)
 * - 分離チェックは SlotRing と同じ方式(他スロット — リング横断含む — との
 *   中心距離 ≥ R_a + R_b + SEPARATION_MARGIN になるまで再ロール、最大
 *   SEPARATION_MAX_TRIES 回。全滅時はジッターなし基準位置 + 偶奇で離した
 *   y の決定的フォールバック)
 * - RNG 呼び順(SlotRing §7.1 と同型): R → (角, 半径, y) × 試行 → bob 位相 ×2
 */
export class SlotField {
  private readonly fieldCount: number;
  private readonly candidate: Vec3 = vec3();

  constructor(fieldCount: number) {
    this.fieldCount = Math.max(fieldCount, 1);
  }

  /**
   * フィールド内インデックス fieldIndex(0 起点、近リングを除いた通し番号)の
   * 配置を out に書き込む。others は近リング含む全スロットの既存配置
   * (null = 未ロール。自スロットは含めない)。
   */
  public rollInto(
    rng: Random,
    fieldIndex: number,
    others: readonly (SlotPlacement | null)[],
    out: SlotPlacement,
  ): void {
    const t = fieldIndex / this.fieldCount;
    const baseRadius =
      FIELD_RADIUS_MIN * (FIELD_RADIUS_MAX / FIELD_RADIUS_MIN) ** t;
    const theta0 = fieldIndex * GOLDEN_ANGLE;
    const r = R_MIN + rng.next() * (R_MAX - R_MIN);
    const p = this.candidate;
    // フォールバック: ジッターなし基準位置(偶奇で y を帯の両端へ離す — 決定的最終手段)
    p.x = baseRadius * Math.cos(theta0);
    p.y = fieldIndex % 2 === 0 ? RING_Y_MIN + 0.3 : RING_Y_MAX - 0.3;
    p.z = baseRadius * Math.sin(theta0);
    for (let tries = 0; tries < SEPARATION_MAX_TRIES; tries++) {
      const theta = theta0 + (2 * rng.next() - 1) * FIELD_ANGLE_JITTER;
      const radius = baseRadius + (2 * rng.next() - 1) * FIELD_RADIAL_JITTER;
      const cy = RING_Y_MIN + rng.next() * (RING_Y_MAX - RING_Y_MIN);
      const cx = radius * Math.cos(theta);
      const cz = radius * Math.sin(theta);
      if (isSeparated(cx, cy, cz, r, others)) {
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
}

/** SlotRing.rollInto の分離判定と同一ロジック(§2.3)。 */
const isSeparated = (
  x: number,
  y: number,
  z: number,
  r: number,
  others: readonly (SlotPlacement | null)[],
): boolean => {
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
};
