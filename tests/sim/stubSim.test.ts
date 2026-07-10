import { describe, expect, it } from 'vitest';
import type { SkyRenderView } from '../../src/contract/RenderView';
import {
  ATOM_VIEW_CAPACITY,
  BUBBLE_STATE,
  DROPLET_VIEW_CAPACITY,
} from '../../src/contract/WorldSpec';
import { StubSim } from '../../src/sim/StubSim';

const SLOTS = 7;

const makeSim = (seed: number): StubSim => {
  const sim = new StubSim();
  sim.init({ seed, slotCount: SLOTS });
  return sim;
};

/** view の有効領域(dense prefix)のスナップショットを取る。 */
const snapshot = (view: SkyRenderView): number[] => {
  const out: number[] = [];
  out.push(view.step, view.atoms.count, view.droplets.count);
  out.push(...view.bubbles.data.subarray(0, view.bubbles.count * 8));
  out.push(...view.bubbles.prevData.subarray(0, view.bubbles.count * 8));
  out.push(...view.atoms.posr.subarray(0, view.atoms.count * 4));
  out.push(...view.atoms.prevPosr.subarray(0, view.atoms.count * 4));
  out.push(...view.atoms.colorKind.subarray(0, view.atoms.count * 4));
  out.push(...view.atoms.aux.subarray(0, view.atoms.count * 4));
  out.push(...view.droplets.posr.subarray(0, view.droplets.count * 4));
  out.push(...view.droplets.prevPosr.subarray(0, view.droplets.count * 4));
  out.push(...view.droplets.aux.subarray(0, view.droplets.count * 4));
  out.push(...view.splashes.data.subarray(0, view.splashes.count * 4));
  out.push(...view.ripples.data.subarray(0, view.ripples.count * 4));
  return out;
};

describe('StubSim(契約不変条件の演技台本)', () => {
  it('決定論: 同 seed 2 回実行で view バッファが一致する', () => {
    const a = makeSim(42);
    const b = makeSim(42);
    for (let step = 0; step < 900; step++) {
      a.step();
      b.step();
      if (step % 150 === 0) {
        expect(snapshot(a.view())).toEqual(snapshot(b.view()));
      }
    }
    expect(snapshot(a.view())).toEqual(snapshot(b.view()));
    expect(a.counts()).toEqual(b.counts());
  });

  it('異なる seed では異なる世界になる', () => {
    const a = makeSim(1);
    const b = makeSim(2);
    for (let step = 0; step < 60; step++) {
      a.step();
      b.step();
    }
    expect(snapshot(a.view())).not.toEqual(snapshot(b.view()));
  });

  it('bubbles.count は常に SLOT_COUNT(Dead 含む — A18)、dense prefix は容量内', () => {
    const sim = makeSim(7);
    for (let step = 0; step < 1200; step++) {
      sim.step();
      const view = sim.view();
      expect(view.bubbles.count).toBe(SLOTS);
      expect(view.atoms.count).toBeLessThanOrEqual(ATOM_VIEW_CAPACITY);
      expect(view.droplets.count).toBeLessThanOrEqual(DROPLET_VIEW_CAPACITY);
      // statePacked の整数部は 0..5
      for (let i = 0; i < SLOTS; i++) {
        const state = Math.floor(view.bubbles.data[i * 8 + 7]);
        expect(state).toBeGreaterThanOrEqual(0);
        expect(state).toBeLessThanOrEqual(5);
      }
    }
  });

  it('init 直後(スポーンフレーム)は全エンティティで prev == curr', () => {
    const sim = makeSim(11);
    const view = sim.view();
    for (let i = 0; i < view.bubbles.count * 8; i++) {
      expect(view.bubbles.prevData[i]).toBe(view.bubbles.data[i]);
    }
    for (let i = 0; i < view.atoms.count * 4; i++) {
      expect(view.atoms.prevPosr[i]).toBe(view.atoms.posr[i]);
    }
    for (let i = 0; i < view.droplets.count * 4; i++) {
      expect(view.droplets.prevPosr[i]).toBe(view.droplets.posr[i]);
    }
  });

  it('補間契約: 全 step・全 index で prev→curr の移動が連続(ワープなし)', () => {
    const sim = makeSim(3);
    // 1 step の最大移動: bob ≈0.001u、原子周回 ≈0.02u、落下 ≈0.08u — 0.5u で十分な帯
    const MAX_MOVE = 0.5;
    for (let step = 0; step < 2400; step++) {
      sim.step();
      const view = sim.view();
      for (let i = 0; i < view.atoms.count; i++) {
        const o = i * 4;
        const dx = view.atoms.posr[o] - view.atoms.prevPosr[o];
        const dy = view.atoms.posr[o + 1] - view.atoms.prevPosr[o + 1];
        const dz = view.atoms.posr[o + 2] - view.atoms.prevPosr[o + 2];
        expect(Math.hypot(dx, dy, dz)).toBeLessThan(MAX_MOVE);
      }
      for (let i = 0; i < view.droplets.count; i++) {
        const o = i * 4;
        const dx = view.droplets.posr[o] - view.droplets.prevPosr[o];
        const dy = view.droplets.posr[o + 1] - view.droplets.prevPosr[o + 1];
        const dz = view.droplets.posr[o + 2] - view.droplets.prevPosr[o + 2];
        expect(Math.hypot(dx, dy, dz)).toBeLessThan(MAX_MOVE);
      }
    }
  });

  it('不変条件 A25: 原子・雫は常に球内(内殻)かつ球内水面より上', () => {
    const sim = makeSim(5);
    for (let step = 0; step < 1800; step++) {
      sim.step();
      const view = sim.view();
      const checkInside = (x: number, y: number, z: number, r: number) => {
        // 所属球 = 中心距離が R 以内の球(スロットは幾何的に重ならない)
        let found = false;
        for (let b = 0; b < view.bubbles.count; b++) {
          const bo = b * 8;
          const lx = x - view.bubbles.data[bo];
          const ly = y - view.bubbles.data[bo + 1];
          const lz = z - view.bubbles.data[bo + 2];
          const bigR = view.bubbles.data[bo + 3];
          if (Math.hypot(lx, ly, lz) <= bigR * 0.94 + 1e-4) {
            const waterY = view.bubbles.data[bo + 4];
            expect(ly - r).toBeGreaterThan(waterY - 1e-4);
            found = true;
            break;
          }
        }
        expect(found).toBe(true);
      };
      for (let i = 0; i < view.atoms.count; i++) {
        const o = i * 4;
        checkInside(
          view.atoms.posr[o],
          view.atoms.posr[o + 1],
          view.atoms.posr[o + 2],
          view.atoms.posr[o + 3],
        );
      }
      for (let i = 0; i < view.droplets.count; i++) {
        const o = i * 4;
        checkInside(
          view.droplets.posr[o],
          view.droplets.posr[o + 1],
          view.droplets.posr[o + 2],
          view.droplets.posr[o + 3],
        );
      }
    }
  });

  it('ライフサイクル: SplashEvent が発火し、球は Dead を経て再誕生する', () => {
    const sim = makeSim(9);
    let splashFrames = 0;
    let sawDead = false;
    let sawRespawnAfterDead = false;
    let ripples = 0;
    // 初期 fill 0.55 のスロットは Spawning 2s + Drifting ≈1.7s + Straining 1.5s
    // + Falling ≈1.5s + Splashing 0.8s + Dead 4s ≈ 12s で一周する
    for (let step = 0; step < 3600; step++) {
      sim.step();
      const view = sim.view();
      splashFrames += view.splashes.count;
      ripples += view.ripples.count;
      for (let i = 0; i < view.bubbles.count; i++) {
        const state = Math.floor(view.bubbles.data[i * 8 + 7]);
        if (state === BUBBLE_STATE.Dead) sawDead = true;
        if (sawDead && state === BUBBLE_STATE.Spawning) {
          sawRespawnAfterDead = true;
        }
      }
    }
    expect(splashFrames).toBeGreaterThan(0);
    expect(ripples).toBeGreaterThan(0); // 雫の球内着水 InnerRipple
    expect(sawDead).toBe(true);
    expect(sawRespawnAfterDead).toBe(true);
    expect(sim.counts().splashesTotal).toBe(splashFrames);
    expect(sim.counts().dropletsAbsorbedTotal).toBeGreaterThan(0);
  });

  it('counts() が view と整合する', () => {
    const sim = makeSim(13);
    for (let step = 0; step < 600; step++) {
      sim.step();
    }
    const view = sim.view();
    const c = sim.counts();
    expect(c.h + c.o + c.h2).toBe(view.atoms.count);
    expect(c.droplets).toBe(view.droplets.count);
    expect(c.bubblesActive).toBeGreaterThan(0);
    expect(c.bubblesActive).toBeLessThanOrEqual(SLOTS);
    expect(c.meanFill01).toBeGreaterThanOrEqual(0);
    expect(c.meanFill01).toBeLessThanOrEqual(1);
  });
});
