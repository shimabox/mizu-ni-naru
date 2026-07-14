/**
 * 固定60Hz simを複数の表示refresh rateで描くときのAtom属性upload要求を数える。
 * WebGLを起動せず、Three.js BufferAttribute.versionをdriver upload要求の代理にする。
 */
import { cpus, platform, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { accumulate } from '../src/app/accumulator';
import { AtomViewAttributes } from '../src/render/atoms/AtomViewAttributes';
import { MizuNiNaruSim } from '../src/sim/MizuNiNaruSim';

interface Options {
  readonly seed: number;
  readonly slotCount: number;
  readonly warmupSteps: number;
  readonly seconds: number;
  readonly refreshRates: number[];
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
  let seed = 7;
  let slotCount = 24;
  let warmupSteps = 2_000;
  let seconds = 60;
  let refreshRates = [60, 120, 144];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--seed') seed = positiveInteger(arg, args[++i]);
    else if (arg === '--slots') slotCount = positiveInteger(arg, args[++i]);
    else if (arg === '--warmup') {
      warmupSteps = positiveInteger(arg, args[++i]);
    } else if (arg === '--seconds') {
      seconds = positiveInteger(arg, args[++i]);
    } else if (arg === '--refresh') {
      refreshRates = (args[++i] ?? '')
        .split(',')
        .map((value) => positiveInteger(arg, value));
    } else throw new Error(`Unknown argument: ${String(arg)}`);
  }
  return { seed, slotCount, warmupSteps, seconds, refreshRates };
};

const attributeVersionSum = (attributes: AtomViewAttributes): number =>
  attributes.posR.version +
  attributes.posRPrev.version +
  attributes.colorKind.version +
  attributes.aux.version;

const options = parseArgs();
const results = options.refreshRates.map((refreshHz) => {
  const sim = new MizuNiNaruSim();
  sim.init({
    seed: options.seed,
    slotCount: options.slotCount,
    pacing: 'desktop',
  });
  for (let step = 0; step < options.warmupSteps; step++) sim.step();

  const attributes = new AtomViewAttributes();
  const frames = refreshHz * options.seconds;
  const frameDtMs = 1000 / refreshHz;
  let remainder = 0;
  let simSteps = 0;
  let uploadFrames = 0;
  let uploadRequests = 0;
  let requestedBytes = 0;
  const start = performance.now();

  for (let frame = 0; frame < frames; frame++) {
    const acc = accumulate(remainder, frameDtMs);
    remainder = acc.remainder;
    for (let step = 0; step < acc.steps; step++) {
      sim.step();
      simSteps++;
    }
    const beforeVersion = attributeVersionSum(attributes);
    const view = sim.view();
    attributes.sync(view);
    const requests = attributeVersionSum(attributes) - beforeVersion;
    if (requests > 0) {
      uploadFrames++;
      uploadRequests += requests;
      requestedBytes += view.atoms.count * 4 * Float32Array.BYTES_PER_ELEMENT * requests;
    }
  }
  const elapsedMs = performance.now() - start;

  return {
    refreshHz,
    frames,
    simSteps,
    uploadFrames,
    uploadRequests,
    requestedBytes,
    uploadFrameRatio: uploadFrames / frames,
    meanRequestedBytesPerFrame: requestedBytes / frames,
    elapsedMs,
    microsecondsPerFrame: (elapsedMs * 1000) / frames,
    finalCounts: sim.counts(),
  };
});

process.stdout.write(
  `${JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: platform(),
        release: release(),
        architecture: process.arch,
        cpu: cpus()[0]?.model ?? 'unknown',
      },
      options,
      results,
    },
    null,
    2,
  )}\n`,
);
