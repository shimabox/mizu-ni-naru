# 同一detailのGlass / InnerWater volume draw統合（不採用）

## 仮説

- 対象ボトルネック: Glass sphereとInnerWater volume sphereはnear/farともdetail 4で、同じmaterialを別drawしている。
- 試作内容: 全球の遠→近順`all` bucketを追加し、Glassを4→2 draw、InnerWater volumeを2→1 drawへ統合する。near/farでgeometry detailが異なるcapは従来どおり2 drawを維持する。
- 世界観・結果を維持できる根拠: 現行near/farは全球距離sortの連続区間なので、`far + near`のinstance順と`all`の全球遠→近順は同一。geometry、material、shader、instance属性値も同一である。
- 交換条件: cap用near/far bucketに加えてall bucketも必要なため、24球で18 floats×4 bytes×24 = 1,728 bytes/frameのattribute uploadが増える。

## 条件

- before SHA: `12c69642047072d249713d9f803a8f566721ae0a`
- after: 上記SHAへの未コミット試作。採否後に全製品差分を戻した。
- 環境: MacBook Air M1 / 16 GB、ANGLE Metal / Apple M1、Headless Chrome 150.0.0.0、Node.js v22.23.1
- URL: `http://127.0.0.1:4173/?seed=7&slots=24&q=0&m=1&dpr=1&probe=1`
- viewport: 1440×727 CSS px、device DPR 2、実描画buffer 1440×727（`dpr=1`）
- warm-up / 計測: production buildを15秒warm-up後、30秒×5 round。各round約1,800 frame。
- コマンド:

```sh
npm run bench:browser -- --warmup 15 --seconds 30 --rounds 5 \
  --output docs/2026-07-14/performance-results/raw/20260714-identical-lod-draw-after.json
```

- before raw: [`20260714-bubble-layout-upload-after.json`](raw/20260714-bubble-layout-upload-after.json)
- trial raw: [`20260714-identical-lod-draw-after.json`](raw/20260714-identical-lod-draw-after.json)
- GPU timer health: before / trialともdisjoint 0。各round1,800前後のGPU samples。

## 結果

値は5 roundそれぞれの要約値から取った中央値。時間はms、転送量はbytes/frame。

|指標|Before|Trial|差分|変化率|判定|
|---|---:|---:|---:|---:|---|
|Draw calls p50|28|25|-3|-10.7%|改善|
|Instanced draw calls p50|11|8|-3|-27.3%|改善|
|Submitted vertices p50|499,746|499,746|0|0.0%|同値|
|`bufferSubData` p50|26,320|28,048|+1,728|+6.6%|悪化（想定どおり）|
|`bufferSubData` mean|26,174|27,912|+1,739|+6.6%|悪化（想定どおり）|
|Frame p50|16.700|16.700|0|0.0%|同値|
|Frame p95|18.100|18.300|+0.200|+1.1%|悪化方向|
|Frame p99|18.600|18.600|0|0.0%|同値|
|Update p50|0.700|0.700|0|0.0%|同値|
|Update p95|1.000|1.100|+0.100|+10.0%|悪化方向|
|Update p99|1.300|1.200|-0.100|-7.7%|改善方向|
|Update mean|0.747|0.747|0|0.0%|同値|
|GPU p50|9.002|9.578|+0.576|+6.4%|悪化|
|GPU p95|13.046|12.720|-0.326|-2.5%|改善|
|GPU mean|9.587|9.724|+0.137|+1.4%|悪化|

draw callは意図どおり全frameで3減り、頂点数とinstance順も維持できた。一方でGPU p50 / meanとFrame p95が悪化方向、GPU p95だけ改善方向に分かれ、全体性能の改善は証明できなかった。追加all bucketの1,728 bytes/frameとCPU二重packを払う価値が、このApple M1 / ANGLE Metal条件では確認できない。

## 不変性

- 試作中も全球instance順、geometry detail、material、shader、RNG、simは変更していない。
- all bucketと参照near/farの有効prefix一致テスト、既存layout upload gatingテスト、型検査は成功した。
- 採否後、`BubbleInstanceBuffers`、`BubbleGlassSystem`、`InnerWaterSystem`、テスト、uploadベンチの試作差分をすべて除去した。
- 復帰後に`npm run typecheck`と`tests/render/bubbleInstanceBuffers.test.ts`（5 tests）成功。

## 判断

不採用。決定論的なdraw call削減だけでは採用せず、Frame / GPU時間の全体改善が一貫しないため製品コードを戻した。将来、base-instance対応の共有GPU bufferなど、追加uploadなしで統合できる設計が可能になった場合だけ再検討する。
