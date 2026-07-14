import {
  Color,
  type InstancedBufferAttribute,
  type InstancedBufferGeometry,
  PerspectiveCamera,
  Vector3,
} from 'three';
import { describe, expect, it } from 'vitest';
import type { SkyRenderView } from '../../src/contract/RenderView';
import type { FrameInfo } from '../../src/render/RenderSystem';
import {
  InnerSplashSystem,
  innerSplashParticleCount,
  isDropletInnerImpact,
  isInnerSplashInsideShell,
  writtenRanges,
} from '../../src/render/particles/InnerSplashSystem';
import { StubSim } from '../../src/sim/StubSim';

const frame = (stepF: number): FrameInfo => ({
  camera: new PerspectiveCamera(),
  alpha: stepF % 1,
  stepF,
  timeSec: stepF / 60,
});

const system = (): InnerSplashSystem =>
  new InnerSplashSystem({
    uSunDir: { value: new Vector3(0.48, 0.24, -0.84).normalize() },
    uSunColor: { value: new Color(0xffd19a) },
  });

const withRipple = (
  view: SkyRenderView,
  step: number,
  strength: number,
): SkyRenderView => ({
  ...view,
  step,
  ripples: {
    data: new Float32Array([0, 0, 0, strength]),
    count: 1,
  },
});

describe('InnerSplashSystem', () => {
  it('雫着水strength帯だけをしぶきへ変換する', () => {
    expect(isDropletInnerImpact(0.15)).toBe(false);
    expect(isDropletInnerImpact(0.3)).toBe(false);
    expect(isDropletInnerImpact(0.6)).toBe(true);
    expect(isDropletInnerImpact(1.0)).toBe(true);
    expect(isDropletInnerImpact(1.1)).toBe(false);
  });

  it('strengthに応じて7〜12粒を決定論的に生成する', () => {
    expect(innerSplashParticleCount(0.6)).toBe(7);
    expect(innerSplashParticleCount(0.8)).toBe(10);
    expect(innerSplashParticleCount(1.0)).toBe(12);
    expect(innerSplashParticleCount(1.0, 0.5)).toBe(6);
  });

  it('粒子半径と最大伸長を含めて内殻境界を判定する', () => {
    expect(isInnerSplashInsideShell(0.9, 0, 0, 1, 0.02)).toBe(true);
    expect(isInnerSplashInsideShell(0.92, 0, 0, 1, 0.02)).toBe(false);
  });

  it('リング末尾を跨ぐ書き込みだけを2範囲へ分ける', () => {
    expect(writtenRanges(10, 4, 16)).toEqual([{ start: 10, count: 4 }]);
    expect(writtenRanges(14, 4, 16)).toEqual([
      { start: 14, count: 2 },
      { start: 0, count: 2 },
    ]);
    expect(writtenRanges(7, 20, 16)).toEqual([{ start: 0, count: 16 }]);
  });

  it('原子波紋は無視し、雫着水だけを同一stepで一度生成する', () => {
    const sim = new StubSim();
    sim.init({ seed: 7, slotCount: 24 });
    const target = system();
    const geometry = target.object.geometry as InstancedBufferGeometry;
    const atomRipple = withRipple(sim.view(), 1, 0.3);
    target.update(atomRipple, frame(1.5));
    expect(geometry.instanceCount).toBe(0);

    const dropletRipple = withRipple(sim.view(), 2, 0.8);
    target.update(dropletRipple, frame(2.5));
    const expected = innerSplashParticleCount(0.8);
    expect(geometry.instanceCount).toBe(expected);
    expect(target.object.visible).toBe(true);
    const spawn = geometry.getAttribute('aSpawn') as InstancedBufferAttribute;
    const bubble = geometry.getAttribute('aBubble') as InstancedBufferAttribute;
    for (let i = 0; i < expected; i++) {
      const o = i * 4;
      const bubbleR = bubble.array[o + 1];
      expect(
        isInnerSplashInsideShell(
          spawn.array[o],
          spawn.array[o + 1],
          spawn.array[o + 2],
          bubbleR,
          bubble.array[o + 2] * bubbleR,
        ),
      ).toBe(true);
    }

    target.update(dropletRipple, frame(2.75));
    expect(geometry.instanceCount).toBe(expected);
    target.dispose();
  });
});
