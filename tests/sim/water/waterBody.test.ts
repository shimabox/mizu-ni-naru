import { describe, expect, it } from 'vitest';
import { WATER_EASE_K } from '../../../src/sim/config';
import { capUExact } from '../../../src/sim/core/CapLut';
import { WaterBody } from '../../../src/sim/water/WaterBody';

const R_INNER = 1.316;
const V_INNER = (4 / 3) * Math.PI * R_INNER ** 3;

describe('WaterBody(体積台帳 — §4.3、A53 二層化)', () => {
  it('reset(rInner, 0) で fill01=0、waterY = −R_inner(底)', () => {
    const w = new WaterBody();
    w.reset(R_INNER, 0);
    expect(w.fill01).toBe(0);
    expect(w.waterY).toBeCloseTo(-R_INNER, 6);
  });

  it('初期 fill(起動スタッガー)が体積に反映される(V_eased = V_ledger で即座初期化)', () => {
    const w = new WaterBody();
    w.reset(R_INNER, 0.5);
    expect(w.fill01).toBeCloseTo(0.5, 6);
    expect(w.ledgerFill01).toBeCloseTo(0.5, 6);
    // f=1/2 → u=1/2 → waterY = 0(大円)
    expect(w.waterY).toBeCloseTo(0, 6);
  });

  it('addVolume は commit まで水位(台帳・表示とも)を動かさない(step 内一貫性)', () => {
    const w = new WaterBody();
    w.reset(R_INNER, 0.2);
    const before = w.waterY;
    const beforeLedgerFill = w.ledgerFill01;
    w.addVolume(0.5);
    expect(w.waterY).toBe(before);
    expect(w.fill01).toBeCloseTo(0.2, 6);
    expect(w.ledgerFill01).toBeCloseTo(beforeLedgerFill, 6);
    w.commit();
    expect(w.waterY).toBeGreaterThan(before);
  });

  it('V_ledger は commit で即時反映(質量保存の正)、V_eased(fill01)は 1 step では僅かにしか動かない(A53)', () => {
    const w = new WaterBody();
    w.reset(R_INNER, 0);
    w.addVolume(0.3 * V_INNER);
    w.commit();
    // 台帳は即座に確定
    expect(w.ledgerFill01).toBeCloseTo(0.3, 5);
    // 表示水位は 1 step で目標(0.3)の WATER_EASE_K 分しか動いていない
    // (階段状の即時ジャンプにならないことがこのテストの主旨)
    expect(w.fill01).toBeCloseTo(0.3 * WATER_EASE_K, 5);
    expect(w.fill01).toBeLessThan(0.3 * 0.2); // 目標の 2 割未満(明確に漸近中)
  });

  it('V_eased は複数 step かけて V_ledger(目標)に漸近する(§4.3 — 指数追従)', () => {
    const w = new WaterBody();
    w.reset(R_INNER, 0);
    w.addVolume(0.3 * V_INNER);
    w.commit(); // 段 6 相当: 台帳は 1 回だけ即時加算、以降は追従のみ
    for (let i = 0; i < 500; i++) {
      w.commit(); // pending=0 だが V_eased がまだ V_ledger 未満なので追従が進む
    }
    expect(w.ledgerFill01).toBeCloseTo(0.3, 5);
    expect(w.fill01).toBeCloseTo(0.3, 4); // 十分な step 数で目標へ収束
  });

  it('雫 1 粒吸収相当(fill01 0.9%)後、水位が 1 step でジャンプせず漸近する' +
    '(10 step 後で目標の約 24%、60 step 後で約 80%)', () => {
    const w = new WaterBody();
    w.reset(R_INNER, 0);
    const dropletFill = 0.009; // design-sim §5.5: 雫 1 粒 ≈ V_inner の 0.92%
    w.addVolume(dropletFill * V_INNER);
    w.commit(); // 1 step 目: 台帳確定 + 追従 1 回分
    // 1 step 目は台帳確定直後の追従 1 回分のみ — カクッと満額には決して届かない
    expect(w.fill01).toBeLessThan(dropletFill * 0.1);
    for (let i = 1; i < 10; i++) w.commit();
    expect(w.fill01 / dropletFill).toBeGreaterThan(0.2);
    expect(w.fill01 / dropletFill).toBeLessThan(0.3);
    for (let i = 10; i < 60; i++) w.commit();
    expect(w.fill01 / dropletFill).toBeGreaterThan(0.75);
    expect(w.fill01 / dropletFill).toBeLessThan(0.85);
  });

  it('fill01 = V_eased / V_inner(分母は内殻 — 裁定 A12。十分収束後に検証)', () => {
    const w = new WaterBody();
    w.reset(R_INNER, 0);
    w.addVolume(0.3 * V_INNER);
    for (let i = 0; i < 400; i++) w.commit();
    expect(w.fill01).toBeCloseTo(0.3, 5);
  });

  it('waterY = (2·u(fill01) − 1)·R_inner(オラクル一致。十分収束後に検証)', () => {
    const w = new WaterBody();
    w.reset(R_INNER, 0);
    w.addVolume(0.37 * V_INNER);
    for (let i = 0; i < 400; i++) w.commit();
    expect(w.waterY).toBeCloseTo((2 * capUExact(0.37) - 1) * R_INNER, 3);
  });

  it('単調非減少: 加算を繰り返す限り fill01 / waterY(台帳・表示とも)は下がらない(§7.3)', () => {
    const w = new WaterBody();
    w.reset(R_INNER, 0);
    let prevFill = w.fill01;
    let prevY = w.waterY;
    let prevLedgerFill = w.ledgerFill01;
    for (let i = 0; i < 200; i++) {
      w.addVolume(0.03);
      w.commit();
      expect(w.fill01).toBeGreaterThanOrEqual(prevFill);
      expect(w.waterY).toBeGreaterThanOrEqual(prevY);
      expect(w.ledgerFill01).toBeGreaterThanOrEqual(prevLedgerFill);
      prevFill = w.fill01;
      prevY = w.waterY;
      prevLedgerFill = w.ledgerFill01;
    }
  });

  it('fill01 は 1 でクランプされる(waterY ≤ +R_inner、十分な step 数で収束)', () => {
    const w = new WaterBody();
    w.reset(R_INNER, 0);
    w.addVolume(V_INNER * 3);
    for (let i = 0; i < 400; i++) w.commit();
    expect(w.fill01).toBe(1);
    expect(w.waterY).toBeCloseTo(R_INNER, 6);
    expect(w.ledgerFill01).toBe(1); // 台帳基準も V_inner でクランプ
  });

  it('決定論: 同じ加算列を与えれば同じ fill01/waterY の軌跡になる(RNG 非使用)', () => {
    const runTrajectory = (): number[] => {
      const w = new WaterBody();
      w.reset(R_INNER, 0.1);
      const trace: number[] = [];
      for (let i = 0; i < 50; i++) {
        if (i % 7 === 0) w.addVolume(0.01 * V_INNER);
        w.commit();
        trace.push(w.fill01);
      }
      return trace;
    };
    expect(runTrajectory()).toEqual(runTrajectory());
  });

  it('pending ゼロ & 追従済みの commit は何もしない(再計算スキップ)', () => {
    const w = new WaterBody();
    w.reset(R_INNER, 0.4);
    const f = w.fill01;
    const y = w.waterY;
    w.commit();
    expect(w.fill01).toBe(f);
    expect(w.waterY).toBe(y);
  });
});
