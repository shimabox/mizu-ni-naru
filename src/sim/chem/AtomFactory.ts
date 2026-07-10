import {
  ATOM_COLOR_BASE,
  ATOM_COLOR_SPAN,
  ATOM_RADIUS_RATIO,
  DROPLET_RADIUS_RATIO_MAX,
  DROPLET_RADIUS_RATIO_MIN,
  SWAY_AMP_RATIO_MAX,
  SWAY_AMP_RATIO_MIN,
} from '../config';
import type { Random } from '../core/Random';
import { Atom } from './Atom';

/**
 * 雫スポーンのレコード(反応 → DropletColumn へのルーティング用 —
 * design-sim §3.5 の droplets?: DropletSpawn[] 拡張の知見:
 * Mizu-threejs/src/sim/reactions/ReactionRule.ts)。座標は球ローカル。
 */
export interface DropletSpawnSpec {
  x: number;
  y: number;
  z: number;
  r: number;
  phase: number; // sway 位相 ∈ [0, 2π)
  swayAmp: number; // 横揺れ速度振幅(u/s)
  seed: number; // DropletView.aux[3]
}

/**
 * 原子・雫スポーンの生成工場 — **RNG 呼び順規約の一元文書化箇所**(design-sim
 * §7.1。規約一元化の様式: Mizu-threejs/src/sim/particles/ParticleFactory.ts)。
 *
 * ━━━ RNG 呼び順規約(単一 mulberry32 ストリーム — ゴールデンテストの生命線)━━━
 * 1. init: スロット昇順に
 *      [R, (角ジッター, 半径ジッター, y) × 分離チェック試行(≤8 回・決定的),
 *       bob 位相 ×2(y 用, x 用), 初期 fill ジッター]
 * 2. 毎 step スロット昇順に:
 *      FSM     — Splashing→Dead 遷移時: 再生成遅延 1 回。
 *                Dead 満了時: 再ロール一式(init と同順、初期 fill ジッターなし)
 *      原子更新 — 1 体あたりウォーク 2 回(cosPolar, azimuth の順)。
 *                水面交差時のみ +1 回(透過判定)
 *      雫カーネル — **0 回**(RNG フリー — §4.1)
 *      反応    — HHFusion: 1 回(色+seed)/ OxidationToDroplet: 4 回
 *                (r, phase, swayAmp, seed の順)
 *      スポナー — 試行ごと位置 3 回(x, y, z の順)、採用時 +1 回(色+seed)。
 *                不足ゼロ・停止状態では 0 回
 * 3. 条件付き消費(水面透過・棄却サンプリング・分離チェック)は「有界・決定的」
 *    のみ許可。閾値 1 つの変更が以後の全乱数をずらす — ゴールデンが壊れたら
 *    まずこの規約からの逸脱を疑う(壊れる変更を意図した場合は期待値を再記録)
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 色は「生成時に RNG 1 回の packed 0xRRGGBB」(Mizu シリーズの伝統 —
 * Mizu-threejs/src/sim/particles/ParticleFactory.ts randomColor)。同じ 1 回の
 * 生値を AtomView.aux の seed(裁定 A6 — render のパルス位相)としても使う
 * (呼び順規約の消費数を増やさないため)。
 */
export class AtomFactory {
  private readonly rng: Random;

  constructor(rng: Random) {
    this.rng = rng;
  }

  /** 原子を生成する(RNG 1 回: 色+seed)。r = ATOM_RADIUS_RATIO[kind] × R。 */
  public createAtom(
    kindIndex: number,
    x: number,
    y: number,
    z: number,
    bubbleR: number,
    nowStep: number,
  ): Atom {
    const v = this.rng.next();
    const packed = Math.min(Math.floor(v * 0x1000000), 0xffffff);
    const colR =
      ATOM_COLOR_BASE + (ATOM_COLOR_SPAN * ((packed >>> 16) & 0xff)) / 255;
    const colG =
      ATOM_COLOR_BASE + (ATOM_COLOR_SPAN * ((packed >>> 8) & 0xff)) / 255;
    const colB = ATOM_COLOR_BASE + (ATOM_COLOR_SPAN * (packed & 0xff)) / 255;
    return new Atom(
      kindIndex,
      ATOM_RADIUS_RATIO[kindIndex] * bubbleR,
      x,
      y,
      z,
      colR,
      colG,
      colB,
      v,
      nowStep,
    );
  }

  /**
   * 雫スポーンのパラメータを out に書き込む(RNG 4 回: r, phase, swayAmp, seed
   * の順 — 呼び順規約)。位相・振幅はスポーン時に確定し、以後の雫カーネルは
   * RNG フリー(§4.1 — Mizu-threejs/src/sim/droplets/DropletStore.ts の知見)。
   * out 再利用で定常アロケーションゼロ。
   */
  public fillDropletSpawn(
    x: number,
    y: number,
    z: number,
    bubbleR: number,
    out: DropletSpawnSpec,
  ): void {
    const rng = this.rng;
    const r =
      (DROPLET_RADIUS_RATIO_MIN +
        rng.next() * (DROPLET_RADIUS_RATIO_MAX - DROPLET_RADIUS_RATIO_MIN)) *
      bubbleR;
    out.x = x;
    out.y = y;
    out.z = z;
    out.r = r;
    out.phase = rng.next() * 2 * Math.PI;
    out.swayAmp =
      (SWAY_AMP_RATIO_MIN +
        rng.next() * (SWAY_AMP_RATIO_MAX - SWAY_AMP_RATIO_MIN)) *
      r;
    out.seed = rng.next();
  }
}
