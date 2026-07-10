import { DT } from '../../contract/WorldSpec';
import {
  DROPLET_CAP_PER_BUBBLE,
  DROPLET_FALL_SPEED_PER_R,
  SWAY_FREQ,
} from '../config';

/**
 * 球ごとの雫 SoA 列(design-sim §4.1)。
 * 雫はオブジェクトにしない(「H2O は決して Particle にならない」—
 * Mizu-threejs の 2 階層設計の知見)。swap-remove SoA + **RNG フリーカーネル**
 * (位相・振幅はスポーン時に確定 — Mizu-threejs/src/sim/droplets/DropletStore.ts)。
 *
 * - 座標は球ローカル。prevPosr はカーネル冒頭で posr をコピー(補間契約 §1.4)
 * - swap-remove は posr / prevPosr / aux の **3 本同時**(prev/curr の同一
 *   インデックス = 同一エンティティを保つ — 契約 §1.4 規約 2)+ i 再処理
 * - 球内クランプ(本作新規): sway が球殻を突き抜けない
 * - cos は素の Math.cos でよい(≤448 雫 ≪ threejs が LUT を要した 30 万 —
 *   過剰最適化をしない判断基準ごと引き継ぐ)
 */

// hot path: ESM import 束縛はローカル束縛に剥がす(design-sim §8 の知見)
const STEP_DT = DT;
const FALL_PER_R = DROPLET_FALL_SPEED_PER_R;
const FREQ = SWAY_FREQ;
const CAP = DROPLET_CAP_PER_BUBBLE;
const V4 = 4;
const HALF_PI = Math.PI / 2;

/** 吸収イベントの通知先(BubbleWorld が体積加算・InnerRipple・wobble を担う)。 */
export interface AbsorbSink {
  onAbsorb(x: number, z: number, r: number): void;
}

export class DropletColumn {
  public readonly posr = new Float32Array(CAP * V4); // [x, y, z, r]
  public readonly prevPosr = new Float32Array(CAP * V4);
  public readonly aux = new Float32Array(CAP * V4); // [phase, swayAmp, spawnStep, seed]
  public count = 0;
  /** 容量溢れで捨てた数(ハードキャップ + ドロップカウンタで優雅に劣化)。 */
  public droppedTotal = 0;

  public clear(): void {
    this.count = 0;
  }

  /** スポーン(スポーンフレームは prev = curr)。満杯なら捨ててカウント。 */
  public spawn(
    x: number,
    y: number,
    z: number,
    r: number,
    phase: number,
    swayAmp: number,
    seed: number,
    nowStep: number,
  ): void {
    if (this.count >= CAP) {
      this.droppedTotal++;
      return;
    }
    const o = this.count * V4;
    const posr = this.posr;
    posr[o] = x;
    posr[o + 1] = y;
    posr[o + 2] = z;
    posr[o + 3] = r;
    this.prevPosr[o] = x;
    this.prevPosr[o + 1] = y;
    this.prevPosr[o + 2] = z;
    this.prevPosr[o + 3] = r;
    const aux = this.aux;
    aux[o] = phase;
    aux[o + 1] = swayAmp;
    aux[o + 2] = nowStep;
    aux[o + 3] = seed;
    this.count++;
  }

  /**
   * step カーネル(RNG フリー): prev コピー → 落下 + cos-sway(デチューン
   * Lissajous)→ 球内クランプ → 吸収(y ≤ waterY + r で swap-remove + 通知)。
   * @param waterY 球内水位(球ローカル y)
   * @param rInner 内殻半径 R_inner(粒子ごとの有効半径は rInner − r)
   */
  public step(waterY: number, rInner: number, sink: AbsorbSink): void {
    const posr = this.posr;
    const prev = this.prevPosr;
    const aux = this.aux;
    for (let i = 0; i < this.count; i++) {
      const o = i * V4;
      // 1. prev コピー(4 レーン)
      prev[o] = posr[o];
      prev[o + 1] = posr[o + 1];
      prev[o + 2] = posr[o + 2];
      prev[o + 3] = posr[o + 3];

      const r = posr[o + 3];
      const phase = aux[o];
      const swayAmp = aux[o + 1];
      let x = posr[o];
      const y = posr[o + 1] - FALL_PER_R * r * STEP_DT; // 落下速度は導出、保存しない
      let z = posr[o + 2];
      const s = (y + phase) * FREQ;
      x += Math.cos(s) * swayAmp * STEP_DT;
      z += Math.cos(s * 0.9 + HALF_PI) * swayAmp * 0.7 * STEP_DT;

      // 2. 球内クランプ(sway が球殻を突き抜けない)
      const rEff = rInner - r;
      const l2 = Math.max(rEff * rEff - y * y, 0);
      const h2 = x * x + z * z;
      if (h2 > l2 && h2 > 0) {
        const k = Math.sqrt(l2 / h2);
        x *= k;
        z *= k;
      }

      // 3. 吸収(下端接触)。swap-remove は 3 本同時 + i 再処理
      if (y <= waterY + r) {
        sink.onAbsorb(x, z, r);
        const last = (this.count - 1) * V4;
        for (let k = 0; k < V4; k++) {
          posr[o + k] = posr[last + k];
          prev[o + k] = prev[last + k];
          aux[o + k] = aux[last + k];
        }
        this.count--;
        i--;
        continue;
      }
      posr[o] = x;
      posr[o + 1] = y;
      posr[o + 2] = z;
    }
  }
}
