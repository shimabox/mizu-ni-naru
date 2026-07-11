import { describe, expect, it } from 'vitest';
import { BUBBLE_STATE, STEP_HZ } from '../../../src/contract/WorldSpec';
import {
  BubbleFsm,
  FSM_EVENT,
  SPAWNING_STEPS,
  SPLASHING_STEPS,
  STRAINING_STEPS,
} from '../../../src/sim/bubble/BubbleFsm';
import {
  F_FULL_MAX,
  RESPAWN_DELAY_MAX_S,
  RESPAWN_DELAY_MIN_S,
  WOBBLE_PULSE,
} from '../../../src/sim/config';
import { Mulberry32, type Random } from '../../../src/sim/core/Random';
import { ForbiddenRandom, SpyRandom } from '../../helpers/testRandom';

const R = 1.4;

const advanceN = (
  fsm: BubbleFsm,
  anchor: { ay: number },
  n: number,
  fill = 0,
  rng: Random = new Mulberry32(1),
): number => {
  let events = 0;
  for (let i = 0; i < n; i++) {
    events |= fsm.advance(rng, anchor, fill, R);
  }
  return events;
};

describe('BubbleFsm(§2 の状態机上表)', () => {
  it('Spawning は 120 step(2.0 s)で Drifting へ', () => {
    const fsm = new BubbleFsm();
    const anchor = { ay: 4 };
    advanceN(fsm, anchor, SPAWNING_STEPS - 1);
    expect(fsm.state).toBe(BUBBLE_STATE.Spawning);
    advanceN(fsm, anchor, 1);
    expect(fsm.state).toBe(BUBBLE_STATE.Drifting);
  });

  it('Drifting は fill01 ≥ F_FULL_MAX で Straining へ(時間ではない)', () => {
    const fsm = new BubbleFsm();
    const anchor = { ay: 4 };
    advanceN(fsm, anchor, SPAWNING_STEPS); // → Drifting
    advanceN(fsm, anchor, 1000, F_FULL_MAX - 0.01);
    expect(fsm.state).toBe(BUBBLE_STATE.Drifting);
    advanceN(fsm, anchor, 1, F_FULL_MAX);
    expect(fsm.state).toBe(BUBBLE_STATE.Straining);
  });

  it('Straining は 90 step(1.5 s)で Falling へ(fallY0 を捕捉)', () => {
    const fsm = new BubbleFsm();
    const anchor = { ay: 4.2 };
    advanceN(fsm, anchor, SPAWNING_STEPS, 0);
    advanceN(fsm, anchor, 1, F_FULL_MAX); // → Straining
    advanceN(fsm, anchor, STRAINING_STEPS, F_FULL_MAX);
    expect(fsm.state).toBe(BUBBLE_STATE.Falling);
    expect(fsm.fallY0).toBe(4.2);
  });

  it('Straining 中 wobble は 0→1 の線形ランプ', () => {
    const fsm = new BubbleFsm();
    const anchor = { ay: 4 };
    advanceN(fsm, anchor, SPAWNING_STEPS, 0);
    advanceN(fsm, anchor, 1, F_FULL_MAX); // 遷移フレーム(wobble はまだ 0 — 連続性)
    expect(fsm.wobble).toBe(0);
    advanceN(fsm, anchor, 1, F_FULL_MAX);
    expect(fsm.wobble).toBeCloseTo(1 / STRAINING_STEPS, 5);
    advanceN(fsm, anchor, STRAINING_STEPS / 2 - 1, F_FULL_MAX);
    expect(fsm.wobble).toBeCloseTo(0.5, 2);
  });

  it('Falling: 線形抗力付き落下、ay ≤ R で Splashed イベント + クランプ', () => {
    const fsm = new BubbleFsm();
    const anchor = { ay: 4.0 };
    advanceN(fsm, anchor, SPAWNING_STEPS, 0);
    advanceN(fsm, anchor, 1 + STRAINING_STEPS, F_FULL_MAX); // → Falling
    expect(fsm.state).toBe(BUBBLE_STATE.Falling);
    let splashed = false;
    let steps = 0;
    const rng = new Mulberry32(2);
    while (!splashed && steps < 600) {
      const ev = fsm.advance(rng, anchor, F_FULL_MAX, R);
      expect(fsm.wobble).toBe(1);
      if ((ev & FSM_EVENT.Splashed) !== 0) splashed = true;
      steps++;
    }
    expect(splashed).toBe(true);
    expect(anchor.ay).toBe(R);
    expect(fsm.state).toBe(BUBBLE_STATE.Splashing);
    // §2.4 の解析: 落下 ≈1.45 s、着水速度 ≈3.2 u/s(y0=4.0、R=1.4)
    expect(steps / STEP_HZ).toBeGreaterThan(1.1);
    expect(steps / STEP_HZ).toBeLessThan(1.9);
    expect(fsm.impactV).toBeGreaterThan(2.5);
    expect(fsm.impactV).toBeLessThan(4.0);
  });

  it('Splashing は 48 step(0.8 s)で Dead へ(遅延ロール + EnteredDead)', () => {
    const fsm = new BubbleFsm();
    const anchor = { ay: 4.0 };
    const rng = new SpyRandom(new Mulberry32(3));
    advanceN(fsm, anchor, SPAWNING_STEPS, 0, rng);
    advanceN(fsm, anchor, 1 + STRAINING_STEPS, F_FULL_MAX, rng);
    while (fsm.state === BUBBLE_STATE.Falling) {
      fsm.advance(rng, anchor, F_FULL_MAX, R);
    }
    const callsBefore = rng.calls;
    expect(callsBefore).toBe(0); // ここまで FSM は RNG を消費しない
    const ev = advanceN(fsm, anchor, SPLASHING_STEPS, F_FULL_MAX, rng);
    expect((ev & FSM_EVENT.EnteredDead) !== 0).toBe(true);
    expect(fsm.state).toBe(BUBBLE_STATE.Dead);
    expect(rng.calls).toBe(1); // Dead 遷移時の遅延ロールのみ(§7.1)
    expect(fsm.wobble).toBe(0);
    // 遅延帯 [4, 10] s
    expect(fsm.deadDurationSteps).toBeGreaterThanOrEqual(
      RESPAWN_DELAY_MIN_S * STEP_HZ,
    );
    expect(fsm.deadDurationSteps).toBeLessThanOrEqual(
      RESPAWN_DELAY_MAX_S * STEP_HZ,
    );
  });

  it('Dead は満了で RespawnDue を出し続ける(再ロールは呼び出し側)', () => {
    const fsm = new BubbleFsm();
    fsm.state = BUBBLE_STATE.Dead;
    fsm.stateStep = 0;
    fsm.deadDurationSteps = 10;
    const anchor = { ay: R };
    const ev1 = advanceN(fsm, anchor, 9, 0, new Mulberry32(1));
    expect(ev1 & FSM_EVENT.RespawnDue).toBe(0);
    const ev2 = advanceN(fsm, anchor, 1, 0, new Mulberry32(1));
    expect((ev2 & FSM_EVENT.RespawnDue) !== 0).toBe(true);
  });

  it('Spawning〜Falling の advance は RNG フリー(spy 不呼)', () => {
    const fsm = new BubbleFsm();
    const anchor = { ay: 4 };
    const rng = new ForbiddenRandom();
    expect(() => {
      advanceN(fsm, anchor, SPAWNING_STEPS + 50, 0, rng);
    }).not.toThrow();
  });

  it('wobble パルス: +0.15、毎 step ×0.97 減衰、上限 1(§2.2)', () => {
    const fsm = new BubbleFsm();
    const anchor = { ay: 4 };
    fsm.addWobblePulse();
    expect(fsm.wobblePulse).toBeCloseTo(WOBBLE_PULSE, 6);
    for (let i = 0; i < 20; i++) fsm.addWobblePulse();
    expect(fsm.wobblePulse).toBe(1);
    advanceN(fsm, anchor, 1);
    expect(fsm.wobble).toBeCloseTo(0.97, 5);
  });

  it('isWorldAlive は Spawning/Drifting/Straining/Falling のみ true', () => {
    const fsm = new BubbleFsm();
    for (const s of [
      BUBBLE_STATE.Spawning,
      BUBBLE_STATE.Drifting,
      BUBBLE_STATE.Straining,
      BUBBLE_STATE.Falling,
    ]) {
      fsm.state = s;
      expect(fsm.isWorldAlive()).toBe(true);
    }
    for (const s of [BUBBLE_STATE.Splashing, BUBBLE_STATE.Dead]) {
      fsm.state = s;
      expect(fsm.isWorldAlive()).toBe(false);
    }
  });

  describe('statePacked(§1.3)', () => {
    it('整数部 = 状態、progress は 0.999 でクランプ', () => {
      const fsm = new BubbleFsm();
      const anchor = { ay: 4 };
      advanceN(fsm, anchor, 30);
      const packed = fsm.statePacked(0, 4, R);
      expect(Math.floor(packed)).toBe(BUBBLE_STATE.Spawning);
      expect(packed - Math.floor(packed)).toBeCloseTo(30 / SPAWNING_STEPS, 5);
      fsm.stateStep = SPAWNING_STEPS * 10; // 異常な超過でも
      expect(fsm.statePacked(0, 4, R) - BUBBLE_STATE.Spawning).toBeLessThan(1);
    });

    it('Drifting の progress は fill01 / F_FULL_MAX(落下前の「張り」の先取り)', () => {
      const fsm = new BubbleFsm();
      fsm.state = BUBBLE_STATE.Drifting;
      const packed = fsm.statePacked(0.3, 4, R);
      expect(Math.floor(packed)).toBe(BUBBLE_STATE.Drifting);
      expect(packed - 1).toBeCloseTo(0.3 / F_FULL_MAX, 5);
    });

    it('Falling の progress は落下距離正規化', () => {
      const fsm = new BubbleFsm();
      fsm.state = BUBBLE_STATE.Falling;
      fsm.fallY0 = 4.0;
      const packed = fsm.statePacked(F_FULL_MAX, 2.7, R); // 半分落ちた
      expect(packed - 3).toBeCloseTo((4.0 - 2.7) / (4.0 - R), 5);
    });
  });
});
