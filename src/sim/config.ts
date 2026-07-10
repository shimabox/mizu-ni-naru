/**
 * sim 層の全チューナブル定数(design-sim.md §6 — 全数値に根拠コメント)。
 * 何も import しない定数最下層(様式の知見: Mizu-threejs/src/sim/config.ts の
 * 「根拠コメント付き定数集約」)。contract 側と重複する定数(STEP_HZ / DT /
 * SLOT_COUNT / 容量)は contract/WorldSpec.ts が正であり、ここには置かない。
 *
 * ペーシングの逆算チェーン(design-sim §5.7):
 *   リズム目標(15〜25s/落下, 7球) → 周期 ≈134s → T_fill ≈122s
 *   T_fill と「ぽつぽつ」感(2s強/粒) → N_DROPS_TARGET ≈55 → VOLUME_GAIN = 15
 *   雫レート 0.45/s → スポナー 1.5 体/s(40 step 間隔)
 *   溶解は供給の 1 割弱に抑える → P_DISSOLVE = 0.05
 * 校正ノブの優先順位(§7.5): ① SPAWN_INTERVAL_STEPS ② VOLUME_GAIN ③ P_DISSOLVE
 */

/* ── スロット / アンカー(§2.3)─────────────────────────────── */

/** リング半径。隣接間隔 2·4.5·sin(π/7) ≈ 3.91 u > 2·R_MAX = 3.4 u(重なり回避の下限を満たす最小リング)。 */
export const RING_RADIUS = 4.5;
/** アンカー高さ帯。下限は落下演出の行程(≥1.4 u)確保、上限はカメラフレーミング協定。 */
export const RING_Y_MIN = 2.8;
export const RING_Y_MAX = 5.2;
/** 角/半径ジッター(±)。最悪接近 ≈2.87 u でも分離チェック 8 回で解ける疎さ。 */
export const ANGLE_JITTER = 0.06; // rad
export const RADIAL_JITTER = 0.25; // u
/** スポーン時の決定的分離チェック: 中心距離 ≥ R_a + R_b + margin まで再ロール(§2.3)。 */
export const SEPARATION_MARGIN = 0.1; // u
export const SEPARATION_MAX_TRIES = 8;
/** bob(漂い)。振幅は R の 1 割未満(酔わない)、周期は満水時間の 1/13(単調さ回避)— 「呼吸」。 */
export const BOB_AMP = 0.12; // u
export const BOB_PERIOD_S = 9;
/** 満水時に球が沈む「重み」演出。リング下限 2.8 − 0.35 > R_MAX + 落下判定余裕。 */
export const SAG_MAX = 0.35; // u

/* ── 球体 / FSM(§2)──────────────────────────────────────── */

export const R_MIN = 1.1; // u
export const R_MAX = 1.7; // u
/** 内殻比 R_inner = 0.94R。シェル見かけ厚 6%(粒子・台帳の境界 — 裁定 A13)。 */
export const SHELL_RATIO = 0.94;
/** 落下トリガの fill01(分母 V_inner — 裁定 A12)。「見えている空洞の 6 割」。 */
export const F_FULL = 0.6;
/** Spawning: フェードイン+バースト補充が目標人口 20 体に届く最短(120 step / 6 step 間隔 = 20 回)。 */
export const SPAWNING_DURATION_S = 2.0;
export const BURST_SPAWN_INTERVAL_STEPS = 6;
/** Straining: wobble ランプが知覚できる最短(1 s 未満は「予兆」に見えない)。 */
export const STRAINING_DURATION_S = 1.5;
/** 落下(§2.4): 線形抗力付き等加速度。1.45 s・着水 ≈3.2 u/s(実重力 9.8 は速すぎて視線が追えない)。 */
export const FALL_G = 3.0; // u/s²
export const FALL_DRAG_K = 0.4; // /s
/** SplashEvent の strength = min(1, vImpact / SPLASH_STRENGTH_V_REF)(裁定 A10)。 */
export const SPLASH_STRENGTH_V_REF = 4; // u/s
/** Splashing: 海の波紋 FX の立ち上がりを覆う長さ(render 協定)。 */
export const SPLASHING_DURATION_S = 0.8;
/** Dead: 4〜10 s 一様。±3 s の位相拡散が周期縮退(§2.5)を防ぐ。 */
export const RESPAWN_DELAY_MIN_S = 4;
export const RESPAWN_DELAY_MAX_S = 10;
/** 起動スタッガー: 初期 fill を 0.55 幅で散らし、起動 10〜15 s で初落下・以降 ≈16 s 間隔(§2.5)。 */
export const INITIAL_FILL_MAX = 0.55;
export const INITIAL_FILL_JITTER = 0.03; // ±
/** 雫着水の wobble パルス(+0.15、毎 step ×0.97 減衰、上限 1 — §2.2)。 */
export const WOBBLE_PULSE = 0.15;
export const WOBBLE_DECAY = 0.97;

/* ── 原子(§3.1)──────────────────────────────────────────── */

/**
 * 原子半径(×R)。KIND_INDEX 順 [H, O, H2]。
 * Mizu-ts 実測比 H:O:H2 = 9:11:13.5 の移植。絶対値 0.06 は §5.1 の衝突断面積 σ から逆算
 * (球内 20〜26 体が「漂って見えるが混雑しない」密度)。
 */
export const ATOM_RADIUS_RATIO = [0.06, 0.073, 0.09] as const;
/** v_max = 0.55·R /s: HH レート 0.45/s を成立させる v_rel の逆算値(§5.1)。球横断 ≈4.5 s の「漂い」。 */
export const ATOM_MAX_SPEED_RATIO = 0.55; // /s(×R)
/** accel_per_step = v_max / 14: Mizu-ts の accel/maxSpeed = 0.075/1.05 比を継承(ウォークの質感保存)。 */
export const ATOM_ACCEL_FRACTION = 1 / 14; // ×v_max /step
/** 目標人口(§5.1)。化学量論 2:1 + H2 滞留 ≈4.5 を見込んだ視覚密度(≈25 体/球)。 */
export const H_TARGET = 12;
export const O_TARGET = 8;
/**
 * 凝結スポナーの試行間隔(§5.3/§5.6): 1.5 体/s = 雫 0.5/s の律速上限。
 * mobile は 0.75 倍間隔(2.0 体/s)で周期 ≈121 s → 落下間隔 ≈24 s に補正。
 */
export const SPAWN_INTERVAL_STEPS_DESKTOP = 40;
export const SPAWN_INTERVAL_STEPS_MOBILE = 30;
/** スロット位相オフセット: スロット i は globalStep + i·7 で試行(同時ポップ防止、決定的 — §3.6)。 */
export const SPAWN_SLOT_PHASE_STEPS = 7;
/** 棄却サンプリング上限。採用率 ≈1/1.9 → 16 回全滅は確率 ≈3×10⁻⁵(決定論的フォールバック付き)。 */
export const SPAWN_MAX_TRIES = 16;
/** 水面の確率透過(§5.2): 完全吸収(2.8 体/s)の 1/20 に絞り、溶解 ≈0.14 体/s = 供給の 1 割弱。 */
export const P_DISSOLVE = 0.05;
/** 原子/H2 溶解の InnerRipple strength(裁定 A7)。 */
export const DISSOLVE_RIPPLE_STRENGTH = 0.3;
/** 原子色: 単一 RNG 値(packed 0xRRGGBB)から導出するチャンネルの下駄(暗すぎる文字を避ける)。 */
export const ATOM_COLOR_BASE = 0.35;
export const ATOM_COLOR_SPAN = 0.65;

/* ── 雫(§4.1)────────────────────────────────────────────── */

/** 雫半径(×R)。原子(0.06〜0.09)と同格の見かけ(Mizu の「雫は原子よりやや大きい」比)。 */
export const DROPLET_RADIUS_RATIO_MIN = 0.065;
export const DROPLET_RADIUS_RATIO_MAX = 0.095;
/** v = 4r /s: 落下行程 ≈1.2 u を ≈2.7 s — 雫 1 粒の旅が目で追える長さ。 */
export const DROPLET_FALL_SPEED_PER_R = 4.0; // /s
/** 落下行程に 2〜3 揺れ(Mizu-ts の /100px を行程比換算)。 */
export const SWAY_FREQ = 12; // /u
/** 横速度が落下速度(4r/s)の 1 割未満 — 揺れても軌道は落下が主。 */
export const SWAY_AMP_RATIO_MIN = 0.25; // ×r /s
export const SWAY_AMP_RATIO_MAX = 0.45; // ×r /s
/** ワースト同時滞留 ≈1.4 粒の 45 倍(splash 直前の駆け込みも安全)。 */
export const DROPLET_CAP_PER_BUBBLE = 64;
/** 雫着水 InnerRipple strength = 0.6 + 0.4·(r/r_max)(裁定 A7 の 0.6..1.0 帯)。 */
export const DROPLET_RIPPLE_BASE = 0.6;
export const DROPLET_RIPPLE_SPAN = 0.4;

/* ── 水(§4)─────────────────────────────────────────────── */

/**
 * 演出係数(§4.4): 1 雫が見かけの 15 倍の水を運ぶ。
 * = (SHARE_DROPLET 0.85 × F_FULL 0.6 × V_inner) / (N_DROPS_TARGET 55 × V̄_drop)。
 * R が両辺で消えるため球サイズに依存しない(§5.4 のスケール不変性)。
 */
export const VOLUME_GAIN = 15;
/**
 * 球冠 LUT(§4.2): 257 エントリ(1KB)。誤差 ≤5×10⁻⁴(中央)/ 2×10⁻³(端点帯)。
 * 端点は漸近式 u = √(f/3)(対称)へ切替(du/df の √ 特異性対策)。
 * 実体は core/CapLut.ts(sim/core は config に依存できない — depcruise の
 * sim-core-is-base)。ここは文書化ミラーで、一致はテストで固定する。
 */
export const CAP_LUT_SIZE = 256;
export const CAP_LUT_ENDPOINT_F = 1 / 64;
