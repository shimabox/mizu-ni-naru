/**
 * 固定60Hz simを複数の表示refresh rateで描くときのAtom属性upload要求を数える。
 * WebGLを起動せず、Three.js BufferAttribute.versionをdriver upload要求の代理にする。
 */
import { cpus, platform, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Color, PerspectiveCamera, Vector3 } from 'three';
import { accumulate } from '../src/app/accumulator';
import { AtomViewAttributes } from '../src/render/atoms/AtomViewAttributes';
import { DropletSystem } from '../src/render/atoms/DropletSystem';
import {
  type BubbleBucket,
  BubbleInstanceBuffers,
} from '../src/render/bubbles/BubbleInstanceBuffers';
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

const dropletVersionSum = (system: DropletSystem): number =>
  system.object.geometry.getAttribute('aPosR').version +
  system.object.geometry.getAttribute('aPosRPrev').version +
  system.object.geometry.getAttribute('aAux').version;

const bucketVersionSum = (bucket: BubbleBucket): number =>
  bucket.currA.version +
  bucket.currB.version +
  bucket.prevA.version +
  bucket.prevB.version +
  bucket.misc.version;

const bubbleVersionSum = (buffers: BubbleInstanceBuffers): number =>
  bucketVersionSum(buffers.near) + bucketVersionSum(buffers.far);

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
  const dropletSystem = new DropletSystem({
    uSunDir: { value: new Vector3(0.485, 0.242, -0.841).normalize() },
    uSunColor: { value: new Color(0xffd19a) },
  });
  const frameInfo = {
    camera: new PerspectiveCamera(),
    alpha: 0,
    stepF: 0,
    timeSec: 0,
  };
  const bubbleBuffers = new BubbleInstanceBuffers();
  const frames = refreshHz * options.seconds;
  const frameDtMs = 1000 / refreshHz;
  let remainder = 0;
  let simSteps = 0;
  let uploadFrames = 0;
  let uploadRequests = 0;
  let requestedBytes = 0;
  let dropletUploadFrames = 0;
  let dropletUploadRequests = 0;
  let dropletRequestedBytes = 0;
  let bubbleUploadFrames = 0;
  let bubbleUploadRequests = 0;
  let bubbleRequestedBytes = 0;
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
    frameInfo.alpha = acc.alpha;
    frameInfo.stepF = view.step + acc.alpha;
    frameInfo.timeSec = frameInfo.stepF / 60;
    const beforeDropletVersion = dropletVersionSum(dropletSystem);
    dropletSystem.update(view, frameInfo);
    const dropletRequests =
      dropletVersionSum(dropletSystem) - beforeDropletVersion;
    if (dropletRequests > 0) {
      dropletUploadFrames++;
      dropletUploadRequests += dropletRequests;
      dropletRequestedBytes +=
        view.droplets.count *
        4 *
        Float32Array.BYTES_PER_ELEMENT *
        dropletRequests;
    }
    const timeSec = frame / refreshHz;
    frameInfo.camera.position.set(
      13.2 * Math.sin((2 * Math.PI * timeSec) / 240),
      5.4 + 0.7 * Math.sin((2 * Math.PI * timeSec) / 61 + 1.3),
      13.2 * Math.cos((2 * Math.PI * timeSec) / 240),
    );
    const beforeBubbleVersion = bubbleVersionSum(bubbleBuffers);
    bubbleBuffers.sync(view, frameInfo.camera);
    const bubbleRequests =
      bubbleVersionSum(bubbleBuffers) - beforeBubbleVersion;
    if (bubbleRequests > 0) {
      bubbleUploadFrames++;
      bubbleUploadRequests += bubbleRequests;
      bubbleRequestedBytes +=
        view.bubbles.count *
        18 *
        Float32Array.BYTES_PER_ELEMENT;
    }
  }
  const elapsedMs = performance.now() - start;
  dropletSystem.dispose();

  return {
    refreshHz,
    frames,
    simSteps,
    uploadFrames,
    uploadRequests,
    requestedBytes,
    uploadFrameRatio: uploadFrames / frames,
    meanRequestedBytesPerFrame: requestedBytes / frames,
    dropletUploadFrames,
    dropletUploadRequests,
    dropletRequestedBytes,
    dropletUploadFrameRatio: dropletUploadFrames / frames,
    dropletMeanRequestedBytesPerFrame: dropletRequestedBytes / frames,
    bubbleUploadFrames,
    bubbleUploadRequests,
    bubbleRequestedBytes,
    bubbleUploadFrameRatio: bubbleUploadFrames / frames,
    bubbleMeanRequestedBytesPerFrame: bubbleRequestedBytes / frames,
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
