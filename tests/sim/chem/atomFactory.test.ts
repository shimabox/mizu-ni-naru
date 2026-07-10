import { describe, expect, it } from 'vitest';
import { KIND_INDEX } from '../../../src/contract/WorldSpec';
import {
  AtomFactory,
  type DropletSpawnSpec,
} from '../../../src/sim/chem/AtomFactory';
import {
  ATOM_COLOR_BASE,
  ATOM_RADIUS_RATIO,
  DROPLET_RADIUS_RATIO_MAX,
  DROPLET_RADIUS_RATIO_MIN,
  SWAY_AMP_RATIO_MAX,
  SWAY_AMP_RATIO_MIN,
} from '../../../src/sim/config';
import { Mulberry32 } from '../../../src/sim/core/Random';
import { SequenceRandom, SpyRandom } from '../../helpers/testRandom';

const emptySpec = (): DropletSpawnSpec => ({
  x: 0,
  y: 0,
  z: 0,
  r: 0,
  phase: 0,
  swayAmp: 0,
  seed: 0,
});

describe('AtomFactory.createAtom', () => {
  it('RNG をちょうど 1 回消費する(色+seed 共有 — §7.1)', () => {
    const rng = new SpyRandom(new Mulberry32(1));
    const factory = new AtomFactory(rng);
    factory.createAtom(KIND_INDEX.H, 0.1, 0.2, 0.3, 1.4, 42);
    expect(rng.calls).toBe(1);
  });

  it('半径は ATOM_RADIUS_RATIO[kind] × R', () => {
    const factory = new AtomFactory(new Mulberry32(1));
    const r = 1.4;
    for (const kind of [KIND_INDEX.H, KIND_INDEX.O, KIND_INDEX.H2]) {
      const atom = factory.createAtom(kind, 0, 0, 0, r, 0);
      expect(atom.r).toBeCloseTo(ATOM_RADIUS_RATIO[kind] * r, 10);
      expect(atom.kindIndex).toBe(kind);
    }
  });

  it('seed は消費した RNG 生値そのもの、色チャンネルは [BASE, 1] に収まる', () => {
    const v = 0.6180339887;
    const factory = new AtomFactory(new SequenceRandom([v]));
    const atom = factory.createAtom(KIND_INDEX.O, 0, 0, 0, 1.4, 7);
    expect(atom.seed).toBe(v);
    for (const c of [atom.colR, atom.colG, atom.colB]) {
      expect(c).toBeGreaterThanOrEqual(ATOM_COLOR_BASE);
      expect(c).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('スポーンフレームは prev = curr(位置・spawnStep 記録)', () => {
    const factory = new AtomFactory(new Mulberry32(5));
    const atom = factory.createAtom(KIND_INDEX.H, 0.1, -0.2, 0.3, 1.4, 99);
    expect(atom.px).toBe(atom.x);
    expect(atom.py).toBe(atom.y);
    expect(atom.pz).toBe(atom.z);
    expect(atom.spawnStep).toBe(99);
    expect(atom.dead).toBe(false);
  });

  it('同 seed からは同一の原子列が得られる(決定論)', () => {
    const make = () => {
      const factory = new AtomFactory(new Mulberry32(1234));
      return [0, 1, 2].map((k) => factory.createAtom(k, 0, 0, 0, 1.3, 0));
    };
    const a = make();
    const b = make();
    for (let i = 0; i < 3; i++) {
      expect(a[i].seed).toBe(b[i].seed);
      expect(a[i].colR).toBe(b[i].colR);
    }
  });
});

describe('AtomFactory.fillDropletSpawn', () => {
  it('RNG をちょうど 4 回消費する(r, phase, swayAmp, seed の順 — §7.1)', () => {
    const rng = new SpyRandom(new Mulberry32(1));
    const factory = new AtomFactory(rng);
    factory.fillDropletSpawn(0, 0, 0, 1.4, emptySpec());
    expect(rng.calls).toBe(4);
  });

  it('パラメータが設計帯に収まる(r ∈ [0.065, 0.095]R、swayAmp ∈ [0.25, 0.45]r)', () => {
    const factory = new AtomFactory(new Mulberry32(7));
    const bubbleR = 1.4;
    const spec = emptySpec();
    for (let i = 0; i < 100; i++) {
      factory.fillDropletSpawn(0.1, 0.2, 0.3, bubbleR, spec);
      expect(spec.r).toBeGreaterThanOrEqual(
        DROPLET_RADIUS_RATIO_MIN * bubbleR - 1e-9,
      );
      expect(spec.r).toBeLessThanOrEqual(
        DROPLET_RADIUS_RATIO_MAX * bubbleR + 1e-9,
      );
      expect(spec.phase).toBeGreaterThanOrEqual(0);
      expect(spec.phase).toBeLessThan(2 * Math.PI);
      expect(spec.swayAmp).toBeGreaterThanOrEqual(
        SWAY_AMP_RATIO_MIN * spec.r - 1e-9,
      );
      expect(spec.swayAmp).toBeLessThanOrEqual(
        SWAY_AMP_RATIO_MAX * spec.r + 1e-9,
      );
      expect(spec.seed).toBeGreaterThanOrEqual(0);
      expect(spec.seed).toBeLessThan(1);
      expect(spec.x).toBe(0.1);
      expect(spec.y).toBe(0.2);
      expect(spec.z).toBe(0.3);
    }
  });
});
