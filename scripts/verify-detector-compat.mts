/** GridDetectorとOrderedDirectDetectorでsim状態が完全一致することを長時間検証する。 */
import type { SkyRenderView } from '../src/contract/RenderView';
import { MizuNiNaruSim } from '../src/sim/MizuNiNaruSim';
import type { CollisionDetector } from '../src/sim/physics/CollisionDetector';
import { GridDetector } from '../src/sim/physics/GridDetector';

interface Options {
  seeds: number[];
  slotCount: number;
  steps: number;
  checkpointEvery: number;
}

interface SimPrivateBridge {
  shared: { detector: CollisionDetector } | null;
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
    seeds: [7, 42, 123, 2026],
    slotCount: 24,
    steps: 10_000,
    checkpointEvery: 1_000,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--seeds') {
      options.seeds = (args[++i] ?? '')
        .split(',')
        .map((value) => positiveInteger(arg, value));
    } else if (arg === '--slots') {
      options.slotCount = positiveInteger(arg, args[++i]);
    } else if (arg === '--steps') {
      options.steps = positiveInteger(arg, args[++i]);
    } else if (arg === '--checkpoint') {
      options.checkpointEvery = positiveInteger(arg, args[++i]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
};

const assertObjectExact = (label: string, a: object, b: object): void => {
  const aJson = JSON.stringify(a);
  const bJson = JSON.stringify(b);
  if (aJson !== bJson) throw new Error(`${label} mismatch\n${aJson}\n${bJson}`);
};

const assertArrayExact = (
  label: string,
  a: Float32Array,
  b: Float32Array,
  length: number,
): void => {
  for (let i = 0; i < length; i++) {
    if (!Object.is(a[i], b[i])) {
      throw new Error(`${label}[${i}] mismatch: ${a[i]} !== ${b[i]}`);
    }
  }
};

const assertViewExact = (
  label: string,
  a: SkyRenderView,
  b: SkyRenderView,
): void => {
  if (a.step !== b.step) throw new Error(`${label}.step mismatch`);
  assertObjectExact(`${label}.counts`, {
    bubbles: a.bubbles.count,
    atoms: a.atoms.count,
    droplets: a.droplets.count,
    splashes: a.splashes.count,
    ripples: a.ripples.count,
  }, {
    bubbles: b.bubbles.count,
    atoms: b.atoms.count,
    droplets: b.droplets.count,
    splashes: b.splashes.count,
    ripples: b.ripples.count,
  });
  assertArrayExact(
    `${label}.bubbles.data`,
    a.bubbles.data,
    b.bubbles.data,
    a.bubbles.count * 8,
  );
  assertArrayExact(
    `${label}.bubbles.prevData`,
    a.bubbles.prevData,
    b.bubbles.prevData,
    a.bubbles.count * 8,
  );
  for (const [name, left, right, count] of [
    ['atoms.posr', a.atoms.posr, b.atoms.posr, a.atoms.count],
    ['atoms.prevPosr', a.atoms.prevPosr, b.atoms.prevPosr, a.atoms.count],
    ['atoms.colorKind', a.atoms.colorKind, b.atoms.colorKind, a.atoms.count],
    ['atoms.aux', a.atoms.aux, b.atoms.aux, a.atoms.count],
    ['droplets.posr', a.droplets.posr, b.droplets.posr, a.droplets.count],
    [
      'droplets.prevPosr',
      a.droplets.prevPosr,
      b.droplets.prevPosr,
      a.droplets.count,
    ],
    ['droplets.aux', a.droplets.aux, b.droplets.aux, a.droplets.count],
    ['splashes.data', a.splashes.data, b.splashes.data, a.splashes.count],
    ['ripples.data', a.ripples.data, b.ripples.data, a.ripples.count],
  ] as const) {
    assertArrayExact(`${label}.${name}`, left, right, count * 4);
  }
};

const options = parseArgs();
const checkpoints: Array<{ seed: number; step: number }> = [];

for (const seed of options.seeds) {
  const gridSim = new MizuNiNaruSim();
  gridSim.init({ seed, slotCount: options.slotCount, pacing: 'desktop' });
  const bridge = gridSim as unknown as SimPrivateBridge;
  if (!bridge.shared) throw new Error('Grid sim shared state was not initialized');
  bridge.shared.detector = new GridDetector();

  const directSim = new MizuNiNaruSim();
  directSim.init({ seed, slotCount: options.slotCount, pacing: 'desktop' });

  for (let step = 1; step <= options.steps; step++) {
    gridSim.step();
    directSim.step();
    if (step % options.checkpointEvery !== 0 && step !== options.steps) continue;
    const label = `seed=${seed},step=${step}`;
    assertObjectExact(`${label}.counts`, gridSim.counts(), directSim.counts());
    assertObjectExact(`${label}.ledger`, gridSim.ledger(), directSim.ledger());
    assertViewExact(label, gridSim.view(), directSim.view());
    checkpoints.push({ seed, step });
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      verifiedAt: new Date().toISOString(),
      options,
      checkpointCount: checkpoints.length,
      checkpoints,
      exactMatch: true,
    },
    null,
    2,
  )}\n`,
);
