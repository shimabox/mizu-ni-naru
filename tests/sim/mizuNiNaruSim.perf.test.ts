import { describe, expect, it } from 'vitest';
import { MizuNiNaruSim } from '../../src/sim/MizuNiNaruSim';

/**
 * perf トリップワイヤ(§7.3 / §8 — 位置づけの知見: Mizu-threejs の perf テスト)。
 * 予算は ≈0.06 ms/step(§8.2)。ここでは CI 変動に対し 2 桁寛大な上限を張る —
 * 落ちたら「アロケーションによる GC スパイク」か経路の事故を疑う。
 * CI ゲートの厳密な性能測定には使わない。
 */
describe('MizuNiNaruSim perf(トリップワイヤ)', () => {
  it('12 球 × 3000 step が寛大な上限(3000ms = 1ms/step)以内', () => {
    const sim = new MizuNiNaruSim();
    sim.init({ seed: 7, slotCount: 12 });
    // ウォームアップ(JIT)
    for (let s = 0; s < 300; s++) sim.step();
    const t0 = performance.now();
    for (let s = 0; s < 3000; s++) sim.step();
    const elapsed = performance.now() - t0;
    // 実測はこの 1/50 以下のはず(参照: threejs 9,000 体 ≈2.5ms/step)
    expect(elapsed).toBeLessThan(3000);
    expect(sim.counts().h).toBeGreaterThan(0); // 空虚テスト防止
  });
});
