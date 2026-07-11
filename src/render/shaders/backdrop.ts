import { MIZU_BLUE_GLSL } from './glass';
import { SKY_CHUNK_GLSL, SKY_UNIFORMS_GLSL } from './sky';

/**
 * 遠景の書き割り球体フィールド(裁定 A41 — 「もっと多くの球体で壮大に」)。
 *
 * sim・契約・リズムに一切触れない **render 専用の装飾**。数百個の
 * 非シミュレーション球を遠方 r∈[40,180] に散布し、
 * - 位置/サイズ/水位/落下周期は全て per-instance ハッシュ + uTimeSec から
 *   **毎フレーム閉形式で導出**(状態なし・属性アップロードは構築時 1 回)
 * - 水位はサイクル進行に合わせてゆっくり上がり、満ちると 1 個がすーっと
 *   落ちて海面でフェードアウト → しばらく休んで再出現(本物の球の
 *   「溜まって落ちる」リズムを遠景でも反響させる)
 * - 距離フォグと同式(1-exp(-(d/260)^1.35))でスカイへ溶かす — 継ぎ目ゼロ
 * - instanced 1 draw(A35 の draw call 予算 ≤20 内)
 */

/** 落下シーケンスの尺(秒)— サイクル末尾に配置。 */
export const BACKDROP_FALL_S = 1.8;
export const BACKDROP_SINK_S = 1.2;

/**
 * GLSL float リテラル整形(バグ修正 — A41): JS の template literal は
 * `1.8 + 1.2 === 3` を `"3"` と書き出し、GLSL では整数リテラルとして
 * パースされて `float - int` の型エラー(コンパイル失敗)になる。
 * 定数の和が整数値になっても必ず `.0` を保つ。
 */
const glslFloat = (n: number): string =>
  Number.isInteger(n) ? `${n}.0` : `${n}`;

export const BACKDROP_VERTEX_GLSL = /* glsl */ `
precision highp float;
attribute float aIdx;
uniform float uTimeSec;
uniform float uCount;
varying vec3 vLocal;
varying vec3 vWorldPos;
varying float vWaterLevel; // 単位球ローカルの水面 y
varying float vAlpha;      // サイクル × 距離フェード
varying float vSeed;

float hash1(float n) { return fract(sin(n) * 43758.5453123); }

void main() {
  float h1 = hash1(aIdx * 12.9898 + 78.233);
  float h2 = hash1(aIdx * 39.3468 + 11.135);
  float h3 = hash1(aIdx * 73.156 + 52.235);
  float h4 = hash1(aIdx * 21.317 + 91.421);
  float h5 = hash1(aIdx * 57.585 + 33.987);
  float h6 = hash1(aIdx * 93.989 + 67.345);

  // 幾何スパイラル配置(SlotField A32 と同型: 密度 ∝ 1/r で外へ薄く)
  float t = aIdx / uCount;
  float radius = 40.0 * pow(180.0 / 40.0, t);
  float angle = aIdx * 2.39996323 + (h1 - 0.5) * 0.8; // 黄金角 + ジッター
  float anchorY = mix(2.6, 7.5, h2);
  // 遠いほど世界サイズも少し小さく(「遠くは小さく」— 縮小 ×0.7 まで)
  float R = mix(1.0, 1.7, h3) * mix(1.0, 0.7, t);

  // 落下サイクル(状態なし): 再出現 → 漂い(水位上昇)→ 落下 → 海面で消滅
  float period = mix(240.0, 720.0, h5);
  float cycleT = mod(uTimeSec + h6 * period, period);
  float driftEnd = period - ${glslFloat(BACKDROP_FALL_S + BACKDROP_SINK_S)};
  float fallT = clamp((cycleT - driftEnd) / ${glslFloat(BACKDROP_FALL_S)}, 0.0, 1.0);
  float sinkT = clamp((cycleT - driftEnd - ${glslFloat(BACKDROP_FALL_S)}) / ${glslFloat(BACKDROP_SINK_S)}, 0.0, 1.0);

  // bob(呼吸)+ 落下(等加速の見え方 = fallT²)
  float y = anchorY + 0.12 * sin(uTimeSec * (0.45 + 0.4 * h4) + h1 * 6.2832);
  y = mix(y, R * 0.55, fallT * fallT);
  float scale = R * (1.0 - 0.55 * sinkT);          // 海面で縮んで消える
  float cycleAlpha = smoothstep(0.0, 3.0, cycleT)  // 再出現フェードイン
                   * (1.0 - sinkT);                // 消滅フェードアウト

  // 水位: 漂い中にゆっくり満ちる(空 -0.62 → ほぼ満水 +0.55)
  vWaterLevel = mix(-0.62, 0.55, clamp(cycleT / max(driftEnd, 1.0), 0.0, 1.0));

  vec3 center = vec3(cos(angle) * radius, y, sin(angle) * radius);
  vec3 wp = center + position * scale;

  // 距離フェード: 海のフォグ(§2.6)と同式でスカイへ溶ける
  float dist = distance(center, cameraPosition);
  float fog = 1.0 - exp(-pow(dist / 260.0, 1.35));
  vAlpha = cycleAlpha * (1.0 - fog);

  vLocal = position;
  vWorldPos = wp;
  vSeed = h1;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const BACKDROP_FRAGMENT_GLSL = /* glsl */ `
precision highp float;
${SKY_UNIFORMS_GLSL}
varying vec3 vLocal;
varying vec3 vWorldPos;
varying float vWaterLevel;
varying float vAlpha;
varying float vSeed;
${SKY_CHUNK_GLSL}
${MIZU_BLUE_GLSL}

void main() {
  if (vAlpha < 0.004) discard;
  vec3 n = normalize(vLocal);
  vec3 viewDir = normalize(vWorldPos - cameraPosition);
  float rim = pow(1.0 - abs(dot(n, -viewDir)), 2.5);

  // 遠景の透明ガラス: 空の反射リムだけで「球がいる」と読ませる(超軽量)
  vec3 color = sky(reflect(viewDir, n)) * (0.25 + 0.45 * rim);
  float alpha = 0.05 + 0.30 * rim;

  // 擬似内水: 水面 (local y < vWaterLevel) は #007fff 系がうっすら透ける
  float water = smoothstep(vWaterLevel + 0.04, vWaterLevel - 0.10, vLocal.y);
  color = mix(color, MIZU_BLUE * 0.55, water * 0.75);
  alpha = mix(alpha, 0.34, water * 0.8);

  gl_FragColor = vec4(color, alpha * vAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
