import type { QualityTier } from './RenderSystem';

/**
 * AdaptiveQuality(design-render §9.3 — 7 ノブ×5ティアを、現行システムの
 * applyTier フックに再マップ。master-plan Phase 4 の指示で backdropCount /
 * spray 上限 の 2 ノブを追加)。
 *
 * 制御ロジックは rAF デルタ EMA(α=0.1)+ 非対称ヒステリシス:
 * - down: EMA > 20ms が 90 フレーム連続 → ティア+1(悪化)
 * - up:   EMA < 11ms が 600 フレーム連続 → ティア-1(改善)
 * - 250ms 超のフレームデルタ(タブ復帰・GC 長時間停止等の外乱)は
 *   ストリークを破棄する(EMA 自体は更新しない — 一発で暴発させない)
 *
 * A50(2026-07-11 ユーザー指示「くっきりめのほうがよい」): 旧閾値(15ms/30f)は
 * 60fps(16.7ms)環境でもバックグラウンド負荷等の一時的ノイズで容易に降格
 * ストリークが成立し、戻り(600f)に時間がかかるため「一度ぼやけると居着く」
 * 体感になっていた。60fps は無条件に down 対象から外れる余裕(20ms、
 * 75Hz 環境の 13.3ms も安全域)を持たせ、ストリーク長も 90 フレーム(60fps で
 * 約 1.5 秒)に伸ばして真に継続的な低フレームレートのみで降格するようにした。
 * 降格機構自体(非力な端末向けの保護)は撤去しない — 閾値のみ緩和。
 * up 側は変更なし(戻りは慎重なままでよい、というユーザーの意図を汲む)。
 *
 * この節は**純関数のみ**(node でテスト可能)。DOM/three への副作用は
 * AdaptiveQuality クラス(下部)と呼び出し元(app/main.ts)が持つ。
 */
export const EMA_ALPHA = 0.1;
export const DOWN_THRESHOLD_MS = 20;
export const DOWN_STREAK_FRAMES = 90;
export const UP_THRESHOLD_MS = 11;
export const UP_STREAK_FRAMES = 600;
/**
 * これを超える rAF デルタは外乱として無視(ストリーク破棄・EMA 据え置き)。
 * DOWN_THRESHOLD_MS(20ms)より十分大きく(250ms ≫ 20ms)、外乱判定と
 * down 判定のレンジは重ならない — A50 の閾値引き上げ後も矛盾なし。
 */
export const DISTURBANCE_MS = 250;

export interface EmaState {
  readonly ema: number;
  readonly downStreak: number;
  readonly upStreak: number;
}

export const createEmaState = (initialMs = 1000 / 60): EmaState => ({
  ema: initialMs,
  downStreak: 0,
  upStreak: 0,
});

/**
 * 1 フレーム分の EMA/ストリーク更新(純関数・非破壊)。
 * 外乱フレーム(dtMs > DISTURBANCE_MS)は EMA を更新せずストリークのみ破棄する。
 */
export const updateEma = (state: EmaState, dtMs: number): EmaState => {
  if (dtMs > DISTURBANCE_MS) {
    return { ema: state.ema, downStreak: 0, upStreak: 0 };
  }
  const ema = state.ema + EMA_ALPHA * (dtMs - state.ema);
  const downStreak = ema > DOWN_THRESHOLD_MS ? state.downStreak + 1 : 0;
  const upStreak = ema < UP_THRESHOLD_MS ? state.upStreak + 1 : 0;
  return { ema, downStreak, upStreak };
};

export type TierDecision = 'down' | 'up' | 'none';

/** ヒステリシス判定(ストリークが閾値に達したら decision を返す)。 */
export const decideTierChange = (state: EmaState): TierDecision => {
  if (state.downStreak >= DOWN_STREAK_FRAMES) return 'down';
  if (state.upStreak >= UP_STREAK_FRAMES) return 'up';
  return 'none';
};

/** decision をティアへ適用(0 が最高品質・4 が最低 — クランプ + ストリークリセット後の状態)。 */
export const applyTierDecision = (
  tier: QualityTier,
  decision: TierDecision,
): QualityTier => {
  if (decision === 'down') return Math.min(4, tier + 1) as QualityTier;
  if (decision === 'up') return Math.max(0, tier - 1) as QualityTier;
  return tier;
};

/* ── ティア表(design-render §9.3 の7ノブ + backdropCount/sprayBudget) ───── */

/** renderScale(setPixelRatio に乗じる)。 */
export const RENDER_SCALE_BY_TIER: readonly number[] = [
  1.0, 0.85, 0.75, 0.66, 0.5,
];
/** dprCap(実効 DPR 上限。`?dpr=` 明示指定時はそちらが優先)。 */
export const DPR_CAP_BY_TIER: readonly number[] = [2.0, 2.0, 2.0, 1.75, 1.5];
/** bloomScale(0 で bloom パス無効 — PostPipeline.setBloomScale)。 */
export const BLOOM_SCALE_BY_TIER: readonly number[] = [0.5, 0.5, 0.25, 0.25, 0];

/**
 * EMA ヒステリシス制御クラス(状態機械の薄いラッパー)。
 * `?q=` 固定時や `?m=1` は本クラスを生成しない(呼び出し元 app/main.ts の責務)。
 */
export class AdaptiveQuality {
  private state: EmaState = createEmaState();
  private tier: QualityTier;
  private readonly onTierChange: (tier: QualityTier) => void;

  constructor(
    initialTier: QualityTier,
    onTierChange: (tier: QualityTier) => void,
  ) {
    this.tier = initialTier;
    this.onTierChange = onTierChange;
    onTierChange(initialTier);
  }

  /** rAF デルタ(ms)を 1 フレーム分供給する。ティアが変化したらコールバックを呼ぶ。 */
  public update(frameDtMs: number): void {
    this.state = updateEma(this.state, frameDtMs);
    const decision = decideTierChange(this.state);
    if (decision === 'none') return;
    const next = applyTierDecision(this.tier, decision);
    // ストリークをリセット(同じフレームで連鎖的に何段も飛ばない)
    this.state = { ema: this.state.ema, downStreak: 0, upStreak: 0 };
    if (next === this.tier) return;
    this.tier = next;
    this.onTierChange(next);
  }

  public get currentTier(): QualityTier {
    return this.tier;
  }
}
