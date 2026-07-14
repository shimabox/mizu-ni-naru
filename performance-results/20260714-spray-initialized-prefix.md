# Spray未書き込みsuffixの描画省略

## 仮説

- 対象ボトルネック: Spray meshはイベント中、まだ一度も書かれていないring suffixを含む4,096 instanceを常に描き、vertex shader内で未spawnをkillしていた。
- 変更内容: 初回ring飽和までは累計書き込み済みprefixだけを`instanceCount`に設定する。instance数の更新は粒子ごとではなくイベントbatch末尾に1回だけ行う。ring飽和後は従来と同じ4,096へ戻る。
- 世界観・結果を維持できる根拠: 省略するsuffixの`spawnStepF`はすべて`NEVER_SPAWNED = -1e6`であり、変更前も必ずvertex shaderで不可視になっていた。書き込み済みinstanceのindex、属性、通常α合成順、弾道、寿命、seed、capacity超過時のring上書きは変更しない。

これは完全なlive compactではなく、最も安全な第1段階である。寿命切れinstanceのcompactと180,224 bytes/eventの全range upload削減は別の作業単位として残す。

## 条件

- before SHA: `514b078ed3346954b664b6dc9d8c1a57be495e2c`
- after SHA: `83fca330ffa98f28edeb64fa78246dfd6710e150`
- 環境: MacBook Air M1 / 16 GB、ANGLE Metal / Apple M1、Headless Chrome 150.0.0.0、Node.js v22.23.1
- URL: `http://127.0.0.1:4173/?seed=7&slots=24&q=0&m=1&dpr=1&probe=1`
- viewport: 1440×727 CSS px、device DPR 2、実描画buffer 1440×727（`dpr=1`）
- warm-up / 計測: production buildを15秒warm-up後、30秒×5 round。各round約1,800 frame。
- コマンド:

```sh
npm run bench:browser -- --warmup 15 --seconds 30 --rounds 5 \
  --output performance-results/raw/20260714-spray-prefix-after.json
```

- before raw: [`20260714-ocean-uniform-after.json`](raw/20260714-ocean-uniform-after.json)。海面uniform変更のafter計測後、Spray製品コードを変更するまで他の製品変更がないため、そのまま本作業のclean beforeとして再利用した。
- after raw: [`20260714-spray-prefix-after.json`](raw/20260714-spray-prefix-after.json)
- GPU timer health: before / afterともdisjoint 0。各round1,799〜1,800 GPU samples。

## 結果

値は5 roundそれぞれの要約値から取った中央値。時間はms、頂点数はdraw APIへ渡したindex count×instance countの総和/frame。

|指標|Before|After|差分|変化率|判定|
|---|---:|---:|---:|---:|---|
|Submitted vertices p50|499,746|499,746|0|0.0%|通常frameは同値|
|Submitted vertices p95|510,774|510,165|-609|-0.1%|改善|
|Submitted vertices p99|524,202|510,180|-14,022|-2.7%|改善|
|Submitted vertices max|524,229|510,192|-14,037|-2.7%|改善|
|Submitted vertices mean|500,748|500,163|-585|-0.1%|改善|
|Draw calls p50 / p95|28 / 29|28 / 29|0 / 0|0.0%|意図どおり同値|
|Frame p50 / p95|16.700 / 18.200|16.700 / 18.200|0 / 0|0.0%|非劣化|
|Frame p99|18.600|18.600|0|0.0%|非劣化|
|Update p50 / p95|0.800 / 1.400|0.900 / 1.400|+0.100 / 0|+12.5% / 0.0%|p50は0.1ms量子化差、p95同値|
|Update mean / max|0.855 / 5.100|0.905 / 3.800|+0.050 / -1.300|+5.8% / -25.5%|run揺れ、tail悪化なし|
|GPU p50 / p95|12.417 / 19.703|12.450 / 19.681|+0.034 / -0.022|+0.3% / -0.1%|ノイズ域|
|GPU p99|24.426|24.137|-0.289|-1.2%|改善方向、ノイズ域|

主指標はSprayが多いtailで再現性のある削減を示した。p99差14,022 index submissionsはquad換算で約2,337 instance/frameに相当する。p50が同値なのは、Sprayが不可視または未書き込みsuffixが小さい通常frameでは変更前後のdraw内容が同じだからである。

Update p50はブラウザtimerの0.1ms粒度で1段上がった一方、p95は同値、maxは低下し、Frame p50/p95/p99はすべて同値だった。実装が追加するCPU処理はイベント時の飽和加算とbatch末尾の1プロパティ更新だけで、定常frameには新しい処理がない。したがってUpdate meanの差はrun順・動作周波数による揺れと判断し、Frame非劣化と決定論的な頂点削減を採否の根拠にする。

## 不変性

- 未書き込みsuffixだけを除外し、書き込み済みprefixのindex順は不変。
- ringが4,096へ達した後の`instanceCount`、cursor wrap、上書き規約は従来と同一。
- particle属性、RNG、sim、shader、blend、renderOrder、visible期間は変更なし。
- 新規単体テストで0、1、capacity−1、capacity、capacity超過のdraw countを固定した。
- `npm test`: 30 files / 230 tests成功（期待値の更新なし）。
- `npm run lint`: 99 files成功。
- `npm run typecheck`: 成功。
- `npm run depcruise`: 73 modules / 214 dependencies、違反なし。
- `npm run build`: 成功。

## 判断

採用。通常frameとring飽和後の仕事は悪化させず、Spray負荷が高いtailで不要なvertex submissionを2.7%削減できた。見た目に寄与し得るinstanceは一切省略していない。完全なlive compactと部分attribute uploadは、α合成順を固定したうえで別途before / afterを取る。
