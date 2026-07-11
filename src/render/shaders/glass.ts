import { SKY_CHUNK_GLSL, SKY_UNIFORMS_GLSL } from './sky';

/**
 * 球体ガラス(design-render §3)。instanced 2 パス:
 * - backside(加算・BackSide・dW off): 内側のリム発光 — 「厚みの向こう側」
 * - frontside(αブレンド・FrontSide・dW off): 低 α 吸収 + フレネルリム +
 *   虹彩 + 太陽スペキュラ + メニスカス(#007fff の光の帯)
 *
 * statePacked(整数部 = 状態 / 小数部 = 進行度)駆動の頂点変形:
 * Spawning スケールイン / Straining 縦呼吸 + さざ波 / Falling 張り解放 +
 * 微小空力ストレッチのみの剛体落下(A29)/
 * Splashing 膜拡張 + 閃光 + α フェード / Dead 縮退(ラスタ 0)。
 */

/** #007fff(linear)— 水のアイデンティティカラー。 */
export const MIZU_BLUE_GLSL = /* glsl */ `
const vec3 MIZU_BLUE = vec3(0.0, 0.2122, 1.0);
`;

/** cos パレットの虹彩(§3 — パステルに抑制して使う)。 */
export const IRID_CHUNK_GLSL = /* glsl */ `
vec3 irid(float x) {
  return 0.5 + 0.5 * cos(6.28318 * (x + vec3(0.0, 0.33, 0.67)));
}
`;

/** 球インスタンス共通の attribute / varying 宣言と復号(glass / innerWater 共用)。 */
export const BUBBLE_INSTANCE_VERTEX_PARS_GLSL = /* glsl */ `
attribute vec4 aCurrA;  // [ax, ay, az, R]
attribute vec4 aCurrB;  // [waterLevelYLocal, fill01, wobble, statePacked]
attribute vec4 aPrevA;
attribute vec4 aPrevB;
attribute vec2 aMisc;   // [slot, seed]
uniform float uAlpha;
uniform float uTimeSec;
`;

export const GLASS_VERTEX_GLSL = /* glsl */ `
precision highp float;
${BUBBLE_INSTANCE_VERTEX_PARS_GLSL}
varying vec3 vLocalPos;    // 単位球ローカル(= 法線の素)
varying vec3 vNormalW;
varying vec3 vWorldPos;
varying float vWaterLevel; // waterLevelYLocal / R
varying float vFill;
varying float vState;
varying float vProg;
varying float vSeed;

void main() {
  vec3 center = mix(aPrevA.xyz, aCurrA.xyz, uAlpha);
  float R = mix(aPrevA.w, aCurrA.w, uAlpha);
  float wl = mix(aPrevB.x, aCurrB.x, uAlpha);
  float fill = mix(aPrevB.y, aCurrB.y, uAlpha);
  float wobble = mix(aPrevB.z, aCurrB.z, uAlpha);
  float state = floor(aCurrB.w);   // statePacked は curr のみ(prev lerp 禁止)
  float prog = fract(aCurrB.w);
  float seed = aMisc.y;

  vec3 p = position;               // 単位球 = 法線
  // Spawning: スケールイン(弾性オーバーシュート)
  float grow = (state == 0.0) ? 0.6 + 0.5 * prog - 0.1 * sin(prog * 9.0) : 1.0;
  // Straining: 縦呼吸(張りの予兆)。Falling: 落下開始 ≈0.5 s で張り(+0.10)を
  // 解き、微小な空力ストレッチ(+0.04)だけ残して剛体的にまっすぐ落ちる(A29)
  float strain = (state == 2.0) ? prog : 0.0;
  float fallRelax = (state == 3.0) ? min(prog * 8.0, 1.0) : 0.0;
  float stretchY = 1.0 + strain * 0.10
                 + ((state == 3.0) ? mix(0.10, 0.04, fallRelax) : 0.0);
  p *= vec3(inversesqrt(stretchY), stretchY, inversesqrt(stretchY));
  // 表面さざ波(wobble ∈ [0,1] は sim 供給)— Falling では張りと同時に減衰(A29)
  float wobbleGain = 1.0 - fallRelax;
  p += position * wobble * wobbleGain
     * 0.05 * sin(p.y * 7.0 + uTimeSec * 12.0 + seed * 6.2832);
  // Splashing: 膜の拡張(消滅は α 側)。Dead: 縮退 quad = 実質カリング(A18)
  float pop = (state == 4.0) ? 1.0 + 0.25 * prog : 1.0;
  float alive = (state >= 5.0) ? 0.0 : 1.0;
  vec3 wp = center + p * R * grow * pop * alive;

  vLocalPos = position;
  vNormalW = normalize(p);
  vWorldPos = wp;
  vWaterLevel = wl / max(R, 1e-5);
  vFill = fill;
  vState = state;
  vProg = prog;
  vSeed = seed;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const GLASS_FRONT_FRAGMENT_GLSL = /* glsl */ `
precision highp float;
${SKY_UNIFORMS_GLSL}
uniform float uTimeSec;
varying vec3 vLocalPos;
varying vec3 vNormalW;
varying vec3 vWorldPos;
varying float vWaterLevel;
varying float vFill;
varying float vState;
varying float vProg;
varying float vSeed;
${SKY_CHUNK_GLSL}
${IRID_CHUNK_GLSL}
${MIZU_BLUE_GLSL}

void main() {
  vec3 nWorld = normalize(vNormalW);
  vec3 viewDir = normalize(vWorldPos - cameraPosition);
  float ndv = abs(dot(nWorld, -viewDir));
  float fresnel = 0.04 + 0.96 * pow(1.0 - ndv, 3.0);

  // 薄膜干渉の虹彩: 視角 + シード + 微時間で位相が回る(パステル)
  vec3 filmTint = irid(pow(1.0 - ndv, 1.4) * 2.2 + vSeed * 0.61 + uTimeSec * 0.015);

  // 屈折は解析スカイ(IOR ~1.02 の薄殻 — 背景の透過感は低 α が担う)
  vec3 color = sky(refract(viewDir, nWorld, 0.98)) * 0.10
             + sky(reflect(viewDir, nWorld)) * fresnel * 0.55
             + filmTint * fresnel * 0.16;

  // 太陽スペキュラ(タイト)
  vec3 halfDir = normalize(uSunDir - viewDir);
  color += uSunColor * (1.6 * pow(max(dot(nWorld, halfDir), 0.0), 240.0));

  // メニスカス: 内水面と接する円周の発光帯(交円上は全て y = wl)
  float yl = vLocalPos.y;
  float wl = vWaterLevel;
  color += MIZU_BLUE * exp(-pow((yl - wl) / 0.05, 2.0)) * (0.6 + 0.8 * vFill) * 1.4;
  color += MIZU_BLUE * smoothstep(wl + 0.02, wl - 0.25, yl) * 0.05; // 水没部のうっすら青

  // Splashing のポップ: フレネル閃光(指数減衰)+ α フェード
  // 裁定 A36: しぶきと同時に光る bloom バーストの主犯だったため 6.0→2.0 に減衰
  float flash = (vState == 4.0) ? 2.0 * exp(-vProg * 5.0) : 0.0;
  color *= 1.0 + flash * fresnel;
  float alpha = (0.06 + fresnel * 0.30) * ((vState == 4.0) ? 1.0 - vProg : 1.0);

  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export const GLASS_BACK_FRAGMENT_GLSL = /* glsl */ `
precision highp float;
${SKY_UNIFORMS_GLSL}
uniform float uTimeSec;
varying vec3 vLocalPos;
varying vec3 vNormalW;
varying vec3 vWorldPos;
varying float vWaterLevel;
varying float vFill;
varying float vState;
varying float vProg;
varying float vSeed;
${SKY_CHUNK_GLSL}
${IRID_CHUNK_GLSL}
${MIZU_BLUE_GLSL}

void main() {
  // 内側の面(BackSide)— ガラスの厚みの向こう側のリム発光(加算)
  vec3 nWorld = normalize(vNormalW);
  vec3 viewDir = normalize(vWorldPos - cameraPosition);
  float ndv = abs(dot(nWorld, viewDir));
  float rim = pow(1.0 - ndv, 2.5);

  vec3 filmTint = irid(pow(1.0 - ndv, 1.4) * 1.8 + vSeed * 0.61 - uTimeSec * 0.011);
  vec3 color = (sky(reflect(viewDir, nWorld)) * 0.30 + filmTint * 0.34) * rim;

  // メニスカスのかすかな裏写り
  color += MIZU_BLUE * exp(-pow((vLocalPos.y - vWaterLevel) / 0.07, 2.0)) * 0.20;

  float fade = (vState == 4.0) ? 1.0 - vProg : 1.0;
  gl_FragColor = vec4(color * fade * 0.55, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
