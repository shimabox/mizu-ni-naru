import { describe, expect, it } from 'vitest';
import {
  ATOM_VIEW_CAPACITY,
  BUBBLE_CAPACITY,
  BUBBLE_STATE,
  DROPLET_VIEW_CAPACITY,
  DT,
  KIND_INDEX,
  MAX_STEPS_PER_FRAME,
  RIPPLE_VIEW_CAPACITY,
  SEA_LEVEL,
  SLOT_COUNT_DESKTOP,
  SLOT_COUNT_MOBILE,
  SPLASH_VIEW_CAPACITY,
  STEP_HZ,
} from '../../src/contract/WorldSpec';

describe('WorldSpec(凍結契約 — master-plan §5 の確定形)', () => {
  it('BUBBLE_STATE のインデックスは Spawning..Dead = 0..5(裁定 A3)', () => {
    expect(BUBBLE_STATE.Spawning).toBe(0);
    expect(BUBBLE_STATE.Drifting).toBe(1);
    expect(BUBBLE_STATE.Straining).toBe(2);
    expect(BUBBLE_STATE.Falling).toBe(3);
    expect(BUBBLE_STATE.Splashing).toBe(4);
    expect(BUBBLE_STATE.Dead).toBe(5);
  });

  it('容量定数(裁定 A5、A30、A32、A35 で改訂)', () => {
    expect(BUBBLE_CAPACITY).toBe(128);
    expect(ATOM_VIEW_CAPACITY).toBe(4096);
    expect(DROPLET_VIEW_CAPACITY).toBe(8192);
    expect(SPLASH_VIEW_CAPACITY).toBe(128);
    expect(RIPPLE_VIEW_CAPACITY).toBe(256);
  });

  it('KIND_INDEX = { H:0, O:1, H2:2 }', () => {
    expect(KIND_INDEX.H).toBe(0);
    expect(KIND_INDEX.O).toBe(1);
    expect(KIND_INDEX.H2).toBe(2);
  });

  it('時間・スロット・座標の規約', () => {
    expect(SEA_LEVEL).toBe(0);
    expect(STEP_HZ).toBe(60);
    expect(DT).toBe(1 / 60);
    expect(MAX_STEPS_PER_FRAME).toBe(3);
    expect(SLOT_COUNT_DESKTOP).toBe(24);
    expect(SLOT_COUNT_MOBILE).toBe(24);
    expect(BUBBLE_CAPACITY).toBeGreaterThanOrEqual(SLOT_COUNT_DESKTOP);
  });
});
