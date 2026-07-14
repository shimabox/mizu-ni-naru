import type { QualityTier } from './RenderSystem';

/**
 * AdaptiveQuality(design-render §9.3 — 7 ノブ×5ティアを、現行システムの
 * applyTier フックに再マップ。master-plan Phase 4 の指示で backdropCount /
 * spray 上限 の 2 ノブを追加)。
 *
 * 制御ロジックは rAF デルタ EMA(α=0.1)+ 非対称ヒステリシス:
 * - down: EMA > DOWN_THRESHOLD_MS が DOWN_STREAK_FRAMES 連続 → ティア+1(悪化)
 * - up:   EMA < 11ms が 600 フレーム連続 → ティア-1(改善)
 * - 250ms 超のフレームデルタ(タブ復帰・GC 長時間停止等の外乱)は
 *   ストリークを破棄する(EMA 自体は更新しない — 一発で暴発させない)
 *
 * A50(2026-07-11 ユーザー指示「くっきりめのほうがよい」): 旧閾値(15ms/30f)は
 * 60fps(16.7ms)環境でもバックグラウンド負荷等の一時的ノイズで容易に降格
 * ストリークが成立し、戻り(600f)に時間がかかるため「一度ぼやけると居着く」
 * 体感になっていた。閾値を 20ms/90f まで緩めて真に継続的な低フレームレート
 * のみで降格するようにしたが、これは「解像度が最初に犠牲になるティア表」の
 * 上で行ったため、GPU が重い局面で高解像度に居座って fps 自体を犠牲にする
 * 副作用があった(A52 で修正)。
 *
 * A52(2026-07-11 ユーザー指示、複数回の改訂を経て確定): 最終的な優先順位は
 * 「**エフェクト(bloom・書き割り・しぶき・波紋解像度・反射・海グリッド)>
 * 解像度 > 文字のくっきりさ**」— 本作は「ぼーっと眺める」環境映像であり、
 * 世界の空気を作るエフェクト群が最優先。よってティア表は**解像度を先に**
 * 削る構成に組み替えた(renderScale 1.00→0.85→0.75→0.66→0.55、dprCap
 * 2.00→2.00→1.75→1.75→1.50)。エフェクト側(bloom・backdropCount・
 * spray・rippleSimResolution・oceanGridDensity・analyticReflections)は
 * tier2 まで完全温存し、解析反射は tier3 まで生存させる。文字は解像度低下の
 * 影響を直接受けるため、LabelAtlas 側(アトラス解像度・縁取り太さ)を
 * 頑健化して判読性を補う(labelDensity ノブ自体は tier2 まで温存)。
 * 降格感度は 60fps 維持を最優先に再強化: DOWN_THRESHOLD_MS 20→18ms
 * (EMA が約 55.6fps 相当を上回ったら降格候補)、DOWN_STREAK_FRAMES 90→60
 * (60fps で約 1 秒)。60fps は依然 18ms 未満なので down 対象から外れる。
 * up 側は不変(戻りは慎重なままでよい、というユーザーの意図を汲む)。
 *
 * A52 不変条件(ユーザー追補「球体は球に見えるように、そのへんは妥協したく
 * ない」): **球体ジオメトリの分割レベル(前景Glass / InnerWater detail6、
 * BackdropBubbles detail4)はティアのノブに一切
 * 含めない**。どのティアでも球は丸いまま固定。本ファイルのティア表(下記
 * RENDER_SCALE_BY_TIER 以下の全エクスポート)に球体 detail の項目が存在
 * しないのはこの不変条件による意図的な設計であり、欠落ではない。
 * backdropCount(COUNT_FRACTION_BY_TIER)は「遠景球の**個数**」を減らす
 * だけで、残った球 1 個ずつの丸さ(detail4)は不変 — 個数と detail は
 * 独立したノブとして区別すること。BubbleGlassSystem に applyTier 自体が
 * 存在しない(近景の主役球は詳細度・個数ともにティア非対象)のも同じ理由。
 *
 * この節は**純関数のみ**(node でテスト可能)。DOM/three への副作用は
 * AdaptiveQuality クラス(下部)と呼び出し元(app/main.ts)が持つ。
 */
export const EMA_ALPHA = 0.1;
export const DOWN_THRESHOLD_MS = 18;
export const DOWN_STREAK_FRAMES = 60;
export const UP_THRESHOLD_MS = 11;
export const UP_STREAK_FRAMES = 600;
/**
 * これを超える rAF デルタは外乱として無視(ストリーク破棄・EMA 据え置き)。
 * DOWN_THRESHOLD_MS(18ms)より十分大きく(250ms ≫ 18ms)、外乱判定と
 * down 判定のレンジは重ならない — A52 の閾値引き上げ後も矛盾なし。
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

/**
 * A52(最終確定 — 2026-07-11 ユーザー指示「エフェクトは文字の解像度より価値が
 * 高い」): 降格は renderScale/dprCap を**先に**削り、bloom・書き割り数・
 * 波紋解像度・海グリッド・解析反射・スプレー上限は tier2 まで完全温存する
 * (解析反射のみ tier3 まで温存)。文字(labelDensity)は tier2 まで温存の
 * うえで、解像度低下の影響は LabelAtlas 側の頑健化(縁取り太め・アトラス
 * 解像度アップ)で吸収する。
 */
/** renderScale(setPixelRatio に乗じる)。tier0 のみ無劣化、以降段階的に低下(A52 最終)。 */
export const RENDER_SCALE_BY_TIER: readonly number[] = [
  1.0, 0.85, 0.75, 0.66, 0.55,
];
/** dprCap(実効 DPR 上限。`?dpr=` 明示指定時はそちらが優先)。tier2 から 1.75、tier4 で 1.5(A52 最終)。 */
export const DPR_CAP_BY_TIER: readonly number[] = [2.0, 2.0, 1.75, 1.75, 1.5];
/** bloomScale(0 で bloom パス無効 — PostPipeline.setBloomScale)。tier2 まで温存、tier3 以降のみ半減(A52 最終)。 */
export const BLOOM_SCALE_BY_TIER: readonly number[] = [
  0.5, 0.5, 0.5, 0.25, 0.25,
];

/**
 * モバイルはフィルレート律速のため、dprCap を全ティアで抑える(A52)。
 * 高 DPR(3 前後)の過剰画素はモバイルの物理画面サイズでは知覚されにくい
 * 一方、フィルレートコストは DPR² で効くため desktop より早く頭打ちにする。
 */
export const MOBILE_DPR_CAP = 1.75;

/** dprCap(§9.3)にモバイル上限(A52)を適用した実効値。 */
export const dprCapForTier = (tier: QualityTier, isMobile: boolean): number =>
  isMobile
    ? Math.min(DPR_CAP_BY_TIER[tier], MOBILE_DPR_CAP)
    : DPR_CAP_BY_TIER[tier];

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
