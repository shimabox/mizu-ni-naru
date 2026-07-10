/**
 * sim → render のデータ契約(凍結契約 — master-plan.md §5、design-sim.md §1.2
 * ベース + 裁定差分: AtomView.aux 追加(A6))。
 *
 * 所有権と有効期間:
 * - 配列は sim が所有しインプレース変異。render は同一 ArrayBuffer をラップ(ゼロコピー)
 * - step() のリターンから次の step() 呼び出しまでコヒーレント
 * - 有効データは dense prefix [0, count*stride)。インデックスはフレーム間で不安定
 *   (swap-remove / 再パック)— render はインデックスに識別性を持たせない
 * - 再確保時は version++(固定容量設計なので実運用では発生しない想定)
 *
 * 不変条件(裁定 A4/A12/A25):
 * - prev/curr は同一 step の 2 世代。**同一インデックスは同一エンティティ**を指す。
 *   render は pos = lerp(prev, curr, alpha) で補間する
 * - **スポーンしたフレームは prev = curr**(生成時の飛び込みグリッチなし)。
 *   消滅したエンティティは両世代から消える(swap-remove は prev/curr/aux を同時に移す)
 * - BubbleView.count は常に SLOT_COUNT(Dead も含める — A18)
 * - **原子・雫は常に球内水面より上**(A25 — render の depth 戦略が依存する文書化不変条件)
 * - statePacked の prev は lerp 禁止(状態境界で整数部が跳ぶ — curr のみ読む)
 * - fill01 の分母は V_inner(内殻球 R_inner = 0.94R の体積 — A12)。
 *   F_FULL=0.6 は「見えている空洞の 6 割」
 */
export interface BubbleView {
  /** stride 8: [ax, ay, az, R, waterLevelYLocal, fill01, wobble, statePacked] */
  readonly data: Float32Array;
  /** 同 stride の前 step 値。statePacked は lerp 禁止(curr を読む) */
  readonly prevData: Float32Array;
  /** 常に SLOT_COUNT(Dead も含める。判別は statePacked — instancing 安定化) */
  readonly count: number;
  readonly version: number;
}

export interface AtomView {
  /** stride 4: [x, y, z, r](ワールド座標 — 集約パッカーが anchor 加算済み) */
  readonly posr: Float32Array;
  readonly prevPosr: Float32Array;
  /** stride 4: [r, g, b, kindIndex]。r/g/b は 0..1、kindIndex は KIND_INDEX */
  readonly colorKind: Float32Array;
  /**
   * stride 4: [spawnStep, seed, 0, 0](裁定 A6)。スポーン時のみ書き込み。
   * 凝結スポーンのフェードイン + パルス位相に使用(render のパルスは
   * gl_InstanceID ハッシュではなく seed 駆動 — swap-remove で位相が飛ばない)
   */
  readonly aux: Float32Array;
  readonly count: number;
  readonly version: number;
}

export interface DropletView {
  /** stride 4: [x, y, z, r](ワールド座標) */
  readonly posr: Float32Array;
  readonly prevPosr: Float32Array;
  /**
   * stride 4: [phase, swayAmp, spawnStep, seed]。スポーン時のみ書き込み。
   * age はシェーダで uStep - spawnStep(f32 の整数精度 2^24 step ≈ 77 時間。
   * 超えると FX の age がジッタるだけ — render は step を 2^20 で mod してよい)
   */
  readonly aux: Float32Array;
  readonly count: number;
  readonly version: number;
}

/**
 * 海(y=0)への球の着水イベント。フレーム内 append、フレームをまたがない。
 * 裁定 A10: radius = 球半径 R、strength = min(1, vImpact/4)(速度項のみ)。
 */
export interface SplashEventView {
  /** stride 4: [x, z, radius, strength] */
  readonly data: Float32Array;
  readonly count: number;
}

/**
 * 球内水面へのイベント(FX 用)。雫着水 strength=0.6..1.0、原子溶解 strength=0.3
 * (裁定 A7)。localX/Z は球ローカル世界単位(−R..+R — 裁定 A8)。
 */
export interface InnerRippleView {
  /** stride 4: [bubbleIndex, localX, localZ, strength] */
  readonly data: Float32Array;
  readonly count: number;
}

export interface SkyRenderView {
  /** 経過 step 数(整数)。シェーダの uStep / age 導出用 */
  readonly step: number;
  readonly bubbles: BubbleView;
  readonly atoms: AtomView;
  readonly droplets: DropletView;
  readonly splashes: SplashEventView;
  readonly ripples: InnerRippleView;
}

/** 診断カウンタ(オーバーレイ / ヘッドレス校正用。表示契約は本作で新規定義 — 裁定 A19)。 */
export interface SimCounts {
  readonly h: number; // 生存 H
  readonly o: number; // 生存 O
  readonly h2: number; // 生存 H2
  readonly droplets: number; // 生存雫(全球合計)
  readonly bubblesActive: number; // Dead 以外のスロット数
  readonly splashesTotal: number; // 累計着水(球)
  readonly dropletsAbsorbedTotal: number; // 累計 雫吸収
  readonly dissolvedTotal: number; // 累計 原子/H2 溶解
  readonly meanFill01: number; // アクティブ球の平均 fill01(校正スクリプト用)
}

export interface SimInitOptions {
  readonly seed: number; // 単一 RNG ストリームのシード
  readonly slotCount: number; // SLOT_COUNT_DESKTOP | SLOT_COUNT_MOBILE
  readonly pacing?: 'desktop' | 'mobile'; // 省略時 slotCount から導出
}

export interface SimLike {
  init(options: SimInitOptions): void;
  step(): void; // 1 step = DT 秒。dt 引数なし・描画なし・DOM なし
  view(): SkyRenderView; // 安定オブジェクト(毎フレーム同一参照、フィールド更新のみ)
  counts(): SimCounts;
}

/** render 側差し替え点(alpha は補間係数 ∈ [0,1) — 裁定 A1)。 */
export interface SkyRenderer {
  render(view: SkyRenderView, alpha: number): void;
  resize(): void;
  dispose(): void;
}
