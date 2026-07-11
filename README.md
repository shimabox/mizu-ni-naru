# 水になる(mizu-ni-naru)

H と O が出会い、雫になり、球体を満たし、海へ還る — ぼーっと眺める水の世界。

半透明の球体が空中に何個も浮かんでいる。中では文字 H / O が漂い、`H + H → H2`、
`H2 + O →` 雫になって球の底に溜まっていく。水が満ちると球は落下し、下界の海に
着水して弾け「水になる」。新しい球が生まれ、これが永遠に繰り返される。

操作は不要 — スクリーンセーバーのように、放っておけば勝手に世界が進む。

## デモ

https://app.orukubami.sh/mizu-ni-naru/

![水になる — 満ちていく球体と海](images/demo.png)

## 操作

カメラは自動でゆったり漂う(スクリーンセーバー的)。触るとオービットできる:

- **放置** — 自動でカメラが世界を漂う(リサージュ的な軌道・非反復)
- **ドラッグ** — クリック/タップしたまま動かすとカメラがオービット
- **ホイール / ピンチ** — ズーム(距離クランプ付き)
- 操作をやめて約 5 秒後、自動ドリフトへ滑らかに復帰する
- `prefers-reduced-motion` を尊重(カメラのドリフトを停止。世界の進行自体は止めない)

## URL パラメータ

|パラメータ|既定|説明|
|:---|:---|:---|
|`seed`|(乱数)|RNG シード。同じ値で毎回同じ世界が再現される|
|`m`|`0`|`1` で計測オーバーレイを表示(FPS/Frame/Update/カウンタ/Tier)。品質は tier0 固定・マウス視差無効・カメラは t=0 起点になる|
|`q`|(自動)|品質ティアを `0`〜`4` に固定(0 が最高品質)。指定すると自動品質調整(AdaptiveQuality)が無効になる|
|`dpr`|`2`|`devicePixelRatio` の上限(ベンチマークの機種間比較用)|
|`sim`|(実 sim)|`stub` で合成アニメの StubSim に差し替え(レンダリング単体の動作確認用)|
|`slots`|(自動)|球のスロット数を上書き(デバッグ用)。既定はビューポート幅 <768px でモバイル値、それ以外はデスクトップ値|

例: https://app.orukubami.sh/mizu-ni-naru/?seed=7&m=1

## 開発

[mise](https://mise.jdx.dev/) が Node.js のバージョンを管理する(`mise.toml` に固定)。

```sh
# mise のインストール
curl https://mise.run | sh

# 固定バージョンの Node.js を導入(mise.toml を読む)
mise install

# 依存パッケージのインストール
npm install
```

npm スクリプト(`mise exec --` 経由での実行を推奨):

|スクリプト|説明|
|:---|:---|
|`npm run dev`|開発サーバ起動(Vite)|
|`npm run build`|型検査(2 tsconfig)+ 本番ビルド|
|`npm run preview`|本番ビルドのプレビュー|
|`npm run test`|テスト実行(Vitest)|
|`npm run lint`|Biome での静的検査|
|`npm run lint:fix`|Biome での自動修正|
|`npm run typecheck`|`tsconfig.json` + `tsconfig.sim.json` の型検査(後者は sim 層の DOM 非依存性を保証)|
|`npm run depcruise`|dependency-cruiser によるレイヤ境界の強制検査|
|`npm run calibrate`|シミュレーションのペーシング(満水時間・落下間隔)をヘッドレスで校正|

## アーキテクチャ

4 層構成。依存方向は dependency-cruiser で機械強制する:

```
contract/   sim ↔ render の唯一の接点。型と定数のみ、依存ゼロ
sim/        シミュレーション本体。純ロジック(DOM・three.js 非依存)
render/     three.js による描画層(three を import できる唯一の場所)
app/        合成ルート(DI・rAF ループ・URL パラメータ・オーバーレイ)
```

設計の詳細(裁定の経緯・契約・各層の詳細設計)は [`.claude/plans/`](.claude/plans/) を参照:
[`master-plan.md`](.claude/plans/master-plan.md)(裁定・フェーズ)/
[`design-sim.md`](.claude/plans/design-sim.md)(シミュレーション層)/
[`design-render.md`](.claude/plans/design-render.md)(レンダリング層)。

テストは 205 本(Vitest。sim/render/app/contract の各層を横断)。

### Dependency Graph

![Dependency Graph](dependency-graph.svg)

`npm run dependency-graph` で `dependency-graph.svg` をリポジトリルートに生成する(dependency-cruiser + Graphviz `dot` が必要)。

## デプロイ

`npm run build` の出力 `dist/` を任意の静的ホスティングへそのまま配置できる
(Vite の `base` は常に相対パス — サブパス配下でも資産解決が壊れない)。
このリポジトリのデモは Cloudflare 上の `https://app.orukubami.sh/mizu-ni-naru/`
というサブパスに配置している。

## ライセンス

ISC
