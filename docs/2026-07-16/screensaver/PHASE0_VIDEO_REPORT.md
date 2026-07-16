# macOS動画版スクリーンセーバー Phase 0 実現性検証

- 実施日: 2026-07-16
- 判定: **合格（動画方式で実現可能）**
- 対象コミット: `ffdb83a29ef24e4a7be5097a66333d4836944c0b`
- 検証物: リポジトリ外の `/tmp/mizu-ni-naru-video-screensaver-poc/`

## 結論

WKWebViewを使わず、WebGL画面を事前収録したH.264動画を `AVQueuePlayer` / `AVPlayerLooper` / `AVPlayerLayer` で再生する方式により、macOSのカスタムスクリーンセーバーとして表示できた。

次を実機で確認した。

- システム設定の小型プレビューで映像が動く
- フルスクリーンプレビューで映像が動く
- 現在の日付と時刻をネイティブ表示し、秒単位で更新できる
- 10分間、動画ループが停止・消失・クラッシュしない
- マウス操作でフルスクリーンを終了できる
- 再起動後も映像と時計が動く
- システム設定終了後、動画デコードのCPU負荷が0.0%まで下がる

動画方式は、WKWebView版で発生した黒画面を回避する現実的な方式である。

## 検証環境

|項目|値|
|:---|:---|
|macOS|26.2（Build 25C56）|
|Mac|MacBookAir10,1|
|アーキテクチャ|arm64|
|Chrome|150.0.7871.124|
|ffmpeg|8.0.1|
|ビルド|Xcode Command Line Toolsの `clang`|

## 生成した検証動画

現行の本番ビルドをローカルChromeで実行し、Canvasの `captureStream()` と `MediaRecorder` で収録した。計測表示は映像に含めていない。

|項目|値|
|:---|:---|
|URL|`http://127.0.0.1:4173/?seed=7&q=0&dpr=1&time=21%3A00`|
|収録時間|14.983秒|
|解像度|1280×720|
|平均フレームレート|約30.03fps|
|収録形式|VP9 WebM|
|同梱形式|H.264 High / yuv420p / MP4|
|MP4容量|6,052,646 bytes|
|MP4 SHA-256|`fa4fef9fd383a04ca35c41418c986c5d7ff209d1f72d1abde1bd47a921da3a87`|

## 検証用スクリーンセーバー

- `ScreenSaverView` のObjective-Cサブクラス
- `AVQueuePlayer` + `AVPlayerLooper` による無音ループ再生
- `AVPlayerLayerVideoGravityResizeAspectFill` による画面全体への表示
- `NSTextField` による現在時刻 `HH:mm:ss` と日付の表示
- ユーザー領域向けad hoc署名

機械検証はすべて成功した。

|項目|結果|
|:---|:---|
|`npm run build`|成功|
|`npm test`|34 files / 243 tests 成功|
|Info.plist|`plutil -lint` 成功|
|バイナリ|Mach-O 64-bit bundle arm64|
|Principal Class|ロードと初期化に成功|
|Framework|Cocoa / ScreenSaver / AVFoundation / QuartzCore|
|動画リソース|存在・非空を確認|
|署名|`codesign --verify --deep --strict` 成功|
|バンドル容量|約5.9MiB|

## 10分連続動作

5秒間隔、119サンプルで計測した。

|指標|結果|
|:---|---:|
|CPU最小|5.2%|
|CPU平均|8.76%|
|CPU最大|17.3%|
|RSS最小|54.19MiB|
|RSS平均|57.45MiB|
|RSS最大|60.45MiB|
|RSS増減|**-0.95MiB**|

停止、消失、クラッシュ、継続的なメモリ増加はなかった。

この10分試験時のホストには、削除済みWKWebView版が以前からロードされたまま残っていた。したがってRSSは動画版だけの純粋な値ではなく、保守的な上限として扱う。動画の継続再生とメモリ非増加の判定には使用できる。

## 終了時負荷の問題と対策

macOSの `legacyScreenSaver` ホストは、システム設定を終了してもプロセスを再利用のため残す場合がある。また、この環境では `ScreenSaverView.stopAnimation` が常に呼ばれるとは限らなかった。

初期版ではホストが残ったままAVPlayerも動き続け、終了30秒後にもCPU 5〜7%とVideoToolboxのデコードが確認された。

`NSWindow.occlusionState` を使う対策は、リモート表示されるViewを表示中でも非表示と判定し、時計だけが動いて動画が停止したため不採用とした。

最終版では次の対策を採用した。

- `startAnimation` 時にシステム設定から開始されたホストかを記録
- システム設定から開始されたホストは、システム設定終了後にAVPlayerと時刻更新タイマーを停止
- 通常のスクリーンセーバー起動ではこの抑止を適用しない
- 標準の `stopAnimation` でもAVPlayerとタイマーを停止

最終再試験では、表示中に映像と時計が動き、終了直後と10秒後のCPUはいずれも0.0%だった。ホストプロセス自体はmacOSが待機状態で残すが、動画デコードと継続的なCPU負荷は停止した。

## Phase 1へ持ち越す項目

- 朝、昼、夕方、夜の動画資産
- 時刻に応じた動画選択と切り替え
- ループ境界の調整
- 時計の位置、書体、秒表示の有無
- 複数ディスプレイ
- arm64 / x86_64 Universal Binary
- 再現可能な動画生成、build、verify、installコマンド
- Developer ID署名、公証、配布用ZIPは後続Phase
