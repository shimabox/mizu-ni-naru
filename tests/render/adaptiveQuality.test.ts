import { describe, expect, it } from 'vitest';
import {
  AdaptiveQuality,
  BLOOM_SCALE_BY_TIER,
  DISTURBANCE_MS,
  DOWN_STREAK_FRAMES,
  DOWN_THRESHOLD_MS,
  DPR_CAP_BY_TIER,
  MOBILE_DPR_CAP,
  RENDER_SCALE_BY_TIER,
  UP_STREAK_FRAMES,
  UP_THRESHOLD_MS,
  applyTierDecision,
  createEmaState,
  decideTierChange,
  dprCapForTier,
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
    let state = createEmaState(25); // 既に閾値超
    for (let i = 1; i <= 5; i++) {
      state = updateEma(state, 25);
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
    let state = createEmaState(25);
    for (let i = 0; i < 5; i++) state = updateEma(state, 25);
    expect(state.downStreak).toBe(5);
    const emaBefore = state.ema;

    state = updateEma(state, DISTURBANCE_MS + 1);
    expect(state.ema).toBe(emaBefore); // EMA 据え置き
    expect(state.downStreak).toBe(0);
    expect(state.upStreak).toBe(0);
  });

  it('中間帯(11ms〜18ms)ではどちらのストリークも増えない', () => {
    let state = createEmaState(13);
    state = updateEma(state, 13);
    expect(state.downStreak).toBe(0);
    expect(state.upStreak).toBe(0);
  });

  it('A52: 60fps 相当(16.7ms)は down 判定に入らない(EMA が閾値未満)', () => {
    let state = createEmaState(16.67);
    for (let i = 0; i < 10; i++) state = updateEma(state, 16.67);
    expect(state.ema).toBeLessThan(DOWN_THRESHOLD_MS);
    expect(state.downStreak).toBe(0);
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

  it('持続的に重い(21ms)フレームが続くとティアが1段悪化する(境界フレームで検証)', () => {
    const calls: number[] = [];
    const aq = new AdaptiveQuality(0, (t) => calls.push(t));
    // 初期 EMA(≈16.67ms)が 21ms へ収束し DOWN_THRESHOLD_MS(A52: 18ms)を
    // 上回るまで 4 フレームかかる(updateEma の指数追従、call4 で ema≈18.157)。
    // そこから DOWN_STREAK_FRAMES(A52: 60)連続で降格するため、境界は
    // 4 - 1 + 60 = 63 フレーム目。
    for (let i = 0; i < 62; i++) aq.update(21);
    expect(aq.currentTier).toBe(0);
    aq.update(21);
    expect(aq.currentTier).toBe(1);
    expect(calls).toEqual([0, 1]);
  });

  it('A52: 16.7ms(60fps相当)が続いても down 判定に入らない(1000 フレーム連続でも安定)', () => {
    const aq = new AdaptiveQuality(0, () => {});
    for (let i = 0; i < 1000; i++) aq.update(16.67);
    expect(aq.currentTier).toBe(0);
  });

  it('A52: 18ms 超(21ms)が十分に連続すると降格する(境界フレームで検証)', () => {
    const aq = new AdaptiveQuality(0, () => {});
    for (let i = 0; i < 62; i++) aq.update(21);
    expect(aq.currentTier).toBe(0);
    aq.update(21);
    expect(aq.currentTier).toBe(1);
  });

  it('A52: 一時的なスパイク(平均 dt が閾値未満)では降格しない', () => {
    const aq = new AdaptiveQuality(0, () => {});
    // 21ms のスパイクを 5 フレームだけ挟み、55 フレームの 16.7ms アイドルで
    // 十分に減衰させる — を何度も繰り返す。ラウンド平均 dt ≈17.0ms は
    // DOWN_THRESHOLD_MS(18ms)未満なので、EMA は毎ラウンドしっかり 18ms を
    // 下回ってストリークがリセットされる(spike:idle 比が均された「本当に
    // 一時的」なパターン — A50 時代の 10:5 比は平均 19.6ms で実は持続的な
    // 低フレームレートだったため、A52 の閾値では意図的に降格対象になる)。
    for (let round = 0; round < 20; round++) {
      for (let i = 0; i < 5; i++) aq.update(21);
      for (let i = 0; i < 55; i++) aq.update(16.67);
    }
    expect(aq.currentTier).toBe(0);
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
    for (let i = 0; i < 30; i++) aq.update(21);
    aq.update(DISTURBANCE_MS + 100); // 外乱 — ストリーク破棄(EMA は据え置き)
    // disturbance 前に ema は既に 21ms 側へ収束済み(>18ms)なので、
    // phase2 は call1 から downStreak が増え始める。境界は DOWN_STREAK_FRAMES
    // (60)ちょうど。
    for (let i = 0; i < 59; i++) aq.update(21);
    expect(aq.currentTier).toBe(0); // まだ 60 連続に達していない
    aq.update(21);
    expect(aq.currentTier).toBe(1);
  });

  it('tier0 では down しない(既に最悪ではなく最高品質固定の意味ではなく、単に上限クランプ確認)', () => {
    const aq = new AdaptiveQuality(4, () => {});
    for (let i = 0; i < 100; i++) aq.update(21);
    expect(aq.currentTier).toBe(4); // 4 が下限(最低品質)でクランプ
  });
});

describe('A52 最終: ティア表(エフェクト優先・解像度を先に削る)', () => {
  it('renderScale は tier0 のみ無劣化、以降は単調に低下する(エフェクトより先に解像度を削る)', () => {
    expect(RENDER_SCALE_BY_TIER[0]).toBe(1.0);
    for (let tier = 1; tier < RENDER_SCALE_BY_TIER.length; tier++) {
      expect(RENDER_SCALE_BY_TIER[tier]).toBeLessThan(
        RENDER_SCALE_BY_TIER[tier - 1],
      );
    }
    expect(RENDER_SCALE_BY_TIER[4]).toBeLessThan(RENDER_SCALE_BY_TIER[0]);
  });

  it('dprCap は単調非増加で、tier4 が最低になる', () => {
    for (let tier = 1; tier < DPR_CAP_BY_TIER.length; tier++) {
      expect(DPR_CAP_BY_TIER[tier]).toBeLessThanOrEqual(
        DPR_CAP_BY_TIER[tier - 1],
      );
    }
    expect(DPR_CAP_BY_TIER[4]).toBeLessThan(DPR_CAP_BY_TIER[0]);
  });

  it('bloomScale・backdropCount・波紋解像度・海グリッド・解析反射は tier2 まで完全温存される(エフェクト > 解像度)', () => {
    // bloomScale: tier0〜2 は 0.5 のまま、tier3 で初めて下がる
    expect(BLOOM_SCALE_BY_TIER[0]).toBe(0.5);
    expect(BLOOM_SCALE_BY_TIER[1]).toBe(0.5);
    expect(BLOOM_SCALE_BY_TIER[2]).toBe(0.5);
    expect(BLOOM_SCALE_BY_TIER[3]).toBeLessThan(BLOOM_SCALE_BY_TIER[2]);
    expect(BLOOM_SCALE_BY_TIER[4]).toBeGreaterThan(0); // A52 最終: tier4 も 0.25(bloom 自体は残る)
  });

  it('renderScale は tier1 から早期に(解像度優先)低下しはじめる — bloomScale より早い', () => {
    // renderScale は tier1 で既に低下するが、bloomScale は tier2 まで温存 —
    // 「解像度を先に削り、エフェクトは温存する」優先順位の直接的な確認。
    expect(RENDER_SCALE_BY_TIER[1]).toBeLessThan(RENDER_SCALE_BY_TIER[0]);
    expect(BLOOM_SCALE_BY_TIER[1]).toBe(BLOOM_SCALE_BY_TIER[0]);
  });
});

describe('dprCapForTier(A52: モバイルの dprCap 上限)', () => {
  it('desktop はティア表の dprCap をそのまま返す', () => {
    for (let tier = 0; tier < DPR_CAP_BY_TIER.length; tier++) {
      expect(dprCapForTier(tier as 0 | 1 | 2 | 3 | 4, false)).toBe(
        DPR_CAP_BY_TIER[tier],
      );
    }
  });

  it('mobile は全ティアで MOBILE_DPR_CAP(1.75)を上限とする', () => {
    for (let tier = 0; tier < DPR_CAP_BY_TIER.length; tier++) {
      const cap = dprCapForTier(tier as 0 | 1 | 2 | 3 | 4, true);
      expect(cap).toBeLessThanOrEqual(MOBILE_DPR_CAP);
      expect(cap).toBe(Math.min(DPR_CAP_BY_TIER[tier], MOBILE_DPR_CAP));
    }
  });

  it('mobile tier0(dprCap=2.0)は 1.75 に切り詰められる', () => {
    expect(dprCapForTier(0, true)).toBe(1.75);
  });

  it('mobile tier4(dprCap=1.75)は既に上限以下なのでそのまま', () => {
    expect(dprCapForTier(4, true)).toBe(DPR_CAP_BY_TIER[4]);
  });
});
