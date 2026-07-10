import { describe, expect, it } from 'vitest';
import { accumulate } from '../../src/app/accumulator';

const STEP_MS = 1000 / 60;

describe('accumulate(純関数アキュムレータ)', () => {
  it('60Hz 入力では毎フレーム 1 step', () => {
    let remainder = 0;
    for (let i = 0; i < 100; i++) {
      const result = accumulate(remainder, 1000 / 60);
      expect(result.steps).toBe(1);
      remainder = result.remainder;
    }
  });

  it('120Hz 入力では 0/1 step が交互(世界速度は壁時計に一致)', () => {
    let remainder = 0;
    let total = 0;
    const stepsSeen: number[] = [];
    for (let i = 0; i < 100; i++) {
      const result = accumulate(remainder, 1000 / 120);
      stepsSeen.push(result.steps);
      total += result.steps;
      remainder = result.remainder;
    }
    // 100 フレーム × 8.33ms = 833ms → 50 step
    expect(total).toBe(50);
    expect(stepsSeen.every((s) => s === 0 || s === 1)).toBe(true);
    expect(stepsSeen[0]).toBe(0);
    expect(stepsSeen[1]).toBe(1);
  });

  it('250ms スパイクは 3 step に打ち切り、残余は破棄する', () => {
    const result = accumulate(0, 250);
    expect(result.steps).toBe(3);
    expect(result.remainder).toBe(0);
    expect(result.alpha).toBe(0);
  });

  it('ちょうど MAX 境界(3 step 分)は破棄しない', () => {
    const result = accumulate(0, STEP_MS * 3 + 1);
    expect(result.steps).toBe(3);
    expect(result.remainder).toBeCloseTo(1, 10);
  });

  it('alpha は常に [0, 1)', () => {
    let remainder = 0;
    for (let i = 0; i < 500; i++) {
      const dt = (i % 7) * 3.9; // 0〜23.4ms の不規則なフレーム
      const result = accumulate(remainder, dt);
      expect(result.alpha).toBeGreaterThanOrEqual(0);
      expect(result.alpha).toBeLessThan(1);
      expect(result.alpha).toBeCloseTo(result.remainder / STEP_MS, 12);
      remainder = result.remainder;
    }
  });

  it('負の dt は 0 として扱う', () => {
    const result = accumulate(5, -100);
    expect(result.steps).toBe(0);
    expect(result.remainder).toBe(5);
  });
});
