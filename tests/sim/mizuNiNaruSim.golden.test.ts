import { describe, expect, it, vi } from 'vitest';
import { SLOT_COUNT_DESKTOP } from '../../src/contract/WorldSpec';
import { MizuNiNaruSim } from '../../src/sim/MizuNiNaruSim';

/**
 * ゴールデントリップワイヤ(§7.3 — 様式の知見:
 * Mizu-threejs/tests/sim/MizuSimulator3D.golden.test.ts)。
 *
 * 主系列: seed=7・slotCount=12 で 1800 step(30 s)回した後の view バッファ
 * 総和チェックサム・SimCounts・累計イベント数を記録値で assert する
 * (高速・決定論の番犬として十分 — 球数を増やしても検知力は変わらない)。
 * 加えて 96 球(A35 構成)× 300 step の短いチェックサムを 1 本だけ追加し、
 * desktop スロット構成そのものの回帰を検知する。
 *
 * ⚠ このテストが壊れたら:
 * 1. まず RNG 呼び順規約(src/sim/chem/AtomFactory.ts の doc)からの
 *    逸脱を疑う — 意図しない消費順の変化が最頻の事故
 * 2. 挙動を意図して変えた場合のみ、下の EXPECTED を再記録して commit する
 *    (再記録は「変更管理手順」— コミットメッセージに理由を書くこと)
 * 注: チェックサムは同一エンジンでの決定論を固定する(Math.sin/cos の
 * 実装差があるため異エンジン間の一致までは保証しない — threejs と同じ運用)。
 *
 * 負荷環境では既定 5s を超え得るためファイル全体を 30s に緩める。
 */
vi.setConfig({ testTimeout: 30_000 });

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

const runGolden = (slotCount: number, steps = 1800): GoldenRecord => {
  const sim = new MizuNiNaruSim();
  sim.init({ seed: 7, slotCount });
  let splashSum = 0;
  let rippleSum = 0;
  for (let s = 0; s < steps; s++) {
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
 * 主系列 記録値(seed=7・slotCount=12・1800 step)。再記録時は上の手順コメントを読むこと。
 * 2026-07-11 再記録: A32(40/14 球 = 近リング 12/7 不変 + 外側環状フィールド
 * 28/7 SlotField)で配置の RNG 消費とスロット数が意図して変わったため
 * (変更管理手順に基づく再記録)。desktop はさらに校正ノブ調整
 * (SPAWN_INTERVAL_STEPS_DESKTOP 40→44、config.ts 参照)で再々記録。
 * 2026-07-11 再記録(2): A34(水面バウンド「ポチャ」InnerRipple 追加)で
 * rippleSum のみ増加(RNG 消費順は不変 — 他フィールドは無変更)。
 * 2026-07-11 再記録(3): A35(96/24 球 = 近リング 12/7 不変 + 外側環状
 * フィールド 84/17 に増量、フィールド半径帯 [8,26]→[8,45])でスロット数・
 * 配置の RNG 消費が意図して変わったため(変更管理手順に基づく再記録)。
 * 2026-07-11 再記録(4): 重いテストの整理(design-sim §7.3 方針)— 主系列を
 * slotCount=96(desktop)から slotCount=12 に切り替えた。これはテスト対象の
 * 挙動が変わったのではなく、テストパラメータ(球数)を変えたことによる
 * 再記録(境界・台帳ロジックの網羅性は球数に依存しないため、12 球で十分)。
 * 96 球構成そのものの回帰検知は下の EXPECTED_SMOKE_96(300 step)が担う。
 * 2026-07-11 再記録(5): A40(F_FULL 0.6→球ごとの一様帯 [0.8,0.9]、
 * VOLUME_GAIN 15→21、INITIAL_FILL_MAX 0.55→0.75 — 「もっと溜まってから
 * 落ちてほしい。0.8〜0.9 とかにできる?」)で落下トリガの fill01 閾値・
 * 体積換算・rollSlot の RNG 消費(閾値ロール +1 回)が意図して変わったため
 * (変更管理手順に基づく再記録)。
 * 2026-07-11 再記録(6): A40 最終指示(帯上限を 0.9→0.95 へ拡大、
 * VOLUME_GAIN 21→22 に再スケール)で fill01 閾値・体積換算が再度
 * 変わったため(変更管理手順に基づく再記録。rollSlot の RNG 消費順は
 * 再記録(5)から不変 — 帯の分布幅が変わるのみ)。
 * 2026-07-11 再記録(7): A42(球サイズをもっとバラバラに — R 帯
 * [1.1,1.7]→[0.75,2.3]、u² シェーピング、身の丈ロール上限
 * R_NEAR_RING_MAX=1.8/FIELD_INNER_MAX=1.3、SEPARATION_MAX_TRIES 16→32、
 * 全滅時をベスト候補フォールバックに変更)で R そのもの・分離チェックの
 * 試行数上限・フォールバック選択が意図して変わったため(変更管理手順に
 * 基づく再記録。RNG 呼び順は不変 — 1 スロットあたりの消費回数は
 * SEPARATION_MAX_TRIES 依存の可変長で従来通り、値のみ変わる)。
 * 2026-07-11 再記録(8): A42 校正(§7.5 ノブ①)で
 * SPAWN_INTERVAL_STEPS_DESKTOP 44→46 に再調整したため(config.ts 参照)。
 * slotCount=12 の主系列は SLOT_COUNT_MOBILE(24)以下 = mobile 扱いで
 * このノブの影響を受けず不変。96 球スモークのみ再記録。
 */
const EXPECTED_MAIN: GoldenRecord = {
  bubbles: 74.31109456199374,
  bubblesPrev: 74.33333979614872,
  atoms: 615.8828362887725,
  atomsColor: 563.2696081101894,
  droplets: 36.182194761931896,
  atomCount: 211,
  dropletCount: 4,
  splashSum: 2,
  rippleSum: 703,
  h: 106,
  o: 76,
  h2: 29,
  dropletsLive: 4,
  splashesTotal: 2,
  absorbedTotal: 144,
  dissolvedTotal: 64,
  meanFill01: 0.4668081433134574,
};

/**
 * 96 球スモーク 記録値(seed=7・slotCount=96・300 step)。A35 構成(近 12 +
 * フィールド 84)そのものの回帰を短時間で検知する。再記録手順は上と同じ。
 */
const EXPECTED_SMOKE_96: GoldenRecord = {
  bubbles: 635.2386147133075,
  bubblesPrev: 635.1143576246686,
  atoms: 7826.454512866214,
  atomsColor: 4504.336470156908,
  droplets: 78.16660223901272,
  atomCount: 1749,
  dropletCount: 21,
  splashSum: 0,
  rippleSum: 541,
  h: 918,
  o: 689,
  h2: 142,
  dropletsLive: 21,
  splashesTotal: 0,
  absorbedTotal: 49,
  dissolvedTotal: 32,
  meanFill01: 0.388220827917184,
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

describe('MizuNiNaruSim ゴールデン(seed=7)', () => {
  it('主系列(12 球・1800 step)が記録値と一致する', () => {
    assertGolden(runGolden(12, 1800), EXPECTED_MAIN);
  });

  it('96 球スモーク(近 12 + フィールド 84・300 step)が記録値と一致する', () => {
    assertGolden(runGolden(SLOT_COUNT_DESKTOP, 300), EXPECTED_SMOKE_96);
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
