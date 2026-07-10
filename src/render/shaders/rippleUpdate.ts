/**
 * リップルフィールド積分パス(design-render §2.2 — 全画面三角形)。
 *
 * RGBA16F ピンポンの 5 タップ波動方程式カーネル:
 * - R = height / G = velocity / B = foam energy / A = Mizu tint(刻印)
 * - k = 0.45 ≤ 0.5 で無条件安定(Mizu-threejs waterUpdate.ts の実証値を踏襲)
 * - 高さクランプ ±0.28u + 境界フェード(端の反射リング吸収)で
 *   大強度スプラット連打でも発散しない
 * - フォームは微拡散(mix 0.35)+ 減衰 0.988/step(≈ 半減 1.0s)+
 *   強い波動の場所への自然発生(abs(v) 由来)
 * - A(tint)は拡散なし・やや速い減衰 — 「生成直後のリング内側」だけに残る
 *
 * 1 sim-step = 1 積分(60Hz 固定なので dt 項は係数に畳み込み済み)。
 */

/** 波動方程式カーネル係数(無条件安定域 k ≤ 0.5)。 */
export const RIPPLE_K = 0.45;
export const RIPPLE_VEL_DAMP = 0.997;
export const RIPPLE_HEIGHT_DAMP = 0.9993;
/** フォーム減衰 /step(≈ 3s 残存 — §2.4)。 */
export const RIPPLE_FOAM_DECAY = 0.988;
/** Mizu tint 減衰 /step(フォームよりやや速く消える刻印)。 */
export const RIPPLE_TINT_DECAY = 0.982;

export const RIPPLE_UPDATE_VERTEX_GLSL = /* glsl */ `
precision highp float;
varying vec2 vUv;

void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const RIPPLE_UPDATE_FRAGMENT_GLSL = /* glsl */ `
precision highp float;
uniform sampler2D uField;
uniform vec2 uTexel;       // 1 / resolution
uniform float uK;          // 0.45(≤ 0.5 無条件安定)
uniform float uVelDamp;    // 0.997
uniform float uHeightDamp; // 0.9993(DC ドリフト排除)
uniform float uFoamDecay;  // 0.988/step
uniform float uTintDecay;  // 0.982/step
varying vec2 vUv;

void main() {
  vec4 f  = texture2D(uField, vUv);
  vec4 fl = texture2D(uField, vUv - vec2(uTexel.x, 0.0));
  vec4 fr = texture2D(uField, vUv + vec2(uTexel.x, 0.0));
  vec4 fd = texture2D(uField, vUv - vec2(0.0, uTexel.y));
  vec4 fu = texture2D(uField, vUv + vec2(0.0, uTexel.y));

  float avg = 0.25 * (fl.r + fr.r + fd.r + fu.r);
  float v = (f.g + (avg - f.r) * uK) * uVelDamp;
  float h = (f.r + v) * uHeightDamp;

  // フォーム: 微拡散 + 減衰 + 強い波動の場所は自然に白く(§2.2)。
  // 拡散 0.12(リングが 3s 保つ)/ 運動由来はごく僅か(リングの繊細さ優先)
  float foamAvg = 0.25 * (fl.b + fr.b + fd.b + fu.b);
  float foam = mix(f.b, foamAvg, 0.12) * uFoamDecay;
  foam += clamp(abs(v) * 0.28 - 0.002, 0.0, 0.006);

  // Mizu tint(刻印): 拡散なし・減衰のみ
  float tint = f.a * uTintDecay;

  // 境界フェード = 端の反射リング吸収(Mizu-threejs 実証パターン)
  float edge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
  float fade = smoothstep(0.0, 0.06, edge);
  gl_FragColor = vec4(
    clamp(h, -0.28, 0.28) * fade,
    v * fade,
    min(foam, 1.5) * fade,
    min(tint, 1.0) * fade
  );
}
`;
