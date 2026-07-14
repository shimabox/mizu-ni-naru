import { describe, expect, it } from 'vitest';
import { Atom } from '../../../src/sim/chem/Atom';
import { Mulberry32 } from '../../../src/sim/core/Random';
import { BruteForceDetector } from '../../../src/sim/physics/BruteForceDetector';
import { GridDetector } from '../../../src/sim/physics/GridDetector';
import { OrderedDirectDetector } from '../../../src/sim/physics/OrderedDirectDetector';
import { SphereGrid } from '../../../src/sim/physics/SphereGrid';

const R_INNER = 1.316; // 0.94 × 1.4

const makeAtom = (x: number, y: number, z: number, r = 0.1): Atom =>
  new Atom(0, r, x, y, z, 1, 1, 1, 0, 0);

/** 球内一様(棄却)に n 体を撒く。 */
const randomCloud = (seed: number, n: number, rMax = 0.126): Atom[] => {
  const rng = new Mulberry32(seed);
  const atoms: Atom[] = [];
  while (atoms.length < n) {
    const x = (2 * rng.next() - 1) * R_INNER;
    const y = (2 * rng.next() - 1) * R_INNER;
    const z = (2 * rng.next() - 1) * R_INNER;
    if (x * x + y * y + z * z > R_INNER * R_INNER) continue;
    atoms.push(makeAtom(x, y, z, 0.06 + rng.next() * (rMax - 0.06)));
  }
  return atoms;
};

const normalizePairs = (flat: number[], count: number): string[] => {
  const out: string[] = [];
  for (let p = 0; p < count; p++) {
    const i = flat[p * 2];
    const j = flat[p * 2 + 1];
    out.push(i < j ? `${i}-${j}` : `${j}-${i}`);
  }
  return out.sort();
};

describe('GridDetector vs BruteForce オラクル(§3.4/§7.3)', () => {
  it('seed 1..7 でペア集合が完全一致する(空虚テスト防止ガード付き)', () => {
    const grid = new GridDetector();
    const brute = new BruteForceDetector();
    const gridOut: number[] = [];
    const bruteOut: number[] = [];
    let totalExpected = 0;
    for (let seed = 1; seed <= 7; seed++) {
      // 高密度(40 体)で衝突が必ず出る雲
      const atoms = randomCloud(seed, 40);
      const ng = grid.findPairs(atoms, R_INNER, gridOut);
      const nb = brute.findPairs(atoms, R_INNER, bruteOut);
      expect(normalizePairs(gridOut, ng)).toEqual(normalizePairs(bruteOut, nb));
      totalExpected += nb;
    }
    expect(totalExpected).toBeGreaterThan(0); // 空虚テスト防止(threejs 知見)
  });

  it('dead 原子は両検出器とも候補から除外する', () => {
    const atoms = randomCloud(3, 30);
    atoms[0].dead = true;
    atoms[7].dead = true;
    const grid = new GridDetector();
    const brute = new BruteForceDetector();
    const g: number[] = [];
    const b: number[] = [];
    const ng = grid.findPairs(atoms, R_INNER, g);
    const nb = brute.findPairs(atoms, R_INNER, b);
    expect(normalizePairs(g, ng)).toEqual(normalizePairs(b, nb));
    for (let p = 0; p < ng; p++) {
      expect(g[p * 2]).not.toBe(0);
      expect(g[p * 2]).not.toBe(7);
      expect(g[p * 2 + 1]).not.toBe(0);
      expect(g[p * 2 + 1]).not.toBe(7);
    }
  });

  it('接触ペアを検出し、離れたペアは検出しない', () => {
    const atoms = [
      makeAtom(0, 0, 0, 0.1),
      makeAtom(0.15, 0, 0, 0.1), // 距離 0.15 < 0.2 → ヒット
      makeAtom(0.9, 0, 0, 0.1), // 遠い
    ];
    const grid = new GridDetector();
    const out: number[] = [];
    const n = grid.findPairs(atoms, R_INNER, out);
    expect(n).toBe(1);
    expect([out[0], out[1]]).toEqual([0, 1]);
  });

  it('セル境界をまたぐペアも 3×3×3 近傍で必ず拾う', () => {
    // セル幅 = R_inner/2 = 0.658。境界 x=0 を挟んで両側すれすれ
    const atoms = [makeAtom(-0.05, 0, 0, 0.1), makeAtom(0.05, 0, 0, 0.1)];
    const grid = new GridDetector();
    const out: number[] = [];
    expect(grid.findPairs(atoms, R_INNER, out)).toBe(1);
  });

  it('グリッド範囲外(クランプセル)の粒子も検出できる', () => {
    // 構造上は出ない座標だが、クランプの頑健性を固定する
    const atoms = [
      makeAtom(R_INNER * 1.1, 0, 0, 0.1),
      makeAtom(R_INNER * 1.05, 0, 0, 0.1),
    ];
    const grid = new GridDetector();
    const brute = new BruteForceDetector();
    const g: number[] = [];
    const b: number[] = [];
    expect(grid.findPairs(atoms, R_INNER, g)).toBe(
      brute.findPairs(atoms, R_INNER, b),
    );
  });

  it('出力ペアは常に i < j(正準順)', () => {
    const atoms = randomCloud(5, 40);
    const grid = new GridDetector();
    const out: number[] = [];
    const n = grid.findPairs(atoms, R_INNER, out);
    expect(n).toBeGreaterThan(0);
    for (let p = 0; p < n; p++) {
      expect(out[p * 2]).toBeLessThan(out[p * 2 + 1]);
    }
  });

  it('同一入力で列挙順まで再現する(決定論)', () => {
    const atoms = randomCloud(9, 35);
    const grid = new GridDetector();
    const a: number[] = [];
    const b: number[] = [];
    grid.findPairs(atoms, R_INNER, a);
    grid.findPairs(atoms, R_INNER, b);
    expect(a).toEqual(b);
  });

  it('outPairs は使い回される(length が上書きされる)', () => {
    const grid = new GridDetector();
    const out: number[] = [];
    grid.findPairs(randomCloud(1, 40), R_INNER, out);
    const lenDense = out.length;
    expect(lenDense).toBeGreaterThan(0);
    grid.findPairs([makeAtom(0, 0, 0)], R_INNER, out);
    expect(out.length).toBe(0);
  });
});

describe('OrderedDirectDetector(GridDetector列挙順互換)', () => {
  it('seed 1..12、40原子で平坦なペア列全体が一致する', () => {
    const grid = new GridDetector();
    const direct = new OrderedDirectDetector();
    const gridOut: number[] = [];
    const directOut: number[] = [];
    let totalPairs = 0;

    for (let seed = 1; seed <= 12; seed++) {
      const atoms = randomCloud(seed, 40);
      if (seed % 3 === 0) atoms[seed % atoms.length].dead = true;
      const gridCount = grid.findPairs(atoms, R_INNER, gridOut);
      const directCount = direct.findPairs(atoms, R_INNER, directOut);
      expect(directCount).toBe(gridCount);
      expect(directOut).toEqual(gridOut);
      totalPairs += gridCount;
    }

    expect(totalPairs).toBeGreaterThan(0);
  });

  it('48原子まではdirect、49原子以上でもfallbackが同じ列を返す', () => {
    const grid = new GridDetector();
    const direct = new OrderedDirectDetector();

    for (const count of [48, 49, 128]) {
      const atoms = randomCloud(count, count);
      const gridOut: number[] = [];
      const directOut: number[] = [];
      expect(direct.findPairs(atoms, R_INNER, directOut)).toBe(
        grid.findPairs(atoms, R_INNER, gridOut),
      );
      expect(directOut).toEqual(gridOut);
    }
  });
});

describe('SphereGrid(counting sort 索引)', () => {
  it('rebuild 後、全生存原子が entries にちょうど 1 回ずつ現れる(安定順)', () => {
    const atoms = randomCloud(4, 26);
    const grid = new SphereGrid();
    grid.rebuild(atoms, R_INNER);
    const seen: number[] = [];
    const total = grid.starts[64];
    expect(total).toBe(26);
    for (let e = 0; e < total; e++) seen.push(grid.entries[e]);
    expect([...seen].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 26 }, (_, i) => i),
    );
  });

  it('axisCell は 0..3 にクランプされる', () => {
    const grid = new SphereGrid();
    grid.rebuild([], R_INNER);
    expect(grid.axisCell(-99)).toBe(0);
    expect(grid.axisCell(99)).toBe(3);
    expect(grid.axisCell(-R_INNER + 1e-6)).toBe(0);
    expect(grid.axisCell(R_INNER - 1e-6)).toBe(3);
  });
});
