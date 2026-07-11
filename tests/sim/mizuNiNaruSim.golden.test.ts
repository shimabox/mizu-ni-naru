import { describe, expect, it } from 'vitest';
import {
  SLOT_COUNT_DESKTOP,
  SLOT_COUNT_MOBILE,
} from '../../src/contract/WorldSpec';
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
 * 2026-07-11 再記録: A32(40/14 球 = 近リング 12/7 不変 + 外側環状フィールド
 * 28/7 SlotField)で配置の RNG 消費とスロット数が意図して変わったため
 * (変更管理手順に基づく再記録)。desktop はさらに校正ノブ調整
 * (SPAWN_INTERVAL_STEPS_DESKTOP 40→44、config.ts 参照)で再々記録。
 * 2026-07-11 再記録(2): A34(水面バウンド「ポチャ」InnerRipple 追加)で
 * rippleSum のみ増加(RNG 消費順は不変 — 他フィールドは無変更)。
 */
const EXPECTED_DESKTOP: GoldenRecord = {
  bubbles: 294.92617119963506,
  bubblesPrev: 294.94060419272864,
  atoms: 3264.266298341565,
  atomsColor: 1637.4129405915737,
  droplets: 115.36738757789135,
  atomCount: 629,
  dropletCount: 20,
  splashSum: 7,
  rippleSum: 1918,
  h: 329,
  o: 226,
  h2: 74,
  dropletsLive: 20,
  splashesTotal: 7,
  absorbedTotal: 379,
  dissolvedTotal: 132,
  meanFill01: 0.3253196862878686,
};

const EXPECTED_MOBILE: GoldenRecord = {
  bubbles: 122.69174901340088,
  bubblesPrev: 122.70254082342578,
  atoms: 1986.4028758518398,
  atomsColor: 720.9103918075562,
  droplets: 13.10653506219387,
  atomCount: 267,
  dropletCount: 5,
  splashSum: 3,
  rippleSum: 671,
  h: 132,
  o: 97,
  h2: 38,
  dropletsLive: 5,
  splashesTotal: 3,
  absorbedTotal: 144,
  dissolvedTotal: 41,
  meanFill01: 0.2845911103805818,
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
  it('desktop(40 球 = 近 12 + フィールド 28)が記録値と一致する', () => {
    assertGolden(runGolden(SLOT_COUNT_DESKTOP), EXPECTED_DESKTOP);
  });

  it('mobile(14 球 = 近 7 + フィールド 7)が記録値と一致する', () => {
    assertGolden(runGolden(SLOT_COUNT_MOBILE), EXPECTED_MOBILE);
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
