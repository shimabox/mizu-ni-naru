import { describe, expect, it } from 'vitest';
import { DT } from '../../../src/contract/WorldSpec';
import { Atom } from '../../../src/sim/chem/Atom';
import {
  interactWater,
  reflectSphere,
  walk,
} from '../../../src/sim/chem/BoundedWalk';
import { P_DISSOLVE } from '../../../src/sim/config';
import { Mulberry32 } from '../../../src/sim/core/Random';
import { SequenceRandom, SpyRandom } from '../../helpers/testRandom';

const makeAtom = (x = 0, y = 0, z = 0, r = 0.084): Atom =>
  new Atom(0, r, x, y, z, 1, 1, 1, 0.5, 0);

describe('BoundedWalk.walk', () => {
  it('1 回の walk で RNG をちょうど 2 回消費する(cosPolar, azimuth — §7.1)', () => {
    const rng = new SpyRandom(new Mulberry32(1));
    const atom = makeAtom();
    walk(atom, rng, 0.77);
    expect(rng.calls).toBe(2);
  });

  it('速度は v_max にクランプされる', () => {
    const rng = new Mulberry32(2);
    const atom = makeAtom();
    const vMax = 0.77;
    for (let i = 0; i < 200; i++) {
      walk(atom, rng, vMax);
      const s = Math.hypot(atom.vx, atom.vy, atom.vz);
      expect(s).toBeLessThanOrEqual(vMax + 1e-9);
    }
  });

  it('位置は v·DT で積分される', () => {
    // cosPolar=+1(真上)になる列: rng = [1, 0] → cosPolar = 2·1−1 = 1
    const rng = new SequenceRandom([1, 0]);
    const atom = makeAtom();
    const vMax = 0.7;
    walk(atom, rng, vMax);
    const accel = vMax / 14;
    expect(atom.vy).toBeCloseTo(accel, 10);
    expect(atom.y).toBeCloseTo(accel * DT, 10);
    expect(atom.x).toBeCloseTo(0, 10);
    expect(atom.z).toBeCloseTo(0, 10);
  });

  it('多数 step でも速度上限近傍に滞在する(クランプ付きウォークの性格)', () => {
    const rng = new Mulberry32(3);
    const atom = makeAtom();
    const vMax = 0.77;
    let sum = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      walk(atom, rng, vMax);
      sum += Math.hypot(atom.vx, atom.vy, atom.vz);
    }
    // 平均速度 ≈ 0.8·v_max(design-sim §5.1 の運動論仮定の実測アンカー)
    expect(sum / n).toBeGreaterThan(0.6 * vMax);
  });
});

describe('BoundedWalk.reflectSphere', () => {
  it('R_eff 超過で半径方向ミラー(面を挟んで対称な位置)になる', () => {
    const atom = makeAtom(0, 1.21, 0);
    atom.vx = 0;
    atom.vy = 0.5;
    atom.vz = 0;
    reflectSphere(atom, 1.2);
    expect(atom.y).toBeCloseTo(2 * 1.2 - 1.21, 10); // 2·R_eff − d
    expect(atom.vy).toBeCloseTo(-0.5, 10); // 法線成分の反転
  });

  it('接線成分は保存される(mirror-and-negate、clamp ではない)', () => {
    const atom = makeAtom(1.25, 0, 0);
    atom.vx = 0.3; // 法線方向
    atom.vy = 0.2; // 接線方向
    atom.vz = -0.1; // 接線方向
    reflectSphere(atom, 1.2);
    expect(atom.x).toBeCloseTo(2 * 1.2 - 1.25, 10);
    expect(atom.vx).toBeCloseTo(-0.3, 10);
    expect(atom.vy).toBeCloseTo(0.2, 10);
    expect(atom.vz).toBeCloseTo(-0.1, 10);
  });

  it('境界内の粒子は変更しない', () => {
    const atom = makeAtom(0.5, -0.3, 0.2);
    atom.vx = 0.1;
    reflectSphere(atom, 1.2);
    expect(atom.x).toBe(0.5);
    expect(atom.y).toBe(-0.3);
    expect(atom.z).toBe(0.2);
    expect(atom.vx).toBe(0.1);
  });

  it('walk + 反射を繰り返しても |p| ≤ R_eff を破らない(seed 1..7 — §7.3)', () => {
    for (let seed = 1; seed <= 7; seed++) {
      const rng = new Mulberry32(seed);
      const atom = makeAtom();
      const rEff = 1.2;
      for (let i = 0; i < 600; i++) {
        walk(atom, rng, 0.77);
        reflectSphere(atom, rEff);
        const d = Math.hypot(atom.x, atom.y, atom.z);
        expect(d).toBeLessThanOrEqual(rEff + 1e-6);
      }
    }
  });
});

describe('BoundedWalk.interactWater(漏れあり反射 — §3.3)', () => {
  it('水面に触れていなければ RNG を消費しない', () => {
    const rng = new SpyRandom(new Mulberry32(1));
    const atom = makeAtom(0, 0.5, 0);
    const dissolved = interactWater(atom, -0.5, 1.2, rng);
    expect(dissolved).toBe(false);
    expect(rng.calls).toBe(0);
  });

  it('交差時に RNG 1 回で透過判定し、P_DISSOLVE 未満なら溶解を返す', () => {
    const rng = new SequenceRandom([P_DISSOLVE * 0.5]);
    const atom = makeAtom(0.1, -0.45, 0);
    const dissolved = interactWater(atom, -0.4, 1.2, rng);
    expect(dissolved).toBe(true);
    expect(rng.calls).toBe(1);
  });

  it('P_DISSOLVE 以上なら水面で mirror-and-negate(y のみ、x/z 保存)', () => {
    const rng = new SequenceRandom([0.9]);
    const atom = makeAtom(0.1, -0.49, 0.2);
    atom.vx = 0.05;
    atom.vy = -0.3;
    atom.vz = -0.02;
    const waterY = -0.4;
    const dissolved = interactWater(atom, waterY, 1.2, rng);
    expect(dissolved).toBe(false);
    expect(atom.y).toBeCloseTo(2 * (waterY + atom.r) - -0.49, 10);
    expect(atom.y - atom.r).toBeGreaterThanOrEqual(waterY);
    expect(atom.vy).toBeCloseTo(0.3, 10);
    expect(atom.vx).toBeCloseTo(0.05, 10);
    expect(atom.vz).toBeCloseTo(-0.02, 10);
    expect(atom.x).toBeCloseTo(0.1, 10);
    expect(atom.z).toBeCloseTo(0.2, 10);
  });

  it('球殻とのくさび部では水平クランプで球内に留める(y は保存)', () => {
    const rng = new SequenceRandom([0.9]);
    const rEff = 1.2;
    // 水面が高く、粒子が殻ぎりぎりの横位置にいる状況を合成
    const waterY = 0.3;
    const atom = makeAtom(1.15, 0.3, 0.2);
    const dissolved = interactWater(atom, waterY, rEff, rng);
    expect(dissolved).toBe(false);
    const d = Math.hypot(atom.x, atom.y, atom.z);
    expect(d).toBeLessThanOrEqual(rEff + 1e-9);
    expect(atom.y - atom.r).toBeGreaterThanOrEqual(waterY - 1e-9);
  });

  it('溶解確率は P_DISSOLVE に統計的に一致する', () => {
    const rng = new Mulberry32(42);
    let crossings = 0;
    let dissolved = 0;
    for (let i = 0; i < 20000; i++) {
      const atom = makeAtom(0, -0.45, 0);
      crossings++;
      if (interactWater(atom, -0.4, 1.2, rng)) dissolved++;
    }
    const p = dissolved / crossings;
    expect(p).toBeGreaterThan(P_DISSOLVE * 0.7);
    expect(p).toBeLessThan(P_DISSOLVE * 1.3);
  });
});
