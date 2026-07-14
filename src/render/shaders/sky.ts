/**
 * 時刻連動の解析グラデーションスカイ(design-render §7)。
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
uniform vec3 uSkyHorizonCool;
uniform vec3 uSkyHorizonWarm;
uniform vec3 uSkyZenith;
uniform vec3 uSkyBelow;
`;

/**
 * 解析スカイ関数。dir は正規化済みの世界方向ベクトル。
 * CPUで連続補間した空色を受け、主光源方位で地平線の暖色側を回す。
 * 主光源ハロー+ディスクはHDR(>1ならポストのブルームが拾う)。
 */
export const SKY_CHUNK_GLSL = /* glsl */ `
vec3 sky(vec3 dir) {
  float h = dir.y;

  float sunAz = max(dot(normalize(vec3(dir.x, 0.0, dir.z)),
                        normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0);
  vec3 horizon = mix(uSkyHorizonCool, uSkyHorizonWarm, pow(sunAz, 3.0));
  vec3 col = mix(horizon, uSkyZenith, pow(clamp(h, 0.0, 1.0), 0.55));
  col = mix(col, uSkyBelow, smoothstep(0.0, -0.12, h));

  float s = max(dot(dir, uSunDir), 0.0);
  col += uSunColor * (0.30 * pow(s, 16.0) + 3.2 * pow(s, 900.0));

  // A55: 世界そのものが球体である気配(b)— 水平線際(グレージング角)にだけ、
  // 球体ガラスの薄膜干渉(IRID_CHUNK_GLSL の cos パレット)と同系の虹彩を
  // ごく薄く重ねる。太陽方位とは独立(全周)。HDR には乗せない(bloom 閾値
  // 1.15 に遠く及ばない)。「言われれば分かる」程度に留める。
  // A55 follow-up(2026-07-12): ユーザーフィードバック「少し弱いかもな」を
  // 受け、帯幅を 0.16→0.22、ピーク寄与を 0.022→0.055(約2.5倍)に強化。
  // 静止画でも水平線が「なんとなく虹色」と分かる程度まで一段引き上げる
  // (それでも bloom 閾値には乗らない水準を維持)。
  float grazeBand = 1.0 - smoothstep(0.0, 0.22, abs(h));
  if (grazeBand > 0.001) {
    float az = atan(dir.z, dir.x);
    float phase = az * 0.5 + h * 3.0;
    vec3 worldIrid = 0.5 + 0.5 * cos(6.28318 * (phase + vec3(0.0, 0.33, 0.67)));
    // 夜の暗い水平線では絶対輝度0.055が相対的に強くなり、オーロラ状に
    // 見えてしまう。昼の既存表現は保ちつつ、青の時間から夜は静かに消す。
    float horizonLuma = dot(uSkyHorizonCool, vec3(0.2126, 0.7152, 0.0722));
    float iridVisibility = smoothstep(0.035, 0.20, horizonLuma);
    col += worldIrid * (grazeBand * grazeBand) * 0.055 * iridVisibility;
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
uniform float uStarVisibility;
#endif
varying vec3 vDir;

#ifdef SKY_BACKDROP
float starHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
#endif

void main() {
  vec3 dir = normalize(vDir);
  vec3 col = sky(dir);

  #ifdef SKY_BACKDROP
  // 星: 夜だけ評価する固定天球。セル中心には置かず個体ごとに位置をずらし、
  // 等級・色温度・瞬きへ別々の乱数を与える。大半は遠い微光、ごく少数だけ
  // 淡い光輪と短い光条を持つ。bloom閾値以下を基本に、水を主役に保つ。
  if (uStarVisibility > 0.001 && dir.y > 0.0) {
    vec2 sphereUv = vec2(
      atan(dir.z, dir.x) / 6.2831853 + 0.5,
      asin(clamp(dir.y, -1.0, 1.0)) / 3.1415927 + 0.5
    );
    vec2 starGrid = sphereUv * vec2(320.0, 160.0);
    vec2 starCell = floor(starGrid);
    float presence = starHash(starCell);
    float magnitudeSeed = starHash(starCell + vec2(19.17, 47.53));
    float temperatureSeed = starHash(starCell + vec2(71.89, 12.43));
    vec2 starCenter = vec2(0.18) + 0.64 * vec2(
      starHash(starCell + vec2(37.11, 83.17)),
      starHash(starCell + vec2(93.41, 28.67))
    );
    vec2 starLocal = fract(starGrid) - starCenter;
    float magnitude = pow(magnitudeSeed, 2.4);
    float radius = mix(0.012, 0.052, magnitude);
    float distanceFromStar = length(starLocal);
    float core = 1.0 - smoothstep(
      radius,
      radius + 0.030,
      distanceFromStar
    );
    float bright = step(0.78, magnitudeSeed);
    float brilliant = step(0.965, magnitudeSeed);
    float halo =
      (1.0 - smoothstep(radius + 0.02, 0.19, distanceFromStar)) *
      bright *
      0.075;
    float horizontalRay =
      (1.0 - smoothstep(0.009, 0.024, abs(starLocal.y))) *
      (1.0 - smoothstep(0.04, 0.15, abs(starLocal.x)));
    float verticalRay =
      (1.0 - smoothstep(0.009, 0.024, abs(starLocal.x))) *
      (1.0 - smoothstep(0.04, 0.15, abs(starLocal.y)));
    float shape = core + halo + brilliant * (horizontalRay + verticalRay) * 0.075;
    float twinkleDepth = mix(0.025, 0.14, magnitudeSeed);
    float twinklePhase =
      uTimeSec * mix(0.22, 0.68, temperatureSeed) + presence * 74.0;
    float twinkle = 1.0 - twinkleDepth * (0.5 - 0.5 * sin(twinklePhase));
    float intensity = mix(0.18, 0.88, magnitude);
    float star =
      shape *
      step(0.965, presence) *
      smoothstep(0.01, 0.18, dir.y) *
      twinkle;
    vec3 temperatureColor = mix(
      vec3(0.58, 0.71, 1.0),
      vec3(1.0, 0.77, 0.55),
      temperatureSeed
    );
    vec3 starColor = mix(temperatureColor, vec3(0.92, 0.93, 0.96), 0.62);
    col += starColor * star * uStarVisibility * intensity;
  }

  // 雲気: ごく薄い気配だけ(§0 Look)。地平線 h ∈ [0.02, 0.35] の帯
  float h = dir.y;
  float band = smoothstep(0.02, 0.08, h) * (1.0 - smoothstep(0.10, 0.35, h));
  if (band > 0.001) {
    vec2 cuv = dir.xz / max(h + 0.12, 0.12);
    float c1 = texture2D(uNoise, cuv * 0.055 + vec2(uTimeSec * 0.0011, 0.0)).b;
    float c2 = texture2D(uNoise, cuv * 0.021 - vec2(0.0, uTimeSec * 0.0007)).b;
    float cloud = smoothstep(0.55, 0.95, c1 * 0.6 + c2 * 0.55);
    col += uSkyHorizonCool * cloud * band * 0.12;
  }
  #endif

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
