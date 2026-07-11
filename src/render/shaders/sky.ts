/**
 * 朝の解析グラデーションスカイ(design-render §7)。
 *
 * `SKY_CHUNK_GLSL` の `sky(dir)` はスカイ背景だけでなく、海・球・雫シェーダの
 * 反射/屈折/フォグの環境光源としても文字列連結で再利用される共有チャンク。
 * 利用側は `SKY_UNIFORMS_GLSL` も併せて連結し、`uSunDir` / `uSunColor`
 * uniform(Environment が唯一の所有者)を供給すること。
 * 雲気(SKY_BACKDROP)はノイズテクスチャ導入後(Phase 2)に追加する。
 */

/** sky(dir) が要求する uniform 宣言。 */
export const SKY_UNIFORMS_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
`;

/**
 * 解析スカイ関数。dir は正規化済みの世界方向ベクトル。
 * 太陽方位で地平線色が回る(cool #a9c3d6 ↔ warm #f2c39d、linear 値)。
 * 天頂は淡い蒼穹 #6a93bd、水平線下は海フォグと同系の #12303f。
 * 太陽ハロー+ディスクは HDR(>1 — ポスト導入後はブルームが拾う)。
 */
export const SKY_CHUNK_GLSL = /* glsl */ `
vec3 sky(vec3 dir) {
  float h = dir.y;

  const vec3 HORIZON_COOL = vec3(0.397, 0.546, 0.672);
  const vec3 HORIZON_WARM = vec3(0.888, 0.546, 0.337);
  const vec3 ZENITH = vec3(0.144, 0.292, 0.509);
  const vec3 BELOW = vec3(0.006, 0.0296, 0.0497);

  float sunAz = max(dot(normalize(vec3(dir.x, 0.0, dir.z)),
                        normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0);
  vec3 horizon = mix(HORIZON_COOL, HORIZON_WARM, pow(sunAz, 3.0));
  vec3 col = mix(horizon, ZENITH, pow(clamp(h, 0.0, 1.0), 0.55));
  col = mix(col, BELOW, smoothstep(0.0, -0.12, h));

  float s = max(dot(dir, uSunDir), 0.0);
  col += uSunColor * (0.30 * pow(s, 16.0) + 3.2 * pow(s, 900.0));

  // A55: 世界そのものが球体である気配(b)— 水平線際(グレージング角)にだけ、
  // 球体ガラスの薄膜干渉(IRID_CHUNK_GLSL の cos パレット)と同系の虹彩を
  // ごく薄く重ねる。太陽方位とは独立(全周)。HDR には乗せない(ピーク寄与
  // ≈0.02 — bloom 閾値 1.15 に遠く及ばない)。「言われれば分かる」程度に留める
  float grazeBand = 1.0 - smoothstep(0.0, 0.16, abs(h));
  if (grazeBand > 0.001) {
    float az = atan(dir.z, dir.x);
    float phase = az * 0.5 + h * 3.0;
    vec3 worldIrid = 0.5 + 0.5 * cos(6.28318 * (phase + vec3(0.0, 0.33, 0.67)));
    col += worldIrid * (grazeBand * grazeBand) * 0.022;
  }
  return col;
}
`;

/**
 * far plane に貼り付く全画面三角形の頂点シェーダ。
 * NDC をそのまま出力(z = w = 1)し、逆射影で世界方向ベクトルを varying に流す。
 */
export const SKY_VERTEX_GLSL = /* glsl */ `
uniform mat4 uProjInv;
uniform mat4 uCamWorld;
varying vec3 vDir;

void main() {
  vec4 viewPos = uProjInv * vec4(position.xy, 1.0, 1.0);
  viewPos /= viewPos.w;
  vDir = mat3(uCamWorld) * viewPos.xyz;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

/**
 * スカイ背景のフラグメントシェーダ(トーンマップ+色空間変換は three のチャンクに委譲)。
 * `#define SKY_BACKDROP` 時のみ、焼き込みノイズ(B: リッジ)を方向射影 UV で
 * サンプルし、地平線近くに薄い雲気を漂わせる(2 fetch — design-render §7)。
 * 反射・フォグに使う共有 sky() はノイズなしの軽量核のまま。
 */
export const SKY_FRAGMENT_GLSL = /* glsl */ `
precision highp float;
${SKY_UNIFORMS_GLSL}
${SKY_CHUNK_GLSL}
#ifdef SKY_BACKDROP
uniform sampler2D uNoise;
uniform float uTimeSec;
#endif
varying vec3 vDir;

void main() {
  vec3 dir = normalize(vDir);
  vec3 col = sky(dir);

  #ifdef SKY_BACKDROP
  // 雲気: ごく薄い気配だけ(§0 Look)。地平線 h ∈ [0.02, 0.35] の帯
  float h = dir.y;
  float band = smoothstep(0.02, 0.08, h) * (1.0 - smoothstep(0.10, 0.35, h));
  if (band > 0.001) {
    vec2 cuv = dir.xz / max(h + 0.12, 0.12);
    float c1 = texture2D(uNoise, cuv * 0.055 + vec2(uTimeSec * 0.0011, 0.0)).b;
    float c2 = texture2D(uNoise, cuv * 0.021 - vec2(0.0, uTimeSec * 0.0007)).b;
    float cloud = smoothstep(0.55, 0.95, c1 * 0.6 + c2 * 0.55);
    col += vec3(0.05, 0.047, 0.042) * cloud * band;
  }
  #endif

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
