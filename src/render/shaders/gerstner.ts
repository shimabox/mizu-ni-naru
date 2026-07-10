/**
 * Gerstner 波 8 成分の共有チャンク(design-render §2.1)。
 *
 * - 波テーブルは TS 定数(下記)→ OceanSystem が uniform 配列で供給
 * - 分散関係は深水波 φ̇ = √(g_eff·w)、g_eff = 2.4(実世界の約 1/4 —
 *   「時間がゆっくり流れる海」のドリーミー演出。スウェル周期 ~6.5s)
 * - 位相 φ は CPU が毎フレーム mod 2π して uWaveB[i].y に供給する
 *   (t が数時間に達しても fp32 位相が破綻しない — §2.1 精度対策)
 * - 頂点は波 0–4 のみ変位(chop 5–7 は頂点解像度未満 — フラグメント法線専任)
 */

export const OCEAN_G_EFF = 2.4;

export interface GerstnerWave {
  /** 波長 [u] */
  readonly lambda: number;
  /** 振幅 [u] */
  readonly amp: number;
  /** 横変位係数 Q */
  readonly q: number;
  /** 風向 [deg](主風向 ≈ +12°、±50° に散らす) */
  readonly dirDeg: number;
}

/** §2.1 の 8 波テーブル(0-1 swell / 2-4 mid / 5-7 chop)。 */
export const GERSTNER_WAVES: readonly GerstnerWave[] = [
  { lambda: 16.0, amp: 0.13, q: 1.96, dirDeg: 15 },
  { lambda: 11.0, amp: 0.1, q: 1.58, dirDeg: -12 },
  { lambda: 6.5, amp: 0.055, q: 1.32, dirDeg: 38 },
  { lambda: 4.2, amp: 0.04, q: 1.0, dirDeg: -30 },
  { lambda: 2.6, amp: 0.025, q: 0.83, dirDeg: 8 },
  { lambda: 1.6, amp: 0.014, q: 0.89, dirDeg: 55 },
  { lambda: 1.0, amp: 0.009, q: 0.71, dirDeg: -48 },
  { lambda: 0.62, amp: 0.005, q: 0.59, dirDeg: 22 },
];

export const GERSTNER_WAVE_COUNT = GERSTNER_WAVES.length;

/** 頂点変位に使う波数(0..この値の手前まで。以降はフラグメント法線のみ)。 */
export const GERSTNER_VERTEX_WAVES = 5;

/** 角波数 w = 2π/λ。 */
export const gerstnerAngularWavenumber = (lambda: number): number =>
  (2 * Math.PI) / lambda;

/** 位相速度 φ̇ = √(g_eff·w) [rad/s]。 */
export const gerstnerPhaseRate = (lambda: number): number =>
  Math.sqrt(OCEAN_G_EFF * gerstnerAngularWavenumber(lambda));

/** 頂点変位波(0–4)の振幅和 — thin(波頭の薄さ)正規化の分母。 */
export const SWELL_AMP_SUM_VERTEX = GERSTNER_WAVES.slice(
  0,
  GERSTNER_VERTEX_WAVES,
).reduce((sum, w) => sum + w.amp, 0);

/**
 * ループ防止条件 Σ Qᵢ·wᵢ·Aᵢ(< 1 でヤコビアンが負にならない = 波が巻かない)。
 * テーブル値で ≈ 0.49。テストで固定する。
 */
export const gerstnerSteepnessSum = (): number =>
  GERSTNER_WAVES.reduce(
    (sum, w) => sum + w.q * gerstnerAngularWavenumber(w.lambda) * w.amp,
    0,
  );

/** gerstner チャンクが要求する uniform 宣言(頂点・フラグメント共通)。 */
export const GERSTNER_UNIFORMS_GLSL = /* glsl */ `
uniform vec4 uWaveA[8];   // [dirX, dirZ, w, amp]
uniform vec4 uWaveB[8];   // [Q, phase(CPU で mod 2π 済み), 0, 0]
uniform float uSwellGain; // 呼吸 1 + 0.15·sin(2π·t/90s)
`;

/**
 * 共有 GLSL チャンク: 変位(頂点)+ 解析導関数・ヤコビアン(フラグメント)。
 * 両者は同一テーブル・同一位相を読むため整合が構造的に保証される。
 * gain = uSwellGain × 位置依存の減衰(アクション域スウェル 25% 減 — §2.2)
 * を呼び元が計算して渡す。
 */
export const GERSTNER_CHUNK_GLSL = /* glsl */ `
vec3 gerstnerOffset(vec2 xz, int lo, int hi, float gain) {
  vec3 off = vec3(0.0);
  for (int i = lo; i < hi; i++) {
    vec2 D = uWaveA[i].xy;
    float w = uWaveA[i].z;
    float A = uWaveA[i].w * gain;
    float th = w * dot(D, xz) + uWaveB[i].y;
    float s = sin(th), c = cos(th);
    // D は vec2(xz 平面)— 第 2 成分が世界 z 方向
    off += vec3(uWaveB[i].x * A * D.x * c, A * s, uWaveB[i].x * A * D.y * c);
  }
  return off;
}

// 法線勾配とヤコビアン(フォーム用)を同一ループで返す — フラグメントで 8 波フル評価
void gerstnerDeriv(vec2 xz, float gain, out vec3 grad, out float jac) {
  vec2 dH = vec2(0.0);
  float qs = 0.0;
  float jxx = 1.0, jzz = 1.0, jxz = 0.0;
  for (int i = 0; i < 8; i++) {
    vec2 D = uWaveA[i].xy;
    float w = uWaveA[i].z;
    float A = uWaveA[i].w * gain;
    float Q = uWaveB[i].x;
    float th = w * dot(D, xz) + uWaveB[i].y;
    float s = sin(th), c = cos(th), wA = w * A;
    dH += D * (wA * c);                 // ∂y/∂x, ∂y/∂z
    qs += Q * wA * s;                   // 縦圧縮
    jxx -= Q * wA * D.x * D.x * s;
    jzz -= Q * wA * D.y * D.y * s;
    jxz -= Q * wA * D.x * D.y * s;
  }
  grad = vec3(dH.x, qs, dH.y);
  jac = jxx * jzz - jxz * jxz;          // 1 = 無変形、→0 = 波頭圧縮(フォーム)
}
`;
