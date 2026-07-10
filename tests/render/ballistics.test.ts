import { describe, expect, it } from 'vitest';
import {
  SPRAY_G_EFF,
  crownCount,
  hashSeed,
  membraneCount,
  mulberry32,
  packKindSize,
  solveLandingTime,
} from '../../src/render/particles/ballistics';

describe('spray ballistics(§6 — 閉形式弾道)', () => {
  it('solveLandingTime は y(t) = 0 の正根(往復検算)', () => {
    for (const [p0y, v0y] of [
      [0.05, 1.8],
      [0.1, 4.05],
      [0, 3],
      [0.08, 2.5],
    ]) {
      const t = solveLandingTime(p0y, v0y);
      expect(t).toBeGreaterThan(0);
      const y = p0y + v0y * t - 0.5 * SPRAY_G_EFF * t * t;
      expect(Math.abs(y)).toBeLessThan(1e-9);
    }
  });

  it('落着時刻は初速上向き成分に単調', () => {
    const t1 = solveLandingTime(0.05, 2.0);
    const t2 = solveLandingTime(0.05, 3.0);
    const t3 = solveLandingTime(0.05, 4.0);
    expect(t2).toBeGreaterThan(t1);
    expect(t3).toBeGreaterThan(t2);
  });

  it('packKindSize はシェーダ復号(floor / fract×2)と往復一致', () => {
    for (const kind of [0, 1] as const) {
      for (const size of [0, 0.25, 0.5, 0.999]) {
        const w = packKindSize(kind, size);
        expect(Math.floor(w)).toBe(kind);
        expect((w - Math.floor(w)) * 2).toBeCloseTo(Math.min(size, 0.999), 6);
      }
    }
    // 範囲外は安全にクランプ(kind が汚染されない)
    expect(Math.floor(packKindSize(0, 1.5))).toBe(0);
    expect(Math.floor(packKindSize(1, -1))).toBe(1);
  });

  it('クラウン 40〜80 / 膜片 20〜40(strength 比例・有界)', () => {
    expect(crownCount(0)).toBe(40);
    expect(crownCount(1)).toBe(80);
    expect(crownCount(2)).toBe(80);
    expect(membraneCount(0)).toBe(20);
    expect(membraneCount(1)).toBe(40);
    expect(crownCount(0.5)).toBeGreaterThan(40);
    expect(crownCount(0.5)).toBeLessThan(80);
  });

  it('mulberry32 は決定論・[0,1) 有界', () => {
    const a = mulberry32(hashSeed(120, 3, 42));
    const b = mulberry32(hashSeed(120, 3, 42));
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    // シードが違えば列も違う
    const c = mulberry32(hashSeed(121, 3, 42));
    expect(c()).not.toBe(mulberry32(hashSeed(120, 3, 42))());
  });
});
