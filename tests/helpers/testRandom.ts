import type { Random } from '../../src/sim/core/Random';

/** 呼び出し回数を数える Random ラッパ(RNG 消費数の規約テスト用)。 */
export class SpyRandom implements Random {
  public calls = 0;
  private readonly inner: Random;

  constructor(inner: Random) {
    this.inner = inner;
  }

  public next(): number {
    this.calls++;
    return this.inner.next();
  }
}

/** 決められた値列を返す Random(枯渇時は循環)。 */
export class SequenceRandom implements Random {
  public calls = 0;
  private readonly values: readonly number[];

  constructor(values: readonly number[]) {
    this.values = values;
  }

  public next(): number {
    const v = this.values[this.calls % this.values.length];
    this.calls++;
    return v;
  }
}

/** 呼ばれたら即失敗する Random(RNG フリー保証のテスト用)。 */
export class ForbiddenRandom implements Random {
  public next(): number {
    throw new Error('RNG must not be consumed here (RNG-free contract)');
  }
}
