import { KIND_INDEX } from '../../../contract/WorldSpec';
import type { Atom } from '../../chem/Atom';
import type {
  ReactionContext,
  ReactionResult,
  ReactionRule,
} from '../ReactionRule';

/**
 * H + H → H2(design-sim §3.5 — 裁定 A15: 再湧きなし・中点生成)。
 * 収支: H −2, H2 +1。RNG は生成 H2 の色+seed の 1 回のみ。
 * 原典(Mizu-ts/src/reactions/rules/HHFusion.ts)は片親位置 + もう片方を
 * ランダム再湧きさせたが、再湧きのない世界では中点が最も自然(RNG 消費も減る)。
 * 中点が水面下/球殻近傍に落ちるケースの位置クランプは呼び出し側(BubbleWorld)
 * が produced 挿入時に行う。
 */
export class HHFusion implements ReactionRule {
  public readonly kindA = KIND_INDEX.H;
  public readonly kindB = KIND_INDEX.H;

  // 定常アロケーションゼロ: 結果オブジェクトは使い回す(次の react() まで有効)
  private readonly consumed: Atom[] = [];
  private readonly produced: Atom[] = [];
  private readonly result: ReactionResult = {
    consumed: this.consumed,
    produced: this.produced,
    droplets: [],
  };

  public react(a: Atom, b: Atom, ctx: ReactionContext): ReactionResult {
    this.consumed.length = 0;
    this.produced.length = 0;
    this.consumed.push(a, b);
    this.produced.push(
      ctx.factory.createAtom(
        KIND_INDEX.H2,
        (a.x + b.x) / 2,
        (a.y + b.y) / 2,
        (a.z + b.z) / 2,
        ctx.bubbleR,
        ctx.nowStep,
      ),
    );
    return this.result;
  }
}
