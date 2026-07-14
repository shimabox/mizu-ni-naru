/**
 * MizuNiNaruSimの再現可能なwall-time benchmark。
 *
 * 使用例:
 *   npm run bench:sim
 *   npm run bench:sim -- --slots 24,128 --rounds 7 --warmup 2000 --steps 10000
 */
import { cpus, freemem, platform, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { MizuNiNaruSim } from '../src/sim/MizuNiNaruSim';

interface Options {
  seed: number;
  slotCounts: number[];
  pacing: 'desktop' | 'mobile';
  warmupSteps: number;
  measureSteps: number;
  rounds: number;
}

interface RoundResult {
  elapsedMs: number;
  msPerStep: number;
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
    slotCounts: [24, 128],
    pacing: 'desktop',
    warmupSteps: 2_000,
    measureSteps: 10_000,
    rounds: 7,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--seed') options.seed = positiveInteger(arg, args[++i]);
    else if (arg === '--slots') {
      options.slotCounts = (args[++i] ?? '')
        .split(',')
        .map((value) => positiveInteger(arg, value));
    } else if (arg === '--pacing') {
      const pacing = args[++i];
      if (pacing !== 'desktop' && pacing !== 'mobile') {
        throw new Error(`--pacing must be desktop or mobile: ${String(pacing)}`);
      }
      options.pacing = pacing;
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

  if (options.slotCounts.length === 0) {
    throw new Error('--slots must contain at least one value');
  }
  return options;
};

const quantile = (sorted: readonly number[], q: number): number => {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1);
  return sorted[index];
};

const benchmark = (slotCount: number, options: Options) => {
  const rounds: RoundResult[] = [];
  let finalCounts: ReturnType<MizuNiNaruSim['counts']> | undefined;

  for (let round = 0; round < options.rounds; round++) {
    const sim = new MizuNiNaruSim();
    sim.init({
      seed: options.seed,
      slotCount,
      pacing: options.pacing,
    });
    for (let step = 0; step < options.warmupSteps; step++) sim.step();

    const start = performance.now();
    for (let step = 0; step < options.measureSteps; step++) sim.step();
    const elapsedMs = performance.now() - start;
    rounds.push({ elapsedMs, msPerStep: elapsedMs / options.measureSteps });
    finalCounts = sim.counts();
  }

  const sorted = rounds
    .map((round) => round.msPerStep)
    .sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance =
    sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    sorted.length;

  return {
    slotCount,
    samplesMsPerStep: rounds.map((round) => round.msPerStep),
    minMsPerStep: sorted[0],
    medianMsPerStep: quantile(sorted, 0.5),
    p95MsPerStep: quantile(sorted, 0.95),
    maxMsPerStep: sorted[sorted.length - 1],
    meanMsPerStep: mean,
    coefficientOfVariation: Math.sqrt(variance) / mean,
    finalCounts,
  };
};

const options = parseArgs();
const cpu = cpus()[0];
process.stdout.write(
  `${JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: platform(),
        release: release(),
        architecture: process.arch,
        cpu: cpu?.model ?? 'unknown',
        logicalCpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
        freeMemoryBytesAtStart: freemem(),
      },
      options,
      results: options.slotCounts.map((slotCount) =>
        benchmark(slotCount, options),
      ),
    },
    null,
    2,
  )}\n`,
);
