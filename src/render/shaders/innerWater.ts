import {
  SLOT_COUNT_DESKTOP,
  SLOT_COUNT_MOBILE,
} from '../../contract/WorldSpec';
import {
  BUBBLE_INSTANCE_VERTEX_PARS_GLSL,
  MIZU_BLUE_GLSL,
  WATER_TINT_GLSL,
} from './glass';

/** 球ごとの InnerRipple リングバッファ本数(§4b — InnerWaterSystem と共有)。 */
export const RIPPLES_PER_BUBBLE = 6;

/**
 * InnerRipple uniform を張る球数(裁定 A32 で導入した「カメラ近傍のみ」選抜。
 * 当時は 96/24 球中の 12 球という部分選抜だったが、裁定 A71 で球数が
 * 24/24 に統一された結果、12 決め打ちのままだと常に半数が波紋描画対象外になり
 * 「波紋が出るときと出ないときがある」不具合として現れた(ユーザー報告)。
 * BackdropBubbles.ts の BACKDROP_COUNT_BUFFER(A69)と同じ考え方で、決め打ちを
 * やめ SLOT_COUNT_DESKTOP/MOBILE の大きい方から導出する(裁定 A74)。
 * 現在は両者とも 24 のため全球が対象になる。BubbleInstanceBuffers.sync() が
 * カメラ距離で毎フレーム選抜し、aMisc.x(vSlot)を 0..RIPPLE_NEAR_COUNT-1 の
 * インデックスとして詰め替える(対象外の球があれば vSlot=-1 でキャップ/体積の
 * 波紋ループをスキップ — 微波のみ)。
 */
export const RIPPLE_NEAR_COUNT = Math.max(
  SLOT_COUNT_DESKTOP,
  SLOT_COUNT_MOBILE,
);

/**
 * 球内の水 — 体積パス(design-render §4a)。
 *
 * FrontSide 1 パス + 解析コード長 Beer-Lambert:視線が球内水体を貫く長さを
 * 閉形式で求めて吸収に使う(レイマーチ不要)。水面平面より上は discard。
 * αブレンド + depthWrite ON — 「原子・雫は常に球内水面より上」(A25)により
 * ソート不要で閉じる。水の見た目半径は WATER_VISUAL_RATIO = 0.985R(A13)。
 * InnerRipple の波紋は視線と水面平面の交点(tPlane 交点)で評価する
 * (A43 改訂 — 真下から見ても輪が消えない。詳細はフラグメント内コメント)。
 */
export const WATER_VISUAL_RATIO = 0.985;

/** 球インスタンスの状態駆動変形(glass と同一式 — 水は等方縮小で追従)。 */
export const BUBBLE_STATE_TRANSFORM_GLSL = /* glsl */ `
// state 駆動の変形係数(§3)— grow / stretchY / alive / wobbleGain を返す
vec4 bubbleTransform(float state, float prog) {
  // Spawning: スケールイン(A72: smoothstep で単調増加・Drifting の 1.0 に連続着地)
  float growEase = prog * prog * (3.0 - 2.0 * prog);
  float grow = (state == 0.0) ? 0.6 + 0.4 * growEase : 1.0;
  // A45: Straining の予兆 stretch ランプを ~4 割に縮小(0.10→0.04 — A29 は不変)
  float strain = (state == 2.0) ? prog : 0.0;
  // Falling: 落下開始 ≈0.5 s で張り(+0.10)を解き +0.04 の空力感のみ残す(A29)
  float fallRelax = (state == 3.0) ? min(prog * 8.0, 1.0) : 0.0;
  float stretchY = 1.0 + strain * 0.04
                 + ((state == 3.0) ? mix(0.10, 0.04, fallRelax) : 0.0);
  // 中身(水)は Splashing 進入と同時に消える(§3 — 海の FX が受け継ぐ)
  float alive = (state >= 4.0) ? 0.0 : 1.0;
  // wobble の視覚ゲイン — Falling で減衰し剛体的に落ちる(A29)
  float wobbleGain = 1.0 - fallRelax;
  return vec4(grow, stretchY, alive, wobbleGain);
}
`;

export const INNER_WATER_VERTEX_GLSL = /* glsl */ `
precision highp float;
${BUBBLE_INSTANCE_VERTEX_PARS_GLSL}
${BUBBLE_STATE_TRANSFORM_GLSL}
varying vec3 vWorldPos;
varying vec3 vCenter;
varying vec3 vLocalPos;
varying float vR;
varying float vWaterPlaneY;
varying float vFill;
varying float vSeed;
varying float vSlot;

void main() {
  vec3 center = mix(aPrevA.xyz, aCurrA.xyz, uAlpha);
  float R = mix(aPrevA.w, aCurrA.w, uAlpha);
  float wl = mix(aPrevB.x, aCurrB.x, uAlpha);
  float fill = mix(aPrevB.y, aCurrB.y, uAlpha);
  float state = floor(aCurrB.w);
  float prog = fract(aCurrB.w);

  vec4 tf = bubbleTransform(state, prog);
  // ガラスの xz 圧縮(1/√stretchY)の内側に収まる等方半径
  float s = ${WATER_VISUAL_RATIO} * inversesqrt(tf.y);
  float Rv = R * s * tf.x * tf.z;

  vec3 wp = center + position * Rv;
  vWorldPos = wp;
  vCenter = center;
  vLocalPos = position;
  vR = Rv;
  vWaterPlaneY = center.y + wl * tf.x * tf.z;
  vFill = fill;
  vSeed = aMisc.y;
  vSlot = aMisc.x;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const INNER_WATER_FRAGMENT_GLSL = /* glsl */ `
precision highp float;
uniform sampler2D uNoise;
uniform float uTimeSec;
uniform float uStepF;
uniform vec3 uSssColor;
uniform vec4 uInnerRipples[${RIPPLE_NEAR_COUNT * RIPPLES_PER_BUBBLE}];  // [x, z, birthStepF, strength] × 近傍 RIPPLE_NEAR_COUNT 球 × 6 本(A32/A43、球数は A74 で SLOT_COUNT から導出 — キャップと同一配列を共有)
varying vec3 vWorldPos;
varying vec3 vCenter;
varying vec3 vLocalPos;
varying float vR;
varying float vWaterPlaneY;
varying float vFill;
varying float vSeed;
varying float vSlot;  // 0..${RIPPLE_NEAR_COUNT - 1} = uInnerRipples インデックス、-1 = 対象外(A32)
${MIZU_BLUE_GLSL}
${WATER_TINT_GLSL}
const vec3 MIZU_DEEP = vec3(0.0, 0.030, 0.160);

void main() {
  // 水面平面より上は discard(§4a — フラグメント = 球前面の点)
  if (vWorldPos.y > vWaterPlaneY + 0.002) discard;

  vec3 rd = normalize(vWorldPos - cameraPosition);
  vec3 oc = vWorldPos - vCenter;
  float b = dot(oc, rd);
  float tExit = -b + sqrt(max(b * b - dot(oc, oc) + vR * vR, 0.0)); // 球の出口
  float tPlane = (rd.y > 0.0) ? (vWaterPlaneY - vWorldPos.y) / rd.y : 1e9;
  float len = clamp(min(tExit, tPlane), 0.0, 2.0 * vR);

  // A44: 球ごとの水色ハッシュ(0=現在色/最濃端、1=淡い透明水色)。吸収係数を
  // 弱め・基調色を淡いアクアへ・α 上限も下げる方向でキャップ/メニスカスと追従
  float tint = waterTint(vSeed);

  // A48: 「もっと濃くていい — 深い青の水がたっぷり入っている存在感」
  // (ユーザー追撃指示)。A39 で薄めた基調をほぼ撤回し、吸収係数を A39 前
  // (1.9/0.75/0.35)よりやや強い 2.1/0.85/0.40 へ、深色への沈み込みも
  // 0.6→0.92 倍に強化。基調は MIZU_BLUE をベースに MIZU_DEEP へ 15% 沈めた
  // 色から出発し(×0.95 の減衰を撤廃した上でさらに深く)、tint による
  // 淡色化も 0.7→0.5 倍に弱めてレンジ全体を濃い方へシフト。ただし完全な
  // 不透明の塊にはしない — α 上限は 0.94 に留め、absorb 経由の深色ミックス
  // も 1.0 未満(0.92)で floor を残し、僅かな透過を保つ。per-bubble tint
  // (A44/A47)の相対濃淡差はレンジごとの平行移動で維持
  vec3 absorb = exp(-len / max(vR, 1e-5) * vec3(2.1, 0.85, 0.40) * (1.0 - 0.35 * tint)); // 青が生き残る
  vec3 baseColor = mix(mix(MIZU_BLUE, MIZU_DEEP, 0.15), MIZU_LIGHT, tint * 0.5);
  vec3 color = mix(baseColor, MIZU_DEEP, (1.0 - absorb.b) * 0.92)
             + uSssColor * 0.10 *
               texture2D(uNoise, vLocalPos.xz * 2.0 + uTimeSec * 0.05).r;
  float alpha = clamp(0.55 + 0.5 * (1.0 - absorb.b), 0.0, 0.94) * mix(1.0, 0.82, tint);
  alpha *= smoothstep(0.0, 0.03, vFill); // 空球の極小レンズを消す

  // A43(改訂): 波紋(キャップと同じ解析リング波 — 伝播 0.9 u/s・減衰 1.8/s、
  // innerCap.ts と同一定数)を「水中を透過する光の明暗」として評価する。
  // 初版は入射点(vWorldPos)の球ローカル (x, z) + 入射点の深度で減衰させて
  // いたため、真下から見ると入射点が常に球の最深部になり、輪が実質ゼロに
  // 減衰していた(ユーザー実機報告)。修正: 視線(rd)と水面平面
  // (y = vWaterPlaneY)の交点(tPlane 交点)を求め、その交点の球ローカル
  // (x, z) でリング場を評価する。上から見る場合は入射点がほぼ水面上にある
  // ため交点 ≈ 入射点(従来と同等)。真下・斜めから見る場合は交点が実際の
  // 波紋の乗る水面位置になるため輪が消えない — 「下から水面の模様を
  // 見上げる」物理に一致。減衰は入射点→交点までの水中光路長(tPlane)に
  // 対するごく弱い exp(vR 換算で最大 ~2 のとき残存 ≥40% 目安)。交点が
  // 球の cap 半径外(視線が水面と交わらない/球外で交わる)場合はゼロに
  // クランプ。ギラつかせないよう控えめな乗算のみ。
  if (vSlot >= 0.0) {
    vec3 planeHit = vWorldPos + rd * tPlane;
    vec2 planeXZ = planeHit.xz - vCenter.xz;
    float capYOffset = vWaterPlaneY - vCenter.y;
    float capR2 = max(vR * vR - capYOffset * capYOffset, 0.0);
    bool hasPlaneHit = tPlane < tExit;
    bool inCap = dot(planeXZ, planeXZ) <= capR2;
    if (hasPlaneHit && inCap) {
      float ringGlow = 0.0;
      int base = int(vSlot + 0.5) * 6;
      for (int k = 0; k < 6; k++) {
        vec4 rp = uInnerRipples[base + k];
        vec2 d = planeXZ - rp.xy;
        float dist = length(d) + 1e-4;
        float age = max((uStepF - rp.z) / 60.0, 0.0);
        float radius = 0.9 * age;
        float env = exp(-6.0 * abs(dist - radius)) * exp(-1.8 * age) * rp.w;
        ringGlow += env * sin(40.0 * (dist - radius));
      }
      float pathAtten = exp(-0.45 * clamp(tPlane / max(vR, 1e-5), 0.0, 2.0));
      color = max(color * (1.0 + ringGlow * pathAtten * 0.35), vec3(0.0));
    }
  }

  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
