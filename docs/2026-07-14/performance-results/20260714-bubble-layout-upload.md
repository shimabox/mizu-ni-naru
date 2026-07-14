# Bubble属性のcamera-aware再upload抑制

## 仮説

- 対象ボトルネック: `BubbleInstanceBuffers.sync()`はsim stepが進まないframeでもnear/far各5属性を再pack・uploadしていた。
- 単純なstep判定ができない理由: cameraはalphaと操作入力でrAFごとに動き、遠→近sort、near/far LOD、近傍球のripple indexが同じsim step内でも変わり得る。
- 変更内容: 固定配列へ現在のsort順とnear/far分類を計算し、同じstep・同じ配列参照・同じcountで、前回uploadしたsort順と分類が完全一致する場合だけ再pack/uploadを省略する。1要素でも変われば従来どおり全属性とripple mappingを更新する。
- 世界観・結果を維持できる根拠: Bubble属性にcamera連続値そのものは含まれず、cameraが影響するのはsort、LOD、ripple indexだけである。これらが同じなら属性bytesは同一。alpha、time、camera行列は各material uniformで毎frame更新される。

## 条件

- before製品SHA: `349542f4e17572d7f132d6bb04bfe4b6879ce81e`
- after SHA: `12c69642047072d249713d9f803a8f566721ae0a`
- ローカルuploadベンチ: Apple M1、Node.js v22.23.1、seed 7、24 slots、2,000 step warm-up、60秒、表示refresh 60 / 120 / 144Hz、240秒周期の緩やかなcamera軌道
- ブラウザ: MacBook Air M1 / 16 GB、ANGLE Metal / Apple M1、Headless Chrome 150.0.0.0
- URL: `http://127.0.0.1:4173/?seed=7&slots=24&q=0&m=1&dpr=1&probe=1`
- viewport: 1440×727 CSS px、device DPR 2、実描画buffer 1440×727（`dpr=1`）
- ブラウザwarm-up / 計測: production buildを15秒warm-up後、30秒×5 round。各round約1,800 frame。
- コマンド:

```sh
npm run bench:uploads
npm run bench:browser -- --warmup 15 --seconds 30 --rounds 5 \
  --output docs/2026-07-14/performance-results/raw/20260714-bubble-layout-upload-after.json
```

- browser before raw: [`20260714-droplet-step-upload-after.json`](raw/20260714-droplet-step-upload-after.json)。Droplet作業のafterからBubble変更まで他の製品変更がないため、本作業のbeforeとして再利用した。
- browser after raw: [`20260714-bubble-layout-upload-after.json`](raw/20260714-bubble-layout-upload-after.json)
- GPU timer health: before / afterともdisjoint 0。各round1,799〜1,802 samples。

## refresh別の要求upload結果

near/far各5属性の`BufferAttribute.version`増分をdriver upload要求の代理として数え、24球×18 floats×4 bytes = 1,728 bytes/upload frameを集計した。

|表示refresh|指標|Before|After|差分|変化率|
|---:|---|---:|---:|---:|---:|
|60Hz|upload frames|3,600|3,600|0|0.0%|
|60Hz|要求bytes|6,220,800|6,220,800|0|0.0%|
|120Hz|upload frames|7,200|3,663|-3,537|-49.1%|
|120Hz|要求bytes|12,441,600|6,329,664|-6,111,936|-49.1%|
|144Hz|upload frames|8,640|3,667|-4,973|-57.6%|
|144Hz|要求bytes|14,929,920|6,336,576|-8,593,344|-57.6%|

120Hzでは3,600 sim stepに対して3,663 upload frame、144Hzでは3,599 sim stepに対して3,667 upload frameとなった。差の63 / 68 frameは、0-step中でもcamera移動によりsortまたはLODが実際に変わり、正しく再uploadした回数である。stepだけで止める危険な実装とは異なり、camera layout変更を落としていない。

60 / 120 / 144Hzのすべてでbefore / afterの最終countsが一致した。

## 実ブラウザ60Hz結果

値は5 roundそれぞれの要約値から取った中央値。時間はms、転送量はbytes/frame。

|指標|Before|After|差分|変化率|判定|
|---|---:|---:|---:|---:|---|
|`bufferSubData` p50|26,320|26,320|0|0.0%|1 step/frameで同値|
|`bufferSubData` p95|29,456|29,456|0|0.0%|1 step/frameで同値|
|`bufferSubData` mean|26,181|26,174|-7|-0.0%|同値|
|Frame p50 / p95|16.700 / 18.200|16.700 / 18.100|0 / -0.100|0.0% / -0.5%|非劣化|
|Frame p99|18.600|18.600|0|0.0%|非劣化|
|Update p50 / p95 / p99|0.700 / 1.000 / 1.300|0.700 / 1.000 / 1.300|0 / 0 / 0|0.0%|非劣化|
|Update mean|0.753|0.747|-0.006|-0.8%|非劣化|
|GPU p50|8.987|9.002|+0.015|+0.2%|ノイズ域|
|GPU p95|13.268|13.046|-0.222|-1.7%|改善方向|

60Hzはほぼ1 step/frameのためupload量は意図どおり同値である。毎frame追加されるlayout比較ループについて、Update p50 / p95 / p99がすべて完全同値であり、通常経路のCPU回帰は認めない。主効果は高refresh環境の49〜58%削減である。

## 不変性

- Bubbleの配列、count、sort規則、LOD境界、ripple index規則、seed、shader、RNG、simは変更なし。
- 同stepでcameraを微動してlayoutが同じ場合にversionが増えないテストを追加。
- 同stepでcameraを反対側へ動かしてsort/LODが変わる場合、全10属性が再uploadされ、新規参照インスタンスとnear/far有効prefixおよび`rippleIndexBySlot`が完全一致するテストを追加。
- step進行時はlayoutが偶然同じでも必ず再pack/uploadする。
- 配列参照またはcount変更時も必ず再pack/uploadする。
- `npm test`: 32 files / 236 tests成功（期待値の更新なし）。
- `npm run lint`: 101 files成功。
- `npm run typecheck`: 成功。
- `npm run depcruise`: 73 modules / 214 dependencies、違反なし。
- `npm run build`: 成功。

## 判断

採用。camera依存の描画順とLODを保守的に比較し、変わらない0-step frameだけを省略することで、120Hzで49.1%、144Hzで57.6%のBubble属性upload要求を削減した。60HzのUpdate tailと転送量は非劣化で、球の見た目・並び・波紋追跡は完全に維持される。
