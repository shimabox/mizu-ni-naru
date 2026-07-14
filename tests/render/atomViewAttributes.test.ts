import { describe, expect, it } from 'vitest';
import type { SkyRenderView } from '../../src/contract/RenderView';
import { AtomViewAttributes } from '../../src/render/atoms/AtomViewAttributes';
import { StubSim } from '../../src/sim/StubSim';

const versions = (attributes: AtomViewAttributes): number[] => [
  attributes.posR.version,
  attributes.posRPrev.version,
  attributes.colorKind.version,
  attributes.aux.version,
];

describe('AtomViewAttributes upload gating', () => {
  it('同じview.stepの0-step frameでは再uploadを要求しない', () => {
    const sim = new StubSim();
    sim.init({ seed: 7, slotCount: 7 });
    const attributes = new AtomViewAttributes();

    attributes.sync(sim.view());
    expect(versions(attributes)).toEqual([1, 1, 1, 1]);
    attributes.sync(sim.view());
    expect(versions(attributes)).toEqual([1, 1, 1, 1]);

    sim.step();
    attributes.sync(sim.view());
    expect(versions(attributes)).toEqual([2, 2, 2, 2]);
  });

  it('同じstepでも配列再確保時は再ラップしてuploadする', () => {
    const sim = new StubSim();
    sim.init({ seed: 11, slotCount: 7 });
    const attributes = new AtomViewAttributes();
    attributes.sync(sim.view());
    const view = sim.view();
    const replacement: SkyRenderView = {
      ...view,
      atoms: {
        ...view.atoms,
        posr: new Float32Array(view.atoms.posr),
        prevPosr: new Float32Array(view.atoms.prevPosr),
        colorKind: new Float32Array(view.atoms.colorKind),
        aux: new Float32Array(view.atoms.aux),
      },
    };

    attributes.sync(replacement);
    expect(attributes.generation).toBe(2);
    expect(versions(attributes)).toEqual([1, 1, 1, 1]);
  });
});
