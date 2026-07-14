# 時刻連動の空

## 目的

端末のローカル時刻に合わせて、既存世界の空・主光源・水面と球の反射を朝、昼、夕方、夜へ連続的に変化させる。夜は奥行きのある控えめな星空、夕方は薄い茜を加えるが、水と球を主役のまま維持する。

## 最終仕様

- 通常表示は端末のローカル時刻へ追従する
- 時刻は15秒ごとに読み直し、毎フレームの`Date`生成を避ける
- 夜紺、夜明け、朝、昼、午後、夕映え、青の時間をキーフレーム間で連続補間する
- 空の4色、主光源の方向・色、露出、星の可視量を同じ時刻モデルから決める
- 共有`sky()`を介し、海、球、雫の反射・屈折・フォグも背景と同じ空気へ変える
- 星は配置、等級、色温度、瞬きに個体差を持つ固定天球として背景パス内で描く
- 星のためのdraw call、geometry、画像assetは追加しない
- 月は前景の球と視覚的に競合したため、ユーザーレビュー後に描画と関連uniformを完全に削除した
- sim、RNG、step順、反応、球の状態遷移は変更しない

## 時間帯

切り替え時刻で色を段階的に変えず、前後のキーフレームをsmoothstepで補間する。

|目安|雰囲気|
|:---|:---|
|00:00〜04:45|夜紺、奥行きのある疎らな星|
|05:30〜06:15|夜明け、星が消える薄明|
|08:00|従来の朝景をそのまま保存した基準時刻|
|12:00|高い昼光と淡い青空|
|16:30〜18:15|午後から茜色の夕景|
|19:15〜20:30|青の時間から星夜へ|

## 時刻固定

省略時は端末時刻へ追従する。表示確認、テスト、性能計測では`time=HH:MM`で固定できる。

```text
http://localhost:5173/?m=1&time=08:00
http://localhost:5173/?m=1&time=12:00
http://localhost:5173/?m=1&time=18:15
http://localhost:5173/?m=1&time=21:00
```

`00:00`〜`23:59`だけを受け付け、不正値は未指定扱いにする。常設の`bench:browser`は時間帯の差を性能比較へ混ぜないため、既定URLを`time=08:00`へ固定した。

## 実装

- `TimeOfDay.ts`: 時刻正規化、ローカル時刻変換、キーフレーム、再利用可能な状態への補間
- `Environment.ts`: 時刻の定期読取、共有uniform、星、露出の所有
- `sky.ts`: uniform化した空色、昼は休止する星のuniform分岐
- `SceneRenderer.ts`: Environmentの露出を既存ACES出力へ反映
- `urlParams.ts`: `time=HH:MM`の検証と分変換

08:00は従来の固定スカイと同じ空色、太陽方向、太陽色、露出を持つ。これにより、時刻連動を入れても従来の朝景を失わない。

## 目視検証

production buildを固定seed・固定camera・1440×727で起動し、08:00、12:00、18:15、21:00を一時画像で比較した。

- 08:00: 従来の朝景と同じ構図・色調
- 12:00: 朝より冷たく明るい昼光
- 18:15: 太陽と反対側の画角にも薄い茜が回り、水面へ反射する
- 21:00 / 22:21: 水面と球を潰し切らない夜紺、明るさ・大きさ・色が異なる星
- 夜の水平線で虹彩を抑え、オーロラ状の色帯が出ないことを確認
- 星をセル中心からずらし、等間隔の点群に見えないことを確認
- 月および月用uniformが描画コードに残っていないことを確認
- screenshotは目視だけに使い、リポジトリへ保存していない

## 性能計測

### 条件

- 変更前commit: `c29af05d8a965465c1c0917440e3f4ceb5a42830`
- 変更前作業ツリー: clean
- seed: 7
- slots: 24
- quality tier: 0
- viewport / drawing buffer: 1440×727
- DPR上限: 1
- browser benchmark: 15秒warm-up、30秒×5 round
- GPU: ANGLE Metal / Apple M1

変更前コードは時刻パラメータを持たず、固定された従来の朝景だった。変更後の08:00を同じ朝景へ合わせて比較し、追加処理が動く21:00も同条件で別計測した。

- 変更前: [20260714-browser-before.json](raw/20260714-browser-before.json)
- 変更後・08:00: [20260714-browser-after-day.json](raw/20260714-browser-after-day.json)
- 変更後・21:00: [20260714-browser-night.json](raw/20260714-browser-night.json)

### 初回実装の結果

|指標|変更前|08:00|21:00|
|:---|---:|---:|---:|
|Frame p50|16.700 ms|16.700 ms|16.700 ms|
|Frame p95|17.500 ms|17.500 ms|17.400 ms|
|Frame p99|17.600 ms|17.600 ms|17.600 ms|
|Update p50|0.600 ms|0.600 ms|0.600 ms|
|Update p95|1.300 ms|1.200 ms|1.200 ms|
|Update p99|1.500 ms|1.600 ms|1.500 ms|
|GPU p50|14.897 ms|14.485 ms|14.886 ms|
|GPU p95|16.102 ms|18.867 ms|17.311 ms|
|GPU p99|16.657 ms|21.076 ms|20.926 ms|
|Draw calls p50|28|28|28|
|Instanced draw calls p50|11|11|11|
|Submitted vertices p50|604,092|603,426|603,426|
|Buffer upload p50|26,368 bytes|26,336 bytes|26,096 bytes|
|Uniform vec4 upload p50|5,120 bytes|5,120 bytes|5,120 bytes|

全15 roundでGPU timerは有効、disjoint sampleは0だった。Frame p50 / p95 / p99とUpdate p50は維持した。GPU p50は08:00で2.77%減、21:00で0.07%減だった一方、p95 / p99は上振れしたため、GPU時間全体の改善とは判定しない。各計測のmedian round meanは変更前14.217 ms、08:00 13.957 ms、21:00 14.143 msであり、tailの上振れはend-user Frame時間には現れていない。

draw call、instanced draw call、uniform vec4転送は同値である。頂点数とbuffer uploadの小差は、同じsimをwall-clock frameでサンプルした際のLOD・イベントタイミング差であり、時刻機能はgeometryとinstanceを追加していない。

### 夜空の視覚修正

初回実装後のユーザーレビューで、月が前景の白い球に見えること、夜の水平線がオーロラ状に見えること、星が均一な発光点に見えることが分かった。修正前の22:21を先に計測し、月を完全に削除、暗い時間帯の虹彩を抑制、星の配置・等級・色温度・瞬きを再設計した後、同じ22:21で再計測した。

- 修正前: [20260714-moon-legibility-before.json](raw/20260714-moon-legibility-before.json)
- 修正後: [20260714-night-sky-after.json](raw/20260714-night-sky-after.json)

|指標|修正前|修正後|差|
|:---|---:|---:|---:|
|Frame p50|16.700 ms|16.700 ms|±0.000 ms|
|Frame p95|17.500 ms|17.600 ms|+0.100 ms|
|Frame p99|17.700 ms|17.700 ms|±0.000 ms|
|Update p50|0.700 ms|0.800 ms|+0.100 ms|
|Update p95|1.500 ms|1.500 ms|±0.000 ms|
|Update p99|2.600 ms|1.900 ms|-0.700 ms|
|GPU p50|17.362 ms|14.871 ms|-14.3%|
|GPU p95|25.622 ms|21.989 ms|-14.2%|
|GPU p99|30.547 ms|25.104 ms|-17.8%|
|GPU mean|17.895 ms|15.036 ms|-16.0%|
|Draw calls p50|28|28|±0|
|Instanced draw calls p50|11|11|±0|
|Submitted vertices p50|603,426|603,426|±0|
|Buffer upload p50|26,320 bytes|26,304 bytes|-16 bytes|
|Uniform vec4 upload p50|5,120 bytes|5,120 bytes|±0 bytes|

全10 roundでGPU timerは有効、disjoint sampleは0だった。Frame p50 / p99と描画量は維持し、Frame p95とUpdate p50の+0.1 msは絶対値が小さく、GPU処理を変えた今回の修正によるCPU負荷増とは判定しない。月の分岐と計算を除去した効果が星の表現追加を上回り、GPU p50 / p95 / p99 / meanはいずれも短縮した。

production bundleは機能追加前の664.03 kB / gzip 177.43 kBから、最終的に669.64 kB / gzip 179.78 kBとなった（+5.61 kB / gzip +2.35 kB）。初回実装後の668.44 kB / gzip 179.27 kBからは+1.20 kB / gzip +0.51 kBである。詳細probe bundleは変更していない。

## 正しさ

- 時刻の24時間循環、負値、ローカル時刻の小数分変換をunit test
- 08:00が従来の空色・太陽方向・露出を保つことをunit test
- 昼は星を消し、夜は星と低い露出を使うことをunit test
- 夕方の暖色地平線をunit test
- `time=HH:MM`の正常値・境界・不正値をunit test
- production Chromeで4時間帯と最終22:21のGLSLが描画されることを確認
- 既存simのコード・契約ファイルは変更していない

## 判定

採用する。

- 端末時刻だけを入力に、既存世界の描画環境を連続的に変える
- 背景だけでなく水・球・雫の反射まで同じ色へ変わる
- 夜でも水と球を主役に保ち、星は奥行きを作る補助に留める
- 再現用の時刻固定を提供し、常設browser benchmarkも08:00固定へ更新した
- Frame時間、draw、頂点上限、uploadを維持する
- 初回実装のGPU tail上振れと、夜空修正後の同条件での短縮を分けて記録する
