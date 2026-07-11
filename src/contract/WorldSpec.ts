/**
 * 世界座標の規約と共有定数(sim ↔ render の凍結契約)。
 * master-plan.md §5(裁定 A3/A5 反映)+ design-sim.md §1.1。
 *
 * - y-up 右手系。海面 = world y = 0(SEA_LEVEL)
 * - 単位はメートル風の抽象単位(u)。球半径 R ∈ [0.75, 2.3]
 *   (A42: u² シェーピングで小径多数・大径稀。近リング上限は 1.8、
 *   巨大球 R≥2.0 は外側フィールド限定)
 * - 球はワールド内を「平行移動のみ」する(回転なし)。
 *   球ローカル → ワールドは anchor 加算のみ: world = anchor + local
 * - 球ローカル座標は球中心原点。球内水面は local y = waterLevelYLocal の水平面
 *
 * このファイルは何も import しない。実装フェーズ 0 完了後は凍結
 * (変更には master-plan §4 への裁定追記が必要)。
 */
export const SEA_LEVEL = 0;

/** 固定タイムステップ。sim の唯一の時計は step カウンタ。 */
export const STEP_HZ = 60;
export const DT = 1 / STEP_HZ; // 1 step = 1/60 s
export const MAX_STEPS_PER_FRAME = 3; // rAF アキュムレータの上限。超過分は捨てる

/** 原子種 → kindIndex(AtomView.colorKind 第 4 成分・グリフアトラスの並び)。 */
export const KIND_INDEX = { H: 0, O: 1, H2: 2 } as const;
export type AtomKind = keyof typeof KIND_INDEX;

/**
 * 球スロット数(裁定 A30 で 7/5 → 12/7、裁定 A32 で 12/7 → 40/14、
 * 裁定 A35 で 40/14 → 96/24 に増量)。
 * 近リング(既存の緩い二重リング — A30 以降不変)12/7 + 外側環状フィールド
 * (A35: desktop 84 / mobile 17、半径帯を [8,26] → [8,45] に拡張し外へ薄く)。
 * モバイル判定は app 層(viewport width < 768 — 裁定 A16)。
 */
export const SLOT_COUNT_DESKTOP = 96;
export const SLOT_COUNT_MOBILE = 24;

/**
 * 球体 FSM の状態インデックス(statePacked の整数部 — 裁定 A3 で sim 名に統一)。
 * statePacked = stateIndex + min(progress01, 0.999)。
 * 復号: stateIndex = floor(statePacked)、progress01 = fract(statePacked)。
 */
export const BUBBLE_STATE = {
  Spawning: 0,
  Drifting: 1,
  Straining: 2,
  Falling: 3,
  Splashing: 4,
  Dead: 5,
} as const;
export type BubbleStateName = keyof typeof BUBBLE_STATE;

/** view 固定容量(design-sim §8 ワースト見積 × 2 の切り上げ。成長しない設計 — 裁定 A5、A30、A32、A35 で改訂)。 */
export const BUBBLE_CAPACITY = 128; // render のインスタンス/uniform 配列は 128 固定(A35、≥ SLOT_COUNT_DESKTOP=96)
export const ATOM_VIEW_CAPACITY = 4096; // ワースト ≈ 96 球 × 26 体 ≈ 2500
export const DROPLET_VIEW_CAPACITY = 8192; // ワースト ≈ 96 球 × 64(球内キャップ)= 6144
export const SPLASH_VIEW_CAPACITY = 128; // 同一フレーム最大 = スロット数 96(BUBBLE_CAPACITY と同格)
export const RIPPLE_VIEW_CAPACITY = 256; // 雫着水+溶解+水面バウンド(A34)イベント。球増量分の余裕込み
