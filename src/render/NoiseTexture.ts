import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RGBAFormat,
  RepeatWrapping,
  UnsignedByteType,
} from 'three';

/**
 * 手続き生成ノイズテクスチャ(design-render §2.4)。
 *
 * 外部アセットは持たない(GH Pages 完結・ゼロから実装の原則)。起動時に
 * 256² RGBA8 を焼き込み、全シェーダがこの 1 枚を共有する:
 * - R: fbm 値ノイズ 3 オクターブ(海の色揺らぎ・内水の揺らぎ)
 * - G: 別位相 fbm(フォーム breakup 用 — Phase 3)
 * - B: リッジノイズ(空の雲気 SKY_BACKDROP)
 * - A: ハッシュ白色(glitter ジッタ用)
 * 全チャネルがタイル化済み(RepeatWrapping で継ぎ目なし)。
 */
export const NOISE_TEXTURE_SIZE = 256;

/** fbm の基本格子周波数(テクスチャ 1 周あたりのセル数 — 2 の冪でタイル化)。 */
const BASE_FREQ = 8;
const OCTAVES = 3;

/** 決定論の整数ハッシュ → [0,1)。格子座標は周期 mod 済みを渡すこと。 */
const hash01 = (x: number, y: number, seed: number): number => {
  let h =
    Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 144665);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** タイル化した値ノイズ。u,v ∈ [0,1)、freq = 格子周期(整数)。 */
const valueNoise = (
  u: number,
  v: number,
  freq: number,
  seed: number,
): number => {
  const x = u * freq;
  const y = v * freq;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const x1 = (x0 + 1) % freq;
  const y1 = (y0 + 1) % freq;
  const xw = x0 % freq;
  const yw = y0 % freq;
  const a = hash01(xw, yw, seed);
  const b = hash01(x1, yw, seed);
  const c = hash01(xw, y1, seed);
  const d = hash01(x1, y1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
};

/** fbm(3 オクターブ、振幅 1 / 0.5 / 0.25 正規化)。値域 [0,1]。 */
const fbm = (u: number, v: number, seed: number): number => {
  let sum = 0;
  let amp = 1;
  let ampSum = 0;
  let freq = BASE_FREQ;
  for (let o = 0; o < OCTAVES; o++) {
    sum += valueNoise(u, v, freq, seed + o * 101) * amp;
    ampSum += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / ampSum;
};

/** リッジノイズ: 1 − |2·fbm − 1|(尾根状の筋 — 雲気向け)。値域 [0,1]。 */
const ridge = (u: number, v: number, seed: number): number =>
  1 - Math.abs(2 * fbm(u, v, seed) - 1);

/**
 * RGBA8 データの焼き込み(純ロジック — node テスト対象)。
 * 戻り値は size×size×4 バイト。
 */
export const generateNoiseData = (
  size: number = NOISE_TEXTURE_SIZE,
): Uint8Array => {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const o = (y * size + x) * 4;
      data[o] = Math.min(255, Math.floor(fbm(u, v, 1) * 256));
      data[o + 1] = Math.min(255, Math.floor(fbm(u, v, 7919) * 256));
      data[o + 2] = Math.min(255, Math.floor(ridge(u, v, 104729) * 256));
      data[o + 3] = Math.min(255, Math.floor(hash01(x, y, 65537) * 256));
    }
  }
  return data;
};

/** 共有ノイズテクスチャの生成(RepeatWrapping + mipmap)。 */
export const createNoiseTexture = (): DataTexture => {
  const texture = new DataTexture(
    generateNoiseData(),
    NOISE_TEXTURE_SIZE,
    NOISE_TEXTURE_SIZE,
    RGBAFormat,
    UnsignedByteType,
  );
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
};
