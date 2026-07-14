/** GridDetectorとordered-directの切替閾値を決めるmicrobenchmark。 */
import { performance } from 'node:perf_hooks';
import { Atom } from '../src/sim/chem/Atom';
import { Mulberry32 } from '../src/sim/core/Random';
import { GridDetector } from '../src/sim/physics/GridDetector';
import { OrderedDirectDetector } from '../src/sim/physics/OrderedDirectDetector';

const R_INNER = 1.316;

interface Options {
  counts: number[];
  iterations: number;
  rounds: number;
  seed: number;
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
    counts: [24, 40, 64, 128],
    iterations: 5_000,
    rounds: 5,
    seed: 7,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--counts') {
      options.counts = (args[++i] ?? '')
        .split(',')
        .map((value) => positiveInteger(arg, value));
    } else if (arg === '--iterations') {
      options.iterations = positiveInteger(arg, args[++i]);
    } else if (arg === '--rounds') {
      options.rounds = positiveInteger(arg, args[++i]);
    } else if (arg === '--seed') {
      options.seed = positiveInteger(arg, args[++i]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
};

const makeCloud = (seed: number, count: number): Atom[] => {
  const rng = new Mulberry32(seed);
  const atoms: Atom[] = [];
  while (atoms.length < count) {
    const x = (2 * rng.next() - 1) * R_INNER;
    const y = (2 * rng.next() - 1) * R_INNER;
    const z = (2 * rng.next() - 1) * R_INNER;
    if (x * x + y * y + z * z > R_INNER * R_INNER) continue;
    const radius = 0.06 + rng.next() * 0.066;
    atoms.push(new Atom(0, radius, x, y, z, 1, 1, 1, 0, 0));
  }
  return atoms;
};

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const options = parseArgs();
const maxCount = Math.max(...options.counts);
const grid = new GridDetector();
const direct = new OrderedDirectDetector(maxCount);

const results = options.counts.map((count) => {
  const atoms = makeCloud(options.seed + count, count);
  const gridOut: number[] = [];
  const directOut: number[] = [];
  const gridCount = grid.findPairs(atoms, R_INNER, gridOut);
  const directCount = direct.findPairs(atoms, R_INNER, directOut);
  if (gridCount !== directCount || gridOut.join(',') !== directOut.join(',')) {
    throw new Error(`Detector output mismatch at ${count} atoms`);
  }

  const gridSamples: number[] = [];
  const directSamples: number[] = [];
  for (let round = 0; round < options.rounds; round++) {
    const measure = (
      detector: GridDetector | OrderedDirectDetector,
      out: number[],
    ): number => {
      const start = performance.now();
      for (let iteration = 0; iteration < options.iterations; iteration++) {
        detector.findPairs(atoms, R_INNER, out);
      }
      return (performance.now() - start) / options.iterations;
    };
    if (round % 2 === 0) {
      gridSamples.push(measure(grid, gridOut));
      directSamples.push(measure(direct, directOut));
    } else {
      directSamples.push(measure(direct, directOut));
      gridSamples.push(measure(grid, gridOut));
    }
  }

  const gridMedian = median(gridSamples);
  const directMedian = median(directSamples);
  return {
    atomCount: count,
    collisionPairs: gridCount,
    gridSamplesMsPerCall: gridSamples,
    directSamplesMsPerCall: directSamples,
    gridMedianMsPerCall: gridMedian,
    directMedianMsPerCall: directMedian,
    directSpeedup: gridMedian / directMedian,
  };
});

process.stdout.write(
  `${JSON.stringify(
    { measuredAt: new Date().toISOString(), options, results },
    null,
    2,
  )}\n`,
);
