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
 * 加えて 96 球(A35 構成)× 400 step の短いチェックサムを 1 本だけ追加し、
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
 * 96 球構成そのものの回帰検知は下の EXPECTED_SMOKE_96(400 step)が担う。
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
 * 2026-07-12 再記録(9): A53(WaterBody 二層化 — 台帳 V_ledger / 表示水位
 * V_eased の指数追従、config.WATER_EASE_K)で fill01/waterY の値そのものが
 * 変わったため(変更管理手順に基づく再記録)。**RNG 呼び順規約
 * (AtomFactory.ts の doc・walk/interactWater 内の呼び順)自体は不変** —
 * easing 計算(WaterBody.commit)は rng を一切呼ばない純算術。ただし
 * interactWater の RNG 消費は「粒子が水面と交差した step のみ 1 回」
 * (条件付き)なので、水面の上昇軌跡が変わったことで交差タイミングが変わり、
 * 結果として原子数・台帳内訳・チェックサムが連鎖的に変化した(呼び順その
 * ものの変更ではなく、条件分岐に入力される値が変わったことによる下流の
 * 分岐先変化 — 30 s のカオス的発散は A32/A40/A42 再記録時と同種の既知の
 * 現象)。校正実測(scripts/calibrate.mts)で T_fill・落下間隔が帯内に収まる
 * ことを確認済み(config.ts のコメント参照)。
 * 2026-07-12 再記録(10): A56(球の高さ帯上限 RING_Y_MAX 6.0→9.0 拡大)で
 * アンカー y のロール範囲そのものが変わったため(変更管理手順に基づく
 * 再記録)。**RNG 呼び順・消費回数は完全に不変**(y のロールは同じ
 * `RING_Y_MIN + rng.next()·(RING_Y_MAX−RING_Y_MIN)` 呼び出し 1 回のまま、
 * 出力範囲が広がっただけ)— そのため bubbles/bubblesPrev/atoms/droplets の
 * 位置チェックサムのみ変化し、atomCount/dropletCount/h/o/h2/splashesTotal/
 * absorbedTotal/dissolvedTotal/meanFill01/atomsColor/rippleSum/splashSum は
 * ビット単位で不変(個体群動態・化学は高さ帯と独立というスケール不変性の
 * 裏付け)。
 * 2026-07-12 再記録(11): A62(球の高さ帯上限 RING_Y_MAX 9.0→7.5 に再調整
 * — 「まだ球体が少し角ばって見える」ユーザー報告への対応)で、再記録(10)と
 * 同じ理由(アンカー y のロール範囲のみ変化、RNG 呼び順・消費回数は完全に
 * 不変)により bubbles/bubblesPrev/atoms/droplets の位置チェックサムのみ
 * 再度変化。他フィールドはビット単位で不変(再確認)。
 * 2026-07-12 再記録(12): A63(RING_Y_MAX を 7.5→9.0 に復元 — A62 の縮小が
 * ファセット再現に効果を示せなかったため、ユーザー指示で A56 相当に戻した)。
 * config.ts が A56 と完全に同じ値に戻ったため、位置チェックサム
 * (bubbles/bubblesPrev/atoms/droplets)は再記録(10)(A56 時点)の値と
 * ビット単位で一致(RNG 呼び順・消費回数は不変のまま出力範囲が戻っただけ)。
 * 他フィールドは再記録(11)から変化なし。
 * 2026-07-12 再記録(13): A65(初期化時の実球出現を段階湧きに変更 —
 * 「最初の画面表示でいきなり全部同時に丸くなる違和感」対応)。init() が
 * 全スロット rollSlot(Spawning)の直後、1 個(index 0)を除く全スロットを
 * BubbleFsm.enterDead + world.drainWater で Dead に上書きし、通常の
 * Splashing→Dead 遷移と同じ乱数遅延(RESPAWN_DELAY_MIN_S〜MAX_S)を
 * `rng.next()` でロールするため、**RNG 消費順そのものが変わる**(rollSlot
 * 一式完了後にスロット昇順で deadDurationSteps ロールが追加される)。
 * これにより見た目のスタッガー(段階湧き)だけでなく、以降の全 RNG 消費が
 * カスケードして atoms/droplets/h/o/h2 等の下流値も連鎖的に変化する
 * (A32/A40/A42/A53 再記録時と同種の既知の現象 — 意図した RNG 順変更に
 * 伴う正当な再記録)。校正・レンダー(glass.ts の grow アニメ)は無改修
 * (master-plan.md A65 参照)。
 * 2026-07-12 再記録(14): A66(初期化バースト窓を RESPAWN_DELAY_MIN_S/MAX_S
 * 〈4〜10 s〉から新設の INITIAL_SPAWN_STAGGER_MIN_S/MAX_S〈0〜3 s〉に
 * 差し替え — 「最初にひとつだけだと寂しい」ユーザー報告への対応)。
 * deadDurationSteps ロールの `rng.next()` 呼び出し回数・順序は再記録(13)
 * から不変(同じループ・同じ1回ロール)だが、ロール結果の**数値範囲**が
 * 変わるため各スロットの Dead→Spawning 遷移 step が変わり、以降の全 RNG
 * 消費がカスケードして下流値も連鎖的に変化する(再記録(13)と同種の正当な
 * 再記録)。通常再湧き用の RESPAWN_DELAY_MIN_S/MAX_S 自体は無変更
 * (BubbleFsm.ts の通常経路は無改修 — master-plan.md A66 参照)。
 * 2026-07-12 再記録(15): A67(「最初の1個の描画位置は固定なのか?」という
 * ユーザー報告への対応 — `SlotRing.rollInto` は others が完全に空〈=
 * init 冒頭で最初にロールされる index 0 のみ該当〉のとき、分離チェックの
 * スコアがフォールバック候補〈ジッターなし基準位置〉のまま即座に
 * solved=true になり、ジッター抽選ループに一切入らずに確定していたため、
 * INITIAL_VISIBLE_SLOT〈index 0〉の座標が seed によらず常に同一だった)。
 * others が完全に空の場合に限り、無ジッターのフォールバック候補ではなく
 * 既存のジッター式(角・半径・y)を1回だけ適用した候補を採用するよう修正
 * (master-plan.md A67 参照)。others が空でない通常時の分岐・RNG 消費は
 * 完全に不変。others が空の index 0 のみ `rng.next()` を追加で3回消費する
 * ため(角・半径・y のジッター — 従来は0回)、init() 以降の全 RNG 消費が
 * カスケードして下流値も連鎖的に変化する(再記録(13)/(14)と同種の正当な
 * 再記録)。**96 球スモークのみ追加で steps を 300→400 に変更**: RNG 順
 * 変化のカスケードにより 300 step 時点で absorbedTotal が偶然 0 になり
 * (「空虚テスト防止」の `expect(actual.absorbedTotal).toBeGreaterThan(0)`
 * に抵触)、実測で absorbedTotal は step 350 付近から非ゼロになることを
 * 確認したため、余裕を持たせて 400 step に変更した(スモーク検知対象の
 * 96 球構成・境界ロジック自体は無変更 — テストの安定性のためのみの調整)。
 * 主系列(12 球・1800 step)は steps 変更なし。
 * 2026-07-12 再記録(16): A68(初期段階湧きを desktop 限定にし、mobile は
 * 従来の全実球同時 Spawning に戻す — 「スマホの場合は今まで通りにしたい」
 * ユーザー要望への対応)。主系列は slotCount=12(≤ SLOT_COUNT_MOBILE=24)=
 * mobile 扱いのため、init() の A65〜A66 段階湧きループ(Dead 化 +
 * deadDurationSteps ロール)がまるごとスキップされるようになった
 * (`pacing === 'desktop'` の分岐外)。これにより主系列の RNG 消費順は
 * 再記録(13)以前(A65 導入前)の状態に戻り、下流の全値が連鎖的に変化する
 * (再記録(13)/(14)/(15)と同種・逆方向の正当な再記録)。**A67(index 0 の
 * ジッター修正)は mobile でも引き続き有効**(others が空の状態で最初に
 * ロールされるのは mobile でも index 0 のままのため)。96 球スモーク
 * (desktop 扱い)は A68 の分岐条件により従来どおり段階湧きループが実行され、
 * 数値上ビット単位で不変(実測で再確認済み)。
 */
const EXPECTED_MAIN: GoldenRecord = {
  bubbles: 96.21230888972059,
  bubblesPrev: 96.0938917658641,
  atoms: 764.317950990051,
  atomsColor: 454.5858820974827,
  droplets: 67.49942880123854,
  atomCount: 178,
  dropletCount: 5,
  splashSum: 2,
  rippleSum: 725,
  h: 99,
  o: 63,
  h2: 16,
  dropletsLive: 5,
  splashesTotal: 2,
  absorbedTotal: 160,
  dissolvedTotal: 57,
  meanFill01: 0.4849848308525316,
};

/**
 * 96 球スモーク 記録値(seed=7・slotCount=96・400 step)。A35 構成(近 12 +
 * フィールド 84)そのものの回帰を短時間で検知する。再記録手順は上と同じ
 * (steps=300→400 に変更した理由は再記録(15)のコメント参照)。
 */
const EXPECTED_SMOKE_96: GoldenRecord = {
  bubbles: 641.0690765748732,
  bubblesPrev: 641.0885231024586,
  atoms: 11175.275766367093,
  atomsColor: 4851.094311982393,
  droplets: -95.49594381451607,
  atomCount: 1918,
  dropletCount: 23,
  splashSum: 0,
  rippleSum: 20,
  h: 1058,
  o: 751,
  h2: 109,
  dropletsLive: 23,
  splashesTotal: 0,
  absorbedTotal: 4,
  dissolvedTotal: 3,
  meanFill01: 0.008304874061149705,
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

  it('96 球スモーク(近 12 + フィールド 84・400 step)が記録値と一致する', () => {
    assertGolden(runGolden(SLOT_COUNT_DESKTOP, 400), EXPECTED_SMOKE_96);
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
