import { describe, expect, it } from 'vitest';
import { capUExact } from '../../../src/sim/core/CapLut';
import { WaterBody } from '../../../src/sim/water/WaterBody';

const R_INNER = 1.316;
const V_INNER = (4 / 3) * Math.PI * R_INNER ** 3;

describe('WaterBody(体積台帳 — §4.3)', () => {
  it('reset(rInner, 0) で fill01=0、waterY = −R_inner(底)', () => {
    const w = new WaterBody();
    w.reset(R_INNER, 0);
    expect(w.fill01).toBe(0);
    expect(w.waterY).toBeCloseTo(-R_INNER, 6);
  });

  it('初期 fill(起動スタッガー)が体積に反映される', () => {
    const w = new WaterBody();
    w.reset(R_INNER, 0.5);
    expect(w.fill01).toBeCloseTo(0.5, 6);
    // f=1/2 → u=1/2 → waterY = 0(大円)
    expect(w.waterY).toBeCloseTo(0, 6);
  });

  it('addVolume は commit まで水位を動かさない(step 内一貫性)', () => {
    const w = new WaterBody();
    w.reset(R_INNER, 0.2);
    const before = w.waterY;
    w.addVolume(0.5);
    expect(w.waterY).toBe(before);
    expect(w.fill01).toBeCloseTo(0.2, 6);
    w.commit();
    expect(w.waterY).toBeGreaterThan(before);
  });

  it('fill01 = V_water / V_inner(分母は内殻 — 裁定 A12)', () => {
    const w = new WaterBody();
    w.reset(R_INNER, 0);
    w.addVolume(0.3 * V_INNER);
    w.commit();
    expect(w.fill01).toBeCloseTo(0.3, 5);
  });

  it('waterY = (2·u(fill01) − 1)·R_inner(オラクル一致)', () => {
    const w = new WaterBody();
    w.reset(R_INNER, 0);
    w.addVolume(0.37 * V_INNER);
    w.commit();
    expect(w.waterY).toBeCloseTo((2 * capUExact(0.37) - 1) * R_INNER, 3);
  });

  it('単調非減少: 加算を繰り返す限り fill01 / waterY は下がらない(§7.3)', () => {
    const w = new WaterBody();
    w.reset(R_INNER, 0);
    let prevFill = w.fill01;
    let prevY = w.waterY;
    for (let i = 0; i < 200; i++) {
      w.addVolume(0.03);
      w.commit();
      expect(w.fill01).toBeGreaterThanOrEqual(prevFill);
      expect(w.waterY).toBeGreaterThanOrEqual(prevY);
      prevFill = w.fill01;
      prevY = w.waterY;
    }
  });

  it('fill01 は 1 でクランプされる(waterY ≤ +R_inner)', () => {
    const w = new WaterBody();
    w.reset(R_INNER, 0);
    w.addVolume(V_INNER * 3);
    w.commit();
    expect(w.fill01).toBe(1);
    expect(w.waterY).toBeCloseTo(R_INNER, 6);
  });

  it('pending ゼロの commit は何もしない(再計算スキップ)', () => {
    const w = new WaterBody();
    w.reset(R_INNER, 0.4);
    const f = w.fill01;
    const y = w.waterY;
    w.commit();
    expect(w.fill01).toBe(f);
    expect(w.waterY).toBe(y);
  });
});
