import { describe, expect, it } from 'vitest';
import {
  AdaptiveQuality,
  DISTURBANCE_MS,
  DOWN_STREAK_FRAMES,
  DOWN_THRESHOLD_MS,
  UP_STREAK_FRAMES,
  UP_THRESHOLD_MS,
  applyTierDecision,
  createEmaState,
  decideTierChange,
  updateEma,
} from '../../src/render/AdaptiveQuality';

describe('updateEma', () => {
  it('α=0.1 の指数移動平均で dtMs へ追従する', () => {
    let state = createEmaState(16.67);
    state = updateEma(state, 16.67);
    expect(state.ema).toBeCloseTo(16.67, 5);

    // 30ms を1回食わせると EMA は 0.1 だけ動く
    const before = state.ema;
    state = updateEma(state, 30);
    expect(state.ema).toBeCloseTo(before + 0.1 * (30 - before), 6);
  });

  it('EMA が閾値を上回っている間 downStreak が増加する', () => {
    let state = createEmaState(20); // 既に閾値超
    for (let i = 1; i <= 5; i++) {
      state = updateEma(state, 20);
      expect(state.ema).toBeGreaterThan(DOWN_THRESHOLD_MS);
      expect(state.downStreak).toBe(i);
      expect(state.upStreak).toBe(0);
    }
  });

  it('EMA が閾値を下回っている間 upStreak が増加する', () => {
    let state = createEmaState(8);
    for (let i = 1; i <= 5; i++) {
      state = updateEma(state, 8);
      expect(state.ema).toBeLessThan(UP_THRESHOLD_MS);
      expect(state.upStreak).toBe(i);
      expect(state.downStreak).toBe(0);
    }
  });

  it('外乱(dtMs > 250ms)は EMA を更新せずストリークだけ破棄する', () => {
    let state = createEmaState(20);
    for (let i = 0; i < 5; i++) state = updateEma(state, 20);
    expect(state.downStreak).toBe(5);
    const emaBefore = state.ema;

    state = updateEma(state, DISTURBANCE_MS + 1);
    expect(state.ema).toBe(emaBefore); // EMA 据え置き
    expect(state.downStreak).toBe(0);
    expect(state.upStreak).toBe(0);
  });

  it('中間帯(11ms〜15ms)ではどちらのストリークも増えない', () => {
    let state = createEmaState(13);
    state = updateEma(state, 13);
    expect(state.downStreak).toBe(0);
    expect(state.upStreak).toBe(0);
  });
});

describe('decideTierChange', () => {
  it('downStreak が閾値未満なら none', () => {
    const state = { ema: 20, downStreak: DOWN_STREAK_FRAMES - 1, upStreak: 0 };
    expect(decideTierChange(state)).toBe('none');
  });

  it('downStreak が閾値に達すると down', () => {
    const state = { ema: 20, downStreak: DOWN_STREAK_FRAMES, upStreak: 0 };
    expect(decideTierChange(state)).toBe('down');
  });

  it('upStreak が閾値未満なら none', () => {
    const state = { ema: 8, downStreak: 0, upStreak: UP_STREAK_FRAMES - 1 };
    expect(decideTierChange(state)).toBe('none');
  });

  it('upStreak が閾値に達すると up', () => {
    const state = { ema: 8, downStreak: 0, upStreak: UP_STREAK_FRAMES };
    expect(decideTierChange(state)).toBe('up');
  });
});

describe('applyTierDecision', () => {
  it('down はティアを+1(4 でクランプ)', () => {
    expect(applyTierDecision(0, 'down')).toBe(1);
    expect(applyTierDecision(4, 'down')).toBe(4);
  });

  it('up はティアを-1(0 でクランプ)', () => {
    expect(applyTierDecision(4, 'up')).toBe(3);
    expect(applyTierDecision(0, 'up')).toBe(0);
  });

  it('none はティア不変', () => {
    expect(applyTierDecision(2, 'none')).toBe(2);
  });
});

describe('AdaptiveQuality クラス(統合的な状態機械テスト)', () => {
  it('構築時に initialTier でコールバックを1回呼ぶ', () => {
    const calls: number[] = [];
    new AdaptiveQuality(2, (t) => calls.push(t));
    expect(calls).toEqual([2]);
  });

  it('持続的に重い(20ms)フレームが続くと 30 フレーム目でティアが1段悪化する', () => {
    const calls: number[] = [];
    const aq = new AdaptiveQuality(0, (t) => calls.push(t));
    for (let i = 0; i < 29; i++) aq.update(20);
    expect(aq.currentTier).toBe(0);
    aq.update(20);
    expect(aq.currentTier).toBe(1);
    expect(calls).toEqual([0, 1]);
  });

  it('持続的に軽い(8ms)フレームが十分続くとティアが1段改善する(初期 EMA の収束分を見込んだ余裕フレーム数で検証)', () => {
    const aq = new AdaptiveQuality(2, () => {});
    // 初期 EMA(≈16.67ms)が 8ms へ収束し 11ms を下回るまで ~11 フレームかかる
    // (updateEma の指数追従 — 別テストで検証済み)。UP_STREAK_FRAMES(600)に
    // その収束分の余裕を足した回数まではまだ改善しないことを確認する。
    for (let i = 0; i < UP_STREAK_FRAMES; i++) aq.update(8);
    expect(aq.currentTier).toBe(2);
    // 収束分(余裕 20 フレーム)を足せば確実に閾値へ到達している
    for (let i = 0; i < 20; i++) aq.update(8);
    expect(aq.currentTier).toBe(1);
  });

  it('外乱フレームはストリークをリセットし誤発火しない', () => {
    const aq = new AdaptiveQuality(0, () => {});
    for (let i = 0; i < 29; i++) aq.update(20);
    aq.update(DISTURBANCE_MS + 100); // 外乱 — ストリーク破棄
    for (let i = 0; i < 29; i++) aq.update(20);
    expect(aq.currentTier).toBe(0); // まだ 30 連続に達していない
    aq.update(20);
    expect(aq.currentTier).toBe(1);
  });

  it('tier0 では down しない(既に最悪ではなく最高品質固定の意味ではなく、単に上限クランプ確認)', () => {
    const aq = new AdaptiveQuality(4, () => {});
    for (let i = 0; i < 40; i++) aq.update(20);
    expect(aq.currentTier).toBe(4); // 4 が下限(最低品質)でクランプ
  });
});
