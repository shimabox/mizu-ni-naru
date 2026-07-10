# mizu-ni-naru シミュレーション層 詳細設計(design-sim)

- 作成: 2026-07-10(シミュレーション設計エージェント)
- 本書はオーケストレーターの**裁定済み事項(1〜10)に全面的に従う**。裁定への変更提案・render 側との調整事項は文末「裁定希望事項」に集約した(本文はすべて裁定準拠で書かれている)
- コードは**ゼロから新規実装**。ただし同ユーザーの実証済みプロジェクトの知見を採用し、各所に「採用した知見(出典ファイルパス)」を明記する。主な参照元:
  - `/Users/takahiroshimabukuro/shimabox/github/Mizu-threejs`(3D 版・完成品。以下 *threejs*)
  - `/Users/takahiroshimabukuro/shimabox/github/Mizu-ts`(2D 原典。以下 *2D*)

検証済みの参照キャリブレーション事実(本書の外挿の根拠): *threejs* は 9,000 原子のフルパイプラインを実測 ≈2.5ms/step(内 衝突 ≈1.3ms)、30 万雫の RNG フリーカーネルを ≈1.3ms/step で回した(`Mizu-threejs/tests/sim/MizuSimulator3D.perf.test.ts` / `tests/sim/droplets/DropletStore.perf.test.ts` のコメント実測値)。決定論は seed 42 のゴールデンチェックサム(`tests/sim/MizuSimulator3D.golden.test.ts`)で守られ、ESM import 束縛経由の定数参照がカーネルを 10 倍以上遅くする(束縛剥がしで 23.5ms → 1ms 台)ことも実証済み(`src/sim/droplets/DropletStore.ts` 冒頭コメント)。本設計の粒子数はその 1/40〜1/1000 なので、性能は最初から問題にならない — 本書の主戦場は **§5 ペーシングの運動論**である。

## 0. 目的と非目標

**目的。** 「半透明の球体が空中に浮かび、中で H / O の文字が漂い、H+H→H2、H2+O→雫、雫が球底に溜まり、約 6 割で球が海へ落ち、着水して弾け、新しい球が生まれる」— この永遠のサイクルを、**決定論的・固定 60Hz・ヘッドレス実行可能**な純ロジック層(`src/sim/`)として設計する。sim は three.js / DOM を一切知らず、`src/contract/` の typed array view(prev/curr 2 世代)だけを出力する。

- スクリーンセーバー的環境映像: **リズムが製品**。1 球の満水 90〜150 秒、シーン全体で 15〜25 秒ごとにどこかの球が落ちる(§5 で逆算)
- 決定論: `?seed=` 固定でゴールデンテスト可能(§7)
- GitHub Pages + モバイル対応(スロット数 7/5、ペーシング補正 §5.6)

**非目標。**

- **海面上昇の永続化**: 下界の海は無限シンク。着水は `SplashEventView`(1 フレームイベント)を出すだけで、海の水位・蓄積状態は sim に存在しない
- ユーザー操作による注入・カメラ連動・音: なし(sim は入力 API を持たない)
- 球体同士の相互作用(衝突・合体): なし。スロット配置で幾何的に重なりを避ける(§2.3)
- 厳密な流体力学・熱力学: 非目標。水位・浮遊・落下はすべて演出物理。ただし**粒子の個数収支(質量台帳)は厳密に保存**し、テスト対象とする(§7.3)
- 体積の物理的整合: `VOLUME_GAIN`(§4.4)は演出係数であり、雫の見かけ体積と水位上昇は意図的に不一致
- render 側の実装(別設計書)。ただし §1 の契約と §11 の裁定希望が render との合意面

## 1. 契約層の最終形(src/contract/)

裁定 1・6・10 に従う。`contract/` は依存ゼロの最下層で、`WorldSpec.ts`(座標規約・共有定数)と `RenderView.ts`(view 型と SimLike)から成る。

**採用した知見**: 契約の置き場所・所有権/コヒーレンス規約・`version` による再確保通知・「インデックスに識別性を持たせない」文言は `Mizu-threejs/src/contract/RenderView.ts` / `WorldSpec.ts` の実証パターンを踏襲(ゼロコピー転送と Stub 差し替えを 1 プロジェクト完走させた形)。本作の新規点は **prev/curr 2 世代バッファ**(裁定 3。120Hz 端末で世界が 2 倍速になる *threejs* の既知問題 — `Mizu-threejs/.claude/plans/design-sim.md` §5 が「120Hz では壁時計比 2 倍速」と明記した設計負債 — への対策)。

### 1.1 WorldSpec.ts(全文)

```ts
/**
 * 世界座標の規約と共有定数(sim ↔ render の凍結契約)。
 * - y-up 右手系。海面 = world y = 0(SEA_LEVEL)
 * - 単位はメートル風の抽象単位(u)。球半径 R ∈ [1.1, 1.7]
 * - 球はワールド内を「平行移動のみ」する(回転なし — 裁定 5)。
 *   球ローカル → ワールドは anchor 加算のみ: world = anchor + local
 * - 球ローカル座標は球中心原点。球内水面は local y = waterLevelYLocal の水平面
 * このファイルは何も import しない。実装フェーズ 0 完了後は凍結。
 */
export const SEA_LEVEL = 0;

/** 固定タイムステップ(裁定 3)。sim の唯一の時計は step カウンタ。 */
export const STEP_HZ = 60;
export const DT = 1 / STEP_HZ;                // 1 step = 1/60 s
export const MAX_STEPS_PER_FRAME = 3;         // rAF アキュムレータの上限。超過分は捨てる

/** 原子種 → kindIndex(AtomView.colorKind 第 4 成分・グリフアトラスの並び)。 */
export const KIND_INDEX = { H: 0, O: 1, H2: 2 } as const;
export type AtomKind = keyof typeof KIND_INDEX;

/** 球スロット数(裁定 2)。モバイル判定は app 層(CSS width < 768)。 */
export const SLOT_COUNT_DESKTOP = 7;
export const SLOT_COUNT_MOBILE = 5;

/** 球体 FSM の状態インデックス(statePacked の整数部 — §1.3)。 */
export const BUBBLE_STATE = {
  Spawning: 0, Drifting: 1, Straining: 2, Falling: 3, Splashing: 4, Dead: 5,
} as const;
export type BubbleStateName = keyof typeof BUBBLE_STATE;

/** view 固定容量(§8 ワースト見積 × 2 の切り上げ。成長しない設計 — §1.4)。 */
export const ATOM_VIEW_CAPACITY = 256;     // ワースト ≈ 7 球 × 26 体 = 182
export const DROPLET_VIEW_CAPACITY = 512;  // ワースト ≈ 7 球 × 64(球内キャップ)= 448
export const SPLASH_VIEW_CAPACITY = 8;     // 同一フレーム最大 = スロット数 7
export const RIPPLE_VIEW_CAPACITY = 64;    // 雫着水+溶解イベント(実勢 ≤ 5/frame)
```

### 1.2 RenderView.ts(全文)

叩き台(裁定 10)のフィールド名を維持。追加はコメントと `SimCounts` の具体化のみ(変更提案は裁定希望 #2, #4, #10)。

```ts
/**
 * sim → render のデータ契約。
 * 所有権と有効期間(threejs 実証の規約を踏襲):
 * - 配列は sim が所有しインプレース変異。render は同一 ArrayBuffer をラップ(ゼロコピー)
 * - step() のリターンから次の step() 呼び出しまでコヒーレント
 * - 有効データは dense prefix [0, count*stride)。インデックスはフレーム間で不安定
 *   (swap-remove / 再パック)— render はインデックスに識別性を持たせない
 * - 再確保時は version++(固定容量設計なので実運用では発生しない想定 — §1.4)
 * - prev/curr: 同一 step の 2 世代。**同一インデックスは同一エンティティ**を指す
 *   (§1.4 パッキング規約)。render は pos = lerp(prev, curr, alpha) で補間する
 */
export interface BubbleView {
  /** stride 8: [ax, ay, az, R, waterLevelYLocal, fill01, wobble, statePacked] */
  readonly data: Float32Array;
  /** 同 stride の前 step 値。statePacked は lerp 禁止(curr を読む — §1.3) */
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

/** 海(y=0)への球の着水イベント。フレーム内 append、フレームをまたがない。 */
export interface SplashEventView {
  /** stride 4: [x, z, radius, strength]。radius = 球半径 R、strength = min(1, vImpact/4) */
  readonly data: Float32Array;
  readonly count: number;
}

/** 球内水面へのイベント(FX 用)。雫着水 strength=0.6..1.0、原子溶解 strength=0.3。 */
export interface InnerRippleView {
  /** stride 4: [bubbleIndex, localX, localZ, strength](localX/Z は球ローカル) */
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

/** 診断カウンタ(オーバーレイ / ヘッドレス校正用。表示契約は本作で新規定義)。 */
export interface SimCounts {
  readonly h: number;             // 生存 H
  readonly o: number;             // 生存 O
  readonly h2: number;            // 生存 H2
  readonly droplets: number;      // 生存雫(全球合計)
  readonly bubblesActive: number; // Dead 以外のスロット数
  readonly splashesTotal: number; // 累計着水(球)
  readonly dropletsAbsorbedTotal: number; // 累計 雫吸収
  readonly dissolvedTotal: number;        // 累計 原子/H2 溶解
  readonly meanFill01: number;    // アクティブ球の平均 fill01(校正スクリプト用)
}

export interface SimInitOptions {
  readonly seed: number;      // 単一 RNG ストリームのシード(裁定 4)
  readonly slotCount: number; // SLOT_COUNT_DESKTOP | SLOT_COUNT_MOBILE
  readonly pacing?: 'desktop' | 'mobile'; // §5.6(省略時 slotCount から導出)
}

export interface SimLike {
  init(options: SimInitOptions): void;
  step(): void;               // 1 step = DT 秒。dt 引数なし・描画なし・DOM なし
  view(): SkyRenderView;      // 安定オブジェクト(毎フレーム同一参照、フィールド更新のみ)
  counts(): SimCounts;
}

/** render 側差し替え点(render 設計書と共有。alpha は補間係数 ∈ [0,1])。 */
export interface SkyRenderer {
  render(view: SkyRenderView, alpha: number): void;
  resize(): void;
  dispose(): void;
}
```

### 1.3 statePacked のエンコード方式(提案)

f32 1 レーンに FSM 状態と正規化経過を詰める:

```
statePacked = stateIndex + min(progress01, 0.999)
  復号: stateIndex = floor(statePacked)、progress01 = fract(statePacked)
```

- stateIndex ∈ [0, 5](BUBBLE_STATE)。f32 の仮数 23bit に対し値域 < 6 なので progress の分解能は ≈ 2^-20 — 十分
- **progress01 の意味(状態ごと)**: Spawning/Straining/Splashing = 経過時間/持続時間、Drifting = fill01 / F_FULL(render が落下前の「張り」を先取りできる)、Falling = 落下距離正規化 (y0 − ay)/(y0 − R)、Dead = 再生成待ち進捗
- **lerp 禁止**: 状態境界で整数部が跳ぶため、render は curr の statePacked のみ読む(遷移フレームの視覚連続性は progress01 と wobble/fill01 の連続性で担保 — 遷移時にこれらが跳ばないよう FSM が保証する §2.2)

### 1.4 パッキング規約(集約パッカーの契約)

裁定 6: sim は全球を**ワールド座標に集約済み**の typed array で出す。render はループなしの instanced 描画。

1. **順序**: スロット index 昇順 → 球内エンティティ順(原子 = 挿入順、雫 = ストア順)。同一 step の `posr` と `prevPosr` は**同一順序・同一 count** で書かれる(prev/curr の同一インデックス = 同一エンティティ)
2. **prev の定義**: 各エンティティが自身の直前 step 位置を保持し(§3.6/§4.1)、パッカーは `prev = prevLocal + prevAnchor`、`curr = local + anchor` を書く。**スポーンしたフレームは prev = curr**(生成時の飛び込みグリッチなし)。消滅したエンティティは両世代から消える(swap-remove 後の順序で再パック)
3. **容量固定**: §1.1 の *_CAPACITY は §8 ワーストの 2 倍前後で固定確保。溢れたら新規を捨てて `droppedDroplets` 系カウンタで数える(*threejs* の「ハードキャップ + ドロップカウンタで優雅に劣化」知見: `Mizu-threejs/src/sim/droplets/DropletStore.ts`)。よって `version` は実運用で 0 のまま — 契約としては将来の成長に備え残す
4. **BubbleView は常に全スロット**(count = SLOT_COUNT、Dead は statePacked=5.x)。原子/雫/イベントはアクティブ球の分だけの dense prefix
5. **座標系**: BubbleView の ax,ay,az と waterLevelYLocal だけが「アンカー + ローカル」の分離を保持(render が球シェル・球内水面を球ローカルで描くため)。原子・雫はワールド集約済み。InnerRipple は球ローカル(球内水面テクスチャへのスプラット用)

## 2. 球体 FSM とライフサイクル

### 2.1 状態遷移図(裁定 9)

```
            2.0s            fill01 ≥ F_FULL(0.6)      1.5s
 Spawning ───────▶ Drifting ────────────────▶ Straining ───────▶ Falling
    ▲                                                               │ anchor.y ≤ R
    │ 4〜10s(一様乱数、スロット毎に独立)                          ▼
   Dead ◀──────────────── 0.8s ─────────────────────────────── Splashing
 (スロット再利用: R / アンカージッター / bob 位相を再ロール)      (SplashEvent 発火・中身クリア)
```

### 2.2 各状態のパラメータと挙動

| 状態 | 持続 | 化学 | スポナー | anchor | 遷移時の連続性 |
|---|---|---|---|---|---|
| Spawning | 2.0 s(120 step) | 動く(生成済みの分) | **バースト**: 6 step 毎に 1 体、目標数まで(120/6=20 回 ≥ H12+O8) | リング定位置 + bob | fill01=初期値、wobble=0 |
| Drifting | 可変(≈115〜125 s、§5) | 全開 | 定常: SPAWN_INTERVAL_STEPS 毎に不足種を 1 体 | bob + fill 荷重サグ(−fill01·SAG_MAX) | — |
| Straining | 1.5 s(90 step) | 動く(反応も継続 — 満杯の際の駆け込み反応が視覚的クライマックス §5.5) | **停止** | bob 継続 | wobble を 0→1 へ線形ランプ(裁定 9「wobble 増幅」) |
| Falling | ≈1.45 s(§2.4) | 動く(球ローカルの世界は落下中も生きている — 中の雫が落ち続ける画) | 停止 | y に g_eff + 抗力を積分。x/z は固定 | wobble=1 維持 |
| Splashing | 0.8 s(48 step) | **クリア**(進入フレームに原子/雫/水を全消去 = 「弾けて水になる」) | 停止 | 固定(y ≈ R) | 進入フレームに SplashEvent [ax, az, R, min(1, v/4)] を 1 件 push |
| Dead | 4〜10 s(RNG) | なし | なし | — | 満了で Spawning へ。R∈[1.1,1.7]・アンカーjitter・bob 位相・初期 fill=0 を再ロール |

- wobble は Straining のランプに加え、雫着水時に +0.15 のパルス(毎 step ×0.97 減衰、上限 1)。Drifting 中の微振動は render 側 FX に委ねる(sim はスカラーだけ渡す)
- Falling→Splashing 遷移で fill01 / waterLevelYLocal は維持(render が着水の瞬間まで水面を描ける)。Splashing 進入で count 系が 0 になるが fill01 は保持し、Dead 進入で 0 へ(視覚は splash FX が覆う)

### 2.3 スロット管理とアンカーリング(裁定 2)

- スロットは固定配列(desktop 7 / mobile 5)。スロット i の基準角 θᵢ = 2πi/slotCount。アンカー = 中心軸まわりの緩いリング:
  - `ring radius = 4.5 u`、`y ∈ [2.8, 5.2]`(一様)、角ジッター ±0.06 rad、半径ジッター ±0.25 u
  - 隣接間隔(desktop)= 2·4.5·sin(π/7) ≈ **3.91 u** > R_max 同士の 3.4 u。ジッター込みの最悪接近 ≈ 3.91 − 2(0.27+0.25) ≈ 2.87 u なので、**スポーン時に決定的分離チェック**(隣接スロットと中心距離 ≥ R_a+R_b+0.1 になるまでジッター再ロール、最大 8 回、失敗時ジッターなし基準位置)を行う。mobile は間隔 5.29 u で余裕
- bob(漂い): `ay += BOB_AMP · sin(2π·(step·DT)/BOB_PERIOD + φᵢ)` を x/y に位相違いで適用(φ はスポーン時 RNG)。BOB_AMP=0.12 u、周期 ≈ 9 s — スクリーンセーバーの「呼吸」
- **世代とシード**: スロットの再生成パラメータは単一 RNG ストリーム(裁定 4)から、FSM 更新順(スロット昇順)で消費する(§7.1 呼び順規約)

### 2.4 落下の積分(裁定 9)

線形抗力付き等加速度。`v' = v + (G_FALL − K_DRAG·v)·DT`、`ay' = ay − v·DT`(v は下向き正)。

- `G_FALL = 3.0 u/s²`、`K_DRAG = 0.4 /s` → 終端速度 7.5 u/s(未到達)。中央値アンカー y=4.0、R=1.4 の落下距離 ≈ 2.6 u → **t ≈ 1.45 s、着水速度 v ≈ 3.2 u/s**(解析: x(t) = (g/k)t − (g/k²)(1−e^(−kt)))
- 着水判定: `anchor.y ≤ R`(球の下端が海面に接触)。判定は step 末尾、遷移即 SplashEvent
- 演出根拠: 実重力 9.8 だと 0.8 s で落ちて速すぎる(視線が追えない)。3.0 u/s² は「大きな雫がぽとりと落ちる」1.5 秒 — Mizu の雫の落下感(ゆっくり)と海のスケール感の折衷

### 2.5 起動スタッガー(リズムの初期条件)

§5 で示すとおり**満水周期は R に依存しない**(スケール不変)ため、放置すると全球が同位相で落ちる。明示的に位相を散らす:

- 起動時: スロット i の初期 fill01 = `INITIAL_FILL_MAX · (slotCount−1−i)/(slotCount−1) + jitter(±0.03)`、INITIAL_FILL_MAX = 0.55。→ 最初の落下は起動 ≈10〜15 s 後、以降 ≈16 s 間隔で順に落ちる(§5.4)
- 定常時: Dead の 4〜10 s 一様遅延が毎周期 ±3 s の位相拡散を与え、周期の縮退を防ぐ(裁定 9 のスタッガー)

## 3. 球内化学世界

各アクティブ球は独立した小宇宙 `BubbleWorld` を持つ(球間相互作用なし)。座標は球ローカル(中心原点)。**粒子が住めるのは内殻球** `R_inner = SHELL_RATIO · R = 0.94R`(半透明シェルの見かけ厚 6% の内側)。

### 3.1 粒子モデル(半径・色・速度は球半径比 — 裁定「speed は球半径比」)

| 種 | 半径(× R) | R=1.4 での実寸 | 根拠 |
|---|---|---|---|
| H | `0.060·R` | 0.084 u | *2D* 実測比 H:O:H2 = 9:11:13.5(`Mizu-ts/src/particles/ParticleFactory.ts` の measureText 実測に由来、`Mizu-threejs/src/sim/config.ts` ATOM_RADIUS で定数化)をそのまま比率移植 |
| O | `0.073·R` | 0.102 u | 同上(11/9 × 0.06) |
| H2 | `0.090·R` | 0.126 u | 同上(13.5/9 × 0.06) |

- 絶対値 0.06 の選定: 原子直径 ≈ R の 12% — 球内に 20〜26 体が「漂って見えるが混雑しない」密度(数密度は §5.1 の衝突頻度から逆算)
- 色: 生成時に RNG 1 回の packed 0xRRGGBB(Mizu シリーズの伝統。知見: `Mizu-threejs/src/sim/particles/ParticleFactory.ts` randomColor)
- 運動: **有界ランダムウォーク**。加速度・速度上限は *2D* の比率(accel/maxSpeed = 0.075/1.05 = 1/14)を継承し、絶対値は R 比で決める:
  - `v_max = ATOM_MAX_SPEED_RATIO · R / s = 0.55·R u/s`(per-step では ·DT)
  - `accel_per_step = v_max / 14`(2D 比率継承 — ウォークの「性格」を保つ)
  - 方向は一様 3D(RNG 2 回: cosPolar, azimuth の順 — 知見: `Mizu-threejs/src/sim/behaviors/RandomWalk3D.ts` の呼び順固定)
- 粒子表現: kind 別クラスは作らず**単一 `Atom` クラス**(kind / pos / prevPos / vel / r / color / dead)。*2D* の kind 別クラスは拡張教材としての価値だったが、本作は挙動差が半径のみで、ReactionRegistry が kind 文字列で引くため単一クラスで足りる(構成は薄く保つ — 知見: thin composition は `Mizu-threejs/src/sim/particles/H.ts` ほか)

### 3.2 球面境界での反射(数式)

粒子(半径 r)の中心が有効半径 `R_eff = R_inner − r` を超えたら、**半径方向ミラー + 法線反射**:

```
d = |p|                          // p は球ローカル位置、d = √(px²+py²+pz²)
if d > R_eff:
    n̂ = p / d                    // 外向き法線
    p ← n̂ · (2·R_eff − d)        // 半径方向のミラー(面を挟んで対称な位置へ)
    v ← v − 2·(v·n̂)·n̂           // 法線成分の反転(接線成分は保存)
```

- 1 step の移動量 v_max·DT = 0.55·1.4/60 ≈ **0.013 u ≪ R_eff ≈ 1.2 u** なので、オーバーシュートは微小で「平面ミラー近似」の誤差(接線方向のずれ)は O((overshoot/R_eff)²) — 無視できる。`2·R_eff − d < 0` になる速度は構造的に出ない(不変条件としてテスト §7.3)
- mirror-and-negate(clamp ではない)を明示するのは *threejs* の境界テストの鋭さを保つため(知見: `Mizu-threejs/src/sim/behaviors/RandomWalk3D.ts` — 「clamp でなく mirror」を 6 面で規定しテストで固定した)
- 適用順序(決定的): ①ウォーク積分 → ②球面反射 → ③水面処理(§3.3)。②③は毎 step 高々 1 回ずつで十分(移動量が小さいため)

### 3.3 球内水面との相互作用(溶解 — 裁定 8)

水面 `y_w = waterLevelYLocal`(§4)。「水中に入った H/O/H2 は消滅する」を守りつつ、§5.2 で示すとおり**素朴な吸収面はペーシングを壊す**(衝突面フラックス ≈ 2.8 体/s が供給 1.5 体/s を食い尽くす)。そこで**漏れあり反射(確率透過)**を採用する:

```
if p.y − r < y_w:                       // 下面(粒子の下端が水に触れた)
    if rng() < P_DISSOLVE:              // P_DISSOLVE = 0.05
        dissolve(atom)                  // 消滅 + 水体積 += VOLUME_GAIN·(4/3)πr³
                                        // + InnerRipple[bubble, x, z, 0.3]
    else:
        p.y ← 2·(y_w + r) − p.y         // 水面での mirror-and-negate
        v.y ← −v.y                      //(y のみ。x/z は保存)
```

- 「重なれば必ず〜、確率なし」の Mizu ルールは**化学反応**の規約であり境界には適用しない、という解釈(裁定希望 #5 で確認を求める)。視覚的には「原子が水面でぽよんと跳ね、ときどき溶けて消える」— 『すべてはやがて水になる』の物質収支(裁定 7)にも寄与する
- RNG は透過判定時のみ 1 回(交差はまれ: ≈0.35 回/s/球)。呼び順は粒子更新順に埋め込まれ決定的(§7.1)
- 溶解は即時 swap-remove。沈んでいく演出は render が InnerRipple + フェードで行う

### 3.4 空間グリッド衝突(球に外接する AABB グリッド)

**外接 AABB グリッドで良い理由**: 球状の領域に球状の分割は不要 — ローカル AABB `[−R_inner, R_inner]³` を一様グリッドで切ると、球外のセルは**単に空のまま**(体積比 1 − π/6 ≈ 48% が無駄セル)だが、セルは Int32 のカウントに過ぎず、counting sort 実装(知見: `Mizu-threejs/src/sim/physics/SpatialGrid3D.ts` — バケツ配列を持たず prefix sum + entries に詰める、定常アロケーションゼロ、安定ソートで列挙順保存)ではセル 1 個 = 8 bytes。範囲外はクランプ(同知見)なので境界処理も不要。球面分割の座標変換コストの方が高くつく。

**セルサイズの根拠**(2 つの制約の交点):

1. 正しさ: `cell ≥ MAX_COLLISION_DISTANCE = 2·r_H2 = 0.18R` — 衝突しうる 2 粒子が必ず 3×3×3 近傍に収まる不変条件(知見: `Mizu-threejs/src/sim/config.ts` の MAX_COLLISION_DISTANCE 導出コメント)
2. 経済性: counting sort の rebuild コストは cellCount に比例する。N ≈ 26 に対し cellCount は O(N) に保ちたい → 軸あたり 4 セル(64 セル、≈0.4 体/セル)

→ **`cell = R_inner / 2 = 0.47R`**(4×4×4 = 64 セル)。0.47R ≥ 0.18R で制約 1 を満たし、候補数 ≈ 26 × (27/64 · 26) ≈ 26 × 11 → **≈143 回/球/step の二乗距離チェック**(総当たり 325 回の半分以下、rebuild 込みでも総当たりと同オーダー)。

正直な注記: N ≤ 32 では BruteForce も余裕で予算内(§8)。それでもグリッドを既定にするのは、(a) *threejs* で実証済みの「grid vs 総当たりオラクルのプロパティテスト」(`Mizu-threejs/tests/sim/physics/CollisionDetectorProperty.test.ts`)という品質アンカーをそのまま使えること、(b) 将来原子目標数を上げる拡張余地のため。`CollisionDetector` interface(知見: `Mizu-ts/src/physics/CollisionDetector.ts`)で DI し、BruteForce はテストオラクルとして常備する。*threejs* の半近傍レンジ融合最適化(`GridCollisionDetector3D.ts`)は **不採用**(N=26 では複雑さに見合わない)— 素朴な 27 セル走査 + 正準インデックス重複排除 + 二乗距離比較(知見: `Mizu-ts/src/physics/GridCollisionDetector.ts`)で書く。グリッドインスタンスは 1 個を全球で使い回す(球ごとに rebuild → detect)。

### 3.5 反応レジストリとルール(裁定 7: 再湧きなし)

`ReactionRegistry`(両順キー Map + live な `reactiveKinds()` — 知見: `Mizu-ts/src/reactions/ReactionRegistry.ts`、*threejs* も verbatim 移植で完走)と宣言的 `ReactionResult`(知見: `Mizu-ts/src/reactions/ReactionRule.ts` + 雫ルーティングの `droplets?: DropletSpawn[]` 拡張: `Mizu-threejs/src/sim/reactions/ReactionRule.ts`)を採用。**個数収支はルールが全権を持つ**。

```ts
// H + H → H2(再湧きなし)。収支: H −2, H2 +1
HHFusion.react(a, b) = {
  consumed: [a, b],
  produced: [factory.createH2(midpoint(a, b))],   // 中点生成(RNG は色の 1 回のみ)
}
// O + H2 → 雫(再湧きなし)。収支: O −1, H2 −1, droplet +1
OxidationToDroplet.react(a, b) = {
  consumed: [o, h2],                               // kind 判別で順序非依存(2D 知見)
  produced: [],
  droplets: [factory.createDropletSpawn(o.pos)],   // O の座標に雫(2D の伝統)
}
```

- *2D*/*threejs* は消費した H / O をランダム位置に再湧きさせた(人口平衡装置)が、本作は裁定 7 により**凝結スポナーが唯一の供給源**。ルールは純粋な消滅・生成のみになり、質量台帳(§7.3)が単純化する
- H2 の中点生成は本作の新規選択(原典は片親位置 + もう片方を再湧き)。再湧きがない世界では中点が最も自然で、RNG 消費も減る(裁定希望 #6)
- 同一フレーム多重反応の死亡ペアガード(`if (a.isDead() || b.isDead()) continue`)は verbatim 知見(`Mizu-threejs/src/sim/MizuSimulator3D.ts` 段 4)

### 3.6 凝結スポナー(唯一の供給源 — 裁定 7)

「水面より上の空域に、H / O を目標個数まで少しずつ補充」。パラメータの数値根拠は §5.3 で逆算する。

- **目標個数**: `H_TARGET = 12`、`O_TARGET = 8`(±0 — 目標は固定値、実勢が反応・溶解で下振れする)
- **レート**: `SPAWN_INTERVAL_STEPS = 40`(0.667 s)ごとに 1 体だけ試行(desktop。mobile は 30 — §5.6)。種の選択は**相対不足の大きい方**(`(H_TARGET − h)/H_TARGET` vs `(O_TARGET − o)/O_TARGET`、同率は H 優先)— 化学量論 2:1 の消費に自動追従する決定的ルール。不足ゼロなら何もしない(RNG 消費なし)
- **位置分布**: 水面より上の空域に一様。**有界棄却サンプリング**: 空域の AABB(x,z ∈ [−L, L]、y ∈ [y_w + m, R_eff − m]、L = R_eff、m = 2r)に一様 3 点(RNG 3 回/試行)→ 球内かつ水面上 + 既存粒子と非重畳なら採用。最大 16 試行、全滅なら天頂寄り既定点(採用率 ≈ 1/1.9 なので 16 回で失敗する確率は無視できる)。試行数可変でも単一ストリームの決定論は保たれる(§7.1)
- **スポーンクロックの位相**: スロット i はグローバル step + i·7 のオフセットで試行(7 球の同時ポップを防ぐ、決定的)
- Straining 以降は停止(§2.2)。Spawning はバーストモード(6 step 間隔)
- 新粒子は生成フレームには動かない(パイプライン順序 §3.7 — *2D* パリティの知見)

### 3.7 BubbleWorld.step() の段順(1 球分)

*2D* の「update → 衝突 → 反応 → sweep」パイプライン(知見: `Mizu-ts/src/simulator/MizuSimulator.ts`、6 段化: `Mizu-threejs/src/sim/MizuSimulator3D.ts`)を球単位に適用:

```
0. prev 記録   — 原子 prevPos ← pos(雫は §4.1 のカーネル内で同時に行う)
1. 原子更新    — ウォーク積分 → 球面反射 → 水面反射/溶解(挿入順)
2. 雫カーネル  — 落下 + sway + 球内クランプ + 吸収(§4.1)
3. 衝突検出    — grid.rebuild → findHitPairs(reactiveKinds フィルタ)
4. 反応適用    — 死亡ペアガード → consumed/produced/droplets ルーティング
5. sweep       — dead 原子を安定 filter(〜26 体、自明)
6. 水位更新    — 今 step の吸収体積を加算 → fill01 / waterLevelYLocal 再計算(§4.2)
7. スポナー    — クロック該当 step のみ試行
```

FSM(§2)はこの外側で球単位に走り、集約パッカー(§9 の AggregatePacker)が全球を 1 本の view に詰める。

## 4. 雫と水位

### 4.1 雫 SoA(DropletColumn — 球ごとの小さな列)

雫はオブジェクトにしない(知見: 「H2O は決して Particle にならない」— `Mizu-threejs/.claude/plans/design-sim.md` §0 の 2 階層設計。人口が 3 桁小さくても、swap-remove SoA は最も単純で速い形)。球ごとに固定容量 64 の列を持つ:

```ts
class DropletColumn {           // 球ローカル座標
  posr:     Float32Array;       // 64*4 [x,y,z,r]   毎 step 変異
  prevPosr: Float32Array;       // 64*4              カーネル冒頭で posr をコピー
  aux:      Float32Array;       // 64*4 [phase, swayAmp, spawnStep, seed] スポーン時のみ
  count = 0;
  spawn(x,y,z,r,phase,swayAmp,seed,nowStep): void;   // 満杯なら drop + カウント
  step(waterY: number, absorbed: AbsorbSink, ripples: RippleSink): void;
}
```

**step カーネル**(RNG フリー — 知見: `Mizu-threejs/src/sim/droplets/DropletStore.ts` の「位相はスポーン時に確定、カーネルは乱数ゼロ」。決定論と速度の両方に効く):

```
for i in [0, count):                        // 1. prev コピー(prevPosr ← posr、4 レーン)
    vFall = DROPLET_FALL_SPEED_PER_R · r · DT        // 導出、保存しない(threejs 知見)
    y ← y − vFall
    s = (y + phase) · SWAY_FREQ
    x ← x + cos(s) · swayAmp · DT                    // cos-sway(裁定 8)
    z ← z + cos(s·0.9 + π/2) · swayAmp·0.7 · DT      // デチューン Lissajous(threejs 知見)
    L² = max(0, R_eff² − y²)                         // 2. 球内クランプ(本作新規):
    if x²+z² > L²: (x,z) を半径 L に射影             //    sway が球殻を突き抜けない
    if y ≤ waterY + r:                               // 3. 吸収(裁定 8)
        absorbed += VOLUME_GAIN · (4/3)π r³
        ripples.push(bubbleIdx, x, z, 0.6 + 0.4·(r/r_max))
        swapRemove(i)                                // prev/posr/aux の 3 本とも移す。i 再処理
```

- cos は素の `Math.cos` でよい(≤448 雫 × 2 回 ≪ *threejs* が LUT を要した 30 万 × 2 回。LUT 知見 `Mizu-threejs/src/sim/core/CosTable.ts` は「不要になる規模」の判断基準ごと引き継ぐ — 過剰最適化をしない)
- swap-remove + インデックス i 再処理は verbatim 知見(同 DropletStore)。prev/curr 対応は「3 本とも同時に swap」で保たれる(§1.4 規約 2)
- sway パラメータ: `SWAY_FREQ = 12 /u`(落下行程 ≈1.2 u に 2〜3 周期 — *2D* の「/100 px」を落下行程比で換算)、`swayAmp ∈ [0.25, 0.45]·r /s`(横揺れ幅が半径の数十% — 雫らしい「ふるふる」)。phase ∈ [0, 2π)
- 落下: `DROPLET_FALL_SPEED_PER_R = 4.0 /s`(v = 4r/s。r̄=0.112 → 0.45 u/s、平均落下行程 ≈1.2 u を **≈2.7 s**)。一定終端速度・半径比例は *2D* の `size·0.1` の風味を継ぐ(知見: `Mizu-ts/src/core/behaviors/FallAndSway.ts` → `Mizu-threejs` FALL_SPEED_PER_RADIUS)

### 4.2 球冠体積 ↔ 水位の変換(LUT + 線形補間)

水は内殻球(半径 R̂ = R_inner)の底に溜まる球冠。水深 h ∈ [0, 2R̂]、正規化 u = h/(2R̂) とすると、球冠体積公式 V_cap(h) = (π/3)h²(3R̂ − h) から:

```
fill01 ≡ V_water / V_inner = u²(3 − 2u) = 3u² − 2u³      … smoothstep そのもの
waterLevelYLocal = (2u − 1)·R̂
```

順方向(u→f)は自明だが、sim が毎 step 必要なのは**逆方向(f→u)で、3 次方程式**。逆関数には三角閉形式 `u = 1/2 − sin(asin(1 − 2f)/3)` が存在する(検算: f=0 → u=0、f=1/2 → u=1/2、f=1 → u=1)。これを **LUT の生成器 + テストオラクル**に使い、実行時は指示どおり LUT + 線形補間で引く(分岐なし・trig なしで sim step を数値的に平坦に保つ。asin の端点精度クリフも回避):

- **LUT 設計**: `CAP_LUT[i] = u_exact(i / 256)`、i ∈ [0, 256](257 エントリ、1KB)。参照は `u = lerp(CAP_LUT[⌊256f⌋], CAP_LUT[⌈256f⌉], fract)`
- **端点の特異性**: du/df = 1/(6u(1−u)) は f→0, 1 で発散(√ 特異性: f≈3u² より u ≈ √(f/3))。一様 LUT の弦誤差は端の 1 ビンに集中するため、**f < 1/64 は漸近式 `u = √(f/3)`、f > 63/64 は対称式 `u = 1 − √((1−f)/3)`** で直接計算(ハイブリッド)
- **誤差見積もり**: 漸近式の誤差は境界 f = 1/64 で |u_exact − √(f/3)| ≈ 1.7×10⁻³(u 正規化)→ 水位誤差 ≈ 0.0017 × 2R̂ ≈ **0.0045 u @R=1.4**(雫半径 0.11 u の 4%、画面上サブピクセル)。中央域の弦誤差は (Δf)²·|u″|/8 ≤ 10⁻⁵ オーダー(u″ は u=1/2 で 0)。プロパティテストで**全域 |u_lut − u_exact| ≤ 5×10⁻⁴ + 端点帯 2×10⁻³** を assert(§7.3)
- 呼び出し頻度: 球ごと・水体積が変わった step のみ(≤ 7 回/step)。コストは実質ゼロだが、LUT 化により決定論・移植性(将来 GPU 側で同じ LUT を使える)も揃う

**fill01 の分母は V_inner(内殻)**と定義する。「約 6 割」はユーザーが見る空洞に対する水の割合が最も直感に合うため(外殻基準だと同じ水量で 0.5 と表示され「6 割」の絵と乖離)。契約コメントに明記(裁定希望 #1)。

### 4.3 水体積の台帳(WaterBody)

```
V_water += VOLUME_GAIN · (4/3)π r³   // 雫吸収(§4.1)・原子/H2 溶解(§3.3)で加算
fill01 = min(V_water / V_inner, 1)
waterLevelYLocal = (2·capLut(fill01) − 1)·R_inner
```

- 加算は step 段 6 でまとめて適用(段 2 と段 1 の吸収を合算)— 水位が step 内で動かないことで、同 step 内の吸収判定が全粒子に対して一貫する
- fill01 は Drifting/Straining で単調非減少(不変条件 — §7.3)

### 4.4 VOLUME_GAIN の導出(演出係数)

幾何的に正直な雫体積では満水まで ≈1,000 雫 = 8 雫/s の嵐になり(§5.4 の逆算)、「ぽつ…ぽつ…」の情緒が死ぬ。そこで 1 雫が「見かけより多くの水を運ぶ」演出係数を置く:

```
VOLUME_GAIN = (SHARE_DROPLET · F_FULL · V_inner) / (N_DROPS_TARGET · V̄_drop)
            = (0.85 × 0.6 × 3.479·R³) / (55 × 2.145×10⁻³·R³)
            = 1.774 / 0.118 ≈ 15.0   →  VOLUME_GAIN = 15
```

- `V_inner = (4/3)π(0.94R)³ = 3.479·R³`、`V̄_drop = (4/3)π(0.08R)³ = 2.145×10⁻³·R³`(雫半径比の中央値 0.08)
- `N_DROPS_TARGET = 55`: 満水時間目標 ≈122 s × 定常雫レート ≈0.45 /s(§5.4)
- `SHARE_DROPLET = 0.85`: 水体積の 85% を雫が、残り ≈15% を原子/H2 の溶解(§3.3、§5.5 で ≈0.14 体/s × 平均体積から検算)が運ぶ
- **R が両辺で消える** — VOLUME_GAIN は球サイズに依存しない(§5.4 のスケール不変性)
- 直感チェック: 有効水半径 = 0.112 × 15^(1/3) ≈ 0.28 u。「雫 1 粒が球内水面をわずかに(半径の ≈1.5%)持ち上げる」— 60 粒で 6 割、目視で追える上昇速度

## 5. ペーシングの運動論(最重要)

設計目標(裁定・要件):

- **T_fill(1 球の満水)= 90〜150 s(狙い 120 s)**
- **シーン全体で 15〜25 s ごとにどこかの球が落ちる**
- 供給は凝結スポナーのみ(裁定 7)。物質は「原子 → H2 → 雫 → 球内の水 → 海」へ一方通行

方法論の知見: 運動論見積で定数を先に設計し、ヘッドレス校正スクリプトで実測合わせする 2 段構え(`Mizu-threejs/.claude/plans/design-sim.md` §1 の衝突率見積 + `docs/architecture.md` §5「校正の物理」— 見積が super-linear 効果で外れたら校正で吸収した実績)。

### 5.1 球内自由空域での衝突頻度

同種ペアのエンカウント率(希薄気体近似):

```
Rate_AA = ½·N(N−1)·σ·v_rel / V_air        σ = π·(2r_A)²(衝突断面積)
Rate_AB = N_A·N_B·σ_AB·v_rel / V_air      σ_AB = π·(r_A + r_B)²
```

R=1.4(中央値)、目標人口 H=12・O=8、v_max = 0.55R = 0.77 u/s、平均速度 v̄ ≈ 0.8·v_max ≈ 0.62 u/s(速度クランプ付きウォークは上限近傍に滞在)、相対速度 v_rel ≈ 1.2·v̄ ≈ 0.74 u/s(等方 Maxwell の √2 より保守的に)。空域 V_air = V_inner·(1 − fill01)、空時 V_inner = 9.55 u³。

| 反応 | σ (u²) | Rate @fill=0(目標人口時) |
|---|---|---|
| H+H → H2 | π(0.168)² = 0.0887 | ½·12·11·0.0887·0.74 / 9.55 ≈ **0.45 /s** |
| O+H2 → 雫 | π(0.228)² = 0.164 | 8·N_H2·0.164·0.74 / 9.55 ≈ 0.10·N_H2 /s |

H2 は生成(0.45/s)と消費(0.10·N_H2)が釣り合う人口に自走する: **N_H2_ss ≈ 4.5 体**、平均寿命 τ_H2 = V_air/(N_O·σ·v_rel) ≈ **9.9 s**。定常では 雫レート = H2 生成レート = HH レート。

### 5.2 素朴な吸収水面はペーシングを壊す(P_DISSOLVE の根拠)

水面を完全吸収面にすると、効損失フラックスは片面衝突率 Φ = ¼·n·v̄·A(気体分子運動論)。fill=0.3(水面円盤面積 A ≈ 5.0 u²、V_air ≈ 6.7 u³)で:

```
Φ_H ≈ ¼ · (12/6.7) · 0.62 · 5.0 ≈ 1.40 体/s、Φ_O ≈ 0.93、Φ_H2 ≈ 0.47 → 計 ≈ 2.8 体/s
```

スポナー供給上限 1.5 体/s(§5.3)を**溶解だけで倍以上超過** — 原子は反応する前に水没し、雫がほぼ生まれない。よって §3.3 の漏れあり反射を採用し、`P_DISSOLVE = 0.05` で溶解を ≈ 2.8 × 0.05 ≈ **0.14 体/s** に絞る。これは (a) ペーシングを守り、(b) 「ときどき溶けて消える」演出を残し、(c) 水体積の ≈15% を賄う(§4.4 の SHARE_DROPLET=0.85 と整合: 0.14 体/s × 122 s ≈ 17 体 × 15·V̄_atom ≈ 1.07 u³ ≈ 必要量 5.73 u³ の 19% — 演出上の許容帯)。

### 5.3 スポナーレートの逆算(律速の設計)

雫 1 粒の化学量論コスト = H 2 体 + O 1 体 = **3 体**。目標雫レート r_d ≈ 0.45 /s に溶解損失 ≈0.14 体/s を足すと、必要供給 ≈ 3·0.45·(1/0.9 補正) ≈ 1.5 体/s。

→ **`SPAWN_INTERVAL_STEPS = 40`(0.667 s / 体、= 1.5 体/s)**。雫レート上限 = 1.5/3 = **0.5 /s**。

律速構造(意図的な設計):

- **序盤(fill < 0.2)**: 運動論律速(0.40〜0.45 /s < 上限 0.5)。人口は目標近傍に張り付き、スポナーは不足分を静かに埋める
- **終盤(fill > 0.4)**: 空域が縮み運動論レートが上限を突破 → **スポナー律速(0.5 /s 頭打ち)**。原子は湧いた端から素早く反応する(§5.5 のクライマックス)

### 5.4 満水時間 T_fill と落下リズム(逆算の確定)

fill01 の増分は雫吸収(85%)+溶解(15%)。雫 1 粒 = VOLUME_GAIN·V̄_drop = 15 × 2.145×10⁻³ R³ = 0.0322 R³ = V_inner の **0.92%**。

```
N_DROPS_TARGET = SHARE_DROPLET · F_FULL / 0.0092 ≈ 55 粒   (R が消える — スケール不変)
実効雫レート r̄_d ≈ 0.45 /s(序盤 0.42、終盤 0.5 の荷重平均)
T_fill ≈ 55 / 0.45 ≈ 122 s   ✅ 目標帯 90〜150 s の中央
```

**スケール不変性**(本設計の要): σ ∝ R²、V_air ∝ R³、v ∝ R より Rate ∝ N²·R²·R/R³ = R⁰。雫体積 ∝ R³、V_inner ∝ R³ より粒数も R⁰。**すべての長さを R 比で決めたため、球の大小はペーシングに影響しない**。よって R∈[1.1,1.7] のばらつきはリズムを乱さず(見た目の多様性だけを与え)、位相分散は §2.5 のスタッガーが担う。

**1 球の全周期**:

```
Spawning 2.0 + Drifting+Straining(T_fill ≈ 122.6)+ Falling 1.45 + Splashing 0.8 + Dead 平均 7.0
= 約 134 s
```

**落下間隔(シーン)**: 134 / 7 スロット ≈ **19.1 s** ✅(目標 15〜25 s)。起動直後も §2.5 の初期 fill スタッガー(0.55 幅 / 7 球)で間隔 ≈ (0.55/0.6)·122.6/7 ≈ **16 s** から始まる。

### 5.5 水位上昇による反応加速(クライマックスの定量)

スポナーが**個数**を目標に保つため、水位が上がると数密度 n = N/V_air が 1/(1−fill01) で上がる:

| fill01 | V_air (u³) | Rate_HH(運動論) | 実効雫レート | τ_H2(H2 寿命) | N_H2 定常 |
|---|---|---|---|---|---|
| 0.0 | 9.55 | 0.45 /s | 0.42 /s(運動論律速) | 9.9 s | ≈4.5 |
| 0.3 | 6.68 | 0.65 /s | 0.50 /s(スポナー律速へ) | 6.9 s | ≈3.5 |
| 0.5 | 4.77 | 0.91 /s | 0.50 /s | 4.9 s | ≈2.5 |
| 0.6 | 3.82 | 1.13 /s | 0.50 /s | 4.0 s | ≈2.0 |

**視覚的含意**: 終盤は (a) 雫の生成間隔が 2.4 s → 2.0 s へ締まり、(b) H2 が湧いてから雫になるまでの時間が 10 s → 4 s へ半減 —「狭くなった空で原子が忙しなく出会い、次々と雫になる」加速感。総量はスポナー上限が抑えるので、**帯域(T_fill)を壊さずにテンポだけが上がる** — 演出と工学の両立がこの律速切替の狙い。加えて水面円盤面積は fill 0.5 で最大(大円)になり、溶解と着水リップルのイベント密度も終盤ほど高い。

### 5.6 モバイル(5 スロット)のペーシング補正

周期 134 s / 5 = 26.8 s は目標帯を外れる。スポナーを 0.75 倍間隔(`SPAWN_INTERVAL_STEPS = 30`、2.0 体/s、雫上限 0.67/s)にすると、序盤運動論律速(0.42/s)は不変のまま中盤以降の頭打ちが上がり、実効 r̄_d ≈ 0.50 /s → T_fill ≈ 110 s → 周期 ≈ 121 s → **間隔 ≈ 24.2 s** ✅(帯上限際 — 校正スクリプトの第一調整対象、§7.5)。粒子数・見た目の密度は不変(目標人口は同じ)。

### 5.7 逆算チェーンのまとめ(§6 の根拠テーブルの導出元)

```
リズム目標(15〜25s/落下, 7球) → 周期 ≈134s → T_fill ≈122s
T_fill と「ぽつぽつ」感(2s強/粒) → N_DROPS_TARGET ≈55 → VOLUME_GAIN = 15
雫レート 0.45/s → スポナー 1.5 体/s(40 step 間隔) → 運動論が 0.45/s を出せる条件
  → N_H=12, N_O=8, σ(半径比 0.06/0.073/0.09), v_max = 0.55R/s
溶解は供給の 1 割弱に抑える → P_DISSOLVE = 0.05(完全吸収は 2.8 体/s で破綻)
```

## 6. config.ts 全チューナブル一覧(全数値に根拠)

`src/sim/config.ts` に集約(何も import しない定数最下層 — 知見: `Mizu-threejs/src/sim/config.ts` の「根拠コメント付き定数ファイル」様式)。contract 側と重複する定数(STEP_HZ 等)は contract が正。

| 定数 | 値 | 根拠 |
|---|---|---|
| **時間** | | |
| `STEP_HZ` / `DT` | 60 / 1/60 s | 裁定 3。step カウンタが唯一の時計 |
| `MAX_STEPS_PER_FRAME` | 3 | 裁定 3。タブ復帰時のスパイラル・オブ・デス防止(超過分は世界時間ごと捨てる) |
| **スロット / アンカー(§2.3)** | | |
| `SLOT_COUNT_DESKTOP / MOBILE` | 7 / 5 | 裁定 2 |
| `RING_RADIUS` | 4.5 u | 裁定 2。隣接間隔 3.91 u > 2·R_max = 3.4 u(重なり回避の下限を満たす最小リング) |
| `RING_Y_MIN / MAX` | 2.8 / 5.2 u | 裁定 2。下限は落下演出の行程(≥1.4 u)確保、上限はカメラフレーミング協定 |
| `ANGLE_JITTER / RADIAL_JITTER` | ±0.06 rad / ±0.25 u | 最悪接近 2.87 u でも分離チェック(§2.3)8 回で解ける疎さ |
| `BOB_AMP / BOB_PERIOD_S` | 0.12 u / 9 s | 「呼吸」— 振幅は R の 1 割未満(酔わない)、周期は満水時間の 1/13(単調さ回避) |
| `SAG_MAX` | 0.35 u | 満水時に球が 0.35 u 沈む「重み」演出。リング下限 2.8 − 0.35 > R_max + 落下判定余裕 |
| **球体 / FSM(§2)** | | |
| `R_MIN / R_MAX` | 1.1 / 1.7 u | 裁定 2 |
| `SHELL_RATIO`(R_inner/R) | 0.94 | シェル見かけ厚 6%。render の屈折殻表現と要整合(裁定希望 #9) |
| `F_FULL` | 0.6 | 裁定 9(fill01 は V_inner 基準 — 裁定希望 #1) |
| `SPAWNING_DURATION_S` | 2.0 s | フェードイン+バースト補充が目標人口 20 体に届く最短(120 step / 6 step間隔 = 20 回) |
| `BURST_SPAWN_INTERVAL_STEPS` | 6 | 同上 |
| `STRAINING_DURATION_S` | 1.5 s | 裁定 9。wobble ランプが知覚できる最短(1 s 未満は「予兆」に見えない) |
| `FALL_G / FALL_DRAG_K` | 3.0 u/s² / 0.4 /s | 裁定 9 の帯(2.5〜3.5)中央。落下 1.45 s・着水 3.2 u/s(§2.4 解析) |
| `SPLASHING_DURATION_S` | 0.8 s | 海の波紋 FX の立ち上がりを覆う長さ(render 協定) |
| `RESPAWN_DELAY_MIN / MAX_S` | 4 / 10 s | 裁定 9。±3 s の位相拡散が周期縮退(§2.5)を防ぐ |
| `INITIAL_FILL_MAX` | 0.55 | 起動 10〜15 s で初落下、以降 16 s 間隔(§2.5・§5.4) |
| **原子(§3.1)** | | |
| `ATOM_RADIUS_RATIO` | H 0.060 / O 0.073 / H2 0.090 (×R) | *2D* 実測比 9:11:13.5 の移植。絶対値は §5.1 の σ から逆算 |
| `ATOM_MAX_SPEED_RATIO` | 0.55 /s (×R) | §5.1: HH レート 0.45/s を成立させる v_rel の逆算値。球横断 ≈4.5 s の「漂い」 |
| `ATOM_ACCEL_FRACTION` | 1/14 (×v_max /step) | *2D* の 0.075/1.05 比を継承(ウォークの質感保存) |
| `H_TARGET / O_TARGET` | 12 / 8 | §5.1。化学量論 2:1 + H2 滞留 ≈4.5 を見込んだ視覚密度(≈25 体/球) |
| `SPAWN_INTERVAL_STEPS` | 40(mobile 30) | §5.3/§5.6: 1.5 体/s = 雫 0.5/s の律速上限 |
| `SPAWN_MAX_TRIES` | 16 | 棄却採用率 ≈1/1.9 → 16 回全滅は確率 ≈ 3×10⁻⁵(実質ゼロ、決定論的フォールバック付き) |
| `P_DISSOLVE` | 0.05 | §5.2: 完全吸収(2.8 体/s)の 1/20 に絞り、溶解 ≈0.14 体/s = 供給の 1 割弱 |
| **雫(§4.1)** | | |
| `DROPLET_RADIUS_RATIO_MIN / MAX` | 0.065 / 0.095 (×R) | 原子(0.06〜0.09)と同格の見かけ。*2D* の「雫は原子よりやや大きい」比を踏襲 |
| `DROPLET_FALL_SPEED_PER_R` | 4.0 /s | 落下行程 ≈1.2 u を 2.7 s — 雫 1 粒の旅が目で追える(2 s 台)長さ |
| `SWAY_FREQ` | 12 /u | 落下行程に 2〜3 揺れ(*2D* の /100px を行程比換算) |
| `SWAY_AMP_RATIO_MIN / MAX` | 0.25 / 0.45 (×r /s) | 横速度が落下速度(4r/s)の 1 割未満 — 揺れても軌道は落下が主 |
| `DROPLET_CAP_PER_BUBBLE` | 64 | ワースト同時滞留 ≈ 0.5/s × 2.7 s ≈ 1.4 粒の 45 倍(splash 直前の駆け込みも安全) |
| **水(§4)** | | |
| `VOLUME_GAIN` | 15 | §4.4 導出(N_DROPS 55・share 0.85)。R 不変 |
| `CAP_LUT_SIZE` | 256(+両端漸近式) | §4.2: 誤差 ≤ 5×10⁻⁴(中央)/ 2×10⁻³(端)、1KB |
| `CAP_LUT_ENDPOINT_F` | 1/64 | 漸近式との接続点(誤差最小の交点) |
| **view 容量(§1.1)** | 256/512/8/64 | §8 ワースト(182/448/7/≈20)の切り上げ |

## 7. 決定論とテスト計画

### 7.1 決定論の構え(裁定 4)

- **単一 RNG ストリーム**: mulberry32(アルゴリズム知見: `Mizu-threejs/src/sim/core/Random.ts` — 同アルゴリズムを新規実装)。`?seed=` を app 層がパースし `SimInitOptions.seed` で注入。seed 省略時も「実行ごとにランダムな seed を 1 個引いて注入」— コア内に `Math.random()` は存在しない
- **RNG 呼び順規約(唯一の文書化箇所は AtomFactory の doc コメント — 知見: `Mizu-threejs/src/sim/particles/ParticleFactory.ts` の規約一元化)**:
  1. init: スロット昇順に [R, 角ジッター, 半径ジッター, y, bob 位相 ×2, 初期 fill ジッター](分離チェック再ロールは決定的に追加消費)
  2. 毎 step スロット昇順に: FSM(Dead 満了時の再ロール一式)→ 原子更新(1 体あたりウォーク 2 回 cosPolar, azimuth; 水面交差時のみ +1 回)→ 雫カーネル(**0 回** — RNG フリー)→ 反応(HHFusion: 色 1 回 / OxidationToDroplet: r, phase, swayAmp, seed の 4 回)→ スポナー(試行ごと位置 3 回、採用時 色 1 回)
- **時計は step カウンタのみ**。壁時計・`performance.now()` はコア禁止(tsconfig と depcruise で 2 重強制 — §9)
- 固定タイムステップ + アキュムレータは **app 層の純関数**(`accumulate(prevRemainder, frameDt) → {steps, alpha}`)にして node でテスト。sim は「step() を呼ばれた回数」しか知らない

### 7.2 テスト基盤

vitest / `environment: 'node'` を既定(sim はヘッドレスが正常状態 — 知見: *threejs* の tsconfig.sim.json + node 既定環境の 2 重防御)。目標 ≈120 テスト。

### 7.3 テストマトリクス

| 種別 | 内容 |
|---|---|
| ゴールデン(決定論) | seed=7・slotCount=7・1800 step(30 s)後の (a) 全 view バッファ総和チェックサム(bubbles.data + atoms.posr + droplets.posr)、(b) SimCounts 全フィールド、(c) 累計 splash/リップル数を記録値で assert。**2 回実行同一**テスト付き。壊れたら RNG 呼び順違反を疑う(知見: `Mizu-threejs/tests/sim/MizuSimulator3D.golden.test.ts` の「トリップワイヤ + 空虚テスト防止 expect(>0)」様式) |
| プロパティ: 球面境界 | seed 1〜7 × 600 step、全原子・全雫で `|p_local| ≤ R_inner − r + 1e-6` を毎 step assert(§3.2 の不変条件) |
| プロパティ: 質量収支 | 台帳保存則を毎 step assert: `spawnedH ≡ N_H + 2·N_H2 + 2·(N_droplet + absorbedDroplets) + dissolvedH + 2·dissolvedH2`、`spawnedO ≡ N_O + N_droplet + absorbedDroplets + dissolvedO`(要件の式を溶解チャネル込みに拡張) |
| プロパティ: 水位単調 | Drifting/Straining 中 fill01・waterLevelYLocal が単調非減少。`fill01 ≤ 1` |
| LUT 誤差 | f を 10⁻⁴ 刻みで掃引し `|capLut(f) − u_exact(f)|` を §4.2 の帯で assert(オラクル = 三角閉形式)。往復 `f(u(f))` の整合も |
| FSM 遷移 | 状態机上表どおり: fill 到達 → Straining、90 step 後 Falling、`ay ≤ R` で Splashing + SplashEvent 1 件、48 step 後 Dead、遅延帯 [4,10]s で Spawning。スロット再利用で R・ジッター再ロール。Splashing 進入で counts が 0 |
| 衝突: オラクル | seed 1〜7 で GridDetector vs BruteForce の正規化ペア集合一致 + `expected.length > 0` ガード(知見: `Mizu-threejs/tests/sim/physics/CollisionDetectorProperty.test.ts` — 空虚テスト防止ガードごと採用。密度は球内 26 体に再調整) |
| 反応ルール単体 | HHFusion: 中点生成・収支 H−2/H2+1。OxidationToDroplet: O 座標・収支・DropletSpawn レコード形。死亡ペアガード |
| 雫カーネル | spawn/吸収/swap-remove(i 再処理エッジ)、prev/posr/aux 3 本同時 swap、球内クランプ、**RNG フリー(spy Random 不呼)**(知見: threejs DropletStore テスト群の項目立て) |
| スポナー | 目標人口へ収束、不足種選択の 2:1 追従、水面上のみにスポーン(y > y_w + m)、Straining 以降停止、バースト |
| 補間契約 | スポーンフレーム prev==curr、swap-remove 後の prev/curr 同順序、パッカーの world = anchor+local、BubbleView count==SLOT_COUNT 恒常、dense prefix |
| アキュムレータ(app) | 純関数: 60Hz 入力で 1 step、120Hz で 0/1 交互、250ms スパイクで 3 step + 残余破棄、alpha ∈ [0,1) |
| perf 上限 | フル sim 7 球 × 3000 step を寛大な上限(トリップワイヤ、CI ゲートにしない — 知見: threejs perf テストの位置づけ) |

### 7.4 レイヤ強制(裁定 1)

dependency-cruiser に明示 forbidden(全て error): `contract は何も import しない` / `sim ↛ render, app, npm パッケージ` / `render ↛ sim, app` / sim 内レイヤ順(core ← chem/physics/droplets/water ← bubble ← view ← MizuNiNaruSim)/ no-circular。加えて `tsconfig.sim.json` は `lib: ["ES2022"]` で DOM 型を排除(import なしの DOM 使用もコンパイルエラーにする 2 重防御 — 知見: `Mizu-threejs/docs/architecture.md` §1)。

### 7.5 ヘッドレス校正スクリプト(テストの外)

`scripts/calibrate.mts`(node): seed 掃引 × 実 sim を 60×300 step 回し、T_fill 分布・落下間隔分布・溶解/雫の体積シェア・SimCounts を CSV 出力。受入バンド: T_fill ∈ [90, 150] s、落下間隔 ∈ [15, 25] s。§5 の見積が外れた場合のノブ優先順位: ① SPAWN_INTERVAL_STEPS(線形で効く)② VOLUME_GAIN(粒数を変えず時間だけ動く)③ P_DISSOLVE(シェア補正)。(知見: *threejs* Phase 3 の校正で DEPTH_RATIO 0.5→0.15 / FALL 0.05→0.02 と**設計値から実測で大きく動いた**前例 — `Mizu-threejs/src/contract/WorldSpec.ts` の校正コメント。ノブと受入帯を先に決めておくのが肝)

## 8. CPU 予算

### 8.1 ワースト粒子数

| 対象 | ワースト | 内訳 |
|---|---|---|
| 原子 | **182**(容量 256) | 7 球 × (H12 + O8 + H2 ≈4.5 + スポーン過渡 ≈1.5) = 26 |
| 雫 | 実勢 **≈10**、設計上限 448(容量 512) | 実勢 0.5/s × 2.7 s ≈ 1.4 粒/球。上限は球ごとキャップ 64 の総和 |
| イベント | splash ≤ 7、ripple ≤ ≈20/frame | §1.1 容量の根拠 |

### 8.2 step() コスト概算(予算 vs 参照実測からの外挿)

外挿元は *threejs* の実測(本書冒頭の検証済み事実)。「参照単価」= 実測をエンティティ数で割った保守値。

| 段 | 本作ワースト | 参照実測(出典) | 外挿単価 | 予算/step |
|---|---|---|---|---|
| 原子更新(walk+反射+水面) | 182 体 | 9,000 体 ≈ 0.3ms(threejs 設計 §3 の内訳) | ≈33 ns/体 + 球面 sqrt ≈15 ns | **0.01 ms** |
| 衝突(grid 7 回 rebuild + ≈1,000 判定) | 64 セル × 7 + 143 判定 × 7 | 9,000 体・34 万判定 ≈ 1.3ms(`MizuSimulator3D.perf.test.ts`) | ≈4 ns/判定 + rebuild ∝ セル数 | **0.01 ms** |
| 雫カーネル | 448 粒(実勢 10) | 30 万粒 ≈ 1.3ms(`DropletStore.perf.test.ts`) | ≈4.3 ns/粒(+クランプ sqrt ≈10 ns) | **0.01 ms** |
| 反応・sweep・スポナー・FSM・水位 LUT | ≤ 数十件/step | 2D パイプライン同段が誤差レベルだった実績 | — | **0.01 ms** |
| 集約パック(prev/curr 2 世代) | ≈14k float 書込(atoms 182×12 + droplets 448×12 + bubbles 7×16 + color) | 9,000 体 × 8 float 再パックが「自明」(threejs 設計 §3) | ≈1 ns/float | **0.02 ms** |
| **合計** | | | | **≈0.06 ms/step** |

- **60Hz × MAX 3 step でも ≈0.2 ms/frame** — フレーム予算 16.7 ms の ≈1%。モバイル(CPU ≈4 倍遅)でも ≈0.8 ms。**2 桁の余裕**
- 意図的な帰結: 本作は threejs の 1/40(原子)〜1/1000(雫)スケール。性能戦(RNG フリー化・cos LUT・ブランチレス圧縮)の知見は「**どの規模から必要になるか**」の判断基準として引き継ぎ、適用は見送る(swap-remove SoA と定常ゼロアロケーションだけは、コストゼロで得られる規律として採用)
- 予算が崩れる唯一の現実的経路は「アロケーションによる GC スパイク」。定常状態での new 禁止(配列使い回し・`length=0` 再利用 — 知見: threejs 全域)を perf テストではなくコードレビュー規約で守る

## 9. ファイル構成ツリーと LOC 見積(来歴付き)

来歴列の凡例 — **NEW**: 本設計固有。**知見(path)**: 出典プロジェクトの実証パターン・アルゴリズム・規約を学んで**新規実装**する(コードコピーはしない — 大前提)。

```
src/
  contract/                                     LOC   来歴(採用した知見の出典)
    WorldSpec.ts                                ~85   NEW(凍結契約の様式・座標規約文書化: Mizu-threejs/src/contract/WorldSpec.ts)
    RenderView.ts                               ~160  NEW(所有権/コヒーレンス/version 規約: Mizu-threejs/src/contract/RenderView.ts。prev/curr 2 世代は本設計 §1.4)
  sim/
    config.ts                                   ~150  NEW(根拠コメント付き定数集約: Mizu-threejs/src/sim/config.ts の様式)
    core/
      Random.ts                                 ~40   NEW(mulberry32 + interface 注入: Mizu-threejs/src/sim/core/Random.ts のアルゴリズム/パターン)
      Vec3.ts                                   ~15   NEW(plain mutable {x,y,z}: Mizu-threejs/src/sim/core/Vec3.ts)
      CapLut.ts                                 ~55   NEW(§4.2。三角閉形式オラクル込み)
    bubble/
      BubbleFsm.ts                              ~110  NEW(§2。状態・タイマー・遷移)
      SlotRing.ts                               ~80   NEW(§2.3。リング配置・分離チェック・再ロール)
      BubbleWorld.ts                            ~200  NEW(§3.7。球 1 個の合成: 原子/雫/水/スポナーの段順指揮。段順思想: Mizu-ts/src/simulator/MizuSimulator.ts → Mizu-threejs/src/sim/MizuSimulator3D.ts の 6 段)
    chem/
      Atom.ts                                   ~45   NEW(thin データクラス: Mizu-threejs/src/sim/particles/H.ts ほかの「薄い合成」を単一クラス化 §3.1)
      BoundedWalk.ts                            ~95   NEW(一様 3D 方向 + 速度クランプ + mirror-and-negate: Mizu-threejs/src/sim/behaviors/RandomWalk3D.ts。球面反射式と漏れあり水面は本設計 §3.2/§3.3)
      AtomFactory.ts                            ~80   NEW(RNG 呼び順規約の一元文書化: Mizu-threejs/src/sim/particles/ParticleFactory.ts の doc 様式)
      Spawner.ts                                ~100  NEW(§3.6。凝結スポナー — 本設計固有)
    reactions/
      ReactionRule.ts                           ~30   NEW(宣言的 consumed/produced + droplets ルーティング: Mizu-ts/src/reactions/ReactionRule.ts + Mizu-threejs 拡張)
      ReactionRegistry.ts                       ~40   NEW(両順キー + live reactiveKinds: Mizu-ts/src/reactions/ReactionRegistry.ts)
      rules/HHFusion.ts                         ~25   NEW(収支ルール全権: Mizu-ts/src/reactions/rules/HHFusion.ts — 再湧き廃止・中点生成に変更 §3.5)
      rules/OxidationToDroplet.ts               ~30   NEW(kind 判別の順序非依存: Mizu-ts/src/reactions/rules/OxidationToWater.ts — 雫ルーティング化)
    physics/
      CollisionDetector.ts                      ~10   NEW(interface DI: Mizu-ts/src/physics/CollisionDetector.ts)
      SphereGrid.ts                             ~100  NEW(counting-sort 索引グリッド・クランプ・安定順序: Mizu-threejs/src/sim/physics/SpatialGrid3D.ts。球外接 AABB 化は本設計 §3.4)
      GridDetector.ts                           ~80   NEW(27 セル走査 + 正準重複排除 + 二乗距離: Mizu-ts/src/physics/GridCollisionDetector.ts。threejs の半近傍最適化は意図的に不採用 §3.4)
      BruteForceDetector.ts                     ~35   NEW(テストオラクル: Mizu-ts/src/physics/BruteForceCollisionDetector.ts)
    droplets/
      DropletColumn.ts                          ~140  NEW(SoA + swap-remove + RNG フリーカーネル + i 再処理: Mizu-threejs/src/sim/droplets/DropletStore.ts。prev 列・球内クランプ・吸収→体積は本設計 §4.1)
    water/
      WaterBody.ts                              ~60   NEW(§4.3。体積台帳 + LUT 参照)
    view/
      AggregatePacker.ts                        ~180  NEW(安定 view オブジェクト・dense prefix・再パック: Mizu-threejs/src/sim/RenderViewPacker.ts。全球集約 + prev/curr + ワールド変換は本設計 §1.4)
    MizuNiNaruSim.ts                            ~150  NEW(SimLike 実装。スロット走査 + FSM + パック指揮)
    StubSim.ts                                  ~100  NEW(合成アニメを本物の view 型で放出し render を先行解放: Mizu-threejs/src/sim/StubSimulator.ts のマイルストーン戦略)
  app/(本書スコープ外の骨格のみ)
    main.ts / urlParams.ts / accumulator.ts     ~150  NEW(rAF アキュムレータ + alpha 渡し §7.1。seed/URL パース様式: Mizu-threejs/src/app/urlParams.ts)
```

- **sim + contract ≈ 2,190 LOC**(テスト別途 ≈1,800)。*threejs* sim(≈1,450)より 5 割増 — FSM・水位・スポナー・prev/curr の追加分として妥当
- 実装順序の推奨(threejs のマイルストーン戦略知見): M1 contract + StubSim(render 解放)→ M2 chem/physics(オラクルテスト)→ M3 droplets/water(LUT)→ M4 bubble/FSM + パイプライン + ゴールデン → M5 校正スクリプト + チューニング

## 10. リスク Top3 + Plan-B

1. **ペーシングの見積外れ**(最重要 §5 が製品そのもの)。運動論近似(v_rel 係数、クランプ付きウォークの実効速度、水面フラックス)は ±50% 単位でズレうる。*threejs* でも設計値 DEPTH_RATIO 0.5 が校正で 0.15 になった前例(super-linear 効果)がある。**緩和(設計済み)**: ノブを 3 つ(SPAWN_INTERVAL / VOLUME_GAIN / P_DISSOLVE)に絞り §5.7 の逆算チェーンで感度を文書化、受入帯付き校正スクリプト(§7.5)を M5 に組み込み。**Plan-B**: 決定的な閉ループスポナー — fill01 の実測進行が目標カーブ(t/T_fill)から ±20% 外れたらスポナー間隔を毎 10 s ±10% 補正する(sim 内部の決定的フィードバックなので決定論・ゴールデンとは両立)。これで運動論が外れても T_fill は帯に収束する
2. **prev/curr 補間契約の綻び**(裁定 3 の核心)。swap-remove・スポーン・FSM 遷移・スロット再利用のどこかで prev/curr のエンティティ対応が 1 フレームずれると、雫や球が一瞬ワープする(120Hz 端末で顕在化 — *threejs* の既知問題の再発形)。**緩和**: 「3 本同時 swap」「スポーン時 prev=curr」「パック同順序」を §1.4 で契約化し補間契約テスト(§7.3)で固定。StubSim が最初から prev/curr を出し、render 側が M1 時点で 120Hz 実機検証できる。**Plan-B**: SkyRenderer に snap モード(alpha=1 固定)を仕込み、綻び発見時は視覚劣化(60Hz 相当のカクつき)で逃がしてから修正する — 世界が 2 倍速になる旧問題よりは常に良い
3. **決定論の侵食(RNG 呼び順の脆さ)**。棄却サンプリング(§3.6)・分離チェック(§2.3)・水面透過(§3.3)は**条件付き RNG 消費**であり、閾値 1 つの変更が以後の全乱数をずらしゴールデンを壊す(意図的変更と事故の区別がつきにくい)。**緩和**: 呼び順規約の一元文書化 + 条件付き消費は「有界・決定的」のみ許可 + ゴールデンは「壊れたら再記録する変更管理手順」(threejs golden テストの運用コメント様式)をテスト内に明記。**Plan-B**: 球ごとの派生サブストリーム(seed = hash(rootSeed, slot, generation))へ移行し、呼び順の影響半径を球 1 個に局所化する(裁定 4 の単一ストリームからの変更になるため裁定希望 #8 として事前予約)

---

## 裁定希望事項

契約叩き台・裁定からの変更提案、render 側との調整が要る点、未決定事項。**本文はすべて現裁定に従って書かれており、以下が却下されても設計は成立する。**

1. **fill01 の分母の明文化**: fill01 = V_water / V_inner(内殻球 R_inner=0.94R 基準)と定義した(§4.2)。F_FULL=0.6 は「見えている空洞の 6 割」。契約コメントへの明記の承認を求める
2. **InnerRippleView の用途拡張**: 雫着水(strength 0.6〜1.0)に加え、原子/H2 の溶解イベント(strength 0.3)も同じ view で流したい(§3.3)。render 側の波紋スプラットが strength で強弱を出せる前提の確認
3. **statePacked のエンコード確定**: `stateIndex + min(progress01, 0.999)`(整数部=状態、小数部=正規化経過。状態ごとの progress 意味は §1.3 の表)。prevData の statePacked は lerp 禁止という規約を render と合意したい
4. **原子のフェードイン用データ**: AtomView に age/spawnStep が無い。凝結スポナーの「じわっと現れる」を render で行う場合、aux 配列(stride 4: [spawnStep, seed, 予備, 予備])の追加を提案する(不要なら現行 4+4 のまま)
5. **水面境界の確率透過(P_DISSOLVE=0.05)の承認**: 「重なれば必ず反応、確率なし」は化学反応の規約であり境界には適用しない、という解釈を採った(§3.3/§5.2 — 完全吸収面はペーシングを定量的に破綻させる)。ユーザー確定事項「水中に入った H/O/H2 は消滅する」は保存される(入ったら必ず消滅。入りにくくしただけ)
6. **HHFusion の生成位置 = 両親の中点**: Mizu 原典(片親位置 + 再湧き)からの変更(§3.5)。再湧きなしの世界での自然な選択として承認を求める
7. **SplashEventView の semantics 確定**: radius に球半径 R、strength に `min(1, vImpact/4)`(§2.4 で vImpact ≈ 3.2 → strength ≈ 0.8)。render の海面波紋スケーリングとの整合確認
8. **RNG サブストリームへの移行パス予約**: 現行は裁定 4 どおり単一ストリーム。ゴールデンの脆さが運用負担になった場合に備え、球ごと派生シード(hash(rootSeed, slot, generation))への移行を Plan-B として予約したい(§10-3)
9. **モバイルのリング半径とカメラフレーミング**: sim はリング半径 4.5 u を desktop/mobile 共通とし、画角調整は render のカメラで吸収する前提(§2.3)。縦画面での見切れ対策(リング縮小 or カメラ後退)は render 設計と要調整。SHELL_RATIO=0.94(§3.1)も render の殻厚表現と要整合
10. **BubbleView.count = 常に SLOT_COUNT**(Dead も含め statePacked で判別 — §1.4 規約 4)。instancing のバッファ長を固定化できる利点があるが、render が「Dead を描かない」分岐を持つ必要がある。この配分の合意を求める
11. **counts()/オーバーレイの表示契約は本作で新規定義**: *threejs* の凍結 StatsOverlay 行形式(ベンチパーサ都合)は継承せず、SimCounts(§1.2)を正とする。ベンチハーネスを移植する場合はパーサも新契約に合わせる
12. **mobile ペーシング(§5.6)は帯上限際(≈24 s)**: SPAWN_INTERVAL 30 で設計したが、校正(§7.5)の結果次第で F_FULL や INITIAL_FILL_MAX の mobile 別値が必要になる可能性がある。config に mobile プリセットの席だけ確保した




