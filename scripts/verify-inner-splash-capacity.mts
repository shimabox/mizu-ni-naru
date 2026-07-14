/**
 * 実simの雫着水列から、球内しぶきリングの保守的な最大使用量を検証する。
 *
 * 使用例:
 *   npm run verify:splash-capacity
 *   npm run verify:splash-capacity -- --seeds 7,42 --seconds 1200
 */
import {
  INNER_SPLASH_CAPACITY,
  INNER_SPLASH_MAX_LIFE_STEPS,
  innerSplashParticleCount,
  isDropletInnerImpact,
} from '../src/render/particles/InnerSplashSystem';
import { MizuNiNaruSim } from '../src/sim/MizuNiNaruSim';

interface Options {
  readonly seeds: number[];
  readonly slotCount: number;
  readonly seconds: number;
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
  let seeds = [7, 42, 123, 2026];
  let slotCount = 24;
  let seconds = 600;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--seeds') {
      seeds = (args[++i] ?? '')
        .split(',')
        .map((value) => positiveInteger(arg, value));
    } else if (arg === '--slots') {
      slotCount = positiveInteger(arg, args[++i]);
    } else if (arg === '--seconds') {
      seconds = positiveInteger(arg, args[++i]);
    } else {
      throw new Error(`Unknown argument: ${String(arg)}`);
    }
  }
  if (seeds.length === 0) throw new Error('--seeds must not be empty');
  return { seeds, slotCount, seconds };
};

const options = parseArgs();
const steps = options.seconds * 60;
const expiryBuckets = INNER_SPLASH_MAX_LIFE_STEPS + 1;
const results = options.seeds.map((seed) => {
  const sim = new MizuNiNaruSim();
  sim.init({ seed, slotCount: options.slotCount, pacing: 'desktop' });
  const expirations = new Int32Array(expiryBuckets);
  let activeParticles = 0;
  let impactEvents = 0;
  let maxEventsPerStep = 0;
  let maxActiveParticles = 0;

  for (let step = 0; step < steps; step++) {
    const expiryIndex = step % expiryBuckets;
    activeParticles -= expirations[expiryIndex];
    expirations[expiryIndex] = 0;
    sim.step();
    const ripples = sim.view().ripples;
    let eventsThisStep = 0;
    let particlesThisStep = 0;
    for (let i = 0; i < ripples.count; i++) {
      const strength = ripples.data[i * 4 + 3];
      if (!isDropletInnerImpact(strength)) continue;
      eventsThisStep++;
      particlesThisStep += innerSplashParticleCount(strength);
    }

    impactEvents += eventsThisStep;
    maxEventsPerStep = Math.max(maxEventsPerStep, eventsThisStep);
    activeParticles += particlesThisStep;
    const expiresAt = (step + INNER_SPLASH_MAX_LIFE_STEPS) % expiryBuckets;
    expirations[expiresAt] += particlesThisStep;
    maxActiveParticles = Math.max(maxActiveParticles, activeParticles);
  }

  return {
    seed,
    impactEvents,
    maxEventsPerStep,
    maxActiveParticles,
    headroom: INNER_SPLASH_CAPACITY - maxActiveParticles,
  };
});

process.stdout.write(
  `${JSON.stringify(
    {
      options: {
        ...options,
        steps,
        maxLifeSteps: INNER_SPLASH_MAX_LIFE_STEPS,
        capacity: INNER_SPLASH_CAPACITY,
      },
      results,
    },
    null,
    2,
  )}\n`,
);

if (results.some((result) => result.maxActiveParticles > INNER_SPLASH_CAPACITY)) {
  process.exitCode = 1;
}
