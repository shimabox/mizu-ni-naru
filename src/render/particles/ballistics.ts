/**
 * スプレー弾道の純ロジック(design-render §6)。
 *
 * スプレーはステートレス弾道 — CPU は spawn 時に 1 回書くだけで、以後の運動は
 * シェーダが閉形式評価する。従って落着時刻・地点も spawn 時に閉形式で確定でき、
 * SplatScheduler へのマイクロスプラット予約に使う。three 非依存(テスト対象)。
 */

/** スプレーの重力(ドリーミー演出 — §6)。 */
export const SPRAY_G_EFF = 5.4;

/**
 * 落着時刻の閉形式解: y(t) = p0y + v0y·t − g/2·t² = 0 の正根。
 * p0y ≥ 0 前提(海面スポーン)。
 */
export const solveLandingTime = (
  p0y: number,
  v0y: number,
  g: number = SPRAY_G_EFF,
): number => (v0y + Math.sqrt(v0y * v0y + 2 * g * Math.max(p0y, 0))) / g;

/** 決定論の整数ハッシュ(イベント → PRNG シード)。 */
export const hashSeed = (a: number, b: number, c: number): number => {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263);
  h = (h ^ Math.imul(c | 0, 144665)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
};

/** mulberry32(小型・決定論 PRNG — render 側 FX 専用)。 */
export const mulberry32 = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * aVel.w のパック: kind(0 = 水滴 / 1 = 膜片)+ size01/2。
 * シェーダ側: kind = floor(w)、size01 = fract(w)·2、seed = fract(w·7.31)。
 */
export const packKindSize = (kind: 0 | 1, size01: number): number =>
  kind + Math.min(Math.max(size01, 0), 0.999) * 0.5;

const clamp01 = (x: number): number => Math.min(Math.max(x, 0), 1);

/** クラウンリングの粒子数 55〜100(strength 比例 — §6、裁定 A33 でやや増量)。 */
export const crownCount = (strength: number): number =>
  Math.round(55 + 45 * clamp01(strength));

/** 球ポップの膜片数 20〜40(§6)。 */
export const membraneCount = (strength: number): number =>
  Math.round(20 + 20 * clamp01(strength));

/**
 * A57: しぶきの色を着水した球の水色に完全一致させるための JS 側複製。
 *
 * `src/render/shaders/glass.ts` の `WATER_TINT_GLSL`(`waterTint(seed) =
 * WATER_TINT_MAX * fract(sin(seed*91.345+7.13)*43758.5453)`、
 * `WATER_TINT_MAX=0.55`)と `mix(MIZU_BLUE, MIZU_LIGHT, waterTint(seed))` を
 * **同一の計算**として CPU 側に複製する(ソースオブトゥルースは glass.ts —
 * 定数・式を変更する場合は両方を同期させること)。
 * `seed` は `bubbleVisualSeed`(BubbleInstanceBuffers.ts、裁定 A22)と同じ値。
 */
const WATER_TINT_MAX = 0.55; // glass.ts WATER_TINT_GLSL と一致(A47)
/** #007fff(linear)— glass.ts MIZU_BLUE_GLSL と一致。 */
const MIZU_BLUE: readonly [number, number, number] = [0.0, 0.2122, 1.0];
/** glass.ts WATER_TINT_GLSL の MIZU_LIGHT と一致。 */
const MIZU_LIGHT: readonly [number, number, number] = [0.58, 0.84, 0.92];

/** GLSL の `fract(sin(x)*43758.5453)` と同一の疑似乱数ハッシュ。 */
const fractSinHash = (x: number): number => {
  const s = Math.sin(x) * 43758.5453;
  return s - Math.floor(s);
};

/** glass.ts `waterTint(seed)` と同一計算(A44/A47)。 */
export const waterTint = (seed: number): number =>
  WATER_TINT_MAX * fractSinHash(seed * 91.345 + 7.13);

/**
 * `mix(MIZU_BLUE, MIZU_LIGHT, waterTint(seed))` と同一計算の RGB を
 * `out[0..2]` に書く(割り当てなしのホットパス向け)。
 */
export const bubbleWaterColor = (
  seed: number,
  out: Float32Array | [number, number, number],
): void => {
  const t = waterTint(seed);
  out[0] = MIZU_BLUE[0] + (MIZU_LIGHT[0] - MIZU_BLUE[0]) * t;
  out[1] = MIZU_BLUE[1] + (MIZU_LIGHT[1] - MIZU_BLUE[1]) * t;
  out[2] = MIZU_BLUE[2] + (MIZU_LIGHT[2] - MIZU_BLUE[2]) * t;
};
