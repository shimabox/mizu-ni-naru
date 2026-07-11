import { IRID_CHUNK_GLSL } from './glass';

/**
 * スプレー/しぶき(design-render §6 — ステートレス弾道 billboard quad)。
 *
 * - 位置は毎フレームシェーダ内で閉形式評価(アップロードは spawn 時のみ)
 * - 死(寿命超過 / 海面到達 / 未スポーン)= 縮退 quad(ラスタ 0)
 * - 裁定 A36: **加算ブレンドを廃止**し通常アルファブレンド。暗い海を背景にしても
 *   「光を足す発光体」に見えないよう、フォーム白の拡散光沢のみで描く(HDR なし・
 *   色は ≤1.0)。ソフト円スプライトで中心不透明→縁フェード(粒の重なりを溶かす)
 * - kind 0 = 水滴(着水した球の水色に完全一致 — 裁定 A57)/ kind 1 = 膜片
 *   (虹彩 tint 弱め・大きめ、ベース色は aTint 経由の従来色で不変)
 * - 裁定 A37: 純白は暗い海上で最大コントラスト = 「光」と誤読されるため、粒色を
 *   白 8 : 水色 2 目安(下面はさらに青く)に寄せ、不透明度も下げて向こうの海が
 *   うっすら透けるようにした
 * - 裁定 A57: しぶきの色を「その場で着水した球の中の水の色」に完全一致させる
 *   (ブレンドではなく完全採用)。CPU 側(SpraySystem)が着水位置と同フレームの
 *   Splashing 球のアンカー位置を突き合わせ、その球の水色ハッシュ(glass.ts
 *   WATER_TINT_GLSL と同一計算)を instanced attribute aTint として焼き込む。
 *   一致する球がない場合は従来の淡い水色にフォールバック
 */

export const SPRAY_VERTEX_GLSL = /* glsl */ `
precision highp float;
attribute vec4 aSpawn;  // [p0x, p0y, p0z, spawnStepF]
attribute vec4 aVel;    // [v0x, v0y, v0z, kind + size01/2]
attribute vec3 aTint;   // A57: 着水した球の水色(完全一致)/ フォールバック色
uniform float uStepF;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
varying vec2 vQuad;
varying float vKind;
varying float vSeed;
varying float vFade;
varying vec3 vTint;

const float G_EFF = 5.4;   // ballistics.ts SPRAY_G_EFF と一致(ドリーミー演出)

void main() {
  float age = (uStepF - aSpawn.w) / 60.0;
  float kind = floor(aVel.w + 0.001);
  float size01 = fract(aVel.w) * 2.0;
  float seed = fract(aVel.w * 7.31);

  vec3 p = aSpawn.xyz + aVel.xyz * age - vec3(0.0, 0.5 * G_EFF * age * age, 0.0);
  float life = 0.8 + seed * 0.9;
  float fade = smoothstep(0.0, 0.08, age) * (1.0 - smoothstep(life * 0.7, life, age));
  float kill = (age < 0.0 || age > life || p.y < -0.05) ? 0.0 : 1.0;

  // 裁定 A33: 水滴を細かく(mix 上限を 0.14→0.095 に縮小、「水しぶき」の粒立ち)
  float size = mix(0.018, 0.095, size01) * (kind > 0.5 ? 1.7 : 1.0);
  vec3 wp = p + (uCamRight * position.x + uCamUp * position.y)
              * (size * fade * kill);

  vQuad = position.xy;
  vKind = kind;
  vSeed = seed;
  vFade = fade * kill;
  vTint = aTint;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const SPRAY_FRAGMENT_GLSL = /* glsl */ `
precision highp float;
uniform vec3 uSunColor;
varying vec2 vQuad;
varying float vKind;
varying float vSeed;
varying float vFade;
varying vec3 vTint;
${IRID_CHUNK_GLSL}

void main() {
  float d = length(vQuad);
  // ソフト円スプライト: 中心不透明 → 縁へフェード(短命・小粒のためソートなし
  // でも重なりが破綻しないよう、縁を広めに溶かす — 裁定 A36)
  float core = exp(-2.2 * d * d);
  float coverage = 1.0 - smoothstep(0.35, 1.0, d);

  // A57: 水滴(kind 0)の基準色は着水した球の水色そのもの(aTint、完全一致)。
  // 上面/下面の明暗は質感として維持(下面をわずかに明るく — 立体感)。
  float underMix = smoothstep(0.15, -0.6, vQuad.y) * 0.5;
  vec3 water = vTint * (0.85 + underMix * 0.3);

  // 膜片(kind 1): 虹彩を弱く残す(ガラス膜の名残・ロジック不変)。ベース色は
  // aTint 経由(球ポップ時は常にフォールバック色 = 旧 foamTop と同値)。HDR なし。
  vec3 film = mix(vTint, irid(vSeed * 2.7 + d * 1.6) * 0.4 + vec3(0.5), 0.6);
  vec3 tint = mix(water, film, step(0.5, vKind));

  // 拡散光沢のみ(発光ではなく反射)。太陽 tint は最小限のハイライトに留める。
  vec3 col = tint * (0.55 + 0.45 * core) + uSunColor * (core * core * 0.05);
  col = min(col, vec3(1.0));  // HDR なし(A36: 加算グロー自体を廃止)

  // 裁定 A37: 中心不透明度を ~0.75 に下げ、向こうの海がうっすら透けるように。
  float alpha = coverage * core * vFade * 0.75;
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
