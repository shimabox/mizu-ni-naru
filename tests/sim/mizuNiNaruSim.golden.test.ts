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
 * 2026-07-11 再記録(3): A35(96/24 球 = 近リング 12/7 不変 + 外側環状
 * フィールド 84/17 に増量、フィールド半径帯 [8,26]→[8,45])でスロット数・
 * 配置の RNG 消費が意図して変わったため(変更管理手順に基づく再記録)。
 */
const EXPECTED_DESKTOP: GoldenRecord = {
  bubbles: 665.1679266174763,
  bubblesPrev: 665.2341240962184,
  atoms: 6701.429139468353,
  atomsColor: 4095.045686542988,
  droplets: 9.872601643204689,
  atomCount: 1528,
  dropletCount: 40,
  splashSum: 16,
  rippleSum: 4521,
  h: 759,
  o: 542,
  h2: 227,
  dropletsLive: 40,
  splashesTotal: 16,
  absorbedTotal: 888,
  dissolvedTotal: 299,
  meanFill01: 0.3166439957040017,
};

const EXPECTED_MOBILE: GoldenRecord = {
  bubbles: 220.53248112382278,
  bubblesPrev: 220.54260881031058,
  atoms: 3614.5375933256,
  atomsColor: 1192.1188234090805,
  droplets: 211.3657824397087,
  atomCount: 450,
  dropletCount: 13,
  splashSum: 5,
  rippleSum: 1196,
  h: 226,
  o: 162,
  h2: 62,
  dropletsLive: 13,
  splashesTotal: 5,
  absorbedTotal: 264,
  dissolvedTotal: 80,
  meanFill01: 0.281900764696411,
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
  it('desktop(96 球 = 近 12 + フィールド 84)が記録値と一致する', () => {
    assertGolden(runGolden(SLOT_COUNT_DESKTOP), EXPECTED_DESKTOP);
  });

  it('mobile(24 球 = 近 7 + フィールド 17)が記録値と一致する', () => {
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
