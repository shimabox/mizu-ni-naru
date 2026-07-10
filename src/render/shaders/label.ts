/**
 * 原子 = 文字(H / O / H₂)のビルボード — 通常アルファブレンド 1 draw
 * (design-render §5 改: 文字が主役)。
 *
 * 発光球インポスターは廃止し、Mizu-ts の原点「色付きテキストがそのまま
 * 漂う」へ回帰。AtomView の属性バッファを共有し、aColorKind.rgb で文字を
 * per-atom 着色、aColorKind.w でアトラスのセルを選択。アトラスは
 * G = 本体 / R = 暗色縁取り / A = 合計被覆(LabelAtlas 参照)— 縁取りが
 * 明るい空でも文字を沈ませない。加算ブレンドは白背景で消えるため
 * **通常アルファブレンド**(depthTest on / depthWrite off)。
 * スポーンフェードインとごく控えめな明滅は aux = [spawnStep, seed] 駆動。
 */
export const LABEL_VERTEX_GLSL = /* glsl */ `
precision highp float;
attribute vec4 aPosR;      // [x, y, z, r](curr)
attribute vec4 aPosRPrev;
attribute vec4 aColorKind; // [r, g, b, kindIndex]
attribute vec4 aAux;       // [spawnStep, seed, 0, 0]
uniform float uAlpha;
uniform float uStepF;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
varying vec2 vUv;
varying vec3 vColor;
varying float vFade;
varying float vPulse;

void main() {
  vec3 center = mix(aPosRPrev.xyz, aPosR.xyz, uAlpha);
  float r = mix(aPosRPrev.w, aPosR.w, uAlpha);

  // 凝結フェードイン(サイズ 0→1、約 0.4s)+ seed 駆動のごく控えめな明滅
  float fadeIn = smoothstep(0.0, 24.0, uStepF - aAux.x);
  float pulse = 0.92 + 0.08 * sin(uStepF * 0.05 + aAux.y * 25.13);

  // カメラ方向へわずかに浮かせる(雫や球内水面との前後を安定させる)
  vec3 toCam = normalize(cameraPosition - center);
  vec3 base = center + toCam * (0.6 * r);
  // 文字そのものが原子の本体 — 旧「球 + ラベル」と同程度の存在感
  float half_ = 2.0 * r * fadeIn;
  vec3 wp = base + (uCamRight * position.x + uCamUp * position.y) * half_;

  // セル選択: アトラスは横 4 セル(セル順 = KIND_INDEX)
  vec2 corner = position.xy * 0.5 + 0.5;
  vUv = vec2((aColorKind.w + corner.x) * 0.25, corner.y);
  vColor = aColorKind.rgb;
  vFade = fadeIn;
  vPulse = pulse;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const LABEL_FRAGMENT_GLSL = /* glsl */ `
precision highp float;
uniform sampler2D uAtlas;
varying vec2 vUv;
varying vec3 vColor;
varying float vFade;
varying float vPulse;

void main() {
  vec4 tex = texture2D(uAtlas, vUv);
  float coverage = tex.a;
  if (coverage < 0.01) discard;

  // G = 本体(per-atom 色 × 明滅)/ R = 暗色縁取り(明るい空対策)。
  // 被覆の重み付き平均で本体とエッジを混色(bloom に乗らない輝度 ≤ ~1.1)。
  float fill = tex.g;
  float edge = tex.r;
  vec3 fillColor = vColor * (1.1 * vPulse);
  vec3 edgeColor = vec3(0.015, 0.055, 0.10);   // 深い青紺
  vec3 color = (fillColor * fill + edgeColor * edge) / max(fill + edge, 1e-3);

  gl_FragColor = vec4(color, coverage * vFade);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
