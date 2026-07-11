# mizu-ni-naru(水になる)マスタープラン

- 作成: 2026-07-10(オーケストレーター)。**本書が最上位の正** — `design-sim.md` / `design-render.md` と矛盾する場合は本書 §4 の裁定表が優先する
- 三部構成: 本書(裁定・フェーズ・検証)+ [design-sim.md](./design-sim.md)(シミュレーション層詳細)+ [design-render.md](./design-render.md)(レンダリング層詳細)
- 体制: オーケストレーター(Claude)は**実装をしない**。各フェーズをサブエージェントに委任し、受入ゲートで検証する最終確認者である

---

## §1 Context と実現可否

**世界観(ユーザー要件)**: 半透明の球体が空中に何個も浮かんでいる。中では文字 H / O が漂い、H+H→H2、H2+O→水(雫)。雫は球の底に溜まり続け、水中に入った H/O などは消滅する。水が約6割溜まると球は落下し、下界の海に着水して弾け「水になる」。新しい球が生まれ、永遠に繰り返される。

**実現可否: WebGL(three.js)で確実に実現可能。** 根拠: 同作者の Mizu-threejs が「原子 9,000 体のフルパイプライン ≈2.5ms/step、雫 30 万粒 60fps」を実測済み。本作の粒子規模はその 1/40〜1/1000(ワースト原子 182 体・雫 448 粒)であり、シミュレーション負荷は最初から問題にならない。勝負は**海と球の美しさ(フラグメント品質)とペーシング(リズム)**に移る — それぞれ design-render §2(Ocean v2)と design-sim §5(運動論)が主戦場。

## §2 ユーザー決定事項(2026-07-10 確定・変更不可)

| # | 事項 | 決定 |
|--:|---|---|
| U1 | 実装ベース | **ゼロから新規実装**。Mizu-threejs / Mizu-ts のコードコピー禁止。実証済みの知見・パターンの採用は可(出典パス明記) |
| U2 | 落下先 | **下界の海へ落ち、水になる**。かつ**海のクオリティは Mizu-threejs の水面を明確に超えること**(最重要要件) |
| U3 | カメラ/操作 | 自動でゆったり漂うカメラ + マウス視差。**スクリーンセーバー的**。クリック注入などの操作は無し |
| U4 | 公開/環境 | GitHub Pages 公開 + モバイル対応(AdaptiveQuality) |

## §3 世界ルールの実装解釈(ユーザー確認事項)

設計上、原文ルールに演出・工学の解釈を加えた箇所。**却下されたら design-sim の該当ノブを差し替える**(設計は破綻しない):

1. **水面は「たまに溶ける弾む床」**(design-sim §3.3/§5.2): 原子が水面に触れると通常は「ぽよん」と跳ね、確率 5%(P_DISSOLVE)で水に溶けて消える。完全吸収面にすると原子が反応する前に全部水没し、雫がほぼ生まれなくなる(運動論で定量済み: 溶解 2.8 体/s > 供給 1.5 体/s)。「水中に入った H/O は消滅する」は保存(入ったら必ず消滅。入りにくくしただけ)
2. **反応で原子は再湧きしない**(原典 Mizu からの変更): 供給は「凝結スポナー」(水面より上の空域に H/O が少しずつ凝結して現れる)のみ。物質は 原子→H2→雫→球内の水→海 へ一方通行 — 「すべてはやがて水になる」。H2 は両親 H の中点に生まれる
3. **着水の瞬間に球は弾けて中身ごと水になる**(Splashing 0.8s): 中の原子・雫・水は即時消え、海の波紋・フォームリング・しぶきの FX がそれを覆う
4. **海面上昇の永続化は非目標**: 海は無限シンク(波紋と輝きで受け止める)

## §4 契約裁定(並列設計の裁定希望 22 件 + オーケストレーター検出 3 件)

design-sim / design-render の文末「裁定希望事項」への裁定。**本表が最終決定**。

| # | 事項 | 出典 | 裁定 |
|--:|---|---|---|
| A1 | `SkyRenderer.render(view, alpha)` シグネチャ(alpha ∈ [0,1)) | render#1 | **承認**(design-sim §1.2 の契約に含まれている形で確定) |
| A2 | statePacked = `stateIndex + min(progress01, 0.999)`、状態別 progress 意味、prevData の statePacked lerp 禁止 | render#2 + sim#3 | **承認**(design-sim §1.3 の仕様で確定) |
| A3 | **FSM 状態名の統一**(検出: sim=Spawning/Drifting/Dead、render=Growing/Brewing/Dormant) | 検出 | **sim 名で統一**: `Spawning:0, Drifting:1, Straining:2, Falling:3, Splashing:4, Dead:5`。インデックスは両設計で同一のため render のシェーダ断片(数値比較)は無変更で有効。render 文中の Growing/Brewing/Dormant は同インデックスの別名と読み替える |
| A4 | prev/curr の index 整合(同 index = 同エンティティ、スポーン時 prev=curr、3 本同時 swap) | render#3 | **承認**。design-sim §1.4 規約 1-2 を契約コメント本文とし、補間契約テストで固定 |
| A5 | 容量定数の contract 移管 | render#4 vs sim§1.1 | **sim 値で確定 + BUBBLE_CAPACITY 追加**: `BUBBLE_CAPACITY=8` / `ATOM_VIEW_CAPACITY=256` / `DROPLET_VIEW_CAPACITY=512` / `SPLASH_VIEW_CAPACITY=8` / `RIPPLE_VIEW_CAPACITY=64` / `KIND_INDEX={H:0,O:1,H2:2}`。render の uniform 配列は 8 固定。render §9.2 帯域表の atoms ≤512 は 256 に読み替え(余裕が増える方向) |
| A6 | **AtomView.aux 追加**: stride4 `[spawnStep, seed, 0, 0]` | sim#4 | **承認**。凝結スポーンのフェードイン + パルス位相に使用。⚠ render §5 の原子パルスは `gl_InstanceID` 黄金比ハッシュではなく **aux.seed 駆動に差し替えること**(swap-remove で index が動くとパルス位相が飛ぶ潜在バグの解消)。帯域 +4KB/frame(無視できる)。ラベルのフェードも同バッファ共有 |
| A7 | InnerRippleView の用途拡張(雫着水 0.6〜1.0 + 溶解 0.3) | sim#2 | **承認**。render のリングバッファ(球ごと 6 本)は strength スケール対応済み |
| A8 | InnerRipple の localX/Z 単位 | render#5 | **球ローカル世界単位(−R..+R)で確定** |
| A9 | 雫の sway は sim が posr に焼き込み済み(render は位置加算禁止、aux は pop-in/tint のみ) | render#6 | **確認・確定**(design-sim §4.1 カーネルが焼き込む) |
| A10 | SplashEventView の semantics | render#7 vs sim#7 | **sim 案で確定**: `radius = R`、`strength = min(1, vImpact/4)`(速度項のみ)。render がサイズ込みの駆動係数を欲しい場合は `strength × (radius/R_MAX)³` を内部導出する |
| A11 | BubbleView の意味確認(anchor=球中心ワールド座標、waterLevelYLocal=中心からの y オフセット、値域 ±R_inner) | render#8 | **確認・確定** |
| A12 | fill01 の分母 = V_inner(R_inner = 0.94R)。F_FULL=0.6 は「見えている空洞の 6 割」 | sim#1 | **承認**。契約コメントに明記 |
| A13 | シェル半径の二本立て(検出: sim SHELL_RATIO=0.94 vs render 水描画 0.985R) | sim#9b + 検出 | **意図的二本立てとして承認**: 台帳・粒子境界は `SHELL_RATIO=0.94`(sim)、水の見た目半径は `WATER_VISUAL_RATIO=0.985`(render — 水がガラスに接して見える)。**水面平面の高さ waterLevelYLocal が唯一の真実**。体積↔水位はどのみち VOLUME_GAIN で演出的なので視覚差は問題にならない |
| A14 | 水面の確率透過 P_DISSOLVE=0.05 | sim#5 | **承認**(§3-1 でユーザー確認)。「重なれば必ず反応・確率なし」は化学反応の規約であり境界物理には適用しない |
| A15 | HHFusion 中点生成・再湧きなし | sim#6 | **承認**(§3-2 でユーザー確認) |
| A16 | モバイル判定の所在 | render#9 | **app 層で確定**(viewport width < 768)。sim へ `slotCount=5`、render へ初期 tier2 を注入。render は count ≤ 8 を無条件に受ける |
| A17 | `?m=1` の意味論 | render#10 | **承認**: overlay 表示 + tier0 固定 + マウス視差無効 + カメラ軌道 t=0 起点。**seed は独立**(`?seed=` を明示指定。m=1 が seed を固定することはない) |
| A18 | BubbleView.count = 常に SLOT_COUNT(Dead 含む) | sim#10 | **承認**。render は state==Dead を縮退 quad(scale 0)で非描画 — render §3 設計済み |
| A19 | StatsOverlay 行契約は本作で新規定義(SimCounts が正。threejs の凍結行形式は継承しない) | sim#11 | **承認**。ベンチハーネスを将来移植する場合はパーサ側を合わせる |
| A20 | RNG サブストリーム移行(hash(rootSeed, slot, generation))を Plan-B 予約 | sim#8 | **承認**(現行は単一ストリーム。ゴールデン運用が痛くなったら発動) |
| A21 | モバイル縦画面のフレーミング | sim#9a | **方針確定**: 全リングの常時収容は非目標。海 + 2〜4 球が映る構図を優先(球がフレームに出入りするのは演出として正)。Phase 4 の校正項目(owner: render) |
| A22 | 球の per-generation 視覚シード(検出: render §2.5 uniform に seed があるが BubbleView に無い) | 検出 | **契約に seed は追加しない**。render が `hash(slot, R, anchor ジッタ)` から導出(世代ごとに R・ジッタが再ロールされるので自然に変わる) |
| A23 | mobile ペーシング(≈24s は帯上限際) | sim#12 | **校正で判定**: `scripts/calibrate` の受入帯(T_fill 90〜150s / 落下間隔 15〜25s)で実測し、外れたら mobile プリセット(SPAWN_INTERVAL / F_FULL / INITIAL_FILL_MAX)の別値を許可 |
| A24 | 雫の消滅位置(検出: 吸収は「下端接触」判定なので最終描画位置は水面の僅か上) | 検出 | **対処不要と裁定**: 60Hz で残差 ≤0.008u + InnerRipple FX が覆う。実機で気になったら「吸収 step に y を水面へクランプして 1 step 残す」を render 協定なしで sim 側修正可 |
| A25 | 「原子・雫は常に球内水面より上」不変条件(render §4 の depth 戦略が依存) | 検出 | **契約の文書化不変条件に昇格**(sim §3.3/§4.1 が保証、プロパティテスト対象) |
| A26 | **文字が主役**(2026-07-11 ユーザー指示)— 原子を発光球で囲わない | ユーザー | design-render §5 の「発光球+ラベル」を上書き: 発光球インポスターは削除、文字そのもの(per-atom 色+暗色縁取り、通常アルファブレンド)が粒子。`fb87140` で実装済み |
| A27 | **画面パスは bloom FBO 連鎖を再サンプルしない**(黒フレーム対策)| 検出+ユーザー報告 | Chrome/ANGLE Metal の提示段不具合により、画面へ描くパスが UnrealBloom 連鎖の産物を読むと全面黒フレームが混入(CDP screencast 実測 16〜39 枚/20s → 修正後 0 枚/60s)。bloom は二重化した自前ターゲットに閉じ、シーン内加算三角形が前フレーム bloom を適用(1 フレーム遅延+帰還打ち消し)。`29ea69c`。**Phase 3 以降のポスト/FBO 追加時もこの制約を厳守** |
| A28 | **マウスでグリグリ動かしたい**(2026-07-11 ユーザー指示 — U3 改訂) | ユーザー | ドラッグでオービット+ホイールでズーム(クランプ付き)、操作をやめて ≈5s で自動ドリフトへ滑らかに復帰(Mizu-threejs CameraRig の実証パターン)。パン無効・水面下潜行防止クランプ維持。モバイルは 1 本指オービット+ピンチズーム。`prefers-reduced-motion` と `?m=1`(決定論軌道)は不変 |
| A29 | **落下をもっと自然に**(2026-07-11 ユーザー指示) | ユーザー | Falling 中のぐにゃぐにゃ(wobble 変形+雫型ストレッチ 0.14)を大幅減: 落下開始で wobble を数百 ms で減衰させ、ストレッチは ≤0.04 の微小な空力感のみ。剛体的でまっすぐな落下に。値は視覚調整で確定 |
| A30 | **球体を増やしたい**(2026-07-11 ユーザー指示) | ユーザー | SLOT_COUNT: desktop 7→**12** / mobile 5→**7**。凍結契約の容量定数を裁定により改訂: BUBBLE_CAPACITY 8→16 / ATOM_VIEW_CAPACITY 256→512 / DROPLET_VIEW_CAPACITY 512→1024 / SPLASH_VIEW_CAPACITY 8→16(改訂はこの 4 定数のみ、view 構造は不変)。配置は単一リング→**緩い二重リング**(内 r≈3.6×5 球 + 外 r≈6.3×7 球、高さ帯 y 2.6〜6.0 に拡大、3D 分離チェック維持)。カメラ基準距離を再フレーミング。落下間隔の受入帯を 15〜25s → **11〜20s** に改訂(賑やかさはユーザー要望)、校正再実行。海の解析反射はカメラに近い 8 球に CPU 選抜制限(コスト維持) |
| A31 | **球内で出来る水が白っぽすぎる**(2026-07-11 ユーザー指示) | ユーザー | 雫の白コア支配をやめ、溜まった水と同じ #007fff 系の透明な水色を本体に(フレネル縁・空の映り込みは控えめに残す)。球内水面キャップの白いスペキュラ/反射も抑え、体積の青と連続した「同じ水」に見せる |
| A32 | **球体をもっともっと多く+遠くは簡略描画**(2026-07-11 ユーザー指示) | ユーザー | **球体フィールド + 距離 LOD**: desktop 合計 40(近リング 12 は現状のまま+外側に環状フィールド 28)/ mobile 14(7+7)。全球リアル sim(sim コストは自明)。LOD: ガラス/内水ジオメトリを距離 3 段階(icosa d4/d3/d2)、**文字は距離カットオフ**(遠方は判読不能なので描かない)、キャップ波紋 uniform は近傍 12 球のみ、海の解析反射は近傍 8 のまま。契約容量再改訂(A30 と同手続き): BUBBLE_CAPACITY 64 / ATOM 2048 / DROPLET 4096 / SPLASH 64 / RIPPLE 128。遠方の着水はリップル場外なのでスプレー+ポップのみ(知覚上十分)。近リングのリズム帯(11〜20s)は不変、シーン全体では数秒に 1 回どこかで球が還る |

## §5 確定契約サマリ(Phase 0 で凍結するもの)

```ts
// contract/WorldSpec.ts — 裁定 A3/A5 反映(全文は design-sim §1.1 ベース + 本表)
SEA_LEVEL = 0                         // y-up 右手系、海面 y=0、単位 u
STEP_HZ = 60; DT = 1/60; MAX_STEPS_PER_FRAME = 3
KIND_INDEX = { H: 0, O: 1, H2: 2 }
BUBBLE_STATE = { Spawning:0, Drifting:1, Straining:2, Falling:3, Splashing:4, Dead:5 }
SLOT_COUNT_DESKTOP = 7; SLOT_COUNT_MOBILE = 5
BUBBLE_CAPACITY = 8
ATOM_VIEW_CAPACITY = 256; DROPLET_VIEW_CAPACITY = 512
SPLASH_VIEW_CAPACITY = 8; RIPPLE_VIEW_CAPACITY = 64

// contract/RenderView.ts — design-sim §1.2 に対する裁定差分:
//   AtomView に aux: Float32Array を追加(stride 4: [spawnStep, seed, 0, 0] — A6)
// 他フィールドは design-sim §1.2 の全文どおり。
// 不変条件(コメント明記): prev/curr 同 index = 同エンティティ、スポーン時 prev=curr、
//   BubbleView.count は常に SLOT_COUNT、原子・雫は常に球内水面より上(A25)、
//   statePacked の prev は lerp 禁止、fill01 の分母は V_inner(A12)
SimLike { init(SimInitOptions), step(), view(): SkyRenderView, counts(): SimCounts }
SkyRenderer { render(view, alpha), resize(), dispose() }
```

**URL パラメータ(app 層)**: `seed`(RNG シード) / `m=1`(overlay+tier0+視差off+カメラt=0) / `q=0..4`(ティア固定) / `dpr`(DPR 上限) / `sim=stub`(StubSim 差し替え) / `slots`(スロット数上書き、デバッグ用)。

## §6 アーキテクチャ概要

```
src/
  contract/   WorldSpec.ts RenderView.ts            依存ゼロ(凍結契約)
  sim/        config core/ bubble/ chem/ reactions/ physics/ droplets/ water/ view/
              MizuNiNaruSim.ts StubSim.ts           純ロジック・DOM/three 禁止(≈2,190 LOC)
  render/     SceneRenderer CameraRig Environment NoiseTexture AdaptiveQuality PostPipeline
              ocean/(OceanSystem OceanGeometry RippleField SplatScheduler)
              bubbles/(BubbleGlassSystem InnerWaterSystem)
              atoms/(AtomSystem LabelAtlas LabelSystem DropletSystem)
              particles/(SpraySystem) shaders/(14 本)  three はここだけ(≈4,350 LOC)
  app/        main.ts accumulator.ts urlParams.ts StatsOverlay.ts   合成ルート(≈330 LOC)
```

- 強制: dependency-cruiser(contract 依存ゼロ / sim ↛ render・app・npm / render ↛ sim / no-circular)+ 2 tsconfig(`tsconfig.sim.json` は lib:["ES2022"] で DOM 排除)
- ループ: rAF → accumulator(≤3 step)→ `sim.step()`×n → `renderer.render(sim.view(), alpha)`。120Hz 端末でも世界速度不変(threejs の既知問題への回答)
- 主ループのパスグラフ・draw call 予算(12/18)は design-render §1.3、CPU 予算(≈0.06ms/step)は design-sim §8

**ツールチェーン**(Mizu シリーズ踏襲): Vite 8 / TypeScript 6 strict / three ^0.185(唯一のランタイム依存)/ Biome / Vitest 4(sim=node 環境既定)/ dependency-cruiser / mise(Node 22)/ GitHub Actions(CI: lint→depcruise→typecheck×2→test→build、deploy: Pages・`GITHUB_PAGES` 環境変数で base 切替)。

## §7 実装フェーズと受入ゲート

体制: 各フェーズを**実装サブエージェント**に委任(design 文書の該当 § を仕様として渡す)。オーケストレーターは着手指示・中間レビュー・受入ゲート検証のみ。**ゲートを通らない限り次フェーズに進まない**。

### Phase 0 — 骨格と契約凍結(scaffold)
- 内容: `git init`、package.json / mise / Biome / Vitest / depcruise / 2 tsconfig / CI・Pages workflow、`index.html`(タイトル「水になる」)、**contract 2 ファイル実装(§5 の確定形)**、StubSim(球 FSM と雫の合成アニメを本物の view 型で放出)、app 骨格(accumulator + urlParams)、空シーン(スカイ + 自動カメラのみ)
- 受入ゲート: `npm run lint / typecheck / test / build` 全通過、depcruise ルールが**違反をエラーにすることの実証**(わざと違反を书いて落ちるのを確認して戻す)、dev サーバで朝空とカメラドリフトが映る、accumulator 純関数テスト(60/120Hz・スパイク)通過。**以降 contract は凍結**(変更は本書の裁定追記が必要)
- 並列性: 完了後、Phase 1 と 2 は**並列で着手可**(render は StubSim で先行)

### Phase 1 — シミュレーション完成(design-sim 全編)
- 内容: M2 chem/physics(オラクルテスト付き)→ M3 droplets/water(CapLut)→ M4 bubble FSM + 集約パッカー + ゴールデン → M5 校正スクリプト
- 受入ゲート: テスト ≈120 本全通過(ゴールデン 2 回実行同一 / 球面境界 / 質量台帳 / 水位単調 / LUT 誤差帯 / FSM 遷移 / grid vs BruteForce / 補間契約)、**校正受入帯: T_fill ∈ [90,150]s・落下間隔 ∈ [15,25]s(desktop 7 球・seed 掃引)**。外れたらノブ優先順位(SPAWN_INTERVAL → VOLUME_GAIN → P_DISSOLVE)で再校正
- オーケストレーター検証: テスト実行 + 校正 CSV の分布確認 + `?sim=stub` ↔ 実 sim の view 互換確認

### Phase 2 — レンダリング中核(世界が一周する)
- 内容: BubbleGlass(2 パス+状態変形+メニスカス)、InnerWater(体積+キャップ)、Atom/Label/Droplet(prev/curr lerp、aux.seed パルス)、Ocean v2 の (a)(c)(f)(Gerstner+シェーディング+放射グリッド — リップル/フォーム/反射はまだ)、Environment(sky チャンク)、CameraRig、PostPipeline
- 受入ゲート: 実 sim 接続で**フルサイクル**(誕生→充填→張り→落下→着水消滅→再誕生)が視認できる、desktop tier0 60fps(`?m=1` 実測)、**120Hz 相当検証**(alpha 補間でワープ・スジが無いこと — 補間契約の実機確認)、固定 seed + カメラ t=0 のスクリーンショットセットをオーケストレーターが目視レビュー(アートステートメント整合)
- 備考: StubSim 駆動で Phase 1 完了前に着手可(M1 戦略)

### Phase 3 — Ocean v2 完成(最重要要件の山場)
- 内容: RippleField(RGBA16F ピンポン+フォームチャネル)、SplatScheduler(多段着水)、フォーム 2 系統、擬似 SSS + glitter、**解析的球面反射**、SpraySystem(クラウン+膜片)、球ポップ演出、InnerRipple 波紋
- 受入ゲート: ①60fps 維持(tier0 desktop、`?m=1`)②固定シード・複数カメラ角のスクリーンショットセットで **Mizu-threejs の水面とサイドバイサイド比較 — 明確に上回ること**(凪の質感 / 着水の読みやすさ / フォームの繊細さ / 球の映り込み)③長時間安定(30 分連続で発散・ドリフト・フリッカ無し)。**最終判定はユーザーのレビュー**(スクリーンショット+デモ URL 提出)
- リスク対応: design-render §11 の Plan-B ラダー(反射 3 球制限 / glitter 統合 / 導関数削減、リップル法線化 / 凪の窓)

### Phase 4 — 品質適応・モバイル・公開
- 内容: AdaptiveQuality(7 ノブ × 5 ティア + EMA ヒステリシス)、モバイル(slotCount=5、初期 tier2、縦画面フレーミング校正 — A21、タッチは視差なしドリフトのみ)、`prefers-reduced-motion`、StatsOverlay(SimCounts 準拠の新契約)、README(日本語・Mizu シリーズ様式: デモ GIF / URL パラメータ表 / 開発手順)、GitHub Pages デプロイ
- 受入ゲート: Playwright モバイルエミュレーション(390×844)+ CPU スロットリングで tier3 60fps 近傍、ティア遷移がヒッチなし(material 2 変種の事前コンパイル確認)、reduced-motion でカメラ停止・世界継続、CI 緑、Pages で公開 URL が動作。実機(ユーザーの iPhone/Android)確認は任意でユーザーに依頼

### 横断規律(全フェーズ)
- 定常状態での new 禁止(GC スパイク予防 — コードレビュー規約)、シェーダは `precision highp float`、ESM import 束縛の hot path 剥がし(threejs で 10 倍差の実測がある)
- コミット単位はフェーズ内マイルストーン毎。各ゲートで `npm run lint && npm run typecheck && npm run test && npm run build` を全通過させてから次へ

## §8 検証方法(オーケストレーターの受入プロトコル)

1. **自動**: lint / depcruise / typecheck×2 / test / build(CI と同一)。ゴールデン・校正帯・補間契約が最重要トリップワイヤ
2. **視覚**: dev サーバ起動 → Playwright / Chrome DevTools MCP で `?seed=7&m=1`(決定論構図)のスクリーンショット取得 → アートステートメント(design-render §0)と照合。Phase 3 は Mizu-threejs デモとのサイドバイサイド
3. **性能**: `?m=1` オーバーレイの FPS/Frame/Update 読取り + DevTools パフォーマンストレース(GPU 時間の内訳が §9 予算表と乖離していないか)
4. **決定論**: 同一 seed 2 回起動のスクリーンショット一致(ピクセル比較はカメラ t=0 + tier 固定で可能)
5. **ユーザーレビュー**: Phase 2 / 3 / 4 の各ゲート後にスクリーンショット・デモ手順を提出し GO を得る(特に Phase 3 の海はユーザーが最終判定者)

## §9 リスク統合 Top5 + Plan-B

| # | リスク | 一次対策 | Plan-B |
|--:|---|---|---|
| 1 | **ペーシング見積外れ**(運動論 ±50% — 製品はリズムそのもの) | ノブ 3 つに絞った校正スクリプト + 受入帯(design-sim §7.5/§10-1) | 決定的閉ループスポナー(fill 進行が目標カーブ±20% 外で間隔を毎 10s ±10% 補正 — 決定論と両立) |
| 2 | **Ocean v2 フラグメント過重**(~380 ALU) | ティアラダーが正確に海を削る(design-render §9.3) | 反射 3 球制限 → glitter 統合 → 導関数 3 波化(§11-1) |
| 3 | **prev/curr 補間契約の綻び**(120Hz でワープ) | 契約テスト + StubSim で M1 から実機検証(design-sim §10-2) | renderer に snap モード(alpha=1)で視覚劣化に逃がして修正 |
| 4 | **Gerstner × リップル合成破綻** | 勾配線形加算 + アクション域スウェル減衰 + 変位後サンプル(design-render §2.2) | リップルを法線のみに → 「凪の窓」演出(§11-2) |
| 5 | **エージェント実装の契約逸脱**(オーケストレーション固有) | Phase 0 で contract 凍結 + depcruise/tsconfig の機械強制 + ゴールデンのトリップワイヤ + ゲート毎のオーケストレーターレビュー | 逸脱検出時は該当フェーズを契約基準で差し戻し(裁定変更が必要なら本書 §4 に追記してから) |

## §10 未決事項(実装中に確定)

- モバイル縦画面のカメラ構図パラメータ(A21 — Phase 4 校正)
- mobile ペーシングの最終値(A23 — 校正帯で判定)
- 球ポップの膜片の見た目の最終調整(虹彩片 vs 水滴片の配合 — Phase 3 でユーザーレビュー)

## §11 次のアクション

1. ユーザーの **GO**(本プラン + §3 の解釈 4 点の承認)
2. Phase 0 サブエージェント起動(本書 §5-§6 + design-sim §1 を仕様として委任)
3. 以降、各ゲートで検証 → 報告 → 次フェーズ
