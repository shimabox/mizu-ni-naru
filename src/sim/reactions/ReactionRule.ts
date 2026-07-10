import type { Atom } from '../chem/Atom';
import type { AtomFactory, DropletSpawnSpec } from '../chem/AtomFactory';

/**
 * 宣言的反応ルール(design-sim §3.5)。
 * consumed/produced の知見: Mizu-ts/src/reactions/ReactionRule.ts。
 * droplets ルーティング拡張の知見: Mizu-threejs/src/sim/reactions/ReactionRule.ts。
 * **個数収支はルールが全権を持つ**(質量台帳 §7.3 の根拠)。
 * 再湧きなし(裁定 A15)— ルールは純粋な消滅・生成のみ。
 */
export interface ReactionContext {
  readonly factory: AtomFactory;
  readonly bubbleR: number;
  readonly nowStep: number;
}

export interface ReactionResult {
  /** 消滅する原子(呼び出し側が dead を立て sweep する)。 */
  readonly consumed: readonly Atom[];
  /** 生成される原子(呼び出し側が球内クランプの上 atoms へ挿入する)。 */
  readonly produced: readonly Atom[];
  /** 生成される雫(呼び出し側が DropletColumn へルーティングする)。 */
  readonly droplets: readonly DropletSpawnSpec[];
}

export interface ReactionRule {
  readonly kindA: number;
  readonly kindB: number;
  /**
   * a/b の順序は非依存(kind 判別で解決 — Mizu-ts の知見)。
   * 返り値はルール内部の再利用オブジェクトでよい(次の react() 呼び出しまで有効
   * — 定常アロケーションゼロ)。
   */
  react(a: Atom, b: Atom, ctx: ReactionContext): ReactionResult;
}
