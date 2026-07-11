import { MIZU_BLUE_GLSL, WATER_TINT_GLSL } from './glass';
import { SKY_CHUNK_GLSL, SKY_UNIFORMS_GLSL } from './sky';

/**
 * 雫(球内を落ちる水滴)のインポスター(design-render §5、裁定 A31 で改訂、
 * A46 で個体差を追加)。
 *
 * 白コア支配をやめ、溜まった水(InnerWater 体積/キャップ)と同じ #007fff 系の
 * 透明な水色を本体の基調に統一(A31)。加えて A46: aux.seed(雫ごとに独立、
 * 球ごとの水色ハッシュ waterTint とは別入力)をハッシュして個体差係数
 * t∈[0,1] を導出し、t=0 を現在色(最濃端)、t=1 を明るく透明な薄水色
 * (MIZU_LIGHT)として本体色を lerp — 雫ごとに色の個体差が出る
 * (フレネル縁・太陽ハイライト・pop-in は不変)。
 * sway の位置成分は sim が posr に焼き込み済み(裁定 A9)—
 * レンダラーは位置に足さず、aux は pop-in(spawnStep)と tint(seed)のみ。
 * 円外 discard + 不透明 + depthWrite ON。
 */
export const DROPLET_VERTEX_GLSL = /* glsl */ `
precision highp float;
attribute vec4 aPosR;
attribute vec4 aPosRPrev;
attribute vec4 aAux;   // [phase, swayAmp, spawnStep, seed]
uniform float uAlpha;
uniform float uStepF;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
varying vec2 vCorner;
varying vec3 vWorldPos;
varying vec3 vToCam;
varying float vSeed;

void main() {
  vec3 center = mix(aPosRPrev.xyz, aPosR.xyz, uAlpha);
  float r = mix(aPosRPrev.w, aPosR.w, uAlpha);

  // pop-in: 半径 0→1(10 step)。位置加算は禁止(A9 — sway は焼き込み済み)
  float popIn = smoothstep(0.0, 10.0, uStepF - aAux.z);
  float size = r * popIn;

  vec3 wp = center + (uCamRight * position.x + uCamUp * position.y) * size;
  vCorner = position.xy;
  vWorldPos = wp;
  vToCam = normalize(cameraPosition - center);
  vSeed = aAux.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const DROPLET_FRAGMENT_GLSL = /* glsl */ `
precision highp float;
${SKY_UNIFORMS_GLSL}
uniform vec3 uCamRight;
uniform vec3 uCamUp;
varying vec2 vCorner;
varying vec3 vWorldPos;
varying vec3 vToCam;
varying float vSeed;
${SKY_CHUNK_GLSL}
${MIZU_BLUE_GLSL}
${WATER_TINT_GLSL}
const vec3 MIZU_DEEP = vec3(0.0, 0.030, 0.160); // InnerWater 体積と同一パレット(A31)

void main() {
  float r2 = dot(vCorner, vCorner);
  if (r2 > 1.0) discard;
  float z = sqrt(1.0 - r2);

  // 球面法線の再構成(ビルボード基底 + 視線奥行き)
  vec3 n = normalize(uCamRight * vCorner.x + uCamUp * vCorner.y + vToCam * z);
  vec3 viewDir = normalize(vWorldPos - cameraPosition);

  // 本体: 溜まった水と同じ #007fff 系(A31)。中心をわずかに明るく、
  // 縁は MIZU_DEEP 寄りに沈めて球面の陰影を出す(白コアなし)
  vec3 body = mix(MIZU_DEEP, MIZU_BLUE, 0.35 + 0.65 * z);
  // A46: 雫ごとの色個体差 — aux.seed をハッシュした t で、現在色(最濃端、
  // t=0)から明るく透明な薄水色(MIZU_LIGHT、t=1)へ本体色を lerp
  float t = waterTint(vSeed);
  body = mix(body, MIZU_LIGHT, t * 0.85);
  vec3 color = body * (0.75 + 0.25 * z);

  // フレネル縁と空の映り込みはごく控えめに(水滴らしさの最小限の主張)
  float fresnel = pow(1.0 - z, 2.5);
  color += sky(reflect(viewDir, n)) * (0.04 + 0.14 * fresnel);
  vec3 halfDir = normalize(uSunDir - viewDir);
  color += uSunColor * (0.30 * pow(max(dot(n, halfDir), 0.0), 120.0));

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
