import { IRID_CHUNK_GLSL } from './glass';

/**
 * スプレー/しぶき(design-render §6 — ステートレス弾道 billboard quad)。
 *
 * - 位置は毎フレームシェーダ内で閉形式評価(アップロードは spawn 時のみ)
 * - 死(寿命超過 / 海面到達 / 未スポーン)= 縮退 quad(ラスタ 0)
 * - 加算・depthWrite off・HDR ≤ 0.95(裁定 A33: bloom 閾値 1.15 を下回り、
 *   加算しぶきが「発光する火花」に見えないようにする — bloom には乗らない)
 * - kind 0 = 水滴(白 → 淡い水色、細かい粒)/ kind 1 = 膜片(虹彩 tint・大きめ)
 */

export const SPRAY_VERTEX_GLSL = /* glsl */ `
precision highp float;
attribute vec4 aSpawn;  // [p0x, p0y, p0z, spawnStepF]
attribute vec4 aVel;    // [v0x, v0y, v0z, kind + size01/2]
uniform float uStepF;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
varying vec2 vQuad;
varying float vKind;
varying float vSeed;
varying float vFade;

const float G_EFF = 5.4;   // ballistics.ts SPRAY_G_EFF と一致(ドリーミー演出)

void main() {
  float age = (uStepF - aSpawn.w) / 60.0;
  float kind = floor(aVel.w + 0.001);
  float size01 = fract(aVel.w) * 2.0;
  float seed = fract(aVel.w * 7.31);

  vec3 p = aSpawn.xyz + aVel.xyz * age - vec3(0.0, 0.5 * G_EFF * age * age, 0.0);
  float life = 0.8 + seed * 0.9;
  float fade = smoothstep(0.0, 0.08, age) * (1.0 - smoothstep(life * 0.7, life, age));
  float kill = (age < 0.0 || age > life || p.y < -0.05) ? 0.0 : 1.0;

  // 裁定 A33: 水滴を細かく(mix 上限を 0.14→0.095 に縮小、「水しぶき」の粒立ち)
  float size = mix(0.018, 0.095, size01) * (kind > 0.5 ? 1.7 : 1.0);
  vec3 wp = p + (uCamRight * position.x + uCamUp * position.y)
              * (size * fade * kill);

  vQuad = position.xy;
  vKind = kind;
  vSeed = seed;
  vFade = fade * kill;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const SPRAY_FRAGMENT_GLSL = /* glsl */ `
precision highp float;
uniform vec3 uSunColor;
varying vec2 vQuad;
varying float vKind;
varying float vSeed;
varying float vFade;
${IRID_CHUNK_GLSL}

void main() {
  float d = length(vQuad);
  float core = exp(-3.0 * d * d) * (1.0 - smoothstep(0.65, 1.0, d));

  // 裁定 A33: 水滴は白 → 淡い水色の微グラデ(飽和ターコイズを抑え「水しぶき」寄りに)。
  // 膜片: 虹彩(ガラス膜の名残、不変)
  vec3 water = mix(vec3(0.90, 0.96, 0.99), vec3(0.55, 0.82, 0.88),
                   fract(vSeed * 3.7) * 0.55);
  vec3 film = irid(vSeed * 2.7 + d * 1.6) * 0.55 + vec3(0.30);
  vec3 tint = mix(water, film, step(0.5, vKind));

  // 太陽色 tint を弱める(裁定 A33: 0.6→0.18)。加算グロー自体は HDR 上限で頭打ち
  vec3 col = tint * core * (0.7 + 1.1 * vFade)
           + uSunColor * (core * core * 0.18);
  col = min(col, vec3(0.95));  // HDR 上限(bloom 閾値 1.15 未満 — A33)

  gl_FragColor = vec4(col * vFade, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
