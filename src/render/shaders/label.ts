/**
 * 原子ラベル(H / O / H₂ の文字)— 加算ブレンド 1 draw(design-render §5)。
 *
 * AtomSystem の属性バッファをそのまま共有(追加アップロードゼロ)。
 * billboard quad をカメラ方向へ ~1.1×r 浮かせ、aColorKind.w でアトラスの
 * セルを選択。加算 = 順序非依存・depthTest on / depthWrite off。
 * 発光強度 1.2(加算の重なりで焼けない実測値)。
 */
export const LABEL_VERTEX_GLSL = /* glsl */ `
precision highp float;
attribute vec4 aPosR;
attribute vec4 aPosRPrev;
attribute vec4 aColorKind; // .w = kindIndex = アトラスセル
attribute vec4 aAux;
uniform float uAlpha;
uniform float uStepF;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
varying vec2 vUv;
varying float vFade;

void main() {
  vec3 center = mix(aPosRPrev.xyz, aPosR.xyz, uAlpha);
  float r = mix(aPosRPrev.w, aPosR.w, uAlpha);

  float fadeIn = smoothstep(0.0, 24.0, uStepF - aAux.x);
  // カメラ方向へ浮かせる(原子本体の手前に文字が乗る)
  vec3 toCam = normalize(cameraPosition - center);
  vec3 base = center + toCam * (1.1 * r);
  float half_ = 1.4 * r * fadeIn;
  vec3 wp = base + (uCamRight * position.x + uCamUp * position.y) * half_;

  // セル選択: アトラスは横 4 セル(セル順 = KIND_INDEX)
  vec2 corner = position.xy * 0.5 + 0.5;
  vUv = vec2((aColorKind.w + corner.x) * 0.25, corner.y);
  vFade = fadeIn;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const LABEL_FRAGMENT_GLSL = /* glsl */ `
precision highp float;
uniform sampler2D uAtlas;
varying vec2 vUv;
varying float vFade;

void main() {
  float coverage = texture2D(uAtlas, vUv).a;
  if (coverage < 0.01) discard;
  gl_FragColor = vec4(vec3(1.2) * coverage * vFade, coverage * vFade);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
