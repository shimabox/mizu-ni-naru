import { describe, expect, it } from 'vitest';
import {
  CAP_LUT_ENDPOINT_F as CONFIG_ENDPOINT_F,
  CAP_LUT_SIZE as CONFIG_LUT_SIZE,
} from '../../../src/sim/config';
import {
  CAP_LUT_ENDPOINT_F,
  CAP_LUT_SIZE,
  capF,
  capU,
  capUExact,
} from '../../../src/sim/core/CapLut';

describe('CapLut(球冠体積 ↔ 水位 — §4.2)', () => {
  it('config の文書化ミラーと実体が一致する(sim-core-is-base の代償の固定)', () => {
    expect(CAP_LUT_SIZE).toBe(CONFIG_LUT_SIZE);
    expect(CAP_LUT_ENDPOINT_F).toBe(CONFIG_ENDPOINT_F);
  });

  it('オラクル(三角閉形式)の検算: f=0 → u=0、f=1/2 → u=1/2、f=1 → u=1', () => {
    expect(capUExact(0)).toBeCloseTo(0, 12);
    expect(capUExact(0.5)).toBeCloseTo(0.5, 12);
    expect(capUExact(1)).toBeCloseTo(1, 12);
  });

  it('オラクルは順方向 f = 3u² − 2u³ の真の逆関数(往復一致)', () => {
    for (let i = 0; i <= 100; i++) {
      const u = i / 100;
      expect(capUExact(capF(u))).toBeCloseTo(u, 6);
    }
  });

  it('全域掃引(10⁻⁴ 刻み): 中央域 |u_lut − u_exact| ≤ 5×10⁻⁴', () => {
    for (let i = 0; i <= 10000; i++) {
      const f = i / 10000;
      if (f < CAP_LUT_ENDPOINT_F || f > 1 - CAP_LUT_ENDPOINT_F) continue;
      expect(Math.abs(capU(f) - capUExact(f))).toBeLessThanOrEqual(5e-4);
    }
  });

  it('端点帯(f < 1/64、f > 63/64): |u_lut − u_exact| ≤ 2×10⁻³', () => {
    for (let i = 0; i <= 2000; i++) {
      const f = (i / 2000) * CAP_LUT_ENDPOINT_F;
      expect(Math.abs(capU(f) - capUExact(f))).toBeLessThanOrEqual(2e-3);
      expect(Math.abs(capU(1 - f) - capUExact(1 - f))).toBeLessThanOrEqual(
        2e-3,
      );
    }
  });

  it('往復 f(u(f)) の整合(全域 ≤ 2×10⁻³)', () => {
    for (let i = 0; i <= 1000; i++) {
      const f = i / 1000;
      expect(Math.abs(capF(capU(f)) - f)).toBeLessThanOrEqual(2e-3);
    }
  });

  it('単調非減少(水位単調の土台)', () => {
    let prev = -1;
    for (let i = 0; i <= 4096; i++) {
      const u = capU(i / 4096);
      expect(u).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = u;
    }
  });

  it('範囲外はクランプ(f<0 → 0、f>1 → 1)', () => {
    expect(capU(-0.5)).toBe(0);
    expect(capU(1.5)).toBe(1);
    expect(capUExact(-1)).toBeCloseTo(0, 12);
    expect(capUExact(2)).toBeCloseTo(1, 12);
  });
});
