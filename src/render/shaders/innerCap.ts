import {
  BUBBLE_INSTANCE_VERTEX_PARS_GLSL,
  MIZU_BLUE_GLSL,
  WATER_TINT_GLSL,
} from './glass';
import { BUBBLE_STATE_TRANSFORM_GLSL, WATER_VISUAL_RATIO } from './innerWater';
import { SKY_CHUNK_GLSL, SKY_UNIFORMS_GLSL } from './sky';

/** 球ごとの InnerRipple リングバッファ本数(§4b — InnerWaterSystem と共有)。 */
export const RIPPLES_PER_BUBBLE = 6;

/**
 * InnerRipple uniform を張る球数(裁定 A32 — 「カメラ近傍 12 球のみ」)。
 * BubbleInstanceBuffers.sync() がカメラ距離で毎フレーム選抜し、
 * aMisc.x(vSlot)を 0..RIPPLE_NEAR_COUNT-1 のインデックスとして詰め替える
 * (対象外の遠方球は vSlot=-1 でキャップ波紋ループをスキップ — 微波のみ)。
 */
export const RIPPLE_NEAR_COUNT = 12;

/**
 * 球内水面キャップ — ミニ海(design-render §4b、裁定 A31/A32 で改訂)。
 *
 * 単位円盤グリッドを per-instance で cap 半径にスケール:
 * capR = √(Rv² − wl²)(頂点シェーダ内で導出 — CPU 前処理なし)。
 * 頂点は緩い揺れのみ(Straining は wobble 連動 ×1.8 — A45)。フラグメント法線は
 * InnerRippleView 由来の解析リング波(uniform リングバッファ、カメラ近傍
 * 12 球 × 6 本 — A32)。縁はメニスカス帯(§3)と同じ #007fff 発光で滑らかに
 * 接続する。本体は体積(innerWater)と同じ濃い青と地続きに見えるよう白い
 * スペキュラ/空反射を抑制(A31 — 境目で色が跳ねない)。
 */
export const INNER_CAP_VERTEX_GLSL = /* glsl */ `
precision highp float;
${BUBBLE_INSTANCE_VERTEX_PARS_GLSL}
${BUBBLE_STATE_TRANSFORM_GLSL}
varying vec3 vWorldPos;
varying vec2 vCapLocal;   // cap ローカル(世界単位 — InnerRipple の座標系)
varying float vRadial;    // 単位円盤の半径座標(縁発光用)
varying float vSlot;
varying float vFill;
varying float vSeed;

void main() {
  vec3 center = mix(aPrevA.xyz, aCurrA.xyz, uAlpha);
  float R = mix(aPrevA.w, aCurrA.w, uAlpha);
  float wl = mix(aPrevB.x, aCurrB.x, uAlpha);
  float fill = mix(aPrevB.y, aCurrB.y, uAlpha);
  float wobble = mix(aPrevB.z, aCurrB.z, uAlpha);
  float state = floor(aCurrB.w);
  float prog = fract(aCurrB.w);

  vec4 tf = bubbleTransform(state, prog);
  float s = ${WATER_VISUAL_RATIO} * inversesqrt(tf.y);
  float Rv = R * s * tf.x * tf.z;
  float wlv = wl * tf.x * tf.z;
  float capR = sqrt(max(Rv * Rv - wlv * wlv, 0.0));

  vec2 disk = position.xz;             // 単位円盤
  vec2 capXZ = disk * capR;
  // 広域の緩い揺れ(振幅 0.008R、Straining は wobble 連動で ×1.8 — A45 で
  // ×3→×1.8 に縮小、~4 割の予兆に。Falling は wobbleGain(tf.w)で減衰 —
  // 水面も暴れず剛体的に落ちる A29)
  float amp = 0.008 * R * (1.0 + 0.8 * wobble * tf.w) * tf.z;
  float sway = sin(capXZ.x * 5.0 + uTimeSec * 1.3 + aMisc.y * 6.283)
             + sin(capXZ.y * 6.2 - uTimeSec * 1.7 + aMisc.y * 4.1);
  vec3 wp = center + vec3(capXZ.x, wlv + amp * sway, capXZ.y);

  vWorldPos = wp;
  vCapLocal = capXZ;
  vRadial = length(disk);
  vSlot = aMisc.x;
  vFill = fill;
  vSeed = aMisc.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const INNER_CAP_FRAGMENT_GLSL = /* glsl */ `
precision highp float;
${SKY_UNIFORMS_GLSL}
uniform float uStepF;
uniform vec3 uSssColor;
uniform vec4 uInnerRipples[${RIPPLE_NEAR_COUNT * RIPPLES_PER_BUBBLE}];  // [x, z, birthStepF, strength] × 近傍 12 球 × 6 本(A32)
varying vec3 vWorldPos;
varying vec2 vCapLocal;
varying float vRadial;
varying float vSlot;  // 0..${RIPPLE_NEAR_COUNT - 1} = uInnerRipples インデックス、-1 = 対象外(A32)
varying float vFill;
varying float vSeed;
${SKY_CHUNK_GLSL}
${MIZU_BLUE_GLSL}
${WATER_TINT_GLSL}
const vec3 MIZU_DEEP = vec3(0.0, 0.030, 0.160);

void main() {
  // InnerRipple: 解析リング波の法線摂動(§4b — 伝播 0.9 u/s・減衰 1.8/s)。
  // カメラ近傍 12 球のみ追跡(A32) — 対象外(vSlot<0)は微波のみ
  vec3 n = vec3(0.0, 1.0, 0.0);
  if (vSlot >= 0.0) {
    int base = int(vSlot + 0.5) * 6;
    for (int k = 0; k < 6; k++) {
      vec4 rp = uInnerRipples[base + k];
      vec2 d = vCapLocal - rp.xy;
      float dist = length(d) + 1e-4;
      float age = max((uStepF - rp.z) / 60.0, 0.0);
      float radius = 0.9 * age;
      float env = exp(-6.0 * abs(dist - radius)) * exp(-1.8 * age) * rp.w;
      n.xz -= (d / dist) * env * sin(40.0 * (dist - radius)) * 0.6;
    }
    n = normalize(n);
  }

  // ミニ海: 体積(innerWater)と同じ #007fff 基調パレットへ揃え、白い
  // スペキュラ/空反射を抑えて境目で色が跳ねないようにする(A31)
  vec3 viewDir = normalize(vWorldPos - cameraPosition);
  float ndv = max(dot(-viewDir, n), 0.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

  // A44: 体積(innerWater)・メニスカス(glass)と同じ tint 係数で追従
  float tint = waterTint(vSeed);
  vec3 baseColor = mix(MIZU_BLUE * 0.95, MIZU_LIGHT, tint * 0.7);

  // A39: 体積(innerWater)の淡色化に合わせ、キャップも明るめ基調 + 浅めの
  // 深色ミックスへ(境目で色が跳ねない — A31 の地続き原則を維持)
  vec3 body = mix(baseColor, MIZU_DEEP, 0.22 + 0.34 * vFill);
  body += uSssColor * min(length(n.xz) * 1.4, 0.35);   // リング波頭のターコイズ(控えめ)

  // 空の映り込みは baseColor で色相を引き戻してから弱めに混ぜる(白飛び防止)
  vec3 reflection = mix(sky(reflect(viewDir, n)), baseColor, 0.55);
  vec3 color = mix(body, reflection, fresnel * 0.40);
  vec3 halfDir = normalize(uSunDir - viewDir);
  color += uSunColor * (0.5 * pow(max(dot(n, halfDir), 0.0), 300.0));

  // 縁(92% 以遠)はメニスカス帯(§3)へ滑らかに接続(A44: tint 追従)
  color += baseColor * smoothstep(0.92, 1.0, vRadial) * 1.1;

  // A39: 淡色化に合わせ僅かに透過。A44: 薄い個体は α 上限もやや下げる
  float alpha = 0.8 * mix(1.0, 0.85, tint) * smoothstep(0.0, 0.03, vFill);
  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
