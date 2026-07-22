import {
  CAP_SHADOWS_PER_BUBBLE,
  CAP_SHADOW_BUBBLES,
} from '../bubbles/CapShadows';
import {
  BUBBLE_INSTANCE_VERTEX_PARS_GLSL,
  MIZU_BLUE_GLSL,
  WATER_TINT_GLSL,
} from './glass';
import {
  BUBBLE_STATE_TRANSFORM_GLSL,
  RIPPLES_PER_BUBBLE,
  RIPPLE_NEAR_COUNT,
  WATER_VISUAL_RATIO,
} from './innerWater';
import { SKY_CHUNK_GLSL, SKY_UNIFORMS_GLSL } from './sky';

// RIPPLES_PER_BUBBLE / RIPPLE_NEAR_COUNT は innerWater.ts が定義元(A43 で体積
// シェーダも同じリングバッファを共有するため移設)。既存の import 元
// ('../shaders/innerCap') を変えずに済むようここで再エクスポートする。
export { RIPPLES_PER_BUBBLE, RIPPLE_NEAR_COUNT };

/**
 * 球内水面キャップ — ミニ海(design-render §4b、裁定 A31/A32 で改訂)。
 *
 * 単位円盤グリッドを per-instance で cap 半径にスケール:
 * capR = √(Rv² − wl²)(頂点シェーダ内で導出 — CPU 前処理なし)。
 * 頂点は緩い揺れのみ(Straining は wobble 連動 ×1.8 — A45)。フラグメント法線は
 * InnerRippleView 由来の解析リング波(uniform リングバッファ、カメラ近傍
 * RIPPLE_NEAR_COUNT 球 × 6 本 — A32、球数は A74 で SLOT_COUNT から導出)。縁はメニスカス帯(§3)と同じ #007fff 発光で滑らかに
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
uniform vec4 uInnerRipples[${RIPPLE_NEAR_COUNT * RIPPLES_PER_BUBBLE}];  // [x, z, birthStepF, strength] × 近傍 RIPPLE_NEAR_COUNT 球 × 6 本(A32、球数は A74 で SLOT_COUNT から導出)
// 球内水面キャップの接触影(A76)— 雫の影ブロブ。CapShadows.ts が
// カメラ近傍 CAP_SHADOW_BUBBLES 球 × CAP_SHADOWS_PER_BUBBLE 体を CPU 選抜
uniform vec4 uCapShadows[${CAP_SHADOW_BUBBLES * CAP_SHADOWS_PER_BUBBLE}];   // [localX, localZ, height, r] × 近傍${CAP_SHADOW_BUBBLES}球×${CAP_SHADOWS_PER_BUBBLE}体(A76)
uniform vec4 uCapShadowMeta[${CAP_SHADOW_BUBBLES}];  // [rippleIndex, count, fade, 0](A76)
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
  // カメラ近傍 RIPPLE_NEAR_COUNT 球のみ追跡(A32、球数は A74 で SLOT_COUNT から導出) — 対象外(vSlot<0)は微波のみ
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
  // A48: ユーザー追撃指示「もっと濃くていい」— 体積(innerWater)と同じ
  // 基調(MIZU_BLUE を MIZU_DEEP へ 15% 沈めた色)を出発点にし、tint による
  // 淡色化も 0.7→0.5 倍に弱める
  float tint = waterTint(vSeed);
  vec3 baseColor = mix(mix(MIZU_BLUE, MIZU_DEEP, 0.15), MIZU_LIGHT, tint * 0.5);

  // A48: 体積(innerWater)の濃色化に合わせ、キャップも濃いめ基調 + やや
  // 深めの深色ミックスへ(0.22+0.34*vFill → 0.34+0.46*vFill、境目で色が
  // 跳ねない — A31 の地続き原則を維持)
  vec3 body = mix(baseColor, MIZU_DEEP, 0.34 + 0.46 * vFill);
  body += uSssColor * min(length(n.xz) * 1.4, 0.35);   // リング波頭のターコイズ(控えめ)

  // 接触影(A76)— 落下中の雫が水面に落とすうっすらしたブロブ影(A76 改訂:
  // 文字原子は記号として漂う主役なので影を落とさない — 雫のみ)。
  // 低い(h 小)・大きい(r 大)ほど濃く鋭く、高いほど薄く広がる半影(§ペナンブラ pr は
  // s.w(半径)を基準に s.z(高さ)で広げる)。太陽方向へ弱くオフセットして「光源から
  // 見て影が伸びる」感を出す(夜=太陽が低い/沈んでいるときは sunShift=0 で
  // 真下投影にフォールバック — 昼夜で影の落ち方が破綻しない)。vSlot(rippleIndex)
  // で uCapShadowMeta と照合し、対象外(vSlot<0)の球は影も出さない(InnerRipple と対称)。
  float shade = 0.0;
  if (vSlot >= 0.0) {
    vec2 sunShift = (uSunDir.y > 0.05)
      ? -uSunDir.xz / max(uSunDir.y, 0.35)
      : vec2(0.0);
    for (int j = 0; j < ${CAP_SHADOW_BUBBLES}; j++) {
      vec4 meta = uCapShadowMeta[j];
      if (abs(meta.x - vSlot) > 0.5) continue;
      for (int k = 0; k < ${CAP_SHADOWS_PER_BUBBLE}; k++) {
        if (float(k) >= meta.y) break;
        vec4 s = uCapShadows[j * ${CAP_SHADOWS_PER_BUBBLE} + k];
        vec2 c = s.xy + sunShift * min(s.z, 1.2) * 0.5;
        float pr = s.w * 1.15 + s.z * 0.5;       // 半影: 高いほど広がる
        float fall = 1.0 - smoothstep(0.0, pr, length(vCapLocal - c));
        shade += fall * fall * exp(-1.4 * s.z) * meta.z;
      }
    }
    shade = min(shade, 0.5);
  }
  // うっすら要件(A76): 最大でも 3 割減。縁のメニスカス発光(下の smoothstep 加算)には掛けない
  body *= 1.0 - 0.30 * shade;

  // 空の映り込みは baseColor で色相を引き戻してから弱めに混ぜる(白飛び防止)
  vec3 reflection = mix(sky(reflect(viewDir, n)), baseColor, 0.55);
  vec3 color = mix(body, reflection, fresnel * 0.40);
  vec3 halfDir = normalize(uSunDir - viewDir);
  // 太陽スペキュラは接触影で強めに減衰(0.85)— 雫の真下でグリントが消えるのが
  // 接触影の最も分かりやすいリアリティ(A76)
  color += uSunColor * (0.5 * pow(max(dot(n, halfDir), 0.0), 300.0) * (1.0 - 0.85 * shade));

  // 縁(92% 以遠)はメニスカス帯(§3)へ滑らかに接続(A44: tint 追従)
  color += baseColor * smoothstep(0.92, 1.0, vRadial) * 1.1;

  // A48: 濃色化に合わせ α 上限を 0.8→0.94 に引き上げ。A44: 薄い個体は
  // α 上限もやや下げる
  float alpha = 0.94 * mix(1.0, 0.82, tint) * smoothstep(0.0, 0.03, vFill);
  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
