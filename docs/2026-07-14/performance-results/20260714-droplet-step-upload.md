# Droplet属性の0-step frame再upload抑制

## 仮説

- 対象ボトルネック: `DropletSystem.update()`はsim stepが進まないframeでも`posR`、`posRPrev`、`aux`の3属性すべてに`needsUpdate`を立てていた。
- 変更内容: 最後にupload要求を出した`view.step`を保持し、配列再確保がなくstepも同じならupdate rangeと`needsUpdate`を更新しない。instance count、補間uniform、camera basisは毎frame従来どおり更新する。
- 世界観・結果を維持できる根拠: Droplet配列はsim step間で不変で、補間率とcameraはuniform側にある。配列参照が変わった場合はstepが同じでも必ず再ラップ・uploadする。

## 条件

- before製品SHA: `f8086dbad04ac43fda7ce0ca1acc661050fb6f9c`
- after SHA: `349542f4e17572d7f132d6bb04bfe4b6879ce81e`
- ローカルuploadベンチ: Apple M1、Node.js v22.23.1、seed 7、24 slots、2,000 step warm-up、60秒、表示refresh 60 / 120 / 144Hz
- ブラウザ: MacBook Air M1 / 16 GB、ANGLE Metal / Apple M1、Headless Chrome 150.0.0.0
- URL: `http://127.0.0.1:4173/?seed=7&slots=24&q=0&m=1&dpr=1&probe=1`
- viewport: 1440×727 CSS px、device DPR 2、実描画buffer 1440×727（`dpr=1`）
- ブラウザwarm-up / 計測: production buildを15秒warm-up後、30秒×5 round。各round約1,800 frame。
- コマンド:

```sh
npm run bench:uploads
npm run bench:browser -- --warmup 15 --seconds 30 --rounds 5 \
  --output docs/2026-07-14/performance-results/raw/20260714-droplet-step-upload-after.json
```

- browser before raw: [`20260714-atom-step-upload-after.json`](raw/20260714-atom-step-upload-after.json)。Atom作業のafterからDroplet変更まで他の製品変更がないため、本作業のbeforeとして再利用した。
- browser after raw: [`20260714-droplet-step-upload-after.json`](raw/20260714-droplet-step-upload-after.json)
- GPU timer health: before / afterともdisjoint 0。各round1,799〜1,800 GPU samples。

## refresh別の要求upload結果

`BufferAttribute.version`増分をdriver upload要求の代理として数え、有効Droplet prefixのbytesを集計した。全refreshで同じ60秒の世界時間を進めている。

|表示refresh|指標|Before|After|差分|変化率|
|---:|---|---:|---:|---:|---:|
|60Hz|upload frames|3,600|3,600|0|0.0%|
|60Hz|要求bytes|2,186,928|2,186,928|0|0.0%|
|120Hz|upload frames|7,200|3,601|-3,599|-50.0%|
|120Hz|要求bytes|4,374,048|2,187,840|-2,186,208|-50.0%|
|144Hz|upload frames|8,640|3,600|-5,040|-58.3%|
|144Hz|要求bytes|5,249,904|2,187,120|-3,062,784|-58.3%|

Atomと同様、120Hzの3,601回は初回upload 1回と3,600 sim step、144Hzの3,600回は初回を含む3,599 sim stepに対応する。60 / 120 / 144Hzのすべてでbefore / afterの最終countsが一致した。

## 実ブラウザ60Hz結果

値は5 roundそれぞれの要約値から取った中央値。時間はms、転送量はbytes/frame。

|指標|Before|After|差分|判定|
|---|---:|---:|---:|---|
|`bufferSubData` p50|25,152|26,320|+1,168|run間の0-step比率差|
|`bufferSubData` mean|22,014|26,181|+4,168|run間の0-step比率差|
|Frame p50 / p95|16.700 / 18.300|16.700 / 18.200|0 / -0.100|非劣化|
|Frame p99|18.600|18.600|0|非劣化|
|Update p50 / p95|0.900 / 1.500|0.700 / 1.000|-0.200 / -0.500|改善方向、run差|
|GPU p50 / p95|12.305 / 19.670|8.987 / 13.268|-3.318 / -6.402|改善方向、run差|

60Hzの要求bytesは1 step/frameなら変更前後で同じである。今回のafter runはほぼ全frameでstepが進み、before runはrAF間隔の揺れによる0-step frameが多かったため、総`bufferSubData`が増えた。これは同一step列の局所ベンチで60Hz bytesが完全同値であること、120/144Hzでだけ意図した比率に減ることと整合する。

逆にGPU時間の大幅低下もDropletの数百bytes/frameでは説明できないため、run間のGPU動作状態差として採用効果には数えない。重要な回帰指標であるFrame p50 / p95 / p99は非劣化だった。

## 不変性

- Droplet配列、count、並び、shader、uniform、RNG、simは変更なし。
- 配列再確保時は同じstepでも3属性を再ラップし、upload要求を出す。
- 新規単体テストで初回、同一step、step進行、同step配列再確保を固定した。
- `npm test`: 32 files / 234 tests成功（期待値の更新なし）。
- `npm run lint`: 101 files成功。
- `npm run typecheck`: 成功。
- `npm run depcruise`: 73 modules / 214 dependencies、違反なし。
- `npm run build`: 成功。

## 判断

採用。60Hz・1 step/frameの仕事を変えず、120Hzで50.0%、144Hzで58.3%のDroplet属性upload要求を除去した。実ブラウザの総転送量はstepスケジュール差で単純比較できなかったが、Frame p50 / p95 / p99に回帰はない。雫の位置、補間、色、順序、弾道は一切変わらない。
