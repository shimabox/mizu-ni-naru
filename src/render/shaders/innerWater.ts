import {
  BUBBLE_INSTANCE_VERTEX_PARS_GLSL,
  MIZU_BLUE_GLSL,
  WATER_TINT_GLSL,
} from './glass';

/**
 * 球内の水 — 体積パス(design-render §4a)。
 *
 * FrontSide 1 パス + 解析コード長 Beer-Lambert:視線が球内水体を貫く長さを
 * 閉形式で求めて吸収に使う(レイマーチ不要)。水面平面より上は discard。
 * αブレンド + depthWrite ON — 「原子・雫は常に球内水面より上」(A25)により
 * ソート不要で閉じる。水の見た目半径は WATER_VISUAL_RATIO = 0.985R(A13)。
 */
export const WATER_VISUAL_RATIO = 0.985;

/** 球インスタンスの状態駆動変形(glass と同一式 — 水は等方縮小で追従)。 */
export const BUBBLE_STATE_TRANSFORM_GLSL = /* glsl */ `
// state 駆動の変形係数(§3)— grow / stretchY / alive / wobbleGain を返す
vec4 bubbleTransform(float state, float prog) {
  float grow = (state == 0.0) ? 0.6 + 0.5 * prog - 0.1 * sin(prog * 9.0) : 1.0;
  // A45: Straining の予兆 stretch ランプを ~4 割に縮小(0.10→0.04 — A29 は不変)
  float strain = (state == 2.0) ? prog : 0.0;
  // Falling: 落下開始 ≈0.5 s で張り(+0.10)を解き +0.04 の空力感のみ残す(A29)
  float fallRelax = (state == 3.0) ? min(prog * 8.0, 1.0) : 0.0;
  float stretchY = 1.0 + strain * 0.04
                 + ((state == 3.0) ? mix(0.10, 0.04, fallRelax) : 0.0);
  // 中身(水)は Splashing 進入と同時に消える(§3 — 海の FX が受け継ぐ)
  float alive = (state >= 4.0) ? 0.0 : 1.0;
  // wobble の視覚ゲイン — Falling で減衰し剛体的に落ちる(A29)
  float wobbleGain = 1.0 - fallRelax;
  return vec4(grow, stretchY, alive, wobbleGain);
}
`;

export const INNER_WATER_VERTEX_GLSL = /* glsl */ `
precision highp float;
${BUBBLE_INSTANCE_VERTEX_PARS_GLSL}
${BUBBLE_STATE_TRANSFORM_GLSL}
varying vec3 vWorldPos;
varying vec3 vCenter;
varying vec3 vLocalPos;
varying float vR;
varying float vWaterPlaneY;
varying float vFill;
varying float vSeed;

void main() {
  vec3 center = mix(aPrevA.xyz, aCurrA.xyz, uAlpha);
  float R = mix(aPrevA.w, aCurrA.w, uAlpha);
  float wl = mix(aPrevB.x, aCurrB.x, uAlpha);
  float fill = mix(aPrevB.y, aCurrB.y, uAlpha);
  float state = floor(aCurrB.w);
  float prog = fract(aCurrB.w);

  vec4 tf = bubbleTransform(state, prog);
  // ガラスの xz 圧縮(1/√stretchY)の内側に収まる等方半径
  float s = ${WATER_VISUAL_RATIO} * inversesqrt(tf.y);
  float Rv = R * s * tf.x * tf.z;

  vec3 wp = center + position * Rv;
  vWorldPos = wp;
  vCenter = center;
  vLocalPos = position;
  vR = Rv;
  vWaterPlaneY = center.y + wl * tf.x * tf.z;
  vFill = fill;
  vSeed = aMisc.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const INNER_WATER_FRAGMENT_GLSL = /* glsl */ `
precision highp float;
uniform sampler2D uNoise;
uniform float uTimeSec;
uniform vec3 uSssColor;
varying vec3 vWorldPos;
varying vec3 vCenter;
varying vec3 vLocalPos;
varying float vR;
varying float vWaterPlaneY;
varying float vFill;
varying float vSeed;
${MIZU_BLUE_GLSL}
${WATER_TINT_GLSL}
const vec3 MIZU_DEEP = vec3(0.0, 0.030, 0.160);

void main() {
  // 水面平面より上は discard(§4a — フラグメント = 球前面の点)
  if (vWorldPos.y > vWaterPlaneY + 0.002) discard;

  vec3 rd = normalize(vWorldPos - cameraPosition);
  vec3 oc = vWorldPos - vCenter;
  float b = dot(oc, rd);
  float tExit = -b + sqrt(max(b * b - dot(oc, oc) + vR * vR, 0.0)); // 球の出口
  float tPlane = (rd.y > 0.0) ? (vWaterPlaneY - vWorldPos.y) / rd.y : 1e9;
  float len = clamp(min(tExit, tPlane), 0.0, 2.0 * vR);

  // A44: 球ごとの水色ハッシュ(0=現在色/最濃端、1=淡い透明水色)。吸収係数を
  // 弱め・基調色を淡いアクアへ・α 上限も下げる方向でキャップ/メニスカスと追従
  float tint = waterTint(vSeed);

  // A39: 「色が濃い」— 吸収を弱め(1.9/0.75/0.35 → 1.2/0.5/0.24)、深色への
  // 沈み込みを 0.6 倍に、透過も上げて向こうの景色がうっすら通る薄い水色に
  vec3 absorb = exp(-len / max(vR, 1e-5) * vec3(1.2, 0.5, 0.24) * (1.0 - 0.45 * tint)); // 青が生き残る
  vec3 baseColor = mix(MIZU_BLUE * 0.95, MIZU_LIGHT, tint * 0.7);
  vec3 color = mix(baseColor, MIZU_DEEP, (1.0 - absorb.b) * 0.6)
             + uSssColor * 0.10 *
               texture2D(uNoise, vLocalPos.xz * 2.0 + uTimeSec * 0.05).r;
  float alpha = clamp(0.42 + 0.38 * (1.0 - absorb.b), 0.0, 0.8) * mix(1.0, 0.75, tint);
  alpha *= smoothstep(0.0, 0.03, vFill); // 空球の極小レンズを消す

  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
