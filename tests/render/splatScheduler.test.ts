import { describe, expect, it } from 'vitest';
import {
  SPLASH_QUAD_RADIUS_SCALE,
  SPLASH_RING_R0,
  SPLAT_OUT_STRIDE,
  SUB_SPLAT_JITTER_RATIO,
  SUB_SPLAT_STEP_OFFSETS,
  SUB_SPLAT_STRENGTH_SCALE,
  SplatScheduler,
  splatJitter01,
} from '../../src/render/ocean/SplatScheduler';

const OUT = new Float32Array(64 * SPLAT_OUT_STRIDE);

describe('SplatScheduler', () => {
  it('addSplash は主スプラット + 遅延サブスプラット 3 発に展開する', () => {
    const q = new SplatScheduler();
    q.addSplash(100, 2, -3, 1.4, 0.8);
    expect(q.size).toBe(4);

    // step 100: 主スプラットのみ期日到来
    let n = q.collectDue(100, OUT, 64);
    expect(n).toBe(1);
    expect(OUT[0]).toBe(2); // x
    expect(OUT[1]).toBe(-3); // z
    expect(OUT[2]).toBeCloseTo(1.4 * SPLASH_QUAD_RADIUS_SCALE);
    expect(OUT[3]).toBeCloseTo(0.8);
    expect(OUT[4]).toBeCloseTo(SPLASH_RING_R0);
    expect(OUT[5]).toBe(1); // 刻印 tint は主スプラットのみ

    // +8 / +14 / +22 step で順に到来、強度 ×0.4 / 0.25 / 0.15
    for (let k = 0; k < 3; k++) {
      const due = 100 + SUB_SPLAT_STEP_OFFSETS[k];
      expect(q.collectDue(due - 1, OUT, 64)).toBe(0);
      n = q.collectDue(due, OUT, 64);
      expect(n).toBe(1);
      expect(OUT[3]).toBeCloseTo(0.8 * SUB_SPLAT_STRENGTH_SCALE[k]);
      expect(OUT[5]).toBe(0); // サブに刻印なし
      // 位置ジッタは ±0.3R 以内
      expect(Math.abs(OUT[0] - 2)).toBeLessThanOrEqual(
        SUB_SPLAT_JITTER_RATIO * 1.4 + 1e-6,
      );
      expect(Math.abs(OUT[1] - -3)).toBeLessThanOrEqual(
        SUB_SPLAT_JITTER_RATIO * 1.4 + 1e-6,
      );
    }
    expect(q.size).toBe(0);
  });

  it('複数イベント + マイクロスプラットが期日順に混在して取り出せる', () => {
    const q = new SplatScheduler();
    q.addSplash(10, 0, 0, 1.2, 1);
    q.addMicroSplat(15, 3, 4, 0.06);
    q.addSplash(12, 5, 5, 1.6, 0.5);
    expect(q.size).toBe(9);

    // step 15 で: 主×2(due 10, 12)+ micro(15)+ サブ due 18 以下なし
    const n = q.collectDue(15, OUT, 64);
    expect(n).toBe(3);
    expect(q.size).toBe(6);
    // 残り全部は step 34(12+22)までに掃ける
    expect(q.collectDue(34, OUT, 64)).toBe(6);
    expect(q.size).toBe(0);
  });

  it('maxOut で打ち切っても残りは失われない', () => {
    const q = new SplatScheduler();
    for (let i = 0; i < 8; i++) {
      q.addMicroSplat(1, i, 0, 0.05);
    }
    expect(q.collectDue(1, OUT, 3)).toBe(3);
    expect(q.size).toBe(5);
    expect(q.collectDue(1, OUT, 64)).toBe(5);
    expect(q.size).toBe(0);
  });

  it('容量超過は黙って捨てる(クラッシュしない)', () => {
    const q = new SplatScheduler(8);
    for (let i = 0; i < 5; i++) {
      q.addSplash(0, i, i, 1.2, 1); // 4 エントリ × 5 = 20 > 8
    }
    expect(q.size).toBe(8);
  });

  it('ジッタは決定論(同一イベント → 同一値)かつ [0,1) に有界', () => {
    for (let k = 0; k < 6; k++) {
      const a = splatJitter01(1.5, -2.5, 0.7, k);
      const b = splatJitter01(1.5, -2.5, 0.7, k);
      expect(a).toBe(b);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(1);
    }
  });
});
