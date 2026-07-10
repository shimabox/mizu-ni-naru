import { KIND_INDEX } from '../../../contract/WorldSpec';
import type { Atom } from '../../chem/Atom';
import type { DropletSpawnSpec } from '../../chem/AtomFactory';
import type {
  ReactionContext,
  ReactionResult,
  ReactionRule,
} from '../ReactionRule';

/**
 * O + H2 → 雫(design-sim §3.5 — 裁定 A15: 再湧きなし)。
 * 収支: O −1, H2 −1, droplet +1。雫は O の座標に生まれる(Mizu の伝統 —
 * Mizu-ts/src/reactions/rules/OxidationToWater.ts の雫ルーティング化)。
 * kind 判別で a/b の順序非依存。RNG は雫パラメータの 4 回
 * (r, phase, swayAmp, seed — AtomFactory.fillDropletSpawn)。
 */
export class OxidationToDroplet implements ReactionRule {
  public readonly kindA = KIND_INDEX.O;
  public readonly kindB = KIND_INDEX.H2;

  // 定常アロケーションゼロ: 結果・スポーンレコードは使い回す
  private readonly consumed: Atom[] = [];
  private readonly spec: DropletSpawnSpec = {
    x: 0,
    y: 0,
    z: 0,
    r: 0,
    phase: 0,
    swayAmp: 0,
    seed: 0,
  };
  private readonly droplets: DropletSpawnSpec[] = [this.spec];
  private readonly result: ReactionResult = {
    consumed: this.consumed,
    produced: [],
    droplets: this.droplets,
  };

  public react(a: Atom, b: Atom, ctx: ReactionContext): ReactionResult {
    const o = a.kindIndex === KIND_INDEX.O ? a : b;
    this.consumed.length = 0;
    this.consumed.push(a, b);
    ctx.factory.fillDropletSpawn(o.x, o.y, o.z, ctx.bubbleR, this.spec);
    return this.result;
  }
}
