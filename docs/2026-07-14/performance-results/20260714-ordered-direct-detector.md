# Ordered direct collision detector — 2026-07-14

## 判断

採用。

- before product SHA: `5cb7018`（`9071df4`から計測ツールだけを追加、simコードは同一）
- after product SHA: `d04e5f7`
- 世界観・sim結果: 完全一致
- production 24球: median 36.7%短縮
- stress 128球: median 34.9%短縮

---

## 仮説

各球の原子数は概ね15〜24体であり、4³セルのcounting sortと最大27近傍セル走査は固定費が大きい。全ペアを直接検査し、実際に衝突した少数ペアだけを現行Gridと同じ`(cell(j), j)`順へ並べれば、反応順を変えずに高速化できる。

通常の`i → j`総当たりは反応順とRNG列を変えるため使用しない。

---

## 条件

- Apple M1 / macOS 26.2 / Node.js v22.23.1
- `seed = 7`
- `pacing = desktop`
- 1試行ごとにsimを新規生成
- 2,000 step warm-up
- 10,000 step計測
- before / afterとも24球・128球を各7試行
- ブラウザとpreview serverは停止

コマンド:

```sh
npm run bench:sim
npm run profile:sim
npm run bench:detectors
npm run verify:detectors
```

---

## sim全体結果

|構成|指標|Before|After|変化|
|---|---|---:|---:|---:|
|24球|median|0.127519 ms/step|0.080720 ms/step|-36.7%|
|24球|p95 / max|0.134436 ms/step|0.094848 ms/step|-29.4%|
|128球|median|0.740518 ms/step|0.482231 ms/step|-34.9%|
|128球|p95 / max|0.757236 ms/step|0.500511 ms/step|-33.9%|

before raw:

```text
24球:
0.1344362250
0.1275190250
0.1135153041
0.1244834625
0.1336580000
0.1282348458
0.1134410959

128球:
0.7291394209
0.7539155958
0.7572364083
0.7399502500
0.7405179500
0.7269781083
0.7518295625
```

after raw:

```text
24球:
0.0781857958
0.0948475209
0.0781035250
0.0923573167
0.0775530250
0.0882601959
0.0807203375

128球:
0.4909198042
0.4795152084
0.5005108417
0.4756952250
0.4822309708
0.4886034166
0.4786795958
```

24球はbefore CV 6.39% / after CV 8.10%と揺らぎが大きいが、median差36.7%とp95差29.4%はいずれもノイズ幅を十分超えている。128球でも同じ方向・同程度の改善が出ている。

---

## hot path結果

instrumented profileはwrapperのオーバーヘッドとinclusive時間を含む。

|指標|Before|After|変化|
|---|---:|---:|---:|
|detector時間 / sim step|0.070088 ms|0.029488 ms|-57.9%|
|instrumented sim全体|0.126135 ms/step|0.085297 ms/step|-32.4%|
|detectorのinclusive share|55.57%|34.57%|-21.00 points|

---

## direct / grid切替閾値

`npm run bench:detectors`で同一入力・同一ペア列を確認しながら、各5,000 calls × 5 roundsを測った。

|原子数|direct speedup（grid / direct）|判断|
|---:|---:|---|
|24|1.162倍|direct|
|40|1.222倍|direct|
|48|1.081倍|direct|
|56|1.022倍|ノイズに近い|
|64|0.921倍|grid|
|128|0.673倍|grid|

production閾値は48原子とした。49原子以上は既存`GridDetector`へフォールバックする。現在の実構成はこの閾値より十分小さい。

---

## 不変性

`npm run verify:detectors`で次を検証した。

- seed 7 / 42 / 123 / 2026
- 各24球 × 10,000 step
- 1,000 stepごとの40 checkpoints
- `counts()`完全一致
- mass ledger完全一致
- bubble curr / prev完全一致
- atom curr / prev / color / aux完全一致
- droplet curr / prev / aux完全一致
- splash / ripple完全一致

結果は`exactMatch: true`。加えて:

- 28 test files / 226 tests passed
- golden期待値の更新なし
- lint成功
- typecheck成功
- dependency-cruiser成功（72 modules / 213 dependencies）
- production build成功

JavaScript bundleは660.31 kBから661.49 kB、gzipは175.97 kBから176.40 kBへ増えた。+1.18 kB raw / +0.43 kB gzipであり、定常simの35%前後の短縮に対して許容する。

---

## 変更内容

- `OrderedDirectDetector`を追加。
- 衝突したjだけをcell id順へ安定挿入し、Gridの列挙順を維持。
- 48原子を超える入力は従来Gridへフォールバック。
- Gridは参照実装、BruteForceは集合オラクルとして維持。
- threshold benchmarkと4-seed完全一致検証を再利用可能なnpm scriptとして追加。
