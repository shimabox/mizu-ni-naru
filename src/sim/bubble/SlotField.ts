import {
  FIELD_ANGLE_JITTER,
  FIELD_INNER_MAX,
  FIELD_RADIAL_JITTER,
  FIELD_RADIUS_MAX,
  FIELD_RADIUS_MIN,
  RING_Y_MAX,
  RING_Y_MIN,
  R_MAX,
  R_MIN,
  SEPARATION_MAX_TRIES,
} from '../config';
import type { Random } from '../core/Random';
import { type Vec3, vec3 } from '../core/Vec3';
import { type SlotPlacement, minMargin } from './SlotRing';

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
 * - R は `R_MIN + (R_MAX_site(t) − R_MIN) · u²`(A42「身の丈ロール」)。
 *   サイト上限 R_MAX_site(t) = FIELD_INNER_MAX + (R_MAX − FIELD_INNER_MAX)·t
 *   は幾何スパイラルの t(半径進行)に比例して 1.3 → 2.3 に増える —
 *   最内周(密)は控えめな上限、外側(疎)ほど巨大球を許す(「遠くの
 *   シルエット・近くの繊細さ」)。最内周の上限を FIELD_INNER_MAX まで
 *   絞る理由は config.ts の該当コメント参照(黄金角スパイラルの
 *   Δindex=8 幾何共鳴 — 再ロールでも解けない衝突が実測で確認された)。
 *   u² シェーピングで小径寄りに偏る
 * - 分離チェックは SlotRing と同じ方式(他スロット — リング横断含む — との
 *   中心距離 ≥ R_a + R_b + SEPARATION_MARGIN になるまで再ロール、最大
 *   SEPARATION_MAX_TRIES 回。全滅時は**全試行中で最も分離マージンが良い
 *   候補**にフォールバック(A42、SlotRing と同型 minMargin を共用 — 単純な
 *   「ジッターなし基準位置 + 偶奇 y」だけだと大径球混在時に取りこぼす
 *   ケースがある safety net)
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
    const rMaxSite = FIELD_INNER_MAX + (R_MAX - FIELD_INNER_MAX) * t;
    const uR = rng.next();
    const r = R_MIN + (rMaxSite - R_MIN) * uR * uR;
    const p = this.candidate;
    // フォールバック基準: ジッターなし基準位置(偶奇で y を帯の両端へ離す)
    p.x = baseRadius * Math.cos(theta0);
    p.y = fieldIndex % 2 === 0 ? RING_Y_MIN + 0.3 : RING_Y_MAX - 0.3;
    p.z = baseRadius * Math.sin(theta0);
    let bestScore = minMargin(p.x, p.y, p.z, r, others);
    let bestX = p.x;
    let bestY = p.y;
    let bestZ = p.z;
    let solved = bestScore >= 0;
    for (let tries = 0; tries < SEPARATION_MAX_TRIES && !solved; tries++) {
      const theta = theta0 + (2 * rng.next() - 1) * FIELD_ANGLE_JITTER;
      const radius = baseRadius + (2 * rng.next() - 1) * FIELD_RADIAL_JITTER;
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
