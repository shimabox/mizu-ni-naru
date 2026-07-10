import { describe, expect, it } from 'vitest';
import { KIND_INDEX } from '../../../src/contract/WorldSpec';
import { Atom } from '../../../src/sim/chem/Atom';
import { AtomFactory } from '../../../src/sim/chem/AtomFactory';
import { Mulberry32 } from '../../../src/sim/core/Random';
import { ReactionRegistry } from '../../../src/sim/reactions/ReactionRegistry';
import type { ReactionContext } from '../../../src/sim/reactions/ReactionRule';
import { HHFusion } from '../../../src/sim/reactions/rules/HHFusion';
import { OxidationToDroplet } from '../../../src/sim/reactions/rules/OxidationToDroplet';
import { SpyRandom } from '../../helpers/testRandom';

const makeAtom = (kind: number, x: number, y: number, z: number): Atom =>
  new Atom(kind, 0.08, x, y, z, 1, 1, 1, 0, 0);

const makeCtx = (seed = 1): { ctx: ReactionContext; rng: SpyRandom } => {
  const rng = new SpyRandom(new Mulberry32(seed));
  return {
    ctx: { factory: new AtomFactory(rng), bubbleR: 1.4, nowStep: 100 },
    rng,
  };
};

describe('ReactionRegistry(§3.5)', () => {
  const build = (): ReactionRegistry => {
    const reg = new ReactionRegistry();
    reg.register(new HHFusion());
    reg.register(new OxidationToDroplet());
    return reg;
  };

  it('両順キーで同じルールを引ける(O+H2 と H2+O)', () => {
    const reg = build();
    const a = reg.find(KIND_INDEX.O, KIND_INDEX.H2);
    const b = reg.find(KIND_INDEX.H2, KIND_INDEX.O);
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });

  it('H+H は HHFusion を引く', () => {
    const reg = build();
    expect(reg.find(KIND_INDEX.H, KIND_INDEX.H)).toBeInstanceOf(HHFusion);
  });

  it('未登録ペア(H+O、H2+H2)は undefined', () => {
    const reg = build();
    expect(reg.find(KIND_INDEX.H, KIND_INDEX.O)).toBeUndefined();
    expect(reg.find(KIND_INDEX.H2, KIND_INDEX.H2)).toBeUndefined();
  });

  it('reactiveKinds は登録済み kind の live 集合(本作は全 3 種)', () => {
    const reg = new ReactionRegistry();
    reg.register(new HHFusion());
    const kinds = reg.reactiveKinds();
    expect(kinds.has(KIND_INDEX.H)).toBe(true);
    expect(kinds.has(KIND_INDEX.O)).toBe(false);
    reg.register(new OxidationToDroplet()); // live: 後から増える
    expect(kinds.has(KIND_INDEX.O)).toBe(true);
    expect(kinds.has(KIND_INDEX.H2)).toBe(true);
  });
});

describe('HHFusion(H+H → H2 — 中点生成・再湧きなし)', () => {
  it('収支: consumed = 両親 2 体、produced = H2 1 体、droplets = 0', () => {
    const { ctx } = makeCtx();
    const a = makeAtom(KIND_INDEX.H, -0.2, 0.1, 0);
    const b = makeAtom(KIND_INDEX.H, 0.2, 0.3, 0.4);
    const rule = new HHFusion();
    const result = rule.react(a, b, ctx);
    expect(result.consumed).toEqual([a, b]);
    expect(result.produced).toHaveLength(1);
    expect(result.droplets).toHaveLength(0);
  });

  it('H2 は両親の中点に生まれる', () => {
    const { ctx } = makeCtx();
    const a = makeAtom(KIND_INDEX.H, -0.2, 0.1, 0);
    const b = makeAtom(KIND_INDEX.H, 0.2, 0.3, 0.4);
    const h2 = new HHFusion().react(a, b, ctx).produced[0];
    expect(h2.kindIndex).toBe(KIND_INDEX.H2);
    expect(h2.x).toBeCloseTo(0, 10);
    expect(h2.y).toBeCloseTo(0.2, 10);
    expect(h2.z).toBeCloseTo(0.2, 10);
    expect(h2.spawnStep).toBe(100);
  });

  it('RNG 消費は 1 回のみ(色+seed — §7.1)', () => {
    const { ctx, rng } = makeCtx();
    new HHFusion().react(
      makeAtom(KIND_INDEX.H, 0, 0, 0),
      makeAtom(KIND_INDEX.H, 0.1, 0, 0),
      ctx,
    );
    expect(rng.calls).toBe(1);
  });
});

describe('OxidationToDroplet(O + H2 → 雫)', () => {
  it('収支: consumed = 2 体、produced = 0、droplets = 1', () => {
    const { ctx } = makeCtx();
    const o = makeAtom(KIND_INDEX.O, 0.3, 0.2, -0.1);
    const h2 = makeAtom(KIND_INDEX.H2, -0.3, 0, 0);
    const result = new OxidationToDroplet().react(o, h2, ctx);
    expect(result.consumed).toEqual([o, h2]);
    expect(result.produced).toHaveLength(0);
    expect(result.droplets).toHaveLength(1);
  });

  it('雫は O の座標に生まれる(Mizu の伝統)— 引数順に非依存', () => {
    const rule = new OxidationToDroplet();
    const o = makeAtom(KIND_INDEX.O, 0.3, 0.2, -0.1);
    const h2 = makeAtom(KIND_INDEX.H2, -0.3, 0, 0);
    const d1 = rule.react(o, h2, makeCtx().ctx).droplets[0];
    expect([d1.x, d1.y, d1.z]).toEqual([0.3, 0.2, -0.1]);
    const d2 = rule.react(h2, o, makeCtx().ctx).droplets[0];
    expect([d2.x, d2.y, d2.z]).toEqual([0.3, 0.2, -0.1]);
  });

  it('RNG 消費は 4 回(r, phase, swayAmp, seed — §7.1)', () => {
    const { ctx, rng } = makeCtx();
    new OxidationToDroplet().react(
      makeAtom(KIND_INDEX.O, 0, 0, 0),
      makeAtom(KIND_INDEX.H2, 0.1, 0, 0),
      ctx,
    );
    expect(rng.calls).toBe(4);
  });

  it('DropletSpawn レコード形(x, y, z, r, phase, swayAmp, seed)を満たす', () => {
    const { ctx } = makeCtx(5);
    const d = new OxidationToDroplet().react(
      makeAtom(KIND_INDEX.O, 0.1, 0.2, 0.3),
      makeAtom(KIND_INDEX.H2, 0, 0, 0),
      ctx,
    ).droplets[0];
    expect(d.r).toBeGreaterThan(0);
    expect(d.phase).toBeGreaterThanOrEqual(0);
    expect(d.swayAmp).toBeGreaterThan(0);
    expect(d.seed).toBeGreaterThanOrEqual(0);
  });
});
