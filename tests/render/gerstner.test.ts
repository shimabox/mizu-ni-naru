import { describe, expect, it } from 'vitest';
import {
  GERSTNER_VERTEX_WAVES,
  GERSTNER_WAVES,
  GERSTNER_WAVE_COUNT,
  SWELL_AMP_SUM_VERTEX,
  gerstnerPhaseRate,
  gerstnerSteepnessSum,
} from '../../src/render/shaders/gerstner';

describe('Gerstner 波テーブル(design-render §2.1)', () => {
  it('8 成分・頂点変位は 5 波', () => {
    expect(GERSTNER_WAVE_COUNT).toBe(8);
    expect(GERSTNER_VERTEX_WAVES).toBe(5);
  });

  it('ループ防止条件: Σ Q·w·A < 1(設計値 ≈ 0.49)', () => {
    const sum = gerstnerSteepnessSum();
    expect(sum).toBeLessThan(1);
    expect(sum).toBeCloseTo(0.49, 1);
  });

  it('分散関係 φ̇ = √(g_eff·w)(テーブルの設計値と一致)', () => {
    const expected = [0.97, 1.17, 1.52, 1.9, 2.41, 3.07, 3.88, 4.93];
    GERSTNER_WAVES.forEach((wave, i) => {
      expect(gerstnerPhaseRate(wave.lambda)).toBeCloseTo(expected[i], 1);
    });
  });

  it('頂点振幅和 = 0.35u(球の底 y ≥ 1.1 と交差しない)', () => {
    expect(SWELL_AMP_SUM_VERTEX).toBeCloseTo(0.35, 5);
    expect(SWELL_AMP_SUM_VERTEX * 1.15).toBeLessThan(1.1); // 呼吸 +15% 込み
  });
});
