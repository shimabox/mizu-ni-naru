/**
 * sim 層の全チューナブル定数(design-sim.md §6 — 全数値に根拠コメント)。
 * 何も import しない定数最下層(様式の知見: Mizu-threejs/src/sim/config.ts の
 * 「根拠コメント付き定数集約」)。contract 側と重複する定数(STEP_HZ / DT /
 * SLOT_COUNT / 容量)は contract/WorldSpec.ts が正であり、ここには置かない。
 *
 * ペーシングの逆算チェーン(design-sim §5.7、A30 で 12/7 球に増量、
 * A40 で F_FULL 固定 0.6→球ごとの一様帯 [0.8, 0.95](平均 0.875)に伴い
 * VOLUME_GAIN を同率スケール):
 *   リズム目標(A30 改訂: 11〜20s/落下, 12球) → T_fill ≈132s ÷ 12 ≈ 11s/落下
 *   T_fill と「ぽつぽつ」感(2s強/粒) → N_DROPS_TARGET ≈55 →
 *     VOLUME_GAIN = 15(F_FULL=0.6 当時)→ A40 で F̄_FULL=0.875 に伴い 22 に再スケール
 *     (T_fill ∝ F_FULL / VOLUME_GAIN を保つ比率補正: 15 × 0.875/0.6 ≈ 21.9 → 22)
 *   雫レート 0.45/s → スポナー 1.5 体/s(40 step 間隔)
 *   溶解は供給の 1 割弱に抑える → P_DISSOLVE = 0.05
 * 校正ノブの優先順位(§7.5): ① SPAWN_INTERVAL_STEPS ② VOLUME_GAIN ③ P_DISSOLVE
 *
 * 校正実測(2026-07-11 A32 後、scripts/calibrate.mts — seed 7/42/123/2026 × 900 s):
 *   desktop(40 球 = 近 12 + フィールド 28): T_fill mean 140.2 s(帯 90–150 ✓)/
 *                    近リング落下間隔 mean 11.9 s(帯 11–20 ✓、シーン全体は
 *                    参考値 mean 3.7 s — 「数秒に 1 回どこかで球が還る」)/
 *                    体積シェア 雫 85.0% : 溶解 15.0%(設計 85:15)
 *   mobile (14 球 = 近 7 + フィールド 7): T_fill mean 113.8 s ✓ /
 *                    近リング落下間隔 mean 17.5 s(帯 15–25 ✓)/ シェア 86.7 : 13.3
 *   → 全帯 PASS。ノブ① SPAWN_INTERVAL_STEPS_DESKTOP のみ 40→44 に調整
 *     (A32 で 40 球化 — 共有 RNG ストリームに外側フィールド 28 球分の消費が
 *     挟まり、近リングのデフォルト校正(4 seed)が帯下限 11s を僅かに
 *     割り込んだため。近リングの物理式自体は不変)。mobile は変更なし
 *
 * 校正実測(2026-07-11 A40 最終形 — 帯 [0.8,0.95]・VOLUME_GAIN=22、A35 の
 * 96/24 球構成、同スクリプト・同 seed 掃引 7/42/123/2026 × 900 s):
 *   desktop(96 球 = 近 12 + フィールド 84): T_fill mean 130.3 s [101.8, 227.6]
 *                    (帯 90–150 ✓)/ 近リング落下間隔 mean 11.3 s(帯 11–20 ✓、
 *                    下限寄りだが PASS)/ 体積シェア 雫 81.8% : 溶解 18.2%
 *   mobile (24 球 = 近 7 + フィールド 17): T_fill mean 103.1 s [80.5, 142.2] ✓ /
 *                    近リング落下間隔 mean 15.6 s(帯 15–25 ✓)/ シェア 84.0 : 16.0
 *   → 全帯 PASS(ノブ調整不要 — F_FULL/VOLUME_GAIN の比率補正のみで帯内に収まった)
 */

/* ── スロット / アンカー(§2.3、A30 で緩い二重リングに改訂)─────── */

/**
 * 二重リング半径(A30: 内 r≈3.6 × 5 球 + 外 r≈6.3 × 7 球が目安)。
 * 実値 3.5/6.5 は分離チェックの実現可能性から確定: 5 分割と 7 分割の格子は
 * 最悪 π/35 ≈ 5.1° まで近接し、水平距離 ≈3.13 u。y 帯(幅 3.4)のロールで
 * 最悪ペア(R_a+R_b+0.1 = 3.5 u)でも |Δy| ≥ √(3.5²−3.13²) ≈ 1.6 の解が常に
 * 存在する(gap 2.9 u より狭いと大球ペアが幾何的に分離不能になる)。
 * 同一リング内の隣接間隔は内 2·3.5·sin(π/5) ≈ 4.11 / 外 2·6.5·sin(π/7) ≈ 5.64 > 3.5 u。
 */
export const RING_INNER_RADIUS = 3.5;
export const RING_OUTER_RADIUS = 6.5;
/** 内リングのスロット比(A30: desktop 12 → 5+7、mobile 7 → 3+4)。 */
export const INNER_RING_SHARE = 5 / 12;
/** アンカー高さ帯(A30 で 2.6〜6.0 に拡大 — 奥行きと分離自由度)。上限はカメラフレーミング協定。 */
export const RING_Y_MIN = 2.6;
export const RING_Y_MAX = 6.0;

/**
 * 近リングの総スロット数(A30 以降不変: SlotRing はこのスロット数分だけ従来の
 * 緩い二重リングを使う)。desktop 96 = 近 12 + 外側フィールド 84(A35)、
 * mobile 24 = 近 7 + フィールド 17(A35)。
 */
export const NEAR_RING_COUNT_DESKTOP = 12;
export const NEAR_RING_COUNT_MOBILE = 7;
/**
 * 外側環状フィールド(A32 で導入、A35 で半径帯を [8,26] → [8,45] に拡張)。
 * 半径は幾何スパイラル
 * r(t) = FIELD_RADIUS_MIN·(FIELD_RADIUS_MAX/FIELD_RADIUS_MIN)^t
 * (t = フィールド内インデックス / フィールド数 ∈ [0,1))— dr/dt ∝ r なので
 * 等間隔 t に対し外側ほど半径間隔が開く = 密度∝1/r(「外へ薄くなる」)。
 * 角はひまわり配列の黄金角(均等・非周期分布、リング分割の帳簿不要)。
 * y 帯・分離マージン・再ロール上限は近リングと共通(RING_Y_MIN/MAX、
 * SEPARATION_MARGIN、SEPARATION_MAX_TRIES を再利用)。
 */
export const FIELD_RADIUS_MIN = 8;
export const FIELD_RADIUS_MAX = 45;
export const FIELD_ANGLE_JITTER = 0.35; // rad(黄金角スパイラルは疎なので近リングより広く許容)
export const FIELD_RADIAL_JITTER = 1.4; // u
/** 角/半径ジッター(±)。リング間 5.1° 近接ペアでも y 再ロールで解ける疎さ。 */
export const ANGLE_JITTER = 0.06; // rad
export const RADIAL_JITTER = 0.25; // u
/** スポーン時の決定的分離チェック: 中心距離 ≥ R_a + R_b + margin まで再ロール(§2.3)。 */
export const SEPARATION_MARGIN = 0.1; // u
/** 再ロール上限。二重リングの近接ペア(y 窓 ≈0.6/3.4 ≈ 18%)でも 16 回全滅は ≈4%(フォールバック付き)。 */
export const SEPARATION_MAX_TRIES = 16;
/**
 * フォールバック(全試行失敗時)の y: 内リングは帯下端寄り・外リングは帯上端寄りに
 * 離す(Δy 2.8 u)— フォールバック同士でも近接角ペア(水平 ≈3.0 u)が
 * 3D 距離 √(3.0²+2.8²) ≈ 4.1 > 3.5 u で必ず分離する決定的最終手段。
 */
export const FALLBACK_Y_INNER = RING_Y_MIN + 0.3; // 2.9
export const FALLBACK_Y_OUTER = RING_Y_MAX - 0.3; // 5.7
/** bob(漂い)。振幅は R の 1 割未満(酔わない)、周期は満水時間の 1/13(単調さ回避)— 「呼吸」。 */
export const BOB_AMP = 0.12; // u
export const BOB_PERIOD_S = 9;
/** 満水時に球が沈む「重み」演出。リング下限 2.6 − 0.35 = 2.25 > R_MAX 1.7 + 落下判定余裕。 */
export const SAG_MAX = 0.35; // u

/* ── 球体 / FSM(§2)──────────────────────────────────────── */

export const R_MIN = 1.1; // u
export const R_MAX = 1.7; // u
/** 内殻比 R_inner = 0.94R。シェル見かけ厚 6%(粒子・台帳の境界 — 裁定 A13)。 */
export const SHELL_RATIO = 0.94;
/**
 * 落下トリガの fill01 帯(分母 V_inner — 裁定 A12)。「見えている空洞の
 * 8〜9.5 割」(A40 改訂: 固定 0.6 → 球ごとの一様帯 [0.8, 0.95] —
 * 「もっと溜まってから。0.9 でもいいくらい。0.8〜0.9 とかにできる?」との
 * 初期指示を受けた実装後、最終指示で上限を 0.95 まで拡大)。
 * 閾値は世代(再ロール)ごとに rollSlot が RNG 1 回で引いて BubbleFsm に
 * 持たせる — 同じ球でも毎回わずかに違う満水で落ち、周期縮退(§2.5)も弱まる。
 */
export const F_FULL_MIN = 0.8;
export const F_FULL_MAX = 0.95;
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
/**
 * 起動スタッガー: 初期 fill を 0.75 幅で散らし、起動 10〜15 s で初落下・以降
 * ≈16 s 間隔(§2.5)。A40 で F_FULL 0.6→[0.8,0.95] に伴い比例引き上げ。
 * 上限 0.75 + ジッター 0.03 = 0.78 < F_FULL_MIN 0.8 — 起動直後に
 * いきなり満水落下する球が出ないことを構造的に保証する(帯上限が 0.95 に
 * 広がっても F_FULL_MIN は不変のためこの保証は影響を受けない)。
 */
export const INITIAL_FILL_MAX = 0.75;
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
 * mobile は 0.75 倍間隔(2.0 体/s)で周期 ≈121 s → 7 球で落下間隔 ≈17 s
 * (A30 帯 15–25 の中央寄り)に補正。
 */
/**
 * desktop は A32 校正(§7.5 ノブ①)で 40→44 に微調整: 近リング(12 球)の
 * 落下間隔がデフォルト校正(seed 7/42/123/2026 × 900s)で 10.9s と帯下限
 * (11s)をわずかに割ったため(近リングの物理式自体は不変 — 40 球化で共有
 * RNG ストリームに外側フィールドの消費が挟まり乱数列が変わったことによる
 * サンプル差)。+10% で T_fill・近リング間隔とも帯中央寄りに戻る。
 */
export const SPAWN_INTERVAL_STEPS_DESKTOP = 44;
export const SPAWN_INTERVAL_STEPS_MOBILE = 30;
/** スロット位相オフセット: スロット i は globalStep + i·7 で試行(同時ポップ防止、決定的 — §3.6)。 */
export const SPAWN_SLOT_PHASE_STEPS = 7;
/** 棄却サンプリング上限。採用率 ≈1/1.9 → 16 回全滅は確率 ≈3×10⁻⁵(決定論的フォールバック付き)。 */
export const SPAWN_MAX_TRIES = 16;
/** 水面の確率透過(§5.2): 完全吸収(2.8 体/s)の 1/20 に絞り、溶解 ≈0.14 体/s = 供給の 1 割弱。 */
export const P_DISSOLVE = 0.05;
/** 原子/H2 溶解の InnerRipple strength(裁定 A7)。 */
export const DISSOLVE_RIPPLE_STRENGTH = 0.3;
/**
 * 原子が水面で跳ね返る(mirror反射・非溶解)ときの「ポチャ」InnerRipple
 * strength(裁定 A34)。溶解(0.3)より控えめな微波。
 */
export const BOUNCE_RIPPLE_STRENGTH = 0.15;
/**
 * 跳ね返りポチャの球ごとのレート制限(裁定 A34): 18 step(0.3s)未満の連続発火は
 * 抑止する(直近発火 step を球ごとに記録 — 決定的・RNG 消費なし)。
 */
export const BOUNCE_RIPPLE_RATE_LIMIT_STEPS = 18;
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
 * 演出係数(§4.4): 1 雫が見かけの 22 倍の水を運ぶ。
 * = (SHARE_DROPLET 0.85 × F̄_FULL 0.875 × V_inner) / (N_DROPS_TARGET 55 × V̄_drop)。
 * R が両辺で消えるため球サイズに依存しない(§5.4 のスケール不変性)。
 * A40 改訂: F_FULL 0.6→[0.8,0.95](平均 0.875)を同率スケール
 * (15 × 0.875/0.6 ≈ 21.9 → 22)で補償し、T_fill(充填にかかる実時間)を保存する
 * (T_fill ∝ F̄_FULL / VOLUME_GAIN のため比率一定なら不変)。
 */
export const VOLUME_GAIN = 22;
/**
 * 球冠 LUT(§4.2): 257 エントリ(1KB)。誤差 ≤5×10⁻⁴(中央)/ 2×10⁻³(端点帯)。
 * 端点は漸近式 u = √(f/3)(対称)へ切替(du/df の √ 特異性対策)。
 * 実体は core/CapLut.ts(sim/core は config に依存できない — depcruise の
 * sim-core-is-base)。ここは文書化ミラーで、一致はテストで固定する。
 */
export const CAP_LUT_SIZE = 256;
export const CAP_LUT_ENDPOINT_F = 1 / 64;
