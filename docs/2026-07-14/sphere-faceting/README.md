# 球体の角ばり調査と対応

## 結論

大きく映る前景球が少し角ばって見える原因は、法線や水面キャップではなく、GlassとInnerWater volumeの外周シルエットを作る`IcosahedronGeometry(1, 4)`の分割密度だった。

shader内の法線は既に球面へ正規化されているため面内の陰影は滑らかだが、detail 4は500三角形しかなく、外周には短い直線区間が残る。GlassとInnerWaterは別meshで同じ輪郭を描くため、どちらか片方だけを高密度化しても角ばりは消えない。

detail 5の720三角形でも下端に小さな平坦部が残り、detail 6の980三角形で固定条件の表示上、直線区間を判別できない程度まで解消した。そこで前景2レイヤーを共通factoryからdetail 6で生成する。Backdropは画面上の投影サイズが小さく角ばりを判別できないためdetail 4を維持する。

色、透明度、shader式、時間、RNG、animation、camera、球数、水面キャップ、Backdropの見え方は変更していない。

## 変更前の固定

製品コード変更前に次の状態を記録した。

- Git commit: `9743926550c2193b4687b2dafad569c44fdfc7b9`
- 作業ツリー: clean
- seed: 7
- slots: 24
- quality tier: 0
- viewport: 1440×727
- DPR上限: 1
- browser benchmark: 15秒warm-up、30秒×5 round

性能baseline: [raw JSON](raw/20260714-browser-before.json)

## レイヤー別の切り分け

時系列差を排除するため、同じrendererを使う決定論的`sim=stub`で中央手前の球を同じ表示条件で比較した。

- 変更前（Glass 500 / InnerWater 500 triangles）: 青い水体の下端と透明リムの両方に直線区間が見える
- Glassだけdetail 8: 透明な上半球のリムは滑らかになるが、青いInnerWaterの外周は残る
- InnerWaterだけdetail 8: 青い下半球は滑らかになるが、Glassの透明リムは残る
- 両方detail 5（720 triangles）: 下端に短い平坦部が残る
- 両方detail 6（980 triangles）: 直線区間を判別できない程度まで滑らかになる

この切り分けにより、両meshの同時対応が必要であり、detail 6が視覚要件を満たす最小値だと判定した。比較画像は差が伝わりにくくリポジトリ容量だけを増やすため、作業記録には含めない。

## 実装

- `BubbleGeometry.ts`へ`FOREGROUND_BUBBLE_DETAIL = 6`と共通factoryを追加
- `BubbleGlassSystem`のnear / farを共通factoryから生成
- `InnerWaterSystem`のvolume near / farを同じfactoryから生成
- `BackdropBubbles`はdetail 4を維持
- AdaptiveQualityの全tierで前景detail 6を維持
- 980三角形が生成されることをunit testで固定

生成元を1か所へ集約することで、過去に起きた「Glassだけ修正」「InnerWaterだけ修正」の再発を防ぐ。

## 性能計測

正式な5 round before / after:

|指標|Before detail 4|After detail 6|差分|
|:---|---:|---:|---:|
|Frame p50|16.700 ms|16.700 ms|0.0%|
|Frame p95|17.500 ms|18.200 ms|+4.0%|
|GPU p50|14.565 ms|14.406 ms|-1.1%|
|GPU p95|15.861 ms|18.857 ms|+18.9%|
|Update p95|1.300 ms|1.300 ms|0.0%|
|Submitted vertices p50|499,746|603,426|+103,680 / +20.7%|
|Draw calls p50|28|28|0|
|Instanced draw calls p50|11|11|0|

- Before: [raw JSON](raw/20260714-browser-before.json)
- After: [raw JSON](raw/20260714-browser-after.json)

GPU p50とmeanは悪化していない一方、最初のbeforeに対してGPU tailだけが大きく上がった。geometry負荷と計測セッション間の変動を切り分けるため、after直後にdetail 4へ戻して30秒×3 roundのA/B/A再計測を行った。

同じ3 round同士の中央値:

|指標|detail 4再計測|detail 6・先頭3 round|差分|
|:---|---:|---:|---:|
|Frame p50|16.700 ms|16.700 ms|0.0%|
|Frame p95|17.400 ms|17.400 ms|0.0%|
|GPU p50|14.402 ms|14.472 ms|+0.5%|
|GPU p95|18.538 ms|18.857 ms|+1.7%|
|GPU p99|20.798 ms|21.178 ms|+1.8%|
|Submitted vertices p50|499,746|603,426|+20.7%|

detail 4の再計測でもGPU p95は18.46〜18.56 msに上がっており、正式beforeとの差の大半はセッション間のGPU tail変動だった。A/B/Aの近接比較ではFrame中央値とtailを維持し、GPU差は0.5〜1.8%に収まる。

再計測: [raw JSON](raw/20260714-browser-detail4-recheck.json)

## 採否

採用する。

- 固定条件の表示比較で角ばりの原因と改善を再現できた
- detail 5では視覚要件を満たさず、detail 6が最小値だった
- draw call、upload、CPU updateは増えない
- A/B/A近接比較でFrame p50 / p95は同値
- GPU実時間差は最大1.8%で、視覚改善に対して許容範囲
- world state、RNG、animation、shaderの色・式は不変

## 品質ゲート

- `npm test`: 33 files / 237 tests成功
- `npm run lint`: 103 files成功
- `npm run typecheck`: 成功
- `npm run depcruise`: 74 modules / 217 dependencies、違反なし
- `npm run build`: 成功
- production bundle: 664.03 kB / gzip 177.43 kB
- `git diff --check`: 成功
