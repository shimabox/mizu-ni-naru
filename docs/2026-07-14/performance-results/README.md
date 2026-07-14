# パフォーマンス計測手順

## コマンド

シミュレーション全体のベンチマーク:

```sh
npm run bench:sim
```

デフォルト条件はプロジェクトの基準計測を再現する。seed 7、desktop pacing、24 / 128 slots、2,000 stepのウォームアップ、10,000 stepの計測、7 roundで実行する。

```sh
npm run bench:sim -- --slots 24,128 --rounds 7 --warmup 2000 --steps 10000
```

メソッド境界を含むプロファイル:

```sh
npm run profile:sim
```

デフォルトでは7 round実行する。結果にはラッパーのオーバーヘッドと入れ子になった処理時間も含まれるため、各行を合算してはならない。改善対象の優先順位付けに使い、採否は`bench:sim`で判断する。

衝突検出器の閾値ベンチマークと完全互換性の検証:

```sh
npm run bench:detectors
npm run verify:detectors
```

`verify:detectors`はGrid参照実装と本番用検出器をseed 7 / 42 / 123 / 2026で同期実行し、checkpointごとに個数、mass ledger、すべての有効なrender view値を比較する。

本番ビルドのブラウザ / GPUベンチマーク:

```sh
npm run bench:browser -- --output docs/2026-07-14/performance-results/raw/browser.json
```

このコマンドはアプリをビルドし、独立したVite previewとheadless Chrome profileを起動する。15秒のウォームアップ後に30秒の計測を5 round実行して結果を保存する。デフォルト値は基準計測と同じ固定URLおよび1440×727 viewportである。アプリ内の詳細probeは`probe=1`の場合のみ有効になり、通常URLや軽量な`m=1`オーバーレイではWebGLラッパーを導入しない。

JSONにはrAF frame time、JS update time、draw call、instanced draw call、submitted vertices、`bufferSubData` bytes、`uniform4fv` bytes、非同期`EXT_disjoint_timer_query_webgl2` GPU timeのnearest-rank分布を記録する。各roundのraw値と、round中央値の要約も保持する。主な上書きオプションは次のとおり。

```sh
npm run bench:browser -- --warmup 15 --seconds 30 --rounds 5 --width 1440 --height 727
```

Chromeが標準的な場所にない場合は`CHROME_PATH`を設定するか、`--chrome /absolute/path`を渡す。`--url`にはlocalhostだけを指定でき、`probe=1`は自動的に付与される。

ディスプレイリフレッシュレート別のupload要求ベンチマーク:

```sh
npm run bench:uploads
```

固定60 Hzのシミュレーションを60 / 120 / 144 Hzの表示スケジュールで実行し、`BufferAttribute.version`の増加をGPU upload要求として数える。Atom、Droplet、camera sortされるBubbleのattributeを個別に集計する。ブラウザを使わず、upload frame数、要求回数、要求bytes、loop wall timeを記録する。`view.step`やdirty layoutに関する変更の評価に使い、採用する変更は`bench:browser`でも確認する。

## 作業単位ごとの手順

1. 現在のGit SHAと作業ツリーの状態を記録する。
2. 製品コードを変更する前に、対象とする計測コマンドを実行する。
3. 1回の作業では1つのパフォーマンス仮説だけを変更する。
4. 変更後に同一条件、同一コマンドで再計測する。
5. 期待値を更新せず、テストと決定論的golden検証を実行する。
6. raw sampleと採否を`YYYYMMDD-<slug>.md`形式の結果ファイルに記録する。
7. 採用した変更だけをコミットする。不採用の変更を別の最適化と同じコミットに混ぜない。

シミュレーションまたはブラウザのベンチマーク中は、ほかのブラウザを閉じておく。ブラウザ / GPU計測では本番ビルド、固定URLパラメータ、固定viewport、および[`PERFORMANCE_REFACTORING.md`](../PERFORMANCE_REFACTORING.md)の計測プロトコルを使用する。
