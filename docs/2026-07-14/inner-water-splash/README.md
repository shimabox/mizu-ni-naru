# 球内着水しぶき

## 目的

球内を落下する雫が水面へ着水したとき、既存の波紋に加えて素朴な「ポチャン」を描画する。しぶきは波紋の補助に留め、粒の半径を含めて球体の内殻から外へ出さない。

## 最終仕様

- 既存の`InnerRippleView`を再利用し、雫着水のstrength帯（0.6〜1.0）だけをしぶきへ変換する
- 原子の反射（0.15）と溶解（0.3）は波紋だけを維持する
- 小さな雫は3粒、大きな雫でも5粒に留める
- 粒を均等な円周上へ並べず、着水点の近くから不揃いな方向へ低く跳ねさせる
- 寿命を0.42〜0.58秒に抑え、水面へ戻った時点で描画を終了する
- 球ごとの既存水色をそのまま使い、強いハイライト、色むら、フレネル光を加えない
- simのRNG、step順序、物理状態、イベント契約は変更しない
- render専用hashから決定論的に粒子を生成する
- 粒子中心から内殻までの距離に粒子半径を加え、`0.94R`以内の場合だけ描画する
- 球がSplashing以降へ進んだ時点でも描画を終了する
- 比較スクリーンショットはリポジトリへ保存しない

## 機能追加時の計測

最初に、しぶきが存在しない`main`相当と7〜12粒の初案を比較した。初案は均等な円形クラウンと強めの陰影を持っていたが、最終仕様では採用していない。

### 計測条件

- Git commit: `c29af05d8a965465c1c0917440e3f4ceb5a42830`
- 作業ツリー: cleanから実装
- seed: 7
- slots: 24
- quality tier: 0
- viewport: 1440×727
- drawing buffer: 1440×727
- DPR上限: 1
- browser benchmark: 15秒warm-up、30秒×5 round
- GPU: ANGLE Metal / Apple M1

### しぶきなし

raw: [20260714-browser-before.json](raw/20260714-browser-before.json)

|指標|中央値|
|:---|---:|
|Frame p50|16.700 ms|
|Frame p95|17.400 ms|
|Update p50|0.700 ms|
|Update p95|1.300 ms|
|GPU p50|14.520 ms|
|GPU p95|18.597 ms|
|Draw calls p50|28|
|Instanced draw calls p50|11|
|Submitted vertices p50|603,426|
|Buffer upload p50|26,320 bytes|
|Uniform vec4 upload p50|5,120 bytes|

### 初案

raw: [20260714-browser-after.json](raw/20260714-browser-after.json)

|指標|しぶきなし|初案|差分|
|:---|---:|---:|---:|
|Frame p50|16.700 ms|16.700 ms|0.0%|
|Frame p95|17.400 ms|17.400 ms|0.0%|
|Frame p99|17.600 ms|17.600 ms|0.0%|
|Update p50|0.700 ms|0.700 ms|0.0%|
|Update p95|1.300 ms|1.300 ms|0.0%|
|GPU p50|14.520 ms|14.693 ms|+1.19%|
|GPU p95|18.597 ms|18.647 ms|+0.27%|
|GPU p99|21.289 ms|20.912 ms|-1.77%|
|Draw calls p50|28|29|+1|
|Instanced draw calls p50|11|12|+1|
|Submitted vertices p50|603,426|604,962|+1,536 / +0.25%|
|Buffer upload p50|26,320 bytes|26,224 bytes|-96 bytes|
|Uniform vec4 upload p50|5,120 bytes|5,504 bytes|+384 bytes|

全5 roundでGPU timerは有効、disjoint sampleは0だった。draw callの+1は、しぶきが生きている間だけ追加する単一instanced drawである。粒子がないフレームは`object.visible = false`となり、このdraw自体をsubmitしない。

## 素朴化の作業単位

ユーザーフィードバックを受け、初案を「作り込まれたクラウン」から素朴な「ポチャン」へ変更した。変更前を再計測してから実装し、同じ条件で変更後を計測した。

### 計測条件

- 変更前commit: `1bb605c540cdc6a07afa6d049931f4f044943e93`
- 変更前作業ツリー: clean
- seed: 7
- slots: 24
- quality tier: 0
- viewport / drawing buffer: 1440×727
- DPR上限: 1
- browser benchmark: 15秒warm-up、30秒×5 round
- GPU: ANGLE Metal / Apple M1

- 変更前raw: [20260714-simple-splash-before.json](raw/20260714-simple-splash-before.json)
- 変更後raw: [20260714-simple-splash-after.json](raw/20260714-simple-splash-after.json)

### 結果

|指標|変更前|変更後|差分|
|:---|---:|---:|---:|
|Frame p50|16.700 ms|16.700 ms|0.0%|
|Frame p95|17.600 ms|17.600 ms|0.0%|
|Frame p99|17.700 ms|17.700 ms|0.0%|
|Update p50|0.900 ms|0.800 ms|-11.11%|
|Update p95|1.700 ms|1.500 ms|-11.76%|
|Update p99|2.300 ms|2.000 ms|-13.04%|
|GPU p50|15.999 ms|14.883 ms|-6.97%|
|GPU p95|23.883 ms|27.587 ms|+15.51%|
|GPU p99|29.635 ms|35.456 ms|+19.64%|
|Draw calls p50|29|29|同値|
|Instanced draw calls p50|12|12|同値|
|Submitted vertices p50|604,962|604,884|-78 / -0.01%|
|Buffer upload p50|26,384 bytes|26,544 bytes|+160 / +0.61%|
|Buffer upload p95|29,488 bytes|29,488 bytes|同値|
|Uniform vec4 upload p50|5,504 bytes|5,504 bytes|同値|

全5 roundでGPU timerは有効、disjoint sampleは0だった。Frame中央値とtailは同値、Updateはp50 / p95 / p99がすべて改善した。GPU p50は改善した一方、p95 / p99は上振れした。各roundのGPU値は変更前p50が15.01〜19.10 ms、変更後p50が13.74〜21.97 msと分散が大きく、tailの悪化を今回の小さなしぶき変更による回帰とは断定できない。ただし、GPU時間全体が改善したとも判定しない。

Submitted verticesの全体中央値は他の球LODのタイミングも含むため差が小さい。しぶきdraw単体では固定リングを256→128 instanceへ半減し、発生中のsubmit上限を1,536→768 verticesへ削減した。さらに粒数を7〜12→3〜5、1粒あたりのinstance属性を60→56 bytesとし、fragment shaderから色むら・太陽ハイライト・フレネル計算を除いた。

production bundleは671.10 kB / gzip 179.39 kBから670.72 kB / gzip 179.30 kBへ減少した（-0.38 kB / gzip -0.09 kB）。

## 容量検証

リング容量を256→128へ縮小しても粒が欠落しないか、常設コマンドで実simを検証した。

```sh
npm run verify:splash-capacity
```

既定条件はseed 7 / 42 / 123 / 2026、各10分（36,000 step）、24 slotsである。最大寿命を含む保守的な41 step窓で、実際にshaderが水面復帰で早く消えることは余裕へ算入していない。

|seed|雫着水イベント|同一step最大イベント|最大同時粒子|128までの余裕|
|---:|---:|---:|---:|---:|
|7|5,124|3|83|45|
|42|5,081|3|86|42|
|123|5,072|3|81|47|
|2026|5,105|4|80|48|

全seedで容量内へ収まり、最悪値でも42 instanceの余裕がある。

## 正しさの検証

- 雫着水strength 0.6〜1.0だけを発火対象とし、原子反射0.15・溶解0.3を除外するunit test
- strength別の3〜5粒、リング部分upload範囲、同一step二重発火防止のunit test
- `中心距離 + 粒子半径 × 最大伸長 ≤ 0.94R`の境界unit test
- 実Chromeでproduction buildとGLSLを実行し、全roundを完走
- `npm run verify:splash-capacity`による4 seed×10分の容量検証
- 比較スクリーンショットは保存しない

## 判定

採用する。

- 波紋を主役にし、着水点から3〜5粒だけが低く短く跳ねる
- 均等な円形クラウン、強いハイライト、色むらを除いた
- 粒子は球ローカルで球のbob・落下へ追従する
- 水面へ戻った粒、内殻境界へ達した粒、Splashingへ進んだ球の粒はshaderで描画を終了する
- sim、RNG、step順、既存の波紋イベント列は変更していない
- Frame p50 / p95 / p99は同値、Updateは改善、GPUはp50改善・tail上振れのため全体改善とは断定しない
- 固定しぶきGPU workload、発生粒数、instance転送量、shader演算量はすべて削減した

## 判定基準

- 雫着水時にだけしぶきが発生する
- 粒子半径を含めて内殻外へ描画されない
- simの既存golden値とRNG列を変更しない
- 平常時のdraw callを増やさず、発生中だけ最大1 draw追加する
- Frame p50 / p95を維持し、変更前よりしぶき固有の処理量を増やさない
