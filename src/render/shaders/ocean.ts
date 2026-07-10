import { GERSTNER_CHUNK_GLSL, GERSTNER_UNIFORMS_GLSL } from './gerstner';
import { SKY_CHUNK_GLSL, SKY_UNIFORMS_GLSL } from './sky';

/**
 * Ocean v2 の頂点/フラグメント(design-render §2.1 / §2.3 / §2.6)。
 *
 * Phase 2 スコープ: Gerstner + シェーディング(フレネル / Beer-Lambert /
 * 擬似 SSS / タイトスペキュラ + glitter / sky() フォグ)。
 * Phase 3(リップル §2.2・フォーム §2.4・解析反射 §2.5)は
 * uniform / define の TODO フックのみ置く。
 */

/** Phase 3 フック: リップルフィールド(#define RIPPLE_FIELD で有効化)。 */
export const OCEAN_RIPPLE_HOOK_UNIFORMS_GLSL = /* glsl */ `
#ifdef RIPPLE_FIELD
// TODO(Phase 3 §2.2): uniform sampler2D uRipple; uniform vec2 uRippleCenter;
// uniform float uRippleTexelWorld;(高さ R / 速度 G / フォーム B)
#endif
`;

export const OCEAN_VERTEX_GLSL = /* glsl */ `
precision highp float;
${GERSTNER_UNIFORMS_GLSL}
${OCEAN_RIPPLE_HOOK_UNIFORMS_GLSL}
${GERSTNER_CHUNK_GLSL}
varying vec3 vWorldPos;
varying float vWaveY;

void main() {
  vec2 xz = position.xz;
  // 頂点は波 0-4 のみ(chop 5-7 は頂点解像度未満 — フラグメント法線専任 §2.1)
  vec3 off = gerstnerOffset(xz, 0, 5);
  #ifdef RIPPLE_FIELD
  // TODO(Phase 3 §2.2): off.y += リップル高さの 1 タップ vertex texture fetch
  #endif
  vec3 wp = vec3(xz.x + off.x, off.y, xz.y + off.z);
  vWorldPos = wp;
  vWaveY = off.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const OCEAN_FRAGMENT_GLSL = /* glsl */ `
precision highp float;
${SKY_UNIFORMS_GLSL}
${GERSTNER_UNIFORMS_GLSL}
${OCEAN_RIPPLE_HOOK_UNIFORMS_GLSL}
uniform sampler2D uNoise;
uniform float uTimeSec;
uniform float uSwellAmpSum;
uniform vec3 uDeepColor;   // #05253c(linear)
uniform vec3 uMidColor;    // #0d4d6e
uniform vec3 uSssColor;    // #2fc0a8 ターコイズ
uniform vec3 uFoamColor;   // #eef7f5

#ifdef ANALYTIC_REFLECTIONS
// TODO(Phase 3 §2.5): uniform vec4 uBubblePosR[8]; uniform vec4 uBubbleMisc[8];
// uniform int uBubbleCount; + vec3 reflectEnv(vec3 ro, vec3 rd)
#endif

varying vec3 vWorldPos;
varying float vWaveY;

${SKY_CHUNK_GLSL}
${GERSTNER_CHUNK_GLSL}

void main() {
  // 1) 法線: 8 波解析導関数(頂点法線補間より常に鮮鋭 — §2.1)
  vec3 grad;
  float jac;
  gerstnerDeriv(vWorldPos.xz, grad, jac);
  #ifdef RIPPLE_FIELD
  // TODO(Phase 3 §2.2): リップル勾配(4 タップ中心差分)を線形加算 + 域外フェード
  #endif
  vec3 n = normalize(vec3(-grad.x, 1.0 - grad.y, -grad.z));
  vec3 viewDir = normalize(vWorldPos - cameraPosition);
  float dist = distance(vWorldPos, cameraPosition);
  float facing = max(dot(-viewDir, n), 0.0);

  // 2) フォーム量(Phase 3 §2.4 で foamMask(jac, リップル B)に置換)
  float foam = 0.0;

  // 3) フレネル(Schlick、水の F0 = 0.02。フォームは粗面 → 反射抑制)
  float fresnel = (0.02 + 0.98 * pow(1.0 - facing, 5.0)) * (1.0 - 0.85 * foam);

  // 4) 反射 = 解析スカイ(Phase 3 で解析的球面反射 reflectEnv を追加)
  vec3 rdir = reflect(viewDir, n);
  rdir.y = abs(rdir.y);              // 水面下向き反射レイの黒ずみ防止
  vec3 reflected = sky(rdir);

  // 5) 水体色: Beer-Lambert 近似(視線角プロキシ)+ 波高で青緑へ
  vec3 body = mix(uMidColor, uDeepColor, pow(facing, 0.6));
  float thin = clamp(vWaveY / uSwellAmpSum, 0.0, 1.0);
  body = mix(body, uSssColor * 0.35, 0.25 * thin);

  // 6) 波頭の擬似 SSS: 太陽向き視線 × 波頭 × グレージングでターコイズが灯る
  float behindSun = pow(max(dot(viewDir, uSunDir), 0.0), 4.0);
  float crest = smoothstep(0.15, 0.9, thin); // TODO(Phase 3): + rippleH * 2.5
  vec3 sss = uSssColor * (1.6 * behindSun * crest * pow(1.0 - facing, 2.0));
  body += sss;

  vec3 color = mix(body, reflected, fresnel);

  // 7) 太陽スペキュラ(タイト)+ マイクロ glitter(ジッタ法線の超高指数ローブ)
  vec3 halfDir = normalize(uSunDir - viewDir);
  color += uSunColor * (4.0 * pow(max(dot(n, halfDir), 0.0), 600.0));
  vec2 guv = vWorldPos.xz * 6.5 + vec2(0.13, -0.11) * uTimeSec;
  vec3 jitter = texture2D(uNoise, guv).rgb * 2.0 - 1.0;
  vec3 gn = normalize(n + jitter * 0.16);
  float glint = pow(max(dot(gn, halfDir), 0.0), 1400.0);
  color += uSunColor * min(glint * 3.5, 3.5) * exp(-dist * 0.02);

  // 8) TODO(Phase 3 §2.4): フォーム合成 — color = mix(color, foamLit, foam)
  color = mix(color, uFoamColor, foam);

  // 9) 距離フォグ: sky(viewDir) へ溶かす(背景と数学的に一致 — 継ぎ目ゼロ)
  float fog = 1.0 - exp(-pow(dist / 260.0, 1.35));
  color = mix(color, sky(viewDir), fog);

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
