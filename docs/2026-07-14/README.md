# 2026-07-14 計測駆動パフォーマンスリファクタリング

作品の世界観、見た目、時間、RNG、反応順を変えずに実施したパフォーマンスリファクタリングの作業記録。

## 入口

- [最終サマリー](performance-results/20260714-final-summary.md): 採用・不採用の結論、累積効果、最終品質ゲート
- [改善案と計測プロトコル](PERFORMANCE_REFACTORING.md): コード解析、候補、優先順位、判定基準
- [計測ツール利用ガイド](../performance/README.md): 常設ベンチマークの詳しい使い方、結果の読み方、トラブル対処
- [当日の計測手順](performance-results/README.md): この作業時点で使用した条件と進め方
- [個別の計測結果](performance-results/): before / after、完全一致検証、採否の記録
- [raw計測データ](performance-results/raw/): ブラウザ計測で保存したJSON

## 追加調査

- [球体の角ばり調査と対応](sphere-faceting/README.md): レイヤー別の切り分け、前景geometryの修正、A/B/A性能計測
- [球内着水しぶき](inner-water-splash/README.md): 雫着水しぶきの境界条件、実装、before / after性能計測
