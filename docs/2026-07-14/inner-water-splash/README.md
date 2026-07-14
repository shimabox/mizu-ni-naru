# 球内着水しぶき

## 目的

球内を落下する雫が水面へ着水したとき、既存の波紋に加えて小さなしぶきを描画する。しぶきは粒の半径を含めて球体の内殻から外へ出さない。

## 実装方針

- 既存の`InnerRippleView`を再利用し、雫着水のstrength帯（0.6〜1.0）だけをしぶきへ変換する
- 原子の反射（0.15）と溶解（0.3）は波紋だけを維持する
- simのRNG、step順序、物理状態、イベント契約は変更しない
- render専用hashから決定論的に粒子を生成する
- 粒子中心から内殻までの距離に粒子半径を加え、`0.94R`以内の場合だけ描画する
- 粒子が水面へ戻った時点、球がSplashing以降へ進んだ時点でも描画を終了する
- 球ごとの既存水色をそのまま使い、Glassより前に重ねない
- 比較スクリーンショットはリポジトリへ保存しない

## 計測条件

- Git commit: `c29af05d8a965465c1c0917440e3f4ceb5a42830`
- 作業ツリー: clean
- seed: 7
- slots: 24
- quality tier: 0
- viewport: 1440×727
- drawing buffer: 1440×727
- DPR上限: 1
- browser benchmark: 15秒warm-up、30秒×5 round
- GPU: ANGLE Metal / Apple M1

## Before

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

全5 roundでGPU timerは有効、disjoint sampleは0だった。

## After

raw: [20260714-browser-after.json](raw/20260714-browser-after.json)

|指標|Before|After|差分|
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

全5 roundでGPU timerは有効、disjoint sampleは0だった。FrameとCPU updateの中央値・tailは同値を維持した。GPU p50は1.19%増えたが、p95は0.27%増、p99は1.77%減であり、短命な視覚効果の追加コストとして安定している。

draw callの+1は、しぶきが生きている間だけ追加する単一instanced drawである。実simは雫着水が継続するため正式計測では中央値にも現れた。粒子がないフレームは`object.visible = false`となり、このdraw自体をsubmitしない。

submitted verticesの+1,536は、固定リング256 instance × quad 6 indexに一致する。球追従用uniformの+384 bytesも、24球 × `vec4` 16 bytesに一致する。イベント発生時のattributeは書き込んだリング区間だけを部分uploadするため、buffer upload中央値・p95は実質増えていない。

production bundleは664.03 kB / gzip 177.43 kBから671.10 kB / gzip 179.39 kBへ増加した（+7.07 kB / gzip +1.96 kB）。詳細probe bundleは変更していない。

## 容量検証

固定容量を過剰にしないため、実simをseed 7 / 42 / 123 / 2026、各10分（36,000 step）実行した。粒子の最大寿命を含む保守的な65 step窓で数えた最大同時粒子は次のとおり。

|seed|雫着水イベント|同一step最大イベント|最大同時粒子|
|---:|---:|---:|---:|
|7|5,124|3|271|
|42|5,081|3|250|
|123|5,072|3|247|
|2026|5,105|4|261|

256 instanceを維持する。通常時を収めつつ、まれな集中時だけ寿命末期の古い粒から上書きする。128へ減らすと通常の密集でも欠落し、512へ増やすと発生中のsubmitted verticesが倍になるため採用しない。

## 正しさの検証

- 雫着水strength 0.6〜1.0だけを発火対象とし、原子反射0.15・溶解0.3を除外するunit test
- strength別の粒数、リング部分upload範囲、同一step二重発火防止のunit test
- `中心距離 + 粒子半径 × 最大伸長 ≤ 0.94R`の境界unit test
- 実ChromeでGLSLをコンパイルし、consoleにshader errorがないことを確認
- StubSim 10秒probeで、発生中のdraw call / instanced draw callが各1だけ増えることを確認
- `npm test`: 34 files / 242 tests成功
- `npm run lint`: 106 files成功
- `npm run typecheck`: 成功
- `npm run depcruise`: 76 modules / 229 dependencies、違反なし
- `npm run build`: 成功
- 比較スクリーンショットは保存していない

## 判定

採用する。

- 雫着水に既存の水色を使った小さなクラウンが加わる
- 粒子は球ローカルで球のbob・落下へ追従する
- 水面へ戻った粒、内殻境界へ達した粒、Splashingへ進んだ球の粒はshaderで描画を終了する
- sim、RNG、step順、既存の波紋イベント列は変更していない
- Frame / updateの中央値とtailは同値、GPU増分はp50 1.19%・p95 0.27%に収まる

## 判定基準

- 雫着水時にだけしぶきが発生する
- 粒子半径を含めて内殻外へ描画されない
- simの既存golden値とRNG列を変更しない
- 平常時のdraw callを増やさず、発生中だけ最大1 draw追加する
- Frame p50 / p95を維持し、GPU・upload増分が短命な効果として許容できる範囲に収まる
