import { BufferAttribute, BufferGeometry } from 'three';

/**
 * 放射リンググリッド(design-render §2.6)。
 *
 * - 原点中心・world 固定。カメラは原点周りを周回するだけなので
 *   中心密・遠方疎の放射メッシュが全アングルで最適(追従再メッシュ不要)
 * - リング半径は等比数列 r₀ = 0.5 → r_{rings−1} = 600(tier0 成長率 ≈ 1.051)。
 *   r ≤ 12(アクション域)に 60 本超が集中し、リップル変位も頂点で受けられる
 * - 頂点 = 中心 1 + rings×segments、三角形 = 中心ファン segments +
 *   リング間 (rings−1)×segments×2(tier0 144×192 ≈ 55k tri / 27.6k 頂点)
 * - LOD 変種はキャッシュし参照差し替え(Phase 4 applyTier)
 */
export const OCEAN_R_INNER = 0.5;
export const OCEAN_R_OUTER = 600;

/** 等比リング半径列(純ロジック — テスト対象)。 */
export const oceanRingRadii = (
  rings: number,
  rInner: number = OCEAN_R_INNER,
  rOuter: number = OCEAN_R_OUTER,
): Float64Array => {
  const radii = new Float64Array(rings);
  const growth = (rOuter / rInner) ** (1 / (rings - 1));
  let r = rInner;
  for (let k = 0; k < rings; k++) {
    radii[k] = r;
    r *= growth;
  }
  radii[rings - 1] = rOuter; // 累積誤差の吸収
  return radii;
};

export const oceanVertexCount = (rings: number, segments: number): number =>
  1 + rings * segments;

export const oceanTriangleCount = (rings: number, segments: number): number =>
  segments + (rings - 1) * segments * 2;

/**
 * 放射グリッドの生成。position のみ(y=0 平面 — 法線はシェーダが解析導出)。
 * 巻き順は +y から見て CCW(FrontSide が上面)。
 */
export const createOceanGeometry = (
  rings: number,
  segments: number,
): BufferGeometry => {
  const radii = oceanRingRadii(rings);
  const vertexCount = oceanVertexCount(rings, segments);
  const positions = new Float32Array(vertexCount * 3);

  // index 0 = 中心。リング k のセグメント s = 1 + k*segments + s
  let p = 3;
  for (let k = 0; k < rings; k++) {
    const r = radii[k];
    for (let s = 0; s < segments; s++) {
      const theta = (2 * Math.PI * s) / segments;
      positions[p] = r * Math.cos(theta);
      positions[p + 1] = 0;
      positions[p + 2] = r * Math.sin(theta);
      p += 3;
    }
  }

  const triCount = oceanTriangleCount(rings, segments);
  const indices = new Uint32Array(triCount * 3);
  let i = 0;
  const ringStart = (k: number): number => 1 + k * segments;
  // 中心ファン(上向き法線になる巻き順: center → s+1 → s)
  for (let s = 0; s < segments; s++) {
    const s1 = (s + 1) % segments;
    indices[i++] = 0;
    indices[i++] = ringStart(0) + s1;
    indices[i++] = ringStart(0) + s;
  }
  // リング間クアッド
  for (let k = 0; k < rings - 1; k++) {
    const inner = ringStart(k);
    const outer = ringStart(k + 1);
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      indices[i++] = inner + s;
      indices[i++] = inner + s1;
      indices[i++] = outer + s;
      indices[i++] = inner + s1;
      indices[i++] = outer + s1;
      indices[i++] = outer + s;
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return geometry;
};

/** LOD キャッシュ(ティア切替時の再生成ヒッチ防止 — §2.6 / §9.3)。 */
export class OceanGeometryCache {
  private readonly cache = new Map<string, BufferGeometry>();

  public get(rings: number, segments: number): BufferGeometry {
    const key = `${rings}x${segments}`;
    let geometry = this.cache.get(key);
    if (!geometry) {
      geometry = createOceanGeometry(rings, segments);
      this.cache.set(key, geometry);
    }
    return geometry;
  }

  public dispose(): void {
    for (const geometry of this.cache.values()) {
      geometry.dispose();
    }
    this.cache.clear();
  }
}
