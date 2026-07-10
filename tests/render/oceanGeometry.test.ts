import { describe, expect, it } from 'vitest';
import {
  OCEAN_R_INNER,
  OCEAN_R_OUTER,
  OceanGeometryCache,
  createOceanGeometry,
  oceanRingRadii,
  oceanTriangleCount,
  oceanVertexCount,
} from '../../src/render/ocean/OceanGeometry';

describe('OceanGeometry', () => {
  it('等比リング半径列: 単調増加・端点固定・r≤12 に十分な密度', () => {
    const radii = oceanRingRadii(144);
    expect(radii.length).toBe(144);
    expect(radii[0]).toBeCloseTo(OCEAN_R_INNER, 10);
    expect(radii[143]).toBeCloseTo(OCEAN_R_OUTER, 8);
    for (let k = 1; k < radii.length; k++) {
      expect(radii[k]).toBeGreaterThan(radii[k - 1]);
    }
    // アクション域 r ≤ 12 のリング本数(§2.6: 中心に集中 — 24 本以上)
    const inAction = radii.filter((r) => r <= 12).length;
    expect(inAction).toBeGreaterThanOrEqual(24);
    // r=10 付近のリング間隔 ≈ 0.5u(λ=2.6 の頂点変位波に ≥5 頂点/λ)
    const k10 = radii.findIndex((r) => r >= 10);
    expect(radii[k10 + 1] - radii[k10]).toBeLessThan(0.62);
  });

  it('tier0 144×192: 頂点 27,649 / 三角形 55,104(§2.6 の設計値)', () => {
    expect(oceanVertexCount(144, 192)).toBe(1 + 144 * 192);
    expect(oceanTriangleCount(144, 192)).toBe(192 + 143 * 192 * 2);
    const geometry = createOceanGeometry(144, 192);
    const pos = geometry.getAttribute('position');
    expect(pos.count).toBe(oceanVertexCount(144, 192));
    expect(geometry.getIndex()?.count).toBe(oceanTriangleCount(144, 192) * 3);
    geometry.dispose();
  });

  it('全頂点 y=0・最外周半径 = 600', () => {
    const geometry = createOceanGeometry(24, 32);
    const pos = geometry.getAttribute('position');
    let maxR = 0;
    for (let i = 0; i < pos.count; i++) {
      expect(pos.getY(i)).toBe(0);
      const r = Math.hypot(pos.getX(i), pos.getZ(i));
      if (r > maxR) maxR = r;
    }
    expect(maxR).toBeCloseTo(OCEAN_R_OUTER, 3);
    geometry.dispose();
  });

  it('巻き順: 全三角形の法線が +y(FrontSide が上面)', () => {
    const geometry = createOceanGeometry(8, 12);
    const pos = geometry.getAttribute('position');
    const index = geometry.getIndex();
    if (!index) throw new Error('indexed geometry expected');
    for (let t = 0; t < index.count; t += 3) {
      const a = index.getX(t);
      const b = index.getX(t + 1);
      const c = index.getX(t + 2);
      const ux = pos.getX(b) - pos.getX(a);
      const uz = pos.getZ(b) - pos.getZ(a);
      const vx = pos.getX(c) - pos.getX(a);
      const vz = pos.getZ(c) - pos.getZ(a);
      // cross((ux,0,uz),(vx,0,vz)).y = uz*vx − ux*vz
      expect(uz * vx - ux * vz).toBeGreaterThan(0);
    }
    geometry.dispose();
  });

  it('LOD キャッシュ: 同一密度は同一インスタンスを返す', () => {
    const cache = new OceanGeometryCache();
    const a = cache.get(96, 128);
    const b = cache.get(96, 128);
    const c = cache.get(72, 96);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    cache.dispose();
  });
});
