import { MIZU_BLUE_GLSL } from './glass';
import { SKY_CHUNK_GLSL, SKY_UNIFORMS_GLSL } from './sky';

/**
 * 雫(球内を落ちる水滴)のインポスター(design-render §5)。
 *
 * Mizu 伝統の白コア → #007fff リム + フレネル + 解析スカイ反射。
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

void main() {
  float r2 = dot(vCorner, vCorner);
  if (r2 > 1.0) discard;
  float z = sqrt(1.0 - r2);

  // 球面法線の再構成(ビルボード基底 + 視線奥行き)
  vec3 n = normalize(uCamRight * vCorner.x + uCamUp * vCorner.y + vToCam * z);
  vec3 viewDir = normalize(vWorldPos - cameraPosition);

  // 白コア → #007fff リム(Mizu 伝統グラデ)
  vec3 body = mix(vec3(0.92), MIZU_BLUE, smoothstep(0.05, 0.85, 1.0 - z));
  vec3 color = body * (0.5 + 0.5 * z);

  float fresnel = pow(1.0 - z, 2.5);
  color += sky(reflect(viewDir, n)) * (0.18 + 0.5 * fresnel);
  vec3 halfDir = normalize(uSunDir - viewDir);
  color += uSunColor * (0.8 * pow(max(dot(n, halfDir), 0.0), 60.0));

  // seed の tint 微変動(±8%)
  color *= 0.92 + 0.16 * vSeed;

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
