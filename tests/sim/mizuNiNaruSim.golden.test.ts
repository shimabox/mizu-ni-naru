import { describe, expect, it } from 'vitest';
import { MizuNiNaruSim } from '../../src/sim/MizuNiNaruSim';

/**
 * ゴールデントリップワイヤ(§7.3 — 様式の知見:
 * Mizu-threejs/tests/sim/MizuSimulator3D.golden.test.ts)。
 *
 * seed=7 で 1800 step(30 s)回した後の view バッファ総和チェックサム・
 * SimCounts・累計イベント数を記録値で assert する。
 *
 * ⚠ このテストが壊れたら:
 * 1. まず RNG 呼び順規約(src/sim/chem/AtomFactory.ts の doc)からの
 *    逸脱を疑う — 意図しない消費順の変化が最頻の事故
 * 2. 挙動を意図して変えた場合のみ、下の EXPECTED を再記録して commit する
 *    (再記録は「変更管理手順」— コミットメッセージに理由を書くこと)
 * 注: チェックサムは同一エンジンでの決定論を固定する(Math.sin/cos の
 * 実装差があるため異エンジン間の一致までは保証しない — threejs と同じ運用)。
 */

const checksum = (arr: Float32Array, count: number, stride: number): number => {
  let sum = 0;
  for (let i = 0; i < count * stride; i++) sum += arr[i];
  return sum;
};

interface GoldenRecord {
  bubbles: number;
  bubblesPrev: number;
  atoms: number;
  atomsColor: number;
  droplets: number;
  atomCount: number;
  dropletCount: number;
  splashSum: number;
  rippleSum: number;
  h: number;
  o: number;
  h2: number;
  dropletsLive: number;
  splashesTotal: number;
  absorbedTotal: number;
  dissolvedTotal: number;
  meanFill01: number;
}

const runGolden = (slotCount: number): GoldenRecord => {
  const sim = new MizuNiNaruSim();
  sim.init({ seed: 7, slotCount });
  let splashSum = 0;
  let rippleSum = 0;
  for (let s = 0; s < 1800; s++) {
    sim.step();
    const v = sim.view();
    splashSum += v.splashes.count;
    rippleSum += v.ripples.count;
  }
  const v = sim.view();
  const c = sim.counts();
  return {
    bubbles: checksum(v.bubbles.data, v.bubbles.count, 8),
    bubblesPrev: checksum(v.bubbles.prevData, v.bubbles.count, 8),
    atoms: checksum(v.atoms.posr, v.atoms.count, 4),
    atomsColor: checksum(v.atoms.colorKind, v.atoms.count, 4),
    droplets: checksum(v.droplets.posr, v.droplets.count, 4),
    atomCount: v.atoms.count,
    dropletCount: v.droplets.count,
    splashSum,
    rippleSum,
    h: c.h,
    o: c.o,
    h2: c.h2,
    dropletsLive: c.droplets,
    splashesTotal: c.splashesTotal,
    absorbedTotal: c.dropletsAbsorbedTotal,
    dissolvedTotal: c.dissolvedTotal,
    meanFill01: c.meanFill01,
  };
};

/**
 * 記録値(seed=7・1800 step)。再記録時は上の手順コメントを読むこと。
 * 2026-07-11 再記録: A30(12/7 球・二重リング SlotRing)で配置の RNG 消費と
 * スロット数が意図して変わったため(変更管理手順に基づく再記録)。
 */
const EXPECTED_DESKTOP: GoldenRecord = {
  bubbles: 82.64781701518586,
  bubblesPrev: 82.65873884414759,
  atoms: 836.3408926408738,
  atomsColor: 546.8437252640724,
  droplets: 28.703170500695705,
  atomCount: 202,
  dropletCount: 5,
  splashSum: 2,
  rippleSum: 152,
  h: 99,
  o: 71,
  h2: 32,
  dropletsLive: 5,
  splashesTotal: 2,
  absorbedTotal: 110,
  dissolvedTotal: 42,
  meanFill01: 0.3122864617617281,
};

const EXPECTED_MOBILE: GoldenRecord = {
  bubbles: 47.97128150227945,
  bubblesPrev: 47.84718905808404,
  atoms: 531.0043353140354,
  atomsColor: 356.214117616415,
  droplets: 21.089731879532337,
  atomCount: 133,
  dropletCount: 4,
  splashSum: 1,
  rippleSum: 100,
  h: 67,
  o: 45,
  h2: 21,
  dropletsLive: 4,
  splashesTotal: 1,
  absorbedTotal: 84,
  dissolvedTotal: 16,
  meanFill01: 0.3129974623659507,
};

const assertGolden = (actual: GoldenRecord, expected: GoldenRecord): void => {
  // 空虚テスト防止(threejs 知見): 世界が実際に動いたことを先に固定
  expect(actual.atomCount).toBeGreaterThan(0);
  expect(actual.absorbedTotal).toBeGreaterThan(0);
  expect(actual.rippleSum).toBeGreaterThan(0);
  for (const key of Object.keys(expected) as (keyof GoldenRecord)[]) {
    if (typeof expected[key] === 'number' && !Number.isInteger(expected[key])) {
      expect(actual[key], key).toBeCloseTo(expected[key], 9);
    } else {
      expect(actual[key], key).toBe(expected[key]);
    }
  }
};

describe('MizuNiNaruSim ゴールデン(seed=7・1800 step)', () => {
  it('desktop(12 球)が記録値と一致する', () => {
    assertGolden(runGolden(12), EXPECTED_DESKTOP);
  });

  it('mobile(7 球)が記録値と一致する', () => {
    assertGolden(runGolden(7), EXPECTED_MOBILE);
  });

  it('2 回実行が同一(同一プロセス内の再現性 — init が完全リセットする)', () => {
    const a = runGolden(12);
    const b = runGolden(12);
    expect(a).toEqual(b);
  });

  it('同一インスタンスの re-init でも同一(状態のリーク無し)', () => {
    const sim = new MizuNiNaruSim();
    const runOnce = (): number => {
      sim.init({ seed: 42, slotCount: 12 });
      for (let s = 0; s < 600; s++) sim.step();
      const v = sim.view();
      return (
        checksum(v.bubbles.data, v.bubbles.count, 8) +
        checksum(v.atoms.posr, v.atoms.count, 4)
      );
    };
    expect(runOnce()).toBe(runOnce());
  });

  it('異 seed は異なる世界を生む(seed が実際に効いている)', () => {
    const sim1 = new MizuNiNaruSim();
    sim1.init({ seed: 1, slotCount: 12 });
    const sim2 = new MizuNiNaruSim();
    sim2.init({ seed: 2, slotCount: 12 });
    for (let s = 0; s < 60; s++) {
      sim1.step();
      sim2.step();
    }
    const v1 = sim1.view();
    const v2 = sim2.view();
    expect(checksum(v1.bubbles.data, 12, 8)).not.toBe(
      checksum(v2.bubbles.data, 12, 8),
    );
  });
});
