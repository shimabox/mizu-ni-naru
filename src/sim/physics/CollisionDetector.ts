import type { Atom } from '../chem/Atom';

/**
 * 衝突検出の DI 点(知見: Mizu-ts/src/physics/CollisionDetector.ts)。
 * OrderedDirectDetector が既定、GridDetector は列挙順の参照実装、
 * BruteForceDetector はペア集合のテストオラクルとして常備する。
 *
 * 検出は純幾何(中心距離 < r_i + r_j)。反応可能ペアかどうかの判別は
 * ReactionRegistry のルックアップが担う(全 kind が反応系に属する本作では
 * reactiveKinds フィルタと等価)。
 */
export interface CollisionDetector {
  /**
   * 重なっているペアの atom インデックスを outPairs に (i, j)(i < j)の平坦列で
   * 詰め、ペア数を返す。outPairs は呼び出し側が使い回す(length は上書きされる —
   * 定常アロケーションゼロ)。dead な原子は候補から除外する。
   */
  findPairs(atoms: readonly Atom[], rInner: number, outPairs: number[]): number;
}
