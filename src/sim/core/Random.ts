/**
 * 乱数生成のインターフェース。
 * seed は SimInitOptions で app 層から注入する(seed 省略時も app 層が
 * ランダムな seed を 1 個引いて注入する)— sim コア内に Math.random() は
 * 存在しない(決定論 — design-sim.md §7.1)。
 */
export interface Random {
  /** [0, 1) の乱数を返す */
  next(): number;
}

/**
 * mulberry32 によるシード付き乱数。
 * 同じシードからは常に同じ乱数列が得られる(ゴールデンテストの土台)。
 */
export class Mulberry32 implements Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  public next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
