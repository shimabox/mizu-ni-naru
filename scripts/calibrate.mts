/**
 * ヘッドレス校正スクリプト(design-sim §7.5 — テストの外)。
 *
 *   mise exec -- npm run calibrate            # 既定: seed 7,42,123,2026 × 900 s
 *   mise exec -- npm run calibrate -- --seconds 600 --seeds 1,2,3 --out calibrate-out
 *
 * 測定:
 * - T_fill: 各スロットの「Drifting 進入(fill ≈ 0)→ Falling 進入」の実時間
 *   (近リング + 外側フィールドの全スロット対象。起動スタッガー世代
 *   (初期 fill > 0.05)は除外する)
 * - 落下間隔(近リング): 近リングのスロット(desktop 12 / mobile 7 — A32 で
 *   不変)のみで SplashEvent(Falling→Splashing 遷移)間の実時間
 * - 落下間隔(シーン全体): 全スロット(近リング + フィールド)での落下間隔。
 *   受入バンドは張らない(A32: 「数秒に 1 回どこかで球が還る」の実測報告のみ)
 * - 体積シェア: 雫吸収 vs 原子/H2 溶解が運んだ水体積の比
 *
 * 受入バンド(A30 で確立・A32 でも不変): T_fill ∈ [90, 150] s、
 * 近リングの落下間隔(平均)は desktop(近 12 球)∈ [11, 20] s /
 * mobile(近 7 球)∈ [15, 25] s。
 * 外れた場合のノブ優先順位:
 * ① SPAWN_INTERVAL_STEPS(線形で効く)② VOLUME_GAIN(粒数を変えず時間だけ動く)
 * ③ P_DISSOLVE(シェア補正)。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUBBLE_STATE,
  SLOT_COUNT_DESKTOP,
  SLOT_COUNT_MOBILE,
  STEP_HZ,
} from '../src/contract/WorldSpec';
import {
  NEAR_RING_COUNT_DESKTOP,
  NEAR_RING_COUNT_MOBILE,
} from '../src/sim/config';
import { MizuNiNaruSim } from '../src/sim/MizuNiNaruSim';

interface RunResult {
  preset: string;
  seed: number;
  tFills: number[]; // s(定常世代のみ、全スロット)
  intervalsNear: number[]; // s(近リングの splash 間)
  intervalsAll: number[]; // s(シーン全体の splash 間 — 報告のみ)
  splashCountNear: number;
  splashCountAll: number;
  dropletShare: number; // 体積シェア(雫)
  dissolveShare: number;
  finalCounts: ReturnType<MizuNiNaruSim['counts']>;
}

const parseArgs = (): { seconds: number; seeds: number[]; out: string } => {
  const args = process.argv.slice(2);
  let seconds = 900;
  let seeds = [7, 42, 123, 2026];
  let out = 'calibrate-out';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--seconds') seconds = Number(args[++i]);
    else if (args[i] === '--seeds') {
      seeds = args[++i].split(',').map(Number);
    } else if (args[i] === '--out') out = args[++i];
  }
  return { seconds, seeds, out };
};

const run = (
  preset: 'desktop' | 'mobile',
  slotCount: number,
  nearCount: number,
  seed: number,
  seconds: number,
): RunResult => {
  const sim = new MizuNiNaruSim();
  // A70: pacing を明示指定(SLOT_COUNT_DESKTOP/MOBILE の大小関係からの推測に
  // 依存しない — src/app/main.ts と同じ理由。詳細は master-plan.md A70 参照)
  sim.init({ seed, slotCount, pacing: preset });
  const steps = Math.round(seconds * STEP_HZ);
  const prevState = new Int32Array(slotCount).fill(-1);
  const driftEntryStep = new Float64Array(slotCount).fill(-1);
  const driftEntryFill = new Float64Array(slotCount).fill(-1);
  const tFills: number[] = [];
  const splashStepsNear: number[] = [];
  const splashStepsAll: number[] = [];

  for (let s = 1; s <= steps; s++) {
    sim.step();
    const v = sim.view();
    for (let b = 0; b < slotCount; b++) {
      const bo = b * 8;
      const state = Math.floor(v.bubbles.data[bo + 7]);
      if (state !== prevState[b]) {
        if (state === BUBBLE_STATE.Drifting) {
          driftEntryStep[b] = s;
          driftEntryFill[b] = v.bubbles.data[bo + 5];
        } else if (state === BUBBLE_STATE.Falling && driftEntryStep[b] >= 0) {
          // 定常世代のみ(起動スタッガーの初期 fill を除外)
          if (driftEntryFill[b] < 0.05) {
            tFills.push((s - driftEntryStep[b]) / STEP_HZ);
          }
          driftEntryStep[b] = -1;
        } else if (state === BUBBLE_STATE.Splashing) {
          // 着水(Falling→Splashing 遷移)— スロット単位で近リング/全体に集計
          splashStepsAll.push(s);
          if (b < nearCount) splashStepsNear.push(s);
        }
        prevState[b] = state;
      }
    }
  }

  const gaps = (xs: number[]): number[] => {
    const out: number[] = [];
    for (let i = 1; i < xs.length; i++) out.push((xs[i] - xs[i - 1]) / STEP_HZ);
    return out;
  };
  const ledger = sim.ledger();
  const totalVol = ledger.volumeFromDroplets + ledger.volumeFromDissolve;
  return {
    preset,
    seed,
    tFills,
    intervalsNear: gaps(splashStepsNear),
    intervalsAll: gaps(splashStepsAll),
    splashCountNear: splashStepsNear.length,
    splashCountAll: splashStepsAll.length,
    dropletShare: totalVol > 0 ? ledger.volumeFromDroplets / totalVol : 0,
    dissolveShare: totalVol > 0 ? ledger.volumeFromDissolve / totalVol : 0,
    finalCounts: sim.counts(),
  };
};

const stats = (
  xs: number[],
): { n: number; mean: number; median: number; min: number; max: number } => {
  if (xs.length === 0) return { n: 0, mean: 0, median: 0, min: 0, max: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const median =
    sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return {
    n: xs.length,
    mean,
    median,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
};

const fmt = (x: number): string => x.toFixed(1);

const main = (): void => {
  const { seconds, seeds, out } = parseArgs();
  mkdirSync(out, { recursive: true });

  const presets: {
    name: 'desktop' | 'mobile';
    slots: number;
    nearCount: number;
    ivBand: [number, number];
  }[] = [
    {
      name: 'desktop',
      slots: SLOT_COUNT_DESKTOP,
      nearCount: NEAR_RING_COUNT_DESKTOP,
      ivBand: [11, 20],
    },
    {
      name: 'mobile',
      slots: SLOT_COUNT_MOBILE,
      nearCount: NEAR_RING_COUNT_MOBILE,
      ivBand: [15, 25],
    },
  ];
  const results: RunResult[] = [];
  for (const p of presets) {
    for (const seed of seeds) {
      const t0 = performance.now();
      const r = run(p.name, p.slots, p.nearCount, seed, seconds);
      const wall = performance.now() - t0;
      results.push(r);
      console.log(
        `[${p.name} seed=${seed}] ${seconds}s sim in ${wall.toFixed(0)}ms — ` +
          `splashes near/all=${r.splashCountNear}/${r.splashCountAll}, tFill n=${r.tFills.length}, ` +
          `share droplet/dissolve = ${(r.dropletShare * 100).toFixed(1)}%/${(r.dissolveShare * 100).toFixed(1)}%`,
      );
    }
  }

  // ── CSV(生データ)
  const tfillRows = ['preset,seed,t_fill_s'];
  const intervalRows = ['preset,seed,scope,interval_s'];
  const summaryRows = [
    'preset,seed,seconds,splashes_near,splashes_all,tfill_n,tfill_mean,tfill_median,tfill_min,tfill_max,' +
      'interval_near_n,interval_near_mean,interval_near_median,interval_all_n,interval_all_mean,interval_all_median,' +
      'droplet_share,dissolve_share,h,o,h2',
  ];
  for (const r of results) {
    for (const t of r.tFills) tfillRows.push(`${r.preset},${r.seed},${t.toFixed(2)}`);
    for (const t of r.intervalsNear)
      intervalRows.push(`${r.preset},${r.seed},near,${t.toFixed(2)}`);
    for (const t of r.intervalsAll)
      intervalRows.push(`${r.preset},${r.seed},all,${t.toFixed(2)}`);
    const tf = stats(r.tFills);
    const ivN = stats(r.intervalsNear);
    const ivA = stats(r.intervalsAll);
    summaryRows.push(
      [
        r.preset,
        r.seed,
        seconds,
        r.splashCountNear,
        r.splashCountAll,
        tf.n,
        fmt(tf.mean),
        fmt(tf.median),
        fmt(tf.min),
        fmt(tf.max),
        ivN.n,
        fmt(ivN.mean),
        fmt(ivN.median),
        ivA.n,
        fmt(ivA.mean),
        fmt(ivA.median),
        r.dropletShare.toFixed(3),
        r.dissolveShare.toFixed(3),
        r.finalCounts.h,
        r.finalCounts.o,
        r.finalCounts.h2,
      ].join(','),
    );
  }
  writeFileSync(join(out, 'tfill.csv'), `${tfillRows.join('\n')}\n`);
  writeFileSync(join(out, 'intervals.csv'), `${intervalRows.join('\n')}\n`);
  writeFileSync(join(out, 'summary.csv'), `${summaryRows.join('\n')}\n`);

  // ── サマリ + 受入判定(プリセット単位で全 seed を併合)
  console.log(`\nCSV written to ${out}/ (tfill.csv, intervals.csv, summary.csv)\n`);
  let allPass = true;
  for (const p of presets) {
    const merged = results.filter((r) => r.preset === p.name);
    const tf = stats(merged.flatMap((r) => r.tFills));
    const ivN = stats(merged.flatMap((r) => r.intervalsNear));
    const ivA = stats(merged.flatMap((r) => r.intervalsAll));
    const share =
      merged.reduce((a, r) => a + r.dropletShare, 0) / merged.length;
    const tfillOk = tf.mean >= 90 && tf.mean <= 150;
    const ivOk = ivN.mean >= p.ivBand[0] && ivN.mean <= p.ivBand[1];
    if (p.name === 'desktop' && (!tfillOk || !ivOk)) allPass = false;
    console.log(
      `${p.name}(${p.slots} 球 = 近 ${p.nearCount} + フィールド ${p.slots - p.nearCount}): ` +
        `T_fill mean=${fmt(tf.mean)}s median=${fmt(tf.median)}s [${fmt(tf.min)}, ${fmt(tf.max)}] n=${tf.n} → ${tfillOk ? 'PASS' : 'FAIL'} (band 90–150)\n` +
        `  近リング落下間隔 mean=${fmt(ivN.mean)}s median=${fmt(ivN.median)}s n=${ivN.n} ` +
        `→ ${ivOk ? 'PASS' : 'FAIL'} (band ${p.ivBand[0]}–${p.ivBand[1]})\n` +
        `  シーン全体落下間隔(参考): mean=${fmt(ivA.mean)}s median=${fmt(ivA.median)}s n=${ivA.n}\n` +
        `  体積シェア: 雫 ${(share * 100).toFixed(1)}% / 溶解 ${((1 - share) * 100).toFixed(1)}%(設計 85/15)`,
    );
  }
  process.exitCode = allPass ? 0 : 1;
};

main();
