/**
 * リップルスプラット注入パス(design-render §2.2 — instanced quad 加算)。
 *
 * SplashEventView / SplatScheduler の 1 スプラット = 1 instanced quad を
 * 加算(ONE, ONE)でフィールドへ書く:
 * - G(速度)へ中心ガウスの押し下げ(高さ R には触れない — 運動量注入は
 *   波形が自然でエネルギー爆発しにくい。waterSplat.ts の実証知見)
 * - B(フォーム)へクラウン位置のリングを同時注入
 * - A(Mizu tint)へリング内側のディスク(生成直後だけ #007fff が 5% 透ける刻印)
 * 縁は d² の smoothstep でハードゼロ(加算の四角残滓防止)。
 */

/** 速度チャネルへの押し下げゲイン(高さクランプ ±0.28u が上限を守る)。 */
export const RIPPLE_SPLAT_GAIN = 0.26;
/**
 * フォームリング注入ゲイン(フォームクランプ 1.0)。
 * 裁定 A38: 0.8 → 0.55 — リングが出現フレームから飽和白(=閃光と誤読)に
 * ならず、「泡が湧いて広がる」強度で始まるように。
 */
export const RIPPLE_FOAM_GAIN = 0.55;
/** Mizu tint 注入ゲイン。 */
export const RIPPLE_TINT_GAIN = 0.85;

export const RIPPLE_SPLAT_VERTEX_GLSL = /* glsl */ `
precision highp float;
attribute vec4 aSplat;  // [x, z, quadRadius(world), strength]
attribute vec2 aRing;   // [ringR0(quad-local 0..1), tintGain 0..1]
uniform float uHalfExtent;  // アクション域半幅(12u)— 域中心は原点固定
varying vec2 vLocal;
varying float vStrength;
varying vec2 vRing;

void main() {
  vLocal = position.xy;
  vStrength = aSplat.w;
  vRing = aRing;
  vec2 world = aSplat.xy + position.xy * aSplat.z;
  gl_Position = vec4(world / uHalfExtent, 0.0, 1.0);
}
`;

export const RIPPLE_SPLAT_FRAGMENT_GLSL = /* glsl */ `
precision highp float;
uniform float uSplatGain;
uniform float uFoamGain;
uniform float uTintGain;
varying vec2 vLocal;
varying float vStrength;
varying vec2 vRing;

void main() {
  float d = length(vLocal);
  float d2 = d * d;
  float hard = 1.0 - smoothstep(0.6, 1.0, d2);              // 縁ハードゼロ
  float g = exp(-4.0 * d2) * hard;                          // 中心ガウス(押し下げ)
  float ring = exp(-pow((d - vRing.x) * 7.0, 2.0)) * hard;  // クラウン位置のフォーム
  float disc = (1.0 - smoothstep(vRing.x - 0.1, vRing.x + 0.05, d)) * hard;
  gl_FragColor = vec4(
    0.0,
    -uSplatGain * vStrength * g,
    uFoamGain * vStrength * ring,
    uTintGain * vRing.y * vStrength * disc
  );
}
`;
