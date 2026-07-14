# Atom属性の0-step frame再upload抑制

## 仮説

- 対象ボトルネック: `AtomViewAttributes.sync()`はsim stepが進まないframeでも4属性すべてに`needsUpdate`を立てていた。固定simは60Hzなので、120Hzでは約半分、144Hzでは約58%のframeで同じ配列を再送する。
- 変更内容: 最後にupload要求を出した`view.step`を保持し、配列再確保がなくstepも同じならupdate rangeと`needsUpdate`を更新しない。
- 世界観・結果を維持できる根拠: Atom配列はsim step間で不変である。frame間で変わる`alpha`、`uStepF`、camera basisは従来どおりuniform更新されるため、prev/curr補間と見た目は同一。配列参照が変わった場合はstepが同じでも必ず再ラップ・uploadする。

## 条件

- before製品SHA: `83fca330ffa98f28edeb64fa78246dfd6710e150`
- after SHA: `f8086dbad04ac43fda7ce0ca1acc661050fb6f9c`
- ローカルuploadベンチ: Apple M1、Node.js v22.23.1、seed 7、24 slots、2,000 step warm-up、60秒、表示refresh 60 / 120 / 144Hz
- ブラウザ: MacBook Air M1 / 16 GB、ANGLE Metal / Apple M1、Headless Chrome 150.0.0.0
- URL: `http://127.0.0.1:4173/?seed=7&slots=24&q=0&m=1&dpr=1&probe=1`
- viewport: 1440×727 CSS px、device DPR 2、実描画buffer 1440×727（`dpr=1`）
- ブラウザwarm-up / 計測: production buildを15秒warm-up後、30秒×5 round。各round約1,800 frame。
- コマンド:

```sh
npm run bench:uploads
npm run bench:browser -- --warmup 15 --seconds 30 --rounds 5 \
  --output performance-results/raw/20260714-atom-step-upload-after.json
```

- browser before raw: [`20260714-spray-prefix-after.json`](raw/20260714-spray-prefix-after.json)。Spray作業のafterからAtom変更まで他の製品変更がないため、本作業のbeforeとして再利用した。
- browser after raw: [`20260714-atom-step-upload-after.json`](raw/20260714-atom-step-upload-after.json)
- GPU timer health: before / afterともdisjoint 0。各round1,799〜1,800 GPU samples。

## refresh別の要求upload結果

`BufferAttribute.version`増分をdriver upload要求の代理として数え、有効Atom prefixのbytesを集計した。全refreshで同じ60秒の世界時間を進めている。

|表示refresh|指標|Before|After|差分|変化率|
|---:|---|---:|---:|---:|---:|
|60Hz|upload frames|3,600|3,600|0|0.0%|
|60Hz|要求bytes|99,068,608|99,068,608|0|0.0%|
|120Hz|upload frames|7,200|3,601|-3,599|-50.0%|
|120Hz|要求bytes|198,144,512|99,098,560|-99,045,952|-50.0%|
|144Hz|upload frames|8,640|3,600|-5,040|-58.3%|
|144Hz|要求bytes|237,778,624|99,075,904|-138,702,720|-58.3%|

120Hzの3,601回は初回upload 1回と3,600 sim step、144Hzの3,600回は初回を含む3,599 sim stepに対応する。変更前はrefresh frame数と完全に一致していた。60Hzは1 step/frameなので意図どおり一切変わらない。

60 / 120Hzではbefore / afterの最終countsが完全一致した。144Hzも浮動小数のaccumulatorにより両系列とも3,599 stepとなり、最終countsは両系列で一致した。

## 実ブラウザ60Hz結果

値は5 roundそれぞれの要約値から取った中央値。時間はms、転送量はbytes/frame。

|指標|Before|After|差分|変化率|判定|
|---|---:|---:|---:|---:|---|
|`bufferSubData` p50|26,336|25,152|-1,184|-4.5%|改善|
|`bufferSubData` mean|26,177|22,014|-4,163|-15.9%|改善|
|`bufferSubData` p95|29,456|29,408|-48|-0.2%|改善|
|Frame p50|16.700|16.700|0|0.0%|非劣化|
|Frame p95|18.200|18.300|+0.100|+0.5%|run揺れ|
|Frame p99|18.600|18.600|0|0.0%|非劣化|
|Update p50|0.900|0.900|0|0.0%|非劣化|
|Update p95|1.400|1.500|+0.100|+7.1%|run揺れ|
|GPU p50|12.450|12.305|-0.145|-1.2%|改善方向|
|GPU p95|19.681|19.670|-0.011|-0.1%|非劣化|

60HzでもrAF間隔の揺れにより0-step frameが発生し、mean upload bytesが15.9%減った。Frame / Updateのp95は0.1ms増えたが、p99はFrame同値、GPU p50/p95は改善方向であり、一貫した回帰とは見なさない。主効果は120/144Hzの決定論的な50〜58%削減である。

## 不変性

- Atom配列、count、並び、shader、uniform、RNG、simは変更なし。
- 配列再確保時は同じstepでも4属性を再ラップし、upload要求を出す。
- 新規単体テストで初回、同一step、step進行、同step配列再確保を固定した。
- `npm test`: 31 files / 232 tests成功（期待値の更新なし）。
- `npm run lint`: 100 files成功。
- `npm run typecheck`: 成功。
- `npm run depcruise`: 73 modules / 214 dependencies、違反なし。
- `npm run build`: 成功。

## 判断

採用。60Hzの通常経路を変えず、120Hzで50.0%、144Hzで58.3%のAtom属性upload要求を除去した。実ブラウザ60Hzでもmean転送bytesが15.9%減り、Frame p50 / p99とGPU p95は非劣化だった。作品の時間、補間、原子の色・位置・順序には影響しない。
