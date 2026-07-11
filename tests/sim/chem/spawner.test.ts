import { describe, expect, it } from 'vitest';
import { KIND_INDEX } from '../../../src/contract/WorldSpec';
import type { Atom } from '../../../src/sim/chem/Atom';
import { AtomFactory } from '../../../src/sim/chem/AtomFactory';
import { Spawner } from '../../../src/sim/chem/Spawner';
import { F_FULL_MAX, H_TARGET, O_TARGET } from '../../../src/sim/config';
import { capU } from '../../../src/sim/core/CapLut';
import { Mulberry32 } from '../../../src/sim/core/Random';
import { SpyRandom } from '../../helpers/testRandom';

const R = 1.4;
const R_INNER = 0.94 * R;

const makeSpawner = (seed = 1): { spawner: Spawner; rng: SpyRandom } => {
  const rng = new SpyRandom(new Mulberry32(seed));
  return { spawner: new Spawner(rng, new AtomFactory(rng)), rng };
};

const countKind = (atoms: Atom[], kind: number): number =>
  atoms.filter((a) => a.kindIndex === kind && !a.dead).length;

describe('Spawner(凝結スポナー — §3.6)', () => {
  it('相対不足の大きい種を選ぶ(O が枯れていれば O)', () => {
    const { spawner } = makeSpawner();
    const atom = spawner.trySpawn([], 12, 0, -R_INNER, R_INNER, R, 0);
    expect(atom?.kindIndex).toBe(KIND_INDEX.O);
  });

  it('H が枯れていれば H', () => {
    const { spawner } = makeSpawner();
    const atom = spawner.trySpawn([], 0, 8, -R_INNER, R_INNER, R, 0);
    expect(atom?.kindIndex).toBe(KIND_INDEX.H);
  });

  it('同率不足は H 優先(空の球 → H)', () => {
    const { spawner } = makeSpawner();
    const atom = spawner.trySpawn([], 0, 0, -R_INNER, R_INNER, R, 0);
    expect(atom?.kindIndex).toBe(KIND_INDEX.H);
  });

  it('化学量論 2:1 に追従する(H6/O4 = 同率 50% 不足 → H)', () => {
    const { spawner } = makeSpawner();
    const atom = spawner.trySpawn([], 6, 4, -R_INNER, R_INNER, R, 0);
    expect(atom?.kindIndex).toBe(KIND_INDEX.H);
  });

  it('不足ゼロなら null を返し RNG を一切消費しない(§7.1)', () => {
    const { spawner, rng } = makeSpawner();
    const atom = spawner.trySpawn(
      [],
      H_TARGET,
      O_TARGET,
      -R_INNER,
      R_INNER,
      R,
      0,
    );
    expect(atom).toBeNull();
    expect(rng.calls).toBe(0);
  });

  it('目標超過(過渡)でも湧かない', () => {
    const { spawner, rng } = makeSpawner();
    expect(
      spawner.trySpawn([], H_TARGET + 3, O_TARGET + 1, -R_INNER, R_INNER, R, 0),
    ).toBeNull();
    expect(rng.calls).toBe(0);
  });

  it('スポーン位置は水面より上(y ≥ y_w + 2r)かつ球内(|p| ≤ R_eff)', () => {
    const { spawner } = makeSpawner(7);
    const atoms: Atom[] = [];
    const waterY = -0.3;
    for (let i = 0; i < 60; i++) {
      const h = countKind(atoms, KIND_INDEX.H);
      const o = countKind(atoms, KIND_INDEX.O);
      const atom = spawner.trySpawn(atoms, h, o, waterY, R_INNER, R, i);
      if (!atom) break;
      expect(atom.y - 2 * atom.r).toBeGreaterThanOrEqual(waterY - 1e-9);
      const rEff = R_INNER - atom.r;
      expect(Math.hypot(atom.x, atom.y, atom.z)).toBeLessThanOrEqual(
        rEff + 1e-9,
      );
      atoms.push(atom);
    }
    expect(atoms.length).toBe(H_TARGET + O_TARGET);
  });

  it('既存粒子と重畳しない(採用点の非重畳)', () => {
    const { spawner } = makeSpawner(11);
    const atoms: Atom[] = [];
    for (let i = 0; i < H_TARGET + O_TARGET; i++) {
      const h = countKind(atoms, KIND_INDEX.H);
      const o = countKind(atoms, KIND_INDEX.O);
      const atom = spawner.trySpawn(atoms, h, o, -R_INNER, R_INNER, R, i);
      expect(atom).not.toBeNull();
      if (!atom) return;
      for (const other of atoms) {
        const d = Math.hypot(
          other.x - atom.x,
          other.y - atom.y,
          other.z - atom.z,
        );
        // 全試行棄却のフォールバック(天頂寄り既定点)だけは重畳を許す設計。
        // 疎な球内では実質発生しない — ここでは発生しないことを実測で固定
        expect(d).toBeGreaterThanOrEqual(other.r + atom.r - 1e-9);
      }
      atoms.push(atom);
    }
  });

  it('繰り返し呼べば目標人口(H12 + O8)に到達し、以後停止する', () => {
    const { spawner } = makeSpawner(3);
    const atoms: Atom[] = [];
    for (let i = 0; i < 100; i++) {
      const h = countKind(atoms, KIND_INDEX.H);
      const o = countKind(atoms, KIND_INDEX.O);
      const atom = spawner.trySpawn(atoms, h, o, -R_INNER, R_INNER, R, i);
      if (atom) atoms.push(atom);
    }
    expect(countKind(atoms, KIND_INDEX.H)).toBe(H_TARGET);
    expect(countKind(atoms, KIND_INDEX.O)).toBe(O_TARGET);
  });

  it('空域ゼロ(水がほぼ満杯)なら null(RNG 消費なし)', () => {
    const { spawner, rng } = makeSpawner();
    const atom = spawner.trySpawn([], 0, 0, R_INNER * 0.98, R_INNER, R, 0);
    expect(atom).toBeNull();
    expect(rng.calls).toBe(0);
  });

  it('A40 崩壊ガード: F_FULL_MAX(0.95)相当の水面では空域帯が反転しても ' +
    'null を返し続け、無限試行・NaN・例外なく決定的(RNG 消費ゼロ)', () => {
    const { spawner, rng } = makeSpawner(21);
    // 帯上限 fill01=F_FULL_MAX での実水面(球冠 LUT 経由 — 本 sim と同じ変換)。
    // y ∈ [waterY+m, R_eff−m] が反転する高さになることを想定した regressive 入力。
    const waterY = (2 * capU(F_FULL_MAX) - 1) * R_INNER;
    for (let i = 0; i < 200; i++) {
      const atom = spawner.trySpawn(
        [],
        0,
        0, // H/O とも枯渇 — 供給ゼロなら試行自体が起きない経路も混在させる
        waterY,
        R_INNER,
        R,
        i,
      );
      // 空域が反転していれば null(NaN や無限ループなしで即座に決定)
      if (atom) {
        expect(Number.isFinite(atom.x)).toBe(true);
        expect(Number.isFinite(atom.y)).toBe(true);
        expect(Number.isFinite(atom.z)).toBe(true);
      }
    }
    expect(rng.calls).toBe(0); // 空域反転(または不足ゼロ)なので RNG は一切消費しない
  });

  it('同 seed 同引数なら同一のスポーン列(決定論)', () => {
    const run = (): number[] => {
      const { spawner } = makeSpawner(99);
      const atoms: Atom[] = [];
      const out: number[] = [];
      for (let i = 0; i < 20; i++) {
        const h = countKind(atoms, KIND_INDEX.H);
        const o = countKind(atoms, KIND_INDEX.O);
        const atom = spawner.trySpawn(atoms, h, o, -R_INNER, R_INNER, R, i);
        if (atom) {
          atoms.push(atom);
          out.push(atom.x, atom.y, atom.z, atom.kindIndex);
        }
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});
