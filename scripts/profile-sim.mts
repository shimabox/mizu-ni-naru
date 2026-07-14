/**
 * MizuNiNaruSimのメソッド境界inclusive profiler。
 * wrapperのオーバーヘッドを含むため、絶対値ではなく構成比の比較に使う。
 *
 * 使用例:
 *   npm run profile:sim
 *   npm run profile:sim -- --slots 24 --rounds 7 --warmup 2000 --steps 10000
 */
import { performance } from 'node:perf_hooks';
import { BubbleWorld } from '../src/sim/bubble/BubbleWorld';
import { DropletColumn } from '../src/sim/droplets/DropletColumn';
import { MizuNiNaruSim } from '../src/sim/MizuNiNaruSim';
import { GridDetector } from '../src/sim/physics/GridDetector';
import { OrderedDirectDetector } from '../src/sim/physics/OrderedDirectDetector';
import { SphereGrid } from '../src/sim/physics/SphereGrid';
import { AggregatePacker } from '../src/sim/view/AggregatePacker';
import { WaterBody } from '../src/sim/water/WaterBody';

interface Options {
  seed: number;
  slotCount: number;
  warmupSteps: number;
  measureSteps: number;
  rounds: number;
}

interface RecordValue {
  calls: number;
  elapsedMs: number;
}

const positiveInteger = (name: string, raw: string | undefined): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer: ${String(raw)}`);
  }
  return value;
};

const parseArgs = (): Options => {
  const args = process.argv.slice(2);
  const options: Options = {
    seed: 7,
    slotCount: 24,
    warmupSteps: 2_000,
    measureSteps: 10_000,
    rounds: 7,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--seed') options.seed = positiveInteger(arg, args[++i]);
    else if (arg === '--slots') {
      options.slotCount = positiveInteger(arg, args[++i]);
    } else if (arg === '--warmup') {
      options.warmupSteps = positiveInteger(arg, args[++i]);
    } else if (arg === '--steps') {
      options.measureSteps = positiveInteger(arg, args[++i]);
    } else if (arg === '--rounds') {
      options.rounds = positiveInteger(arg, args[++i]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
};

const records = new Map<string, RecordValue>();
let recording = false;

const instrument = (label: string, prototype: object, key: string): void => {
  const target = prototype as Record<string, (...args: unknown[]) => unknown>;
  const original = target[key];
  records.set(label, { calls: 0, elapsedMs: 0 });
  target[key] = function (this: unknown, ...args: unknown[]) {
    if (!recording) return original.apply(this, args);
    const start = performance.now();
    try {
      return original.apply(this, args);
    } finally {
      const record = records.get(label);
      if (!record) throw new Error(`Missing profile record: ${label}`);
      record.calls++;
      record.elapsedMs += performance.now() - start;
    }
  };
};

const options = parseArgs();
instrument('BubbleWorld.step', BubbleWorld.prototype, 'step');
instrument(
  'OrderedDirectDetector.findPairs',
  OrderedDirectDetector.prototype,
  'findPairs',
);
instrument('GridDetector.findPairs', GridDetector.prototype, 'findPairs');
instrument('SphereGrid.rebuild', SphereGrid.prototype, 'rebuild');
instrument('DropletColumn.step', DropletColumn.prototype, 'step');
instrument('AggregatePacker.pack', AggregatePacker.prototype, 'pack');
instrument('WaterBody.commit', WaterBody.prototype, 'commit');

const roundResults = Array.from({ length: options.rounds }, () => {
  const sim = new MizuNiNaruSim();
  sim.init({
    seed: options.seed,
    slotCount: options.slotCount,
    pacing: 'desktop',
  });
  for (let step = 0; step < options.warmupSteps; step++) sim.step();

  for (const record of records.values()) {
    record.calls = 0;
    record.elapsedMs = 0;
  }
  recording = true;
  const start = performance.now();
  for (let step = 0; step < options.measureSteps; step++) sim.step();
  const elapsedMs = performance.now() - start;
  recording = false;

  return {
    totalElapsedMs: elapsedMs,
    totalMsPerStep: elapsedMs / options.measureSteps,
    records: [...records]
      .map(([name, record]) => ({
        name,
        calls: record.calls,
        elapsedMs: record.elapsedMs,
        msPerSimStep: record.elapsedMs / options.measureSteps,
        inclusiveShareOfInstrumentedTotal: record.elapsedMs / elapsedMs,
      }))
      .filter((record) => record.calls > 0),
    counts: sim.counts(),
  };
});

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const recordNames = roundResults[0]?.records.map((record) => record.name) ?? [];
const summary = {
  totalSamplesMsPerStep: roundResults.map((round) => round.totalMsPerStep),
  totalMedianMsPerStep: median(
    roundResults.map((round) => round.totalMsPerStep),
  ),
  records: recordNames.map((name) => {
    const samples = roundResults.map((round) => {
      const record = round.records.find((candidate) => candidate.name === name);
      if (!record) throw new Error(`Missing round record: ${name}`);
      return record.msPerSimStep;
    });
    return { name, samplesMsPerStep: samples, medianMsPerStep: median(samples) };
  }),
};

process.stdout.write(
  `${JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      options,
      summary,
      rounds: roundResults,
    },
    null,
    2,
  )}\n`,
);
