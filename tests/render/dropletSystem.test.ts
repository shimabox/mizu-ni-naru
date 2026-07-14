import { type InstancedBufferAttribute, PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import type { SkyRenderView } from '../../src/contract/RenderView';
import { createStaticSunUniforms } from '../../src/render/Environment';
import type { FrameInfo } from '../../src/render/RenderSystem';
import { DropletSystem } from '../../src/render/atoms/DropletSystem';
import { StubSim } from '../../src/sim/StubSim';

const makeSystem = (): DropletSystem =>
  new DropletSystem(createStaticSunUniforms());

const makeFrame = (): FrameInfo => ({
  camera: new PerspectiveCamera(),
  alpha: 0.5,
  stepF: 0.5,
  timeSec: 0.5 / 60,
});

const versions = (system: DropletSystem): number[] => [
  (system.object.geometry.getAttribute('aPosR') as InstancedBufferAttribute)
    .version,
  (system.object.geometry.getAttribute('aPosRPrev') as InstancedBufferAttribute)
    .version,
  (system.object.geometry.getAttribute('aAux') as InstancedBufferAttribute)
    .version,
];

describe('DropletSystem upload gating', () => {
  it('同じview.stepの0-step frameでは再uploadを要求しない', () => {
    const sim = new StubSim();
    sim.init({ seed: 7, slotCount: 7 });
    const system = makeSystem();
    const frame = makeFrame();

    system.update(sim.view(), frame);
    expect(versions(system)).toEqual([1, 1, 1]);
    system.update(sim.view(), frame);
    expect(versions(system)).toEqual([1, 1, 1]);

    sim.step();
    system.update(sim.view(), frame);
    expect(versions(system)).toEqual([2, 2, 2]);
    system.dispose();
  });

  it('同じstepでも配列再確保時は再ラップしてuploadする', () => {
    const sim = new StubSim();
    sim.init({ seed: 11, slotCount: 7 });
    const system = makeSystem();
    const frame = makeFrame();
    system.update(sim.view(), frame);
    const view = sim.view();
    const replacement: SkyRenderView = {
      ...view,
      droplets: {
        ...view.droplets,
        posr: new Float32Array(view.droplets.posr),
        prevPosr: new Float32Array(view.droplets.prevPosr),
        aux: new Float32Array(view.droplets.aux),
      },
    };

    system.update(replacement, frame);
    expect(versions(system)).toEqual([1, 1, 1]);
    expect(
      (system.object.geometry.getAttribute('aPosR') as InstancedBufferAttribute)
        .array,
    ).toBe(replacement.droplets.posr);
    system.dispose();
  });
});
