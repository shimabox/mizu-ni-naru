# 2026-07-16 macOS動画版スクリーンセーバー

WKWebView方式の実機検証で黒画面を解消できなかったため、現行WebGL画面を動画へ変換し、macOSネイティブの動画再生と日時表示でスクリーンセーバー化する作業記録。

## 入口

- [動画版Phase 0実現性検証](screensaver/PHASE0_VIDEO_REPORT.md): 一時PoC、実機確認、終了時負荷の調査と合否
- [計測結果](screensaver-results/README.md): 作業単位ごとの条件、CPU、メモリ、容量、採否
- [開始前ベースライン](screensaver-results/20260716-phase0-baseline.md): Phase 1開始時点の比較基準
- [正式版10分連続動作](screensaver-results/20260716-formal-runtime.md): 実機プレビューのCPU、メモリ、終了時負荷
- [動画の長尺化と画質比較](screensaver-results/20260716-video-loop-quality.md): 1080p比較、60秒化、容量と継ぎ目の最終判断
- [最終版単体計測](screensaver-results/20260716-final-clean-runtime.md): 旧版削除後のCPU、メモリ、終了時停止

正式実装の使い方、ビルド、インストール、性能計測は [`screensaver/macos/README.md`](../../screensaver/macos/README.md) にまとめている。
