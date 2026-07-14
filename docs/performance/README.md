# パフォーマンス計測ツール利用ガイド

このプロジェクトに常設しているパフォーマンス計測・互換性検証ツールの使い方をまとめる。

すべてリポジトリのルートでターミナルから実行する。Node REPLやブラウザ内の開発者向け実行機能は不要である。

## 最初に知っておくこと

必要なもの:

- Node.js 22
- `npm install`済みの依存パッケージ
- `bench:browser`を使う場合のみGoogle ChromeまたはChromium

まず全体のシミュレーション性能を確認するだけなら、次のコマンドでよい。

```sh
npm run bench:sim
```

描画やGPU転送まで含めて確認する場合は、ブラウザベンチマークを使う。

```sh
npm run bench:browser -- --output docs/2026-07-14/performance-results/raw/browser.json
```

出力先の日付とファイル名は作業日に合わせて変更する。`bench:browser`は出力先ディレクトリも自動作成する。

## 目的別の選び方

|確認したいこと|コマンド|主に見る値|
|:---|:---|:---|
|シミュレーション全体が速くなったか|`npm run bench:sim`|`medianMsPerStep`、全sample、`coefficientOfVariation`|
|シミュレーション内の重い処理を探したい|`npm run profile:sim`|処理ごとの`medianMsPerStep`|
|衝突検出器の切替閾値を比較したい|`npm run bench:detectors`|`gridMedianMsPerCall`、`directMedianMsPerCall`、`directSpeedup`|
|衝突検出器の変更で世界が完全一致するか|`npm run verify:detectors`|正常終了、`exactMatch: true`|
|高リフレッシュレート時の不要uploadを調べたい|`npm run bench:uploads`|各系統のupload frame率、要求回数、要求bytes|
|本番描画、GPU、draw call、転送量を測りたい|`npm run bench:browser`|`frameMs`、`updateMs`、`gpuMs`、WebGL各指標|

`profile:sim`は改善候補を探す道具で、採否を決める最終ベンチマークではない。`verify:detectors`は性能ではなく、結果の完全一致を確認する道具である。

## 共通の計測ルール

パフォーマンス変更は、必ず次の単位で進める。

1. 変更前のGit SHAと作業ツリー状態を記録する。
2. 製品コードを変更する前に、対象指標のbeforeを計測する。
3. 1作業単位では1つの仮説だけを実装する。
4. beforeと同じコマンド、オプション、端末状態でafterを計測する。
5. 中央値だけでなく全sampleとばらつきも確認する。
6. テストと必要な完全一致検証を実行する。
7. 結果と採否をMarkdownへ残す。不採用なら製品コードを戻す。

シミュレーション変更を測る最短例:

```sh
git rev-parse HEAD
git status --short
npm run bench:sim > docs/2026-07-14/performance-results/raw/20260714-example-before.json
```

1つの変更だけを実装したあと、同じ条件でafterを取る。

```sh
npm run bench:sim > docs/2026-07-14/performance-results/raw/20260714-example-after.json
npm test
```

描画変更では`bench:sim`を`bench:browser -- --output ...`へ置き換え、変更内容に応じて`bench:uploads`などの直接指標も併用する。

ブラウザやGPUを測るときは、ほかのブラウザ、動画再生、重いアプリを閉じる。電源状態、画面解像度、Chrome、viewport、URLパラメータもbefore / afterで揃える。

rawデータは次のように日付単位で保存する。

```text
docs/
  2026-07-14/
    performance-results/
      20260714-example.md
      raw/
        20260714-example-before.json
        20260714-example-after.json
```

## `bench:sim`: シミュレーション全体

`MizuNiNaruSim.step()`のwall timeを固定seedで反復計測する。DOM、Three.jsの描画、GPUは含まない。

```sh
npm run bench:sim
```

既定条件:

|項目|既定値|
|:---|---:|
|seed|7|
|slots|24, 128|
|pacing|desktop|
|ウォームアップ|2,000 step|
|計測|10,000 step / round|
|round数|7|

オプション:

|オプション|意味|例|
|:---|:---|:---|
|`--seed`|乱数seed|`--seed 42`|
|`--slots`|カンマ区切りの球体数|`--slots 24,128`|
|`--pacing`|`desktop`または`mobile`|`--pacing mobile`|
|`--warmup`|計測前に進めるstep数|`--warmup 2000`|
|`--steps`|1 roundで測るstep数|`--steps 10000`|
|`--rounds`|反復回数|`--rounds 7`|

条件を明示する場合:

```sh
npm run bench:sim -- --slots 24,128 --rounds 7 --warmup 2000 --steps 10000
```

JSONを保存する場合:

```sh
npm run bench:sim > docs/2026-07-14/performance-results/raw/20260714-sim-before.json
```

結果の見方:

- `samplesMsPerStep`: 各roundの実測値。外れ値や全体的な移動を確認する。
- `medianMsPerStep`: 採否の中心となる中央値。小さいほど速い。
- `p95MsPerStep`: 遅い側のsample。7 roundでは最大値と同じになりやすいので、中央値と全sampleを併記する。
- `coefficientOfVariation`: 標準偏差を平均で割ったばらつき。大きい場合は環境ノイズを疑う。
- `finalCounts`: 計測終了時の世界の個数。before / afterで予期せず変わっていないかを見る。

異なるマシンの絶対値より、同じマシンで連続して取ったbefore / afterを優先する。

## `profile:sim`: シミュレーション内の候補探索

主要メソッドを薄い計測ラッパーで包み、どの処理に時間を使っているかを調べる。

```sh
npm run profile:sim
```

既定値はseed 7、24 slots、2,000 stepウォームアップ、10,000 step計測、7 round。`--seed`、`--slots`、`--warmup`、`--steps`、`--rounds`で変更できる。

現在の計測対象:

- `BubbleWorld.step`
- `OrderedDirectDetector.findPairs`
- `GridDetector.findPairs`
- `SphereGrid.rebuild`
- `DropletColumn.step`
- `AggregatePacker.pack`
- `WaterBody.commit`

`medianMsPerStep`が大きい処理を改善候補にする。ただし計測ラッパーのコストを含み、親子の処理時間も重複するため、行を合計してはならない。改善を実装したら`bench:sim`で改めてbefore / afterを判定する。

## `bench:detectors`: 衝突検出器の比較

`GridDetector`と`OrderedDirectDetector`を同じAtom配置で測り、小規模直接走査からGridへ切り替える閾値を検討するためのmicrobenchmark。

```sh
npm run bench:detectors
```

既定条件は24 / 40 / 64 / 128 atoms、5,000回 / round、5 round、seed 7。

|オプション|既定値|意味|
|:---|:---|:---|
|`--counts`|`24,40,64,128`|比較するAtom数|
|`--iterations`|`5000`|1 round内の呼び出し回数|
|`--rounds`|`5`|反復回数|
|`--seed`|`7`|Atom配置のseed|

各Atom数で、計測前に検出ペア数とペア順の一致も検査する。`directSpeedup`はGrid中央値をdirect中央値で割った値で、1より大きければdirectのほうが速い。実行順による偏りを抑えるため、roundごとに両方式の計測順を交互にしている。

## `verify:detectors`: 衝突検出器の完全一致

Grid参照実装と本番検出器を長時間同期実行し、世界の状態が数値単位で完全一致することを確認する。

```sh
npm run verify:detectors
```

既定条件はseed 7 / 42 / 123 / 2026、24 slots、10,000 step、1,000 stepごとのcheckpoint。合計40 checkpointを検証する。

|オプション|既定値|意味|
|:---|:---|:---|
|`--seeds`|`7,42,123,2026`|検証するseed|
|`--slots`|`24`|球体数|
|`--steps`|`10000`|seedごとの総step数|
|`--checkpoint`|`1000`|完全比較する間隔|

比較対象はcounts、mass ledger、Bubble、Atom、Droplet、Splash、Rippleの有効なrender view値。成功時は`exactMatch: true`を含むJSONを出力し、不一致があれば該当位置を表示して終了コード1になる。

これは現在の衝突検出器切替に特化した検証であり、すべての描画変更を保証する汎用golden testではない。

## `bench:uploads`: attribute upload要求

60 Hz固定シミュレーションを60 / 120 / 144 Hzの表示スケジュールで消費し、Three.jsの`BufferAttribute.version`増加をGPU upload要求の代理値として数える。ブラウザやWebGLは起動しない。

```sh
npm run bench:uploads
```

|オプション|既定値|意味|
|:---|:---|:---|
|`--seed`|`7`|乱数seed|
|`--slots`|`24`|球体数|
|`--warmup`|`2000`|ウォームアップstep数|
|`--seconds`|`60`|refresh rateごとの仮想計測時間|
|`--refresh`|`60,120,144`|カンマ区切りの表示Hz|

Atom、Droplet、camera sortされるBubbleを個別集計する。各系統で主に見る値は次のとおり。

- `uploadFrames`系: upload要求が発生したframe数。
- `uploadRequests`系: attribute versionが増えた回数。
- `requestedBytes`系: driverへ要求され得るbytesの推定値。
- `uploadFrameRatio`系: 全frameのうちupload要求が発生した割合。
- `meanRequestedBytesPerFrame`系: 1 frameあたりの平均要求bytes。

高refresh rateで同じsimulation stepを複数回描く場合の、不要な再upload削減を評価するのに向く。これはdriverが実際に転送したbytesの直接測定ではないため、採用候補は`bench:browser`の`bufferSubDataBytes`でも確認する。

## `bench:browser`: 本番ブラウザ / GPU

本番ビルドを作成し、独立したVite preview、専用profileのheadless Chrome、Chrome DevTools Protocolを使って固定条件で測る。計測後はpreview、Chrome、一時profileを終了・削除する。

```sh
npm run bench:browser -- --output docs/2026-07-14/performance-results/raw/20260714-browser-before.json
```

このnpm scriptは最初に`npm run build`を実行する。既定では15秒のウォームアップ後、30秒のroundを5回測るため、完了まで数分かかる。

既定URL:

```text
http://127.0.0.1:4173/?seed=7&slots=24&q=0&m=1&dpr=1&probe=1
```

|オプション|既定値|意味|
|:---|:---|:---|
|`--url`|上記URL|計測対象。`localhost`または`127.0.0.1`のみ|
|`--warmup`|`15`|round開始前のウォームアップ秒数|
|`--seconds`|`30`|1 roundの計測秒数|
|`--rounds`|`5`|round数|
|`--width`|`1440`|viewport幅|
|`--height`|`727`|viewport高さ|
|`--chrome`|自動検出|Chrome実行ファイルの絶対パス|
|`--output`|未指定|JSON保存先。省略すると標準出力|

`--url`を指定しても`probe=1`は自動付与される。通常の作品表示では詳細probeは読み込まれず、`probe=1`のときだけWebGL呼び出しを薄くラップする。`m=1`は軽量オーバーレイで、詳細probeとは別の機能である。

主な指標:

|指標|意味|小さい場合の意味|
|:---|:---|:---|
|`frameMs`|rAF間のframe時間|表示が滑らか|
|`updateMs`|アプリのJS update区間|CPU側の更新が軽い|
|`drawCalls`|1 frameのdraw call数|driver呼び出しが少ない|
|`instancedDrawCalls`|instanced draw call数|instance描画呼び出しが少ない|
|`submittedVertices`|drawへ渡したvertex / index数×instance数|vertex処理の入力が少ない|
|`bufferSubDataBytes`|`bufferSubData`へ渡したbytes|attribute転送要求が少ない|
|`uniform4fvBytes`|`uniform4fv`へ渡したbytes|uniform転送要求が少ない|
|`gpuMs`|GPU timer queryによるframe GPU時間|GPU処理が軽い|

各指標には`count`、`min`、`p50`、`p95`、`p99`、`max`、`mean`が入る。通常は`medianOfRoundSummaries`を全体要約として見たうえで、`rounds`の各sampleに一貫した変化があるか確認する。tail改善が目的ならp95 / p99も見る。

環境情報としてGit SHA、作業ツリー、URL、Chrome、viewport、canvas、WebGL vendor / rendererも保存する。before / afterでここが揃っているか必ず確認する。

`gpuTimerAvailable`が`false`なら、その環境ではGPU時間を取得できない。`gpuDisjointSamples`が増えたroundはGPU timer結果の信頼性が低いため、採否に使わない。

## 作業ログの書き方

1作業単位につき、`docs/YYYY-MM-DD/performance-results/`へ1つのMarkdownを残す。

```md
# 変更名

## 仮説

何を減らすと、どの指標が改善するはずか。

## 不変条件

見た目、時間、RNG、順序など、変えてはいけないもの。

## 計測条件

Git SHA、作業ツリー、端末、コマンド、オプション。

## Before

rawファイルへのリンクと主要sample。

## After

rawファイルへのリンクと主要sample。

## 正しさの検証

実行したtest、完全一致検証、目視確認。

## 判定

採用または不採用。その根拠と副作用。
```

改善率は次の式で揃える。

```text
(After - Before) / Before × 100
```

時間やbytesでは負の値が改善を表す。「何%高速化」と書く場合は速度比との混同が起きやすいため、「ms/stepが何%減少」のように指標を明記する。

## 困ったとき

### Node REPLが使えない

問題ない。計測ツールはNode REPLを使わず、リポジトリのルートで`npm run ...`を実行するだけでよい。

### Chromeが見つからない

`CHROME_PATH`を設定するか、`--chrome`で実行ファイルを指定する。

```sh
npm run bench:browser -- --chrome /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome
```

### port 4173が使用中と表示される

`bench:browser`は比較条件を固定するため、Vite previewをstrict portで起動する。既に動いているpreviewやdev serverが4173を使用していないか確認し、停止してから再実行する。

### 結果が大きく揺れる

ほかのブラウザや重い処理を止め、同じ電源状態で取り直す。短すぎる独自条件にせず、まず既定のウォームアップ、step数、round数を使う。before / afterを離れた時刻に測るより、同じ作業セッションで交互に再確認する。

### `gpuMs`が0またはsample数が少ない

`gpuTimerAvailable`、`gpuQueriesPending`、`gpuDisjointSamples`を確認する。拡張が使えない環境やqueryが完了していないroundでは、`gpuMs`だけで判断せず、frame、update、draw、転送指標を使う。

## 計測の限界

- wall timeはOSのscheduler、温度、電源管理、同時実行プロセスの影響を受ける。
- headless Chromeの絶対値は実際の閲覧環境と同一とは限らない。同一条件のbefore / after比較に使う。
- `probe=1`には計測コストがある。通常URLの製品性能そのものではなく、同じprobe条件での差分を見る。
- `bench:uploads`はupload要求の代理計測であり、driverの実転送量ではない。
- 指標が改善しても見た目や決定論が変わる変更は採用しない。

## 実例

2026-07-14に実施した一連のbefore / after、採否、raw JSONは[計測駆動パフォーマンスリファクタリングの作業ログ](../2026-07-14/README.md)で確認できる。
