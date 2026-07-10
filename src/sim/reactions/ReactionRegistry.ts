import type { ReactionRule } from './ReactionRule';

/** kindIndex は 0..2(KIND_INDEX)。キー = kindA * KEY_BASE + kindB。 */
const KEY_BASE = 4;

/**
 * 反応ルールの両順キーレジストリ(design-sim §3.5。知見:
 * Mizu-ts/src/reactions/ReactionRegistry.ts — 両順キー + live な reactiveKinds)。
 */
export class ReactionRegistry {
  private readonly rules: (ReactionRule | undefined)[] = new Array(
    KEY_BASE * KEY_BASE,
  );
  private readonly kinds = new Set<number>();

  public register(rule: ReactionRule): void {
    this.rules[rule.kindA * KEY_BASE + rule.kindB] = rule;
    this.rules[rule.kindB * KEY_BASE + rule.kindA] = rule;
    this.kinds.add(rule.kindA);
    this.kinds.add(rule.kindB);
  }

  /** (kindA, kindB) のルール。未登録ペア(例: H+O)は undefined。順序非依存。 */
  public find(kindA: number, kindB: number): ReactionRule | undefined {
    return this.rules[kindA * KEY_BASE + kindB];
  }

  /** いずれかのルールに登場する kind の live な集合。 */
  public reactiveKinds(): ReadonlySet<number> {
    return this.kinds;
  }
}
