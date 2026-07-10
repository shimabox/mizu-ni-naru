/**
 * 原子(H / O / H₂ 本体)の発光インポスター(design-render §5)。
 *
 * 円外 discard + 不透明 + depthWrite ON(ソート不要・early-z 有効)。
 * HDR の出し方は「素地 <1・正対コアのみ >1」(密集時に白帯化しない教訓)。
 * パルスとフェードインは aux = [spawnStep, seed] 駆動(裁定 A6 —
 * gl_InstanceID ハッシュは swap-remove で位相が飛ぶため不採用)。
 */
export const ATOM_VERTEX_GLSL = /* glsl */ `
precision highp float;
attribute vec4 aPosR;      // [x, y, z, r](curr)
attribute vec4 aPosRPrev;
attribute vec4 aColorKind; // [r, g, b, kindIndex]
attribute vec4 aAux;       // [spawnStep, seed, 0, 0](A6)
uniform float uAlpha;
uniform float uStepF;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
varying vec2 vCorner;
varying vec3 vColor;
varying float vPulse;

void main() {
  vec3 center = mix(aPosRPrev.xyz, aPosR.xyz, uAlpha);
  float r = mix(aPosRPrev.w, aPosR.w, uAlpha);

  // 凝結フェードイン(半径 0→1、約 0.4s)+ seed 駆動パルス(≈0.5Hz)
  float fadeIn = smoothstep(0.0, 24.0, uStepF - aAux.x);
  float pulse = 0.9 + 0.1 * sin(uStepF * 0.05 + aAux.y * 25.13);
  float size = r * fadeIn;

  vec3 wp = center + (uCamRight * position.x + uCamUp * position.y) * size;
  vCorner = position.xy;
  vColor = aColorKind.rgb;
  vPulse = pulse;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const ATOM_FRAGMENT_GLSL = /* glsl */ `
precision highp float;
varying vec2 vCorner;
varying vec3 vColor;
varying float vPulse;

void main() {
  float r2 = dot(vCorner, vCorner);
  if (r2 > 1.0) discard;
  float z = sqrt(1.0 - r2);

  // 発光球: 素地 <1、正対ホットコアのみ >1(bloom はコアだけ拾う)
  vec3 color = vColor * (0.35 + 0.40 * z);
  float core = smoothstep(0.72, 1.0, z);
  color += vec3(1.0) * core * (0.2 + 0.9 * core) * vPulse;
  color += vColor * pow(1.0 - z, 2.0) * 0.6;   // フレネル風リム

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
