import { describe, expect, it } from 'vitest';
import { SLOT_COUNT_DESKTOP } from '../../src/contract/WorldSpec';
import { MizuNiNaruSim } from '../../src/sim/MizuNiNaruSim';

/**
 * perf トリップワイヤ(§7.3 / §8 — 位置づけの知見: Mizu-threejs の perf テスト)。
 * design-sim §7.3 の位置づけ通り「寛大な上限のトリップワイヤ」であり、
 * CI ゲート(マージブロック条件)にはしない — 落ちたら「アロケーションによる
 * GC スパイク」か経路の事故を疑う調査の起点として使う。
 *
 * 96 球(A35 = desktop 実構成)での実測は ≈0.59ms/step。ここでは負荷のある
 * CI 環境でもトリップしないよう、実測の 8 倍超の余裕を見て 5ms/step を
 * 上限とする(3000 step ⇒ 15,000ms)。
 */
describe('MizuNiNaruSim perf(トリップワイヤ・CI ゲートにしない)', () => {
  it('96 球 × 3000 step が寛大な上限(15,000ms = 5ms/step)以内', () => {
    const sim = new MizuNiNaruSim();
    sim.init({ seed: 7, slotCount: SLOT_COUNT_DESKTOP });
    // ウォームアップ(JIT)
    for (let s = 0; s < 300; s++) sim.step();
    const t0 = performance.now();
    for (let s = 0; s < 3000; s++) sim.step();
    const elapsed = performance.now() - t0;
    // 実測はこの 1/8 以下のはず(≈0.59ms/step、96 球構成)
    expect(elapsed).toBeLessThan(15_000);
    expect(sim.counts().h).toBeGreaterThan(0); // 空虚テスト防止
  }, 30_000);
});
