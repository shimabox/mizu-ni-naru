import { describe, expect, it } from 'vitest';
import { summarizeDistribution } from '../../src/app/PerformanceProbe';

describe('summarizeDistribution', () => {
  it('sampleなしは全フィールド0を返す', () => {
    expect(summarizeDistribution([])).toEqual({
      count: 0,
      min: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
      mean: 0,
    });
  });

  it('入力を変更せずnearest-rank分位点を計算する', () => {
    const samples = [4, 1, 5, 2, 3];
    expect(summarizeDistribution(samples)).toEqual({
      count: 5,
      min: 1,
      p50: 3,
      p95: 5,
      p99: 5,
      max: 5,
      mean: 3,
    });
    expect(samples).toEqual([4, 1, 5, 2, 3]);
  });
});
