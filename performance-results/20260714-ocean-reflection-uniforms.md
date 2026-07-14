# 海面解析反射uniform配列の実使用上限化

## 仮説

- 対象ボトルネック: 海面解析反射はカメラ近傍8球しか参照しない一方、`uBubblePosR`と`uBubbleMisc`を世界容量128要素ずつ毎フレーム`uniform4fv`転送していた。
- 変更内容: GLSL配列長とCPU側`Vector4[]`を、既存の`MAX_REFLECT_BUBBLES = 8`へ揃える。全候補を近い順に選ぶscratch配列は128要素のまま維持する。
- 世界観・結果を維持できる根拠: shaderのループ上限は変更前から8、`uBubbleCount`も最大8である。選抜順、先頭8要素の値、補間、状態変形、反射式は変更しない。削除対象の9〜128要素はshaderから参照不能だった。

## 条件

- before SHA: `ba1648bd365a5242cc0dcde33c4e2313a0684f25`（計測ツールを含むclean tree）
- after SHA: `514b078ed3346954b664b6dc9d8c1a57be495e2c`
- 環境: MacBook Air M1 / 16 GB、ANGLE Metal / Apple M1、Headless Chrome 150.0.0.0、Node.js v22.23.1
- URL: `http://127.0.0.1:4173/?seed=7&slots=24&q=0&m=1&dpr=1&probe=1`
- viewport: 1440×727 CSS px、device DPR 2、実描画buffer 1440×727（`dpr=1`）
- warm-up / 計測: production buildを15秒warm-up後、30秒×5 round。各round約1,800 frame。
- コマンド:

```sh
npm run bench:browser -- --warmup 15 --seconds 30 --rounds 5 \
  --output performance-results/raw/20260714-ocean-uniform-<before|after>.json
```

- raw: [`before`](raw/20260714-ocean-uniform-before.json) / [`after`](raw/20260714-ocean-uniform-after.json)
- GPU timer health: before / afterともdisjoint 0。round末尾の未回収queryは0〜1で、各round1,799〜1,800 GPU samplesを取得した。

## 結果

値は5 roundそれぞれの要約値から取った中央値。時間はms、転送量はbytes/frame。

|指標|Before|After|差分|変化率|判定|
|---|---:|---:|---:|---:|---|
|`uniform4fv` p50|8,960|5,120|-3,840|-42.9%|改善|
|Frame p50|16.700|16.700|0.000|0.0%|非劣化|
|Frame p95|18.200|18.200|0.000|0.0%|非劣化|
|Update p50|0.800|0.800|0.000|0.0%|非劣化|
|Update p95|1.400|1.400|0.000|0.0%|非劣化|
|Update mean|0.862|0.855|-0.007|-0.7%|ノイズ域・非劣化|
|GPU p50|12.355|12.417|+0.061|+0.5%|ノイズ域|
|GPU p95|19.818|19.703|-0.115|-0.6%|ノイズ域|
|GPU mean|12.852|12.924|+0.072|+0.6%|ノイズ域|

`uniform4fv`は全9,000前後のframeでbefore 8,960、after 5,120に固定され、意図した3,840 bytes/frameを確実に除去した。60 fps換算では230,400 bytes/s（225 KiB/s）のdriver呼び出し入力を削減する。時間指標は量子化・run間の揺れを超える改善とは判定しないが、Frame / Updateの中央値とp95は同値で、GPUにも一方向の悪化はない。

CPU側では`Vector4`を2配列×128個から2配列×8個へ減らし、到達不能だった240 objectも構築時に生成しなくなった。fragment uniform予約は256 vec4から16 vec4になる。

### round別raw要約

|系列|Round|Update p50|Update p95|GPU p50|GPU p95|uniform p50|
|---|---:|---:|---:|---:|---:|---:|
|Before|1|1.0|1.5|12.612|20.119|8,960|
|Before|2|1.0|1.4|12.771|20.462|8,960|
|Before|3|0.8|1.4|12.355|19.818|8,960|
|Before|4|0.8|1.3|12.265|19.438|8,960|
|Before|5|0.8|1.3|11.629|19.400|8,960|
|After|1|1.0|1.5|12.465|19.674|5,120|
|After|2|0.8|1.4|12.417|19.579|5,120|
|After|3|0.9|1.4|12.434|19.883|5,120|
|After|4|0.8|1.3|12.356|20.189|5,120|
|After|5|0.8|1.2|12.282|19.703|5,120|

## 不変性

- RNG、sim、`RenderView`、選抜候補、距離sort、先頭8球のpack処理は変更なし。
- shaderの反射ループ回数とbreak条件は変更なし。
- 9要素目以降は変更前からループ境界外で、画像への寄与は数学的にゼロ。
- `npm test -- --run tests/render`: 9 files / 65 tests成功（期待値の更新なし）。
- `npm run typecheck`: 成功。
- 最終の全テスト・lint・dependency-cruiser・production buildはコードコミット前に再実行する。

## 判断

採用。時間差そのものはノイズ域だが、主指標である実転送量が全frameで42.9%減り、Frame / Update p50・p95が非劣化である。世界・描画式・参照可能なuniform値を一切変えず、driver入力、shader uniform圧力、構築時object数だけを減らせる。
