# 計測駆動パフォーマンスリファクタリング 最終サマリー

## 結論

作品の世界観、見た目の式、時間、RNG、反応順を変えず、次の7作業単位を採用した。

1. 衝突ペア順互換の小規模直接走査
2. `AggregatePacker`の一時`subarray` view除去
3. 海面反射uniform配列の128→8実使用上限化
4. Sprayの未書き込みring suffix描画省略
5. Atomの0-step frame upload抑制
6. Dropletの0-step frame upload抑制
7. Bubbleのcamera-aware layout不変frame upload抑制

同一detailのGlass / InnerWater draw統合は、draw callが3減っても全体時間改善が一貫しなかったため不採用とし、製品コードを完全に戻した。

## 累積結果

### シミュレーション

条件はseed 7、desktop pacing、2,000 step warm-up、10,000 step×7 round。初期値は変更前の正式baseline、最終値は全作業・全復帰後の最終ゲートである。

|構成|初期median|最終median|差分|変化率|
|---|---:|---:|---:|---:|
|24 slots|0.128709 ms/step|0.077664 ms/step|-0.051045|-39.7%|
|128 slots|0.764588 ms/step|0.481482 ms/step|-0.283106|-37.0%|

最終7 samples:

- 24 slots: `0.075639, 0.088623, 0.077664, 0.085389, 0.076937, 0.077969, 0.077049`
- 128 slots: `0.483857, 0.493228, 0.468055, 0.470030, 0.479243, 0.481482, 0.483047`

### 描画・転送の直接指標

|作業単位|主指標|Before|After|変化|
|---|---|---:|---:|---:|
|Ocean reflection uniform|`uniform4fv` bytes/frame|8,960|5,120|-42.9%|
|Spray未書き込みsuffix|submitted vertices p99|524,202|510,180|-2.7%|
|Atom upload・120Hz|要求bytes/60s|198,144,512|99,098,560|-50.0%|
|Atom upload・144Hz|要求bytes/60s|237,778,624|99,075,904|-58.3%|
|Droplet upload・120Hz|要求bytes/60s|4,374,048|2,187,840|-50.0%|
|Droplet upload・144Hz|要求bytes/60s|5,249,904|2,187,120|-58.3%|
|Bubble upload・120Hz|要求bytes/60s|12,441,600|6,329,664|-49.1%|
|Bubble upload・144Hz|要求bytes/60s|14,929,920|6,336,576|-57.6%|

60Hz・1 step/frameではstep-gated upload量は意図どおり同値であり、通常経路のUpdate中央値・tailに回帰がないことをproduction browserで確認した。

## 世界の不変性

- `verify:detectors`: seed 7 / 42 / 123 / 2026、各10,000 step、合計40 checkpointでexact match。
- 比較対象: counts、mass ledger、Bubble curr/prev、Atom curr/prev/color/aux、Droplet buffer。
- 衝突ペアの平坦な列順をGrid参照と一致させ、集合一致だけでは採用していない。
- RNG呼び順、sim step 60Hz、補間、camera、shaderの見た目係数、球detail、エフェクト数は変更していない。
- 既存期待値の再記録なし。

## 最終品質ゲート

- `npm test`: 32 files / 236 tests成功
- `npm run lint`: 101 files成功
- `npm run typecheck`: 成功
- `npm run depcruise`: 73 modules / 214 dependencies、違反なし
- `npm run build`: 成功
- production bundle: 通常chunk 664.04 kB / gzip 177.43 kB
- 詳細計測probeはdynamic importされた別chunk 5.32 kB / gzip 1.49 kBで、`probe=1`以外では読み込まない

## 常設した計測ツール

```sh
npm run bench:sim
npm run profile:sim
npm run bench:detectors
npm run verify:detectors
npm run bench:uploads
npm run bench:browser -- --output performance-results/raw/browser.json
```

`bench:browser`はproduction build、isolated Vite preview、isolated headless Chrome、固定viewport、warm-up、複数round、GPU timer、WebGL呼び出し計数、raw JSON保存、process/profile cleanupまで1コマンドで行う。

## 個別結果

- [`初期baseline`](20260714-baseline.md)
- [`ordered direct detector`](20260714-ordered-direct-detector.md)
- [`packer subarray`](20260714-packer-subarray.md)
- [`ocean reflection uniforms`](20260714-ocean-reflection-uniforms.md)
- [`spray initialized prefix`](20260714-spray-initialized-prefix.md)
- [`atom step upload`](20260714-atom-step-upload.md)
- [`droplet step upload`](20260714-droplet-step-upload.md)
- [`bubble layout upload`](20260714-bubble-layout-upload.md)
- [`LOD draw統合・不採用`](20260714-identical-lod-draw-rejected.md)

## 次に試す候補

優先順は次のとおり。いずれも同じbefore / afterゲートを通す。

1. `EffectComposer`の未使用フル解像度HDR targetを単一化し、VRAMとresize再確保を削減する。
2. Backdropの同一instance内per-vertex超越関数をper-instanceへ移す。
3. Sprayをイベント時compactし、寿命切れを除いたlive prefixと部分uploadへ進める。α合成index順を固定する。
4. Atom / Dropletの静的metadataへdirty versionを導入し、sim stepごとの不要転送をさらに分離する。
5. Ocean shaderの重複式を、画像一致とGPU timerを見ながら1式ずつ整理する。
