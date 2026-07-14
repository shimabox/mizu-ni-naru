# パフォーマンス改善リファクタリング案

## 0. この文書の前提

この改善では、作品の世界観、見た目、時間感覚、化学反応、球体の丸さ、波紋、しぶき、ブルーム、カメラの漂いを変更しない。

特に次を不変条件とする。

- 同じ `seed`、`slotCount`、`pacing` なら、シミュレーション結果を変えない。
- RNG の呼び出し回数・順序を変えない。
- 衝突ペアの列挙順を変えない。集合が同じだけでは不十分。
- `step = 1 / 60 s`、最大3 step/フレーム、補間規約を変えない。
- 球体ジオメトリの detail 4 を下げない。
- 球数、遠景球数、ラベル密度、波紋、ブルーム、しぶきの既定品質を減らさない。
- `RenderView` の dense prefix、prev/curr、スポーン時 `prev = curr` を守る。
- 品質ティアの表現上の優先順位を変えない。
- 改善は1作業単位ずつ行い、各単位で同条件のbefore / after計測を必須にする。
- 複数の改善をまとめて計測せず、効果が計測ノイズ内なら「改善」と判定しない。

したがって、主戦場は「同じ結果を、少ないCPU命令・GPU命令・転送・VRAMで出す」ことである。

---

## 1. 結論

優先度が最も高いのは次の7件。

|優先度|改善案|主な効果|世界への影響|
|---|---|---|---|
|P0|衝突検出を現在の列挙順と互換な直接走査へ置換|実測で detector 約2.17倍、sim全体 約1.51倍|ビット一致を維持可能|
|P0|`EffectComposer` の未使用フル解像度HDRターゲットを廃止|1080p・DPR 2なら色だけで約63 MiB、depth込みで約95 MiB削減候補|なし|
|P0|遠景球の per-vertex ハッシュ・配置計算を per-instance 化|毎フレーム約68.4万回の hash用 `sin` を除去候補|見た目の式は維持|
|P0|Sprayを4096体固定描画から生存prefix描画へ変更|イベント中の頂点処理を概ね30〜60分の1、転送を局所化|なし|
|P0|sim stepが進んでいないフレームのGPU再転送を止める|120Hzで概ね半分、144Hzで約58%の動的属性転送を省略候補|なし|
|P0|海面反射uniformを128枠×2から実使用8枠×2へ縮小|fragment uniform圧力と毎フレーム走査・転送を削減|なし|
|P0|同一detailになった球体near/far描画を統合|球・内水のdraw callを8から5へ削減候補|同一ジオメトリなのでなし|

GPU側は現在、`?probe=1`限定の`EXT_disjoint_timer_query_webgl2`とWebGL呼び出し計数を実装済みである。`npm run bench:browser`によりproduction build、固定viewport、warm-up、複数round、raw JSON保存まで同じ条件で再実行できる。

---

## 2. 現状の確認結果

### 2.1 品質ゲート

2026-07-14、Node.js v22.23.1 / macOS 26.2 で確認した。

未変更コードの正式なraw値、環境、反復条件は[`performance-results/20260714-baseline.md`](performance-results/20260714-baseline.md)に分離して記録した。

- `npm run typecheck`: 成功
- `npm run lint`: 95 files、問題なし
- `npm run depcruise`: 71 modules / 210 dependencies、違反なし
- `npm run test`: 28 files / 224 tests、全成功
- `npm run build`: 成功
- 本番JS: 660.31 kB、gzip 175.97 kB
- Viteの500 kB超警告あり

### 2.2 シミュレーション基準値

ウォームアップ2,000 step後、10,000 stepを7回計測した中央値。

|構成|中央値|最小|最大|
|---|---:|---:|---:|
|現行24球|0.1287 ms/step|0.1201|0.1369|
|上限128球|0.7646 ms/step|0.7535|0.7800|

60Hzにおける24球simは約0.12 ms/stepなので、現在の実構成ではCPU simだけがフレーム落ちの主因とは考えにくい。ただし、低消費電力端末とcatch-up時の余裕を増やす価値はある。

### 2.3 simの包括時間プロファイル

メソッド境界に計測ラッパーを置いた10,000 stepの結果。ラッパー自体のオーバーヘッドを含むため、絶対値ではなく構成比を見る。

|処理|累計|1 sim stepあたり|備考|
|---|---:|---:|---|
|`BubbleWorld.step`|1,141.95 ms|0.11419 ms|内包時間|
|`GridDetector.findPairs`|700.88 ms|0.07009 ms|計測全体の約55.6%|
|`SphereGrid.rebuild`|72.05 ms|0.00720 ms|`findPairs`に内包|
|`AggregatePacker.pack`|90.02 ms|0.00900 ms|全view集約|
|`DropletColumn.step`|14.72 ms|0.00147 ms|軽い|
|`WaterBody.commit`|8.65 ms|0.00086 ms|軽い|

衝突検出は、現在の粒子数15〜24体/球ではグリッド構築と27近傍セル走査の固定費が大きい。

### 2.4 描画パスの静的分析

通常時の主なscene drawは次の通り。

- Ocean: 1
- Environment: 1
- Backdrop: 1
- Droplet: 1
- Label: 1
- InnerWater volume near/far: 2
- InnerWater cap near/far: 2
- Glass back near/far: 2
- Glass front near/far: 2
- BloomApply: 1
- Spray: 可視時1

メインsceneだけで通常14前後、Spray可視時15前後になる。

さらに毎フレーム、概ね次が加わる。

- Ripple積分: 1 full-screen pass / sim step
- Ripple splat: イベント時1
- Bloom明部抽出: 1
- Bloom分離blur: 5 mip × 横縦 = 10
- Bloom合成: 1
- Output: 1

したがって60Hz・Bloom warm-up後の通常時でも、scene外を含めると約28 draw前後になる。フレームが2〜3 sim stepを消化するとRipple積分も2〜3回になる。

---

## 3. P0: 最初に実施したい改善

## 3.1 現在のペア順を保つ、小規模個体群向け直接衝突検出

実装済み: `d04e5f7`。正式なbefore / afterと完全一致検証は[`performance-results/20260714-ordered-direct-detector.md`](performance-results/20260714-ordered-direct-detector.md)を参照。

対象:

- `src/sim/physics/GridDetector.ts`
- `src/sim/physics/SphereGrid.ts`
- `src/sim/bubble/BubbleWorld.ts`

### 問題

各球の原子数は実測で15〜24程度だった。この規模では、4³セルのcounting sort、セル座標の再計算、最大27セルの走査が、単純な二重ループより高い。

同一スナップショット23球、46万回の `findPairs` 呼び出しで比較した。

|実装|時間|検出ペア数|
|---|---:|---:|
|現行GridDetector|1,560.21 ms|140,000|
|列挙順互換の直接走査|717.63 ms|140,000|

detector単体で約2.17倍速い。

sim全体20,000 stepでは次の結果だった。

|実装|時間|
|---|---:|
|現行GridDetector|2,497.24 ms|
|列挙順互換の直接走査|1,653.71 ms|

sim全体で約1.51倍。

### 重要: 普通のBruteForceへの置換は禁止

通常の `i → j` 順BruteForceは約1.80倍高速だったが、反応の適用順が変わり、20,000 step後のcounts、ledger、全viewが変化した。衝突集合が同じでも、反応順が変わるとRNG列が分岐するためである。

### 世界を変えない実装

現行GridDetectorの順序は、概ね次のキーで表現できる。

1. `i` 昇順
2. 相手 `j` のcell id昇順
3. 同一cell内の `j` 昇順

cell idは `x + 4 * (y + 4 * z)` であり、現行の `z → y → x` 昇順ループと一致する。

したがって、次の方式にする。

1. 全原子のcell idだけを固定配列へ計算する。
2. `i < j` の全ペアを二乗距離で判定する。
3. 実際に衝突した少数ペアだけを `(cell(j), j)` の順へ挿入する。
4. 現行と同じ順に `outPairs` へ書く。

この試作はseed 7 / 42 / 123 / 2026、各24球 × 10,000 stepで、counts、ledger、bubble curr/prev、atom curr/prev/color、droplet bufferが一致した。

### 実装方針

- 原子数が閾値以下ならordered direct、十分大きい場合だけ現行gridを使うadaptive方式でもよい。
- 現在の24球世界ではdirect側に入る閾値を、ベンチで決める。
- `outPairs` の型と使い回し規約は維持する。
- 新規配列はdetector構築時だけ確保する。
- RNGには一切触れない。

### 必須テスト

- ランダム配置で「ペア集合」ではなく「平坦なペア列全体」が現行GridDetectorと一致するテスト。
- 既存goldenの期待値を再記録せず、そのまま通す。
- 4 seed以上 × 10,000 stepの比較テストを校正スクリプト側で実行する。
- 24 / 64 / 128原子で閾値をベンチする。

---

## 3.2 EffectComposerの未使用フル解像度HDRターゲットを廃止

対象:

- `src/render/PostPipeline.ts`

### 問題

`EffectComposer` は渡されたrender targetをcloneし、read/writeの2枚を必ず持つ。しかし現在のpass列では次の通り、swap先を必要とする中間passがない。

- `RenderPass.needsSwap = false`
- `BloomMipsPass`は`UnrealBloomPass`由来で`needsSwap = false`、さらにwriteBufferを無視
- `OutputPass`は最後にscreenへ出力

つまり、フル解像度HDR+depthターゲットの片方は実質未使用である。

1920×1080 CSS px、DPR 2では物理解像度が3840×2160になる。RGBA16Fだけで約63.3 MiB、4 byte相当のdepthを含めると1枚あたり概ね94.9 MiBになる。これは特にモバイルGPU、統合メモリ、ANGLE/Metalで無視できない。

### 改善

`EffectComposer`の汎用ping-pongを外し、現在の固定パイプライン専用の小さなオーケストレータにする。

1. sceneを単一HDR+depth targetへ描く。
2. `BloomMipsPass`へ同targetをreadBufferとして渡す。
3. `OutputPass`で同targetを画面へ出す。
4. 前フレームBloomの二重化targetは現行の黒フレーム回避策なので維持する。

### 期待効果

- フル解像度HDR+depth targetを1枚削減。
- リサイズ時の再確保を1枚分削減。
- `EffectComposer`の不要なswap管理を除去。
- 現在のBloom 1フレーム遅延と黒フレーム回避経路は維持。

### 注意

- Bloomを同一フレームでOutputへ直接混ぜる変更は行わない。コード内にANGLE/Metalの黒フレーム実測根拠がある。
- 固定解像度・固定seedで、Bloomの前フレーム参照とwarm-up 2 frameを含む連続スクリーンショット比較を行う。

---

## 3.3 Backdropのper-vertex状態計算をper-instanceへ移す

対象:

- `src/render/backdrop/BackdropBubbles.ts`
- `src/render/shaders/backdrop.ts`

### 問題

Backdropは76インスタンス、detail 4のIcosahedronは1球1,500頂点なので、毎フレーム114,000頂点を処理する。

現在のvertex shaderは、同一インスタンスの全1,500頂点で次を繰り返す。

- hash用 `sin` ×6
- 幾何半径の `pow`
- `cos(angle)` / `sin(angle)`
- bob用 `sin`
- `mod` / `clamp` / `smoothstep`
- fog用 `distance` / `pow` / `exp`

hash用 `sin` だけで1フレーム684,000回、60fpsなら毎秒約4,104万回である。同じインスタンス内では結果が完全に同一なので、頂点単位で計算する理由がない。

### 改善案A: 静的部分だけ属性化

構築時に次を計算し、InstancedBufferAttributeへ置く。

- center x/z
- anchorY
- R
- hash seed
- period / cycle phase
- bob frequency / phase

vertex shaderには時間依存のbob、fall、sinkだけを残す。

初期アップロード1回のまま、6 hash、配置pow、角度sin/cosを全頂点から除去できる。
ただし配置の`t = aIdx / uCount`は品質ティアの個数変更に依存するため、`countFraction`が変わった時だけ静的属性を再生成する。

### 改善案B: 動的状態もCPUで76回だけ計算

毎フレームCPUで76インスタンス分だけ現在状態を計算し、次の2属性程度へ詰める。

- `[centerX, centerY, centerZ, scale]`
- `[waterLevel, alpha, seed, unused]`

転送量は76 × 8 floats = 2,432 bytes/frame程度。vertex shaderは `center + position * scale` が中心になる。

GPUのper-vertex超越関数を大きく減らせるため、まず案Bを実機GPUタイマーで比較したい。CPUの `Math.sin` とGLSLの丸め差は見た目に影響しないはずだが、固定フレーム画像の許容差で確認する。

### 追加効果

CPU側にcenter/radiusがあれば、保守的な球-frustum判定で完全に画面外のBackdropを除外できる。半透明順を変えず、元のindex順を保ったvisible prefixへ詰める。

---

## 3.4 Sprayの4096体固定描画と全バッファ転送をやめる

部分実装・採用済み: リングの初回飽和までは、まだ一度も書かれていないsuffixを描画対象から除外する。正式結果は[`performance-results/20260714-spray-initialized-prefix.md`](performance-results/20260714-spray-initialized-prefix.md)を参照。イベント時compactと部分uploadは、粒子のα合成順を保つ設計・計測を別作業単位で行う。

対象:

- `src/render/particles/SpraySystem.ts`

### 問題

`geometry.instanceCount` は常に `SPRAY_CAPACITY = 4096`。イベント中だけMeshをvisibleにするが、可視中は未スポーン・寿命切れを含む全4,096インスタンスのvertex shaderを実行し、shader内の`kill`で縮退している。

1回の着水+ポップで実際に生まれる粒は、概ね数十〜百数十程度である。大半のインスタンスは不可視判定のためだけに頂点処理される。

またイベント時は、変更した範囲に関係なく次の全容量をアップロードする。

- spawn: 4096 × 4 floats
- velocity: 4096 × 4 floats
- tint: 4096 × 3 floats
- 合計180,224 bytes、約176 KiB/イベント

### 改善

イベント時だけ既存の生存粒をprefixへcompactし、新規粒を末尾へ追加する。

- `instanceCount = liveCount`
- 書き換えたprefixだけupdate rangeへ指定
- 通常フレームは位置がshader閉形式なのでアップロードなし
- 複数イベントが同stepに来てもcapacityまでappend
- capacity超過時の既存の優雅な劣化方針は維持

リングバッファを維持したい場合でも、wrap前後の最大2 update rangeだけを送ればよい。ただし描画prefix化まで考えると、イベント頻度が低い本作ではイベント時compactの方が単純である。

### 期待効果

- イベント中のvertex invocationを概ね30〜60分の1に削減候補。
- CPU→GPU転送を数KiB程度へ縮小。
- shaderの見た目・弾道式・seedは不変。

---

## 3.5 view.stepとdirty versionでGPU再転送を制御

部分実装・採用済み: Atom / Dropletは同一`view.step`、Bubbleは同一stepかつsort・LOD layout不変時の再uploadを省略する。120Hzで49〜50%、144Hzで57〜58%の要求bytes削減を確認した。正式結果は[`Atom`](performance-results/20260714-atom-step-upload.md) / [`Droplet`](performance-results/20260714-droplet-step-upload.md) / [`Bubble`](performance-results/20260714-bubble-layout-upload.md)を参照。静的metadataのdirty version分離は別作業単位として残す。

対象:

- `src/render/atoms/AtomViewAttributes.ts`
- `src/render/atoms/DropletSystem.ts`
- `src/render/bubbles/BubbleInstanceBuffers.ts`
- `src/contract/RenderView.ts`
- `src/sim/view/AggregatePacker.ts`

### 問題1: 0-step frameでも再アップロード

120Hzではsimが進むのは概ね2フレームに1回、144Hzでは約42%のフレームだけである。それでも現在は毎rAFでatom 4属性、droplet 3属性、bubble near/far各5属性を`needsUpdate`にしている。

`alpha`はuniformなので、viewが同じならattributeを再送しなくても補間表示は正しい。

### 改善1

- `lastUploadedStep`を持つ。
- `view.step`と配列generationが同じならatom/dropletのupdate rangeを立てない。
- bubbleはカメラ移動でsort/LOD/ripple indexが変わり得るので、orderとbucket境界も比較する。
- order、bucket、ripple mapping、view.stepが全て同じならbubble uploadを省略する。

期待上限は、120Hzで動的属性転送約50%、144Hzで約58%の省略。

### 問題2: 静的metadataも毎step送る

Atomの`colorKind`と`aux`、Dropletの`aux`は、位置と違って毎step変わらない。生成、消滅、dense順変更時だけ変化する。

### 改善2

- 再確保用の`version`とは別に、内容変更用`contentVersion`または`topologyVersion`を追加する。
- position curr/prevはsim stepごとに更新。
- metadataは生成・反応・溶解・sweep・clear時だけ更新・転送。
- render側はmetadata versionが同じなら`needsUpdate`を立てない。

契約の意味を明確にするため、既存`version`を別用途へ流用せず、新しい名前を追加する方が安全。

---

## 3.6 海面解析反射のuniform配列を実使用数へ縮小

実装・採用済み。正式なbefore / afterは[`performance-results/20260714-ocean-reflection-uniforms.md`](performance-results/20260714-ocean-reflection-uniforms.md)を参照。

対象:

- `src/render/ocean/OceanSystem.ts`
- `src/render/shaders/ocean.ts`

### 問題

shaderのループ上限とCPU選抜は `MAX_REFLECT_BUBBLES = 8` なのに、uniformは次のように `BUBBLE_CAPACITY = 128` で宣言・構築される。

- `uBubblePosR[128]`
- `uBubbleMisc[128]`
- 合計256 vec4

実際に読むのは先頭8要素ずつ、合計16 vec4だけである。コメントには過去の容量16という記述も残っており、実装と説明が乖離している。

### 改善

- GLSL配列長を`MAX_REFLECT_BUBBLES`にする。
- JS側の`Vector4[]`も各8要素だけ確保する。
- `candSlot` / `candD2`は候補全体を扱うので現状容量を維持してよい。

### 効果

- fragment uniform使用量を256 vec4から16 vec4へ縮小。
- Three.js側のuniform flatten、比較、アップロード対象を縮小。
- 小さいuniform上限のGPUに対する互換性余裕を増やす。
- shader出力は同一。

---

## 3.7 実質消滅したnear/far LODを統合

試作・不採用。全球`all` bucketを追加してGlassを4→2 draw、InnerWater volumeを2→1 drawへ統合したが、追加attribute転送に対してGPU / Frame時間の改善が一貫しなかった。製品コードは戻した。正式結果は[`performance-results/20260714-identical-lod-draw-rejected.md`](performance-results/20260714-identical-lod-draw-rejected.md)を参照。

対象:

- `src/render/bubbles/BubbleInstanceBuffers.ts`
- `src/render/bubbles/BubbleGlassSystem.ts`
- `src/render/bubbles/InnerWaterSystem.ts`

### 問題

過去の画質改善により、現在は次がnear/farともdetail 4で同一。

- Glass sphere
- InnerWater volume sphere

それでもnear/farを別geometry・別drawとしているため、LODとしての頂点削減効果がない。

現状:

- Glass back: 2 draw
- Glass front: 2 draw
- InnerWater volume: 2 draw
- InnerWater cap: 2 draw
- 合計8 draw

### 改善

全球のfar-to-near順を保った`all` bucketを追加する。

- Glass back: all bucket 1 draw
- Glass front: all bucket 1 draw
- InnerWater volume: all bucket 1 draw
- InnerWater cap: detailが異なるためnear/far 2 drawを維持
- 合計5 draw

同じdetail 4ジオメトリと同じmaterialを統合するだけなので、表示内容は変わらない。半透明のpainter's orderは、全体のfar-to-near順を1本で保持すれば現在より直接的になる。

### 併施したいこと

- `Dead`はshaderでゼロ縮退させず、draw listから除外する。
- conservative sphere-frustum cullingを追加する。
- Splashingの最大1.25倍膨張、stretch、wobbleを含む安全半径を使い、画面端のpopを防ぐ。
- ripple履歴の管理は描画cullingと分離し、画面外から入ってきた球の波紋履歴を失わないようにする。

---

## 4. P1: CPU・GC・リサイズの改善

## 4.1 hot pathの小さなアロケーションをゼロへ寄せる

部分実装済み: `AggregatePacker`のsubarray view除去は`6e95dc1`。正式結果は[`performance-results/20260714-packer-subarray.md`](performance-results/20260714-packer-subarray.md)を参照。他のhot pathアロケーションは未実装。

対象:

- `src/sim/view/AggregatePacker.ts`
- `src/app/accumulator.ts`
- `src/render/AdaptiveQuality.ts`
- `src/render/SceneRenderer.ts`
- `src/render/atoms/AtomViewAttributes.ts`
- `src/render/atoms/DropletSystem.ts`
- `src/render/bubbles/BubbleInstanceBuffers.ts`

### TypedArray.subarrayの生成

`AggregatePacker.pack`は球ごとに最大3回、8要素コピーのための`subarray` viewを作る。

24球 × 2 view × 60 step = 2,880 TypedArray view/秒。

8要素なら添字ループまたは手動unrollで十分である。24,000,000コピーの合成ベンチでは次の結果だった。

|方式|時間|
|---|---:|
|`set(subarray(...))`|944.58 ms|
|添字ループ|259.15 ms|

合成ベンチでは約3.64倍。`AggregatePacker`全体は約0.010 ms/stepなので平均CPU削減は小さいが、短命viewをなくしてGCスパイクを抑える価値がある。`StubSim`にも同種の箇所がある。

### update rangeオブジェクト

Three.jsの`addUpdateRange`は毎回 `{ start, count }` をpushし、描画後に配列をclearする。通常フレームではbubble 10、atom 4、droplet 3で、少なくとも約17個のrangeオブジェクト/フレームを作る。

属性ごとにrangeオブジェクトを1個保持し、rendererがclearした配列へ同じオブジェクトを再pushするhelperにまとめる。dirty upload自体を減らす3.5節と併用する。

### 毎フレームの配列・状態オブジェクト

次をin-place更新へ寄せる。

- `accumulate()`の戻りオブジェクト
- `AdaptiveQuality.updateEma()`の`EmaState`
- `SceneRenderer.render()`の`FrameInfo`
- `for (const attr of [a, b, c])`の一時配列

純関数テスト用APIは残し、実行時classだけprimitive fieldをin-place更新する構成でもよい。

---

## 4.2 resizeを冪等化し、Bloom targetの多重再確保を止める

対象:

- `src/render/SceneRenderer.ts`
- `src/render/PostPipeline.ts`
- `src/app/main.ts`

### 問題

`PostPipeline.setSize`は次を連続で呼ぶ。

1. `composer.setPixelRatio(pixelRatio)`
2. `composer.setSize(width, height)`

Three.jsの`EffectComposer.setPixelRatio`は内部で`setSize`を呼ぶため、composer本体と全passが最低2回resizeされる。その後`applyBloomSize()`がBloomを再度resizeする。

さらに起動時は次が重なり得る。

- `SceneRenderer` constructor末尾の`resize()`
- 初期`applyTier()`内の`resize()`
- `ResizeObserver`初回callback

desktop tier 0でも、同じサイズを複数回再確保する可能性がある。

### 改善

- CSS width / height / effective pixelRatioの前回値を保持する。
- 全値が同じなら即returnする。
- 初期tierを`SceneRenderer` constructorへ渡し、tier 0の二重適用を避ける。
- 3.2の専用PostPipeline化で、device sizeを一度だけ各targetへ伝える。
- ResizeObserverの連続通知は次のrAFへcoalesceする。

この改善は定常fpsより、起動、回転、ウィンドウresize時のVRAM再確保ヒッチに効く。

---

## 4.3 Ocean fragment shaderの共通式を1回だけ評価

対象:

- `src/render/shaders/ocean.ts`
- `src/render/shaders/sky.ts`

見た目を変えずにまとめられる式がある。

- `swellZoneGain`と`rippleMask`がそれぞれ`length(xz)`を計算する。
- `normalize(vWorldPos - cameraPosition)`と`distance(...)`が同じ長さを再計算する。
- `reflectEnv`のhit時に`sky(rd)`を再評価している。先頭で得た`env`を再利用できる。
- fog用`sky(viewDir)`は他の同一方向評価と共有できる箇所がある。
- `sky()`内で固定`uSunDir.xz`を毎回normalizeしている。正規化済み水平太陽方向をuniformまたは定数で渡せる。

Oceanは画面占有率が高いため、fragmentあたり数命令・数個の超越関数でも総量が大きい。演算順変更で最下位bitは変わり得るため、HDR出力または最終画像の許容誤差を明示して比較する。

---

## 4.4 共有billboard geometryを1個だけ持つ

対象:

- `src/render/atoms/billboard.ts`
- `src/render/atoms/LabelSystem.ts`
- `src/render/atoms/DropletSystem.ts`
- `src/render/particles/SpraySystem.ts`
- `src/render/ocean/RippleField.ts`

同一のquad position/indexを複数システムが個別に確保している。VRAM効果は小さいが、所有者を`SceneRenderer`または小さなresource poolへ集約し、参照カウントまたは一括disposeにする。

これは単独では優先度が低い。GPU resourceライフサイクル整理と、将来のmaterial/geometry集約の足場として行う。

---

## 5. P2: 起動・配信・保守性

## 5.1 debug専用コードをdynamic importへ分離

対象:

- `src/app/main.ts`
- `src/sim/StubSim.ts`
- `src/app/StatsOverlay.ts`

`StubSim.ts`はTypeScriptソースで約22.6 kBあり、通常表示では使用しない。`sim=stub`のときだけdynamic importする。`StatsOverlay`も`m=1`時だけ読み込める。

通常bundleの初期parse/compileを少し減らせる。Three.jsと本描画コードは初画面に必要なので、無理に細分化してwaterfallを増やさない。

`DOMContentLoaded` callbackをasyncにする場合は、通常経路の`MizuNiNaruSim`を同期importのまま残し、debug分岐だけawaitするのが安全。

---

## 5.2 起動時計算を分離計測する

共有noise 256²の生成は、この環境で中央値約4.90 msだった。単独では大問題ではないが、次と同じmain thread区間へ集中する。

- noise生成
- label atlas 1536×384描画とmipmap生成
- ocean geometry生成
- detail 4 sphere geometry生成
- shader compile/link
- render target確保

`performance.mark()`で次を分ける。

- sim init
- procedural assets
- geometry construction
- renderer construction
- first submit
- first non-black present

Noiseの静的asset化は、ネットワーク転送・decodeとの交換になるため、実測でfirst frameが改善する場合だけ採用する。生成結果自体は完全同一のbyte列にする。

---

## 5.3 容量定数を「実構成」と「debug上限」に分けて監視

現在は過去の96球構成に由来する容量が残る。

- `BUBBLE_CAPACITY = 128`
- `ATOM_VIEW_CAPACITY = 4096`
- `DROPLET_VIEW_CAPACITY = 8192`

現在の既定は24球だが、`?slots=`で上限構成を試せるため、単純に縮めるべきではない。一方、GPU bufferとsim bufferを常にdebug最大で確保する必要があるかは分けて考えられる。

候補:

- `slotCount`から安全上限を計算し、renderer構築時に容量を渡す。
- debug 128球時だけ大容量bufferを確保する。
- contract上限は維持しつつ、GPU stagingだけ実構成に合わせる。

ただし削減量はフル解像度HDR targetよりかなり小さいため、3.2を先に行う。

---

## 6. 計測基盤の不足と追加案

## 6.1 現在のStatsOverlayはGPU時間を測っていない

`Update`は`sim.step() × n + renderer.render()`のJavaScript実行時間であり、GPU完了時間ではない。GPU command submissionが速くても、GPU側で詰まっている可能性がある。

`?m=1`のときだけ次を追加する。

- `EXT_disjoint_timer_query_webgl2`
- `renderer.info.render.calls`
- `renderer.info.render.triangles`
- `renderer.info.memory.geometries`
- `renderer.info.memory.textures`
- sim step数
- upload bytes概算
- viewのatom/droplet/bubble count

GPU queryは数フレーム遅延で回収し、同期readbackをしない。
本作は1フレーム内で`renderer.render()`を複数回呼ぶため、`renderer.info.autoReset = false`としてフレーム先頭で明示resetし、全パスの合計を取る。

### 区間

- Ripple splat
- Ripple integrate
- Main scene
- Bloom high pass
- Bloom blur全体
- Bloom composite
- Output

これにより、Backdrop、Ocean fragment、Bloom、Rippleのどれが端末別に律速か判断できる。

## 6.2 performance testの実態を修正

`tests/sim/mizuNiNaruSim.perf.test.ts`はテスト名とコメントが「96球」のままだが、実際の引数は`SLOT_COUNT_DESKTOP`であり、現在は24球しか測っていない。5 ms/step上限も、旧実測0.59 ms/stepを前提にしたままである。

次の2本へ分ける。

1. production 24球の回帰ベンチ
2. stress 96または128球の回帰ベンチ

CIの不安定なwall timeだけに頼らず、ローカル用の詳細benchでmedian / p95を保存する。テスト名に定数ではなく実際の球数を出す。

## 6.3 表示不変の検証

固定条件のレンダーgoldenを追加する。

- viewport固定
- DPR固定
- `seed=7`
- `q=0`
- parallax無効
- step 0 / 120 / 600 / 着水直後
- WebGL renderer/vendorを記録

比較は次の2段階にする。

- exact対象: draw list、instance count、uniform値、attribute prefix
- image対象: SSIMまたは小さなpixel tolerance

Bloomは1フレーム遅延なので、単発画像ではなく連続3〜5フレームを比較する。

---

## 7. 作業単位ごとの計測ゲート

各改善は、実装・計測・採否判定までを1作業単位とする。次の作業へ進む前に、その単位だけの効果を確定する。計測しにくい変更を後続の改善へ混ぜ、合算値で有効に見せてはならない。

### 7.1 作業単位

原則は「1ボトルネック、1仮説、1変更」である。

- ordered direct collision detectorへの置換
- `AggregatePacker`のsubarray view除去
- Sprayのlive prefix化
- step/versionによるGPU upload抑制
- reflection uniform縮小
- Glass / InnerWaterのLOD draw統合
- Backdropのper-instance化
- post-processing targetの単一化

上記はそれぞれ別々に計測する。例えばSprayの描画数削減とattribute転送抑制は、関連していても別の作業単位にする。計測基盤追加は例外的に性能改善を目的としない単位だが、`?m=1`以外の通常経路にオーバーヘッドがないことを確認する。

### 7.2 beforeを取るタイミング

最初の変更前の全体基準は[`performance-results/20260714-baseline.md`](performance-results/20260714-baseline.md)で固定した。さらに各作業の開始直前にも、対象主指標のbeforeを同じブランチ・同じ環境で取り直す。

手順は常に次の順とする。

1. 作業開始直前のコミットを記録する。
2. 未変更状態で対象主指標を測る。
3. 1つの改善だけを実装する。
4. 同じコマンド・seed・warm-up・反復数でafterを測る。
5. 不変性と回帰指標を確認する。
6. 採用または不採用を決め、結果をMarkdownへ残す。
7. 採用時だけ、その作業単位をコミットする。

beforeの無い変更を「性能改善」としてコミットしない。

### 7.3 固定条件

同一マシン、同一電源状態、同一ブラウザ、同一viewport、同一DPR、同一品質tierで、before / afterを同じセッション内に交互に測る。開発サーバーのHMRやDevTools表示を計測経路へ入れず、production buildを使用する。

各記録に次を残す。

- before / afterのGit SHA
- 計測日時、機種、CPU、GPU renderer、OS、Node.js、ブラウザの版
- viewport、DPR、`seed`、`slots`、`q`、`m`、`sim`
- warm-up時間・step数、計測時間・反復回数
- 実行コマンドと使用した計測スクリプト
- 電源状態、thermal throttling、目立つバックグラウンド負荷

変更と同時に依存関係やブラウザを更新しない。環境差が避けられない結果は同一系列として比較しない。

### 7.4 最低反復数

#### シミュレーション / JavaScript hot path

- 固定seedで2,000 step以上warm-upする。
- 10,000 stepを1試行とし、before / afterを各7試行以上測る。
- median、p95、min、max、CVを記録する。
- 局所メソッドとsim全体の両方を測る。
- seed 7 / 42 / 123 / 2026で最終状態の一致も確認する。

#### フレーム / GPU

- production buildをreload後15秒以上warm-upする。
- 30秒を1試行とし、before / afterを各5試行以上測る。
- rAF frame timeのp50 / p95 / p99、CPU Update、対象GPU時間を記録する。
- draw call、triangleまたはsubmitted vertex、instance、upload bytes、render target数も記録する。
- GPU timerがdisjointになった試行は捨て、再計測する。
- 60 Hz VSyncに張り付く環境ではFPSを主指標にしない。

#### 起動 / resize

- cold cacheとwarm cacheを分離する。
- 各10試行以上を取り、medianとp95を記録する。
- resizeは同一の解像度列とDPR列を再生し、render target再確保回数も数える。

### 7.5 改善ごとの主指標

|作業単位|主指標|回帰指標|
|---|---|---|
|ordered direct collision|detector時間、sim全体のms/step|ペア列順、最終sim状態|
|subarray view除去|packer時間、allocation数|sim全体のms/step、view内容|
|Spray live prefix|spray instance数、upload bytes、Spray GPU時間|着水直後の連続画像|
|step/version upload制御|upload bytes/frame、CPU Update、120/144Hz frame p95|補間、60Hz frame p95|
|reflection uniform縮小|uniform数・転送量、Ocean GPU時間|反射対象の列順、画像|
|LOD draw統合|draw call、Main scene GPU時間|depth、透明合成、画像|
|Backdrop per-instance化|submitted vertex仕事量、Backdrop GPU時間|tier変更後の配置、連続画像|
|post target単一化|render target数、推定VRAM、resize時間|全post pass GPU時間、画像|
|Ocean式共通化|Ocean GPU時間|shader compile、画像|

局所指標だけ速くても、sim全体またはframe p95 / p99が悪化していないか必ず確認する。

### 7.6 採否基準

次をすべて満たした変更だけを採用する。

1. 主指標が改善している。時間指標はmedianの差がbaselineの試行間ノイズを超え、可能なら差のbootstrap 95%信頼区間が0をまたがない。
2. draw call、instance、upload bytes、render target数のような決定論的指標は、意図した値まで確実に減っている。
3. frame p95 / p99、sim全体、起動、resizeなどの回帰指標が計測ノイズを超えて悪化していない。
4. 既存テスト、sim golden、render golden、不変条件をすべて満たす。
5. raw値と判断理由が記録されている。

主指標が改善しない、改善幅がノイズ内、または別の重要指標を悪化させた変更は不採用とする。将来の改善を可能にする構造変更なら「性能改善」ではなく「前提リファクタリング」と明記し、通常経路の非劣化を同じ手順で証明する。不採用の変更を次の最適化へ混ぜて効果を相殺しない。

### 7.7 記録テンプレート

各結果は`performance-results/YYYYMMDD-<slug>.md`のような独立ファイルへ残す。

```md
# <作業単位名>

## 仮説

- 対象ボトルネック:
- 変更内容:
- 世界観・結果を維持できる根拠:

## 条件

- before SHA:
- after SHA:
- 環境:
- URLパラメータ / viewport / DPR:
- warm-up / 計測時間 / 反復数:
- コマンド:

## 結果

|指標|Before|After|差分|変化率|ばらつき・信頼区間|判定|
|---|---:|---:|---:|---:|---:|---|
|主指標|||||||
|全体指標|||||||
|回帰指標|||||||

## 不変性

- 既存テスト:
- sim golden:
- render golden:
- その他の不変条件:

## 判断

- 採用 / 不採用 / 前提リファクタリング
- 理由:
```

---

## 8. 実装順

### Phase 1: 測定と安全柵

1. GPU timerとrenderer.infoを`?m=1`へ追加。
2. production 24球 / stress 128球のbenchを分離。
3. 固定seedのrender goldenを追加。
4. 現行GridDetectorの「ペア列順」を固定するテストを追加。

以降は各番号を1作業単位とし、直後に第7章の計測ゲートを通過してから次へ進む。

### Phase 2: 完全に結果を変えないCPU改善

1. ordered direct collision detector。
2. `AggregatePacker`のsubarray view除去。
3. hot pathの一時配列・状態オブジェクト削減。
4. `view.step` / metadata dirty versionによるupload抑制。
5. reflection uniformを8枠へ縮小。

### Phase 3: GPU構造改善

1. Sprayのlive prefix化。
2. Glass / InnerWater volumeのall bucket統合。
3. Dead / offscreenの保守的culling。
4. Backdropのper-instance化。
5. 単一HDR targetの専用PostPipeline化。

### Phase 4: shaderの共通式整理

1. Oceanの重複`length` / `sky`評価を統合。
2. 実機GPU timerで前後比較。
3. 画像goldenの許容差内であることを確認。

---

## 9. 採用しない改善

次は数値上速くても、本リファクタリングでは行わない。

- 球体detailを下げる。
- 既定の球数・Backdrop数を減らす。
- Bloom、Ripple、Spray、解析反射を通常品質から削る。
- simを30Hzへ落とす。
- RNG呼び順を変える。
- 衝突ペアの集合だけ合わせ、順序差を許容する。
- 水位、落下、カメラ、Gerstner波の係数を調整して軽くする。
- 低DPRを既定にして問題を隠す。
- 画面外cullingで画面端の球やしぶきを欠けさせる。

---

## 10. 完了条件

改善完了は、単にfpsが上がった時ではなく、次をすべて満たした時とする。

- 既存224テストが期待値の再記録なしで通る。
- sim goldenがseed 7 / 42 / 123 / 2026で一致する。
- production 24球のsim中央値が悪化しない。
- stress 128球のsim中央値が悪化しない。
- 固定フレーム画像が許容差内。
- 各作業単位で定めた主指標が、beforeの計測ノイズを超えて明確に改善する。
- 全作業単位に独立した計測結果Markdownがあり、raw値と採否理由を追跡できる。
- tier 0の表現を一切削っていない。
- mobile初期tier 2、desktop初期tier 0、`?q=`、`?m=1`、`?sim=stub`が維持される。
- visibility復帰、resize、orientation changeで黒フレーム・未初期化FBO・波紋二重注入がない。

この条件なら、「水になる」の世界を変えずに、同じ一滴、同じ球、同じ海を、より少ない仕事で描ける。
