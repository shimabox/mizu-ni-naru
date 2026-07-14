# AggregatePacker subarray removal — 2026-07-14

## 判断

採用。

- before SHA: `78cf5f2`
- after SHA: `6e95dc1`
- `AggregatePacker.pack` median: 21.8%短縮
- 24球sim全体 median: 5.7%短縮
- 128球sim全体 median: 3.5%短縮
- sim出力: golden期待値の更新なし

---

## 仮説と変更

旧実装は球の8-float bubble laneをコピーするたびに`TypedArray.subarray()`を生成し、`set()`へ渡していた。24球では1 stepあたり48個、60 Hzでは2,880個/秒の短命TypedArray viewになる。

8 laneを添字ループでコピーし、同じループ内で`bubblePrev`と`prevPacked`を更新する。値、書き込み順、prev/curr規約は変えない。

---

## 条件

- Apple M1 / macOS 26.2 / Node.js v22.23.1
- seed 7 / desktop pacing / 24 slots
- 2,000 step warm-up
- 10,000 step × 7 rounds
- method profileはinclusive wrapper時間
- sim全体は24 / 128 slots × 各7 rounds

コマンド:

```sh
npm run profile:sim
npm run bench:sim
```

---

## Packer対象結果

|指標|Before|After|変化|
|---|---:|---:|---:|
|`AggregatePacker.pack` median|0.009146 ms/step|0.007153 ms/step|-21.8%|
|instrumented sim median|0.086243 ms/step|0.075032 ms/step|-13.0%|
|短命subarray view|48 / step|0 / step|-100%|

Packer raw samples:

```text
Before:
0.0093930715
0.0089443648
0.0100139067
0.0089193528
0.0095236743
0.0089046566
0.0091455049

After:
0.0071529531
0.0072686284
0.0071310849
0.0072652366
0.0071493880
0.0071388935
0.0080970776
```

対象メソッドの7試行すべてがbefore中央値を下回った。instrumented sim全体には他メソッドとOSスケジューリングの揺らぎも含むため、13.0%全体改善は参考値とする。

---

## sim全体結果

|構成|Before median|After median|変化|Before CV|After CV|
|---|---:|---:|---:|---:|---:|
|24球|0.080720 ms/step|0.076137 ms/step|-5.7%|8.10%|5.52%|
|128球|0.482231 ms/step|0.465303 ms/step|-3.5%|1.66%|1.49%|

24球after raw:

```text
0.0761365959
0.0775682375
0.0759258625
0.0756018750
0.0864095167
0.0754740959
0.0848540875
```

128球after raw:

```text
0.4824352666
0.4666772458
0.4596287583
0.4632775208
0.4620574625
0.4686719792
0.4653028125
```

24球の全体差5.7%は単独ではbefore CV内だが、対象メソッドの21.8%短縮、アロケーション数の決定論的な100%削減、128球の低ノイズ系列での3.5%短縮が同じ方向を示すため採用する。

---

## 不変性

- 28 test files / 226 tests passed
- `aggregatePacker.test.ts`全成功
- sim golden期待値の更新なし
- lint成功
- typecheck成功
- production build成功
- dense prefix、prev/curr、respawn時`prev = curr`の契約を維持

production JavaScriptは直前の661.49 kB / gzip 176.40 kBから661.54 kB / gzip 176.42 kB。差は+0.05 kB raw / +0.02 kB gzip。
