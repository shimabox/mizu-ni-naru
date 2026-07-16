# macOSスクリーンセーバー

現行のWebGL画面から生成した動画をmacOSネイティブのAVFoundationで再生する。WebKitは使用せず、ネット接続も必要としない。

## 動作

- 現在のローカル時刻から朝、昼、夕方、夜の動画を選ぶ
- 起動中に時間帯の境界を越えると、再生位置を同期して3秒かけて切り替える
- 現在の日付と時刻は動画へ焼き込まず、ネイティブの文字として更新する
- 動画は無音でループする
- 画面比率が異なる場合は中央基準のAspect Fillで表示する

時間帯は次のように分けている。

|時間帯|範囲|収録時刻|動画|
|:---|:---|:---|:---|
|朝|05:30〜09:59|08:00|`morning.mp4`|
|昼|10:00〜16:29|12:00|`day.mp4`|
|夕方|16:30〜20:29|18:15|`evening.mp4`|
|夜|20:30〜05:29|21:00|`night.mp4`|

## 必要な環境

通常のビルドとインストール:

- macOS 14以降
- Xcode Command Line Tools
- Node.js 22とnpm（リポジトリ全体の開発環境）

動画を作り直す場合のみ追加で必要:

- Google ChromeまたはChromium
- ffmpeg / ffprobe

## ビルド

リポジトリのルートで実行する。

```sh
npm run screensaver:build:mac
```

生成先:

```text
build/screensaver/macos/MizuNiNaru.saver
```

ビルドはインストールを行わない。次を自動検証する。

- Info.plist
- arm64 / x86_64 Universal Binary
- AVFoundationリンク
- 4本のH.264 / yuv420p / 1280×720 / 約60秒動画
- 動画manifestと再生同期時間の整合
- 時間帯境界と1,440分すべての割り当て
- Principal ClassのロードとView初期化
- ad hoc署名

検証だけを再実行する場合:

```sh
npm run screensaver:verify:mac
```

別のバンドルを検証する場合はパスを渡せる。

```sh
bash scripts/verify-macos-screensaver.sh /path/to/MizuNiNaru.saver
```

## インストール

システム設定を終了してから実行する。

```sh
npm run screensaver:install:mac
```

インストール先:

```text
~/Library/Screen Savers/MizuNiNaru.saver
```

インストール後、システム設定の「壁紙」でスクリーンセーバーを開き、`MizuNiNaru` を選ぶ。

ビルドとインストールは意図的に分離している。`screensaver:build:mac` はシステム設定やユーザー領域を変更しない。

削除する場合:

```sh
rm -rf "$HOME/Library/Screen Savers/MizuNiNaru.saver"
```

## 性能計測

インストール済みの `MizuNiNaru.saver` を読み込んでいる `legacyScreenSaver` プロセスを自動検出し、CPU使用率とRSSを記録できる。計測ツール自体はシステム設定やプレビューを操作しない。

### 10分計測

1. システム設定の「壁紙」で `MizuNiNaru` を選ぶ
2. ターミナルで次のコマンドを実行する
3. 「検出したPID」が表示されたら、フルスクリーンプレビューを開始する
4. 計測が終わるまでプレビューを表示したままにする

```sh
npm run screensaver:benchmark:mac -- \
  --duration 600 \
  --interval 5 \
  --output docs/2026-07-16/screensaver-results/raw/local-10min.json
```

1分ごとに現在のCPUとRSSを表示する。JSONには全サンプル、プロセス別集計、最も長く再生状態だったPIDを保存する。CPU 0.5%未満のサンプルは、停止後や小型プレビューの待機状態として再生中集計から除く。

出力先を省略した場合は、画面に集計だけを表示する。

```sh
npm run screensaver:benchmark:mac
```

### 主なオプション

|オプション|既定値|内容|
|:---|---:|:---|
|`--duration`|600秒|計測時間|
|`--interval`|5秒|サンプリング間隔|
|`--wait`|120秒|対象プロセスが現れるまで待つ時間|
|`--bundle`|インストール済み正式版|別の `.saver` を計測する|
|`--pid`|自動検出|特定のPIDだけを計測する|
|`--output`|なし|JSONの保存先|

全オプションは次で確認できる。

```sh
npm run screensaver:benchmark:mac -- --help
```

### 計測結果の読み方

- CPUは1コアを100%とするmacOSのプロセス使用率
- RSSはプロセスが保持している物理メモリの概算
- `activeSampleCount` は再生中と判定されたサンプル数
- `growth` が計測ごとに増え続ける場合はメモリリークを疑う
- 小型プレビューとフルスクリーンが同じホストへ同居する場合があるため、JSONの `primaryPid` と `activeSampleCount` を基準に見る

安定性を見る標準条件は600秒・5秒間隔とする。短い動作確認には、たとえば `--duration 30 --interval 2` を使える。異なる実装を比較するときは、解像度、表示時間帯、計測時間、サンプリング間隔を揃える。

計測終了後はプレビューとシステム設定を閉じ、`legacyScreenSaver` のCPUが0%付近まで戻ることも確認する。macOSは待機プロセスだけを残す場合があり、プロセスが存在すること自体は異常ではない。

## 動画の再生成

4時間帯を本番ビルドから作り直す。

```sh
npm run screensaver:capture:mac
```

このコマンドは最初にWebアプリをビルドし、その後に独立したVite previewとヘッドレスChromeを起動する。各時間帯を62秒収録し、冒頭と末尾の2秒をクロスフェードした約60秒のH.264動画を生成する。

生成先:

```text
screensaver/macos/Resources/Videos/
```

代表的な上書き例:

```sh
npm run screensaver:capture:mac -- \
  --periods night \
  --duration 62 \
  --crossfade 2 \
  --width 1280 \
  --height 720 \
  --fps 30 \
  --seed 7
```

`--periods`は `morning,day,evening,night` から選ぶ。Chromeが標準の場所にない場合は `CHROME_PATH` または `--chrome` で絶対パスを指定する。

生成条件、ffprobe結果、SHA-256は [`Resources/Videos/manifest.json`](Resources/Videos/manifest.json) に保存する。raw WebMと一時Chrome profileはOSの一時領域に作成し、終了時に削除する。

## 設計上の注意

### 終了時の負荷

macOSの `legacyScreenSaver` ホストは、システム設定を終了したあとも待機プロセスを残すことがある。システム設定から開始されたViewは、システム設定終了後にAVPlayerと時計タイマーを停止する。通常の `stopAnimation`、View非表示、ウィンドウ終了でも再生を停止する。

### 署名

現在は個人利用とローカル検証向けのad hoc署名である。他のMacへ正式配布する場合はDeveloper ID署名と公証を別Phaseで行う。

### 動画容量

4本の動画は合計96,852,281 bytes（約93MiB）、ローカルで作成した配布用ZIPは96,866,200 bytes。28秒版より反復を感じにくくするため約60秒へ延長した。長期的なリポジトリ容量とActions artifactは配布Phaseで改めて判断する。

## 検証記録

- [動画版Phase 0実現性検証](../../docs/2026-07-16/screensaver/PHASE0_VIDEO_REPORT.md)
- [Phase 1の計測結果](../../docs/2026-07-16/screensaver-results/README.md)
