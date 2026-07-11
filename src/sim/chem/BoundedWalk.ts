import { DT } from '../../contract/WorldSpec';
import { ATOM_ACCEL_FRACTION, P_DISSOLVE } from '../config';
import type { Random } from '../core/Random';
import type { Atom } from './Atom';

/**
 * 有界ランダムウォーク(design-sim §3.1–3.3)。
 * - 一様 3D 方向 + 速度クランプ + mirror-and-negate(clamp ではない)の知見:
 *   Mizu-threejs/src/sim/behaviors/RandomWalk3D.ts。球面反射式(§3.2)と
 *   漏れあり水面(§3.3)は本設計固有
 * - 適用順序(決定的): ①ウォーク積分 → ②球面反射 → ③水面処理。
 *   移動量/step ≈0.013 u ≪ R_eff なので ②③ は毎 step 高々 1 回ずつで十分
 * - RNG 消費: walk = 2 回(cosPolar, azimuth の順)。水面は交差時のみ 1 回。
 *   呼び順規約の一元文書化は AtomFactory を参照(§7.1)
 */

// hot path: ESM import 束縛はローカル束縛に剥がす
// (束縛経由の定数参照がカーネルを 10 倍以上遅くする実測 — design-sim §8 の知見)
const STEP_DT = DT;
const ACCEL_FRACTION = ATOM_ACCEL_FRACTION;
const DISSOLVE_P = P_DISSOLVE;
const TWO_PI = Math.PI * 2;

/**
 * ウォーク積分: 一様 3D 方向(RNG 2 回: cosPolar, azimuth の順 — 呼び順固定)に
 * accel = v_max/14 を加え、速度を v_max にクランプして位置を積分する。
 */
export const walk = (atom: Atom, rng: Random, vMax: number): void => {
  const cosPolar = 2 * rng.next() - 1;
  const azimuth = TWO_PI * rng.next();
  const sinPolar = Math.sqrt(Math.max(1 - cosPolar * cosPolar, 0));
  const accel = vMax * ACCEL_FRACTION;
  let vx = atom.vx + sinPolar * Math.cos(azimuth) * accel;
  let vy = atom.vy + cosPolar * accel;
  let vz = atom.vz + sinPolar * Math.sin(azimuth) * accel;
  const s2 = vx * vx + vy * vy + vz * vz;
  if (s2 > vMax * vMax) {
    const k = vMax / Math.sqrt(s2);
    vx *= k;
    vy *= k;
    vz *= k;
  }
  atom.vx = vx;
  atom.vy = vy;
  atom.vz = vz;
  atom.x += vx * STEP_DT;
  atom.y += vy * STEP_DT;
  atom.z += vz * STEP_DT;
};

/**
 * 球面境界での反射(§3.2): 中心が有効半径 R_eff = R_inner − r を超えたら
 * 半径方向ミラー + 法線反射(接線成分は保存)。
 *   p ← n̂·(2·R_eff − d)、v ← v − 2·(v·n̂)·n̂
 * 1 step の移動量が微小なため 2·R_eff − d < 0 になる速度は構造的に出ない
 * (不変条件としてテスト対象 — §7.3)。
 */
export const reflectSphere = (atom: Atom, rEff: number): void => {
  const { x, y, z } = atom;
  const d2 = x * x + y * y + z * z;
  if (d2 <= rEff * rEff || d2 === 0) return;
  const d = Math.sqrt(d2);
  const nx = x / d;
  const ny = y / d;
  const nz = z / d;
  const mirrored = 2 * rEff - d;
  atom.x = nx * mirrored;
  atom.y = ny * mirrored;
  atom.z = nz * mirrored;
  const vDotN = atom.vx * nx + atom.vy * ny + atom.vz * nz;
  atom.vx -= 2 * vDotN * nx;
  atom.vy -= 2 * vDotN * ny;
  atom.vz -= 2 * vDotN * nz;
};

/**
 * 球内水面との相互作用の結果(§3.3 拡張 — 裁定 A34)。
 * None = 未接触、Dissolved = 溶解(消滅・体積加算・InnerRipple は呼び出し側)、
 * Bounced = mirror-and-negate 跳ね返り(「ポチャ」InnerRipple の発火・
 * 球ごとのレート制限は呼び出し側 BubbleWorld が担う — この関数は RNG 消費順を
 * 変えないため純粋に幾何を返すだけに留める)。
 */
export const WATER_INTERACTION = {
  None: 0,
  Dissolved: 1,
  Bounced: 2,
} as const;
export type WaterInteraction =
  (typeof WATER_INTERACTION)[keyof typeof WATER_INTERACTION];

/**
 * 球内水面との相互作用(§3.3 — 漏れあり反射 / 確率透過)。
 * 粒子の下端が水に触れたら、確率 P_DISSOLVE で溶解(Dissolved を返す)、
 * さもなくば水面で mirror-and-negate(y のみ。x/z は保存)して Bounced を
 * 返す。RNG は交差時のみ 1 回(呼び順は粒子更新順に埋め込まれ決定的)。
 *
 * 水面ミラーが球殻とのくさび部で R_eff を僅かに超えうるため、反射後に水平方向
 * (x/z)の位置クランプを 1 回だけ行う(y と速度は保存 — 球面境界と「常に水面より
 * 上」の両不変条件 §7.3 を厳密に守る。ミラーの持ち上げ量は ≤2·v_max·DT なので
 * |y| ≤ R_eff は構造的に保たれる)。
 */
export const interactWater = (
  atom: Atom,
  waterY: number,
  rEff: number,
  rng: Random,
): WaterInteraction => {
  if (atom.y - atom.r >= waterY) return WATER_INTERACTION.None;
  if (rng.next() < DISSOLVE_P) return WATER_INTERACTION.Dissolved;
  atom.y = 2 * (waterY + atom.r) - atom.y;
  atom.vy = -atom.vy;
  const l2 = Math.max(rEff * rEff - atom.y * atom.y, 0);
  const h2 = atom.x * atom.x + atom.z * atom.z;
  if (h2 > l2 && h2 > 0) {
    const k = Math.sqrt(l2 / h2);
    atom.x *= k;
    atom.z *= k;
  }
  return WATER_INTERACTION.Bounced;
};
