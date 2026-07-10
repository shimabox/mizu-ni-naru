import { GERSTNER_CHUNK_GLSL, GERSTNER_UNIFORMS_GLSL } from './gerstner';
import { IRID_CHUNK_GLSL, MIZU_BLUE_GLSL } from './glass';
import { SKY_CHUNK_GLSL, SKY_UNIFORMS_GLSL } from './sky';

/**
 * Ocean v2 の頂点/フラグメント(design-render §2.1 / §2.2 / §2.3 / §2.6)。
 *
 * - (a) Gerstner 8 波(頂点 0-4 変位 / フラグメント 8 波解析導関数)
 * - (b) RIPPLE_FIELD: 中央アクション域のハイトフィールドを頂点 1 タップ変位 +
 *   勾配線形加算の法線合成で統合。域内はスウェル振幅 25% 減衰
 *   (リングの読み取りやすさ — §2.2)
 * - (c) フレネル / Beer-Lambert / 擬似 SSS / タイトスペキュラ + glitter / フォグ
 * Phase 3 残: フォーム §2.4 / 解析反射 §2.5。
 */

/** リップルフィールド uniform(#define RIPPLE_FIELD で有効化 — §2.2)。 */
export const OCEAN_RIPPLE_UNIFORMS_GLSL = /* glsl */ `
#ifdef RIPPLE_FIELD
uniform sampler2D uRipple;        // R=height / G=velocity / B=foam / A=tint
uniform float uRippleTexelUv;     // 1 / 解像度
uniform float uRippleTexelWorld;  // 域幅 / 解像度 [u]
uniform float uRippleHalfExtent;  // 12u(域中心は原点固定)

// アクション域のスウェル減衰: 域内 25% 減(×0.75 → 1.0 へ smoothstep)
float swellZoneGain(vec2 xz) {
  return mix(0.75, 1.0, smoothstep(6.0, 12.0, length(xz)));
}
// 域外フェード(法線・変位・フォームの寄与を縁で 0 に)
float rippleMask(vec2 xz) {
  return 1.0 - smoothstep(10.5, 12.0, length(xz));
}
vec2 rippleUv(vec2 xz) {
  return xz / (2.0 * uRippleHalfExtent) + 0.5;
}
#endif
`;

export const OCEAN_VERTEX_GLSL = /* glsl */ `
precision highp float;
${GERSTNER_UNIFORMS_GLSL}
${OCEAN_RIPPLE_UNIFORMS_GLSL}
${GERSTNER_CHUNK_GLSL}
varying vec3 vWorldPos;
varying float vWaveY;

void main() {
  vec2 xz = position.xz;
  float gain = uSwellGain;
  #ifdef RIPPLE_FIELD
  gain *= swellZoneGain(xz);
  #endif
  // 頂点は波 0-4 のみ(chop 5-7 は頂点解像度未満 — フラグメント法線専任 §2.1)
  vec3 off = gerstnerOffset(xz, 0, 5, gain);
  vec3 wp = vec3(xz.x + off.x, off.y, xz.y + off.z);
  #ifdef RIPPLE_FIELD
  // Gerstner 変位後のワールド xz で 1 タップ(横変位 ≤ 0.25u < 4 texel — §2.2)
  wp.y += texture2D(uRipple, rippleUv(wp.xz)).r * rippleMask(wp.xz);
  #endif
  vWorldPos = wp;
  vWaveY = off.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const OCEAN_FRAGMENT_GLSL = /* glsl */ `
precision highp float;
${SKY_UNIFORMS_GLSL}
${GERSTNER_UNIFORMS_GLSL}
${OCEAN_RIPPLE_UNIFORMS_GLSL}
uniform sampler2D uNoise;
uniform float uTimeSec;
uniform float uSwellAmpSum;
uniform vec3 uDeepColor;   // #05253c(linear)
uniform vec3 uMidColor;    // #0d4d6e
uniform vec3 uSssColor;    // #2fc0a8 ターコイズ
uniform vec3 uFoamColor;   // #eef7f5

#ifdef ANALYTIC_REFLECTIONS
uniform vec4 uBubblePosR[8];  // [cx, cy, cz, R_visual](補間 + 状態変形済み)
uniform vec4 uBubbleMisc[8];  // [waterLevelYLocal/R, fill01, seed, fade]
uniform int uBubbleCount;
#endif

varying vec3 vWorldPos;
varying float vWaveY;

${SKY_CHUNK_GLSL}
${GERSTNER_CHUNK_GLSL}
${MIZU_BLUE_GLSL}
${IRID_CHUNK_GLSL}

#ifdef ANALYTIC_REFLECTIONS
// ≤7 球の閉形式レイ交差(§2.5)— 海面が揺れているため反射像は自然に歪む。
// リム + 虹彩 + 内水の青の 3 要素で「球が映っている」と読めれば十分。
// 動的 index を避けるためヒット時に値をコピーする(ESSL への安全策)。
vec3 reflectEnv(vec3 ro, vec3 rd) {
  vec3 env = sky(rd);
  float bestT = 1e9;
  vec3 hitCenter = vec3(0.0);
  float hitR = 1.0;
  vec4 hitMisc = vec4(0.0);
  for (int i = 0; i < 8; i++) {
    if (i >= uBubbleCount) break;
    vec3 oc = ro - uBubblePosR[i].xyz;
    float b = dot(oc, rd);
    float c = dot(oc, oc) - uBubblePosR[i].w * uBubblePosR[i].w;
    float disc = b * b - c;
    if (disc > 0.0) {
      float t = -b - sqrt(disc);
      if (t > 0.0 && t < bestT) {
        bestT = t;
        hitCenter = uBubblePosR[i].xyz;
        hitR = uBubblePosR[i].w;
        hitMisc = uBubbleMisc[i];
      }
    }
  }
  if (bestT < 1e8) {
    vec3 p = ro + rd * bestT;
    vec3 n = (p - hitCenter) / hitR;
    float rim = pow(1.0 - abs(dot(n, -rd)), 2.0);
    vec3 glassy = sky(reflect(rd, n)) * 0.35
                + irid(rim * 2.0 + hitMisc.z * 0.61) * rim * 0.35;
    // 内水面(n.y < wl/R)には #007fff の青が映る
    float water = smoothstep(hitMisc.x + 0.05, hitMisc.x - 0.2, n.y);
    glassy = mix(glassy, MIZU_BLUE * 0.5, water * 0.55);
    env = mix(env, glassy + sky(rd) * 0.25,
              clamp(rim + 0.35, 0.0, 1.0) * hitMisc.w);
  }
  return env;
}
#endif

void main() {
  // 1) 法線: 8 波解析導関数 + リップル勾配の線形加算(§2.1 / §2.2)
  float gain = uSwellGain;
  #ifdef RIPPLE_FIELD
  gain *= swellZoneGain(vWorldPos.xz);
  #endif
  vec3 grad;
  float jac;
  gerstnerDeriv(vWorldPos.xz, gain, grad, jac);

  float rippleH = 0.0;
  float foamE = 0.0;
  float mizuTint = 0.0;
  vec2 rippleGrad = vec2(0.0);
  #ifdef RIPPLE_FIELD
  float rMask = rippleMask(vWorldPos.xz);
  if (rMask > 0.001) {
    vec2 ruv = rippleUv(vWorldPos.xz);
    vec4 rc = texture2D(uRipple, ruv);
    float hl = texture2D(uRipple, ruv - vec2(uRippleTexelUv, 0.0)).r;
    float hr = texture2D(uRipple, ruv + vec2(uRippleTexelUv, 0.0)).r;
    float hd = texture2D(uRipple, ruv - vec2(0.0, uRippleTexelUv)).r;
    float hu = texture2D(uRipple, ruv + vec2(0.0, uRippleTexelUv)).r;
    rippleGrad = vec2(hr - hl, hu - hd) / (2.0 * uRippleTexelWorld) * rMask;
    rippleH = rc.r * rMask;
    foamE = rc.b * rMask;
    mizuTint = rc.a * rMask;
  }
  #endif
  vec3 n = normalize(vec3(-(grad.x + rippleGrad.x),
                          1.0 - grad.y,
                          -(grad.z + rippleGrad.y)));
  vec3 viewDir = normalize(vWorldPos - cameraPosition);
  float dist = distance(vWorldPos, cameraPosition);
  float facing = max(dot(-viewDir, n), 0.0);

  // 2) フォーム量(§2.4 — 2 系統: ヤコビアン波頭 + 着水フォームリング)
  //    凪の海なので波頭フォームは稀 — スウェルが重なった瞬間だけ筋状に湧く
  float crestFoam = smoothstep(0.30, 0.65, 1.0 - jac);
  float foamRaw = clamp(foamE * 1.05 + crestFoam * 0.5, 0.0, 1.0);
  float breakup = texture2D(uNoise, vWorldPos.xz * 1.7 + vec2(uTimeSec * 0.01)).g;
  float foam = foamRaw * smoothstep(0.25, 0.78, breakup + foamRaw * 0.5);

  // 3) フレネル(Schlick、水の F0 = 0.02。フォームは粗面 → 反射抑制)
  float fresnel = (0.02 + 0.98 * pow(1.0 - facing, 5.0)) * (1.0 - 0.85 * foam);

  // 4) 反射 = 解析スカイ + 解析的球面反射(§2.5、ANALYTIC_REFLECTIONS)
  vec3 rdir = reflect(viewDir, n);
  rdir.y = abs(rdir.y);              // 水面下向き反射レイの黒ずみ防止
  #ifdef ANALYTIC_REFLECTIONS
  vec3 reflected = reflectEnv(vWorldPos, rdir);
  #else
  vec3 reflected = sky(rdir);
  #endif

  // 5) 水体色: Beer-Lambert 近似(視線角プロキシ)+ 波高で青緑へ
  vec3 body = mix(uMidColor, uDeepColor, pow(facing, 0.6));
  float thin = clamp(vWaveY / uSwellAmpSum, 0.0, 1.0);
  body = mix(body, uSssColor * 0.35, 0.25 * thin);

  // 6) 波頭の擬似 SSS: 太陽向き視線 × 波頭 × グレージングでターコイズが灯る
  float behindSun = pow(max(dot(viewDir, uSunDir), 0.0), 4.0);
  float crest = smoothstep(0.15, 0.9, thin + rippleH * 2.5);
  vec3 sss = uSssColor * (1.6 * behindSun * crest * pow(1.0 - facing, 2.0));
  body += sss;

  vec3 color = mix(body, reflected, fresnel);

  // Mizu の刻印: 生成直後のリング内側にだけ #007fff を 5% 混ぜる(§2.4)
  color = mix(color, MIZU_BLUE, 0.05 * clamp(mizuTint, 0.0, 1.0));

  // 7) 太陽スペキュラ(タイト)+ マイクロ glitter(ジッタ法線の超高指数ローブ)
  vec3 halfDir = normalize(uSunDir - viewDir);
  color += uSunColor * (4.0 * pow(max(dot(n, halfDir), 0.0), 600.0));
  vec2 guv = vWorldPos.xz * 6.5 + vec2(0.13, -0.11) * uTimeSec;
  vec3 jitter = texture2D(uNoise, guv).rgb * 2.0 - 1.0;
  vec3 gn = normalize(n + jitter * 0.16);
  float glint = pow(max(dot(gn, halfDir), 0.0), 1400.0);
  color += uSunColor * min(glint * 3.5, 3.5) * exp(-dist * 0.02);

  // 8) フォーム合成(§2.4)— 反射より後、フォグより前。太陽高度でライト
  vec3 foamLit = uFoamColor * mix(0.55, 1.0, max(uSunDir.y, 0.0) * 0.8 + 0.2);
  color = mix(color, foamLit, foam);

  // 9) 距離フォグ: sky(viewDir) へ溶かす(背景と数学的に一致 — 継ぎ目ゼロ)
  float fog = 1.0 - exp(-pow(dist / 260.0, 1.35));
  color = mix(color, sky(viewDir), fog);

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
