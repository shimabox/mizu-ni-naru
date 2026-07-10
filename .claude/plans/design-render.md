# mizu-ni-naru レンダリング層 詳細設計(design-render.md)

- 作成: 2026-07-10(レンダリング設計エージェント)。オーケストレーターの裁定済み事項(4層構成 / 座標系 / 60Hz 固定ステップ+prev-curr 補間 / 契約叩き台 / instanced 徹底 / ポスト構成 / AdaptiveQuality 7ノブ / 太陽 uniform 単一所有 / アートディレクション)に従う。契約への変更提案は文末「裁定希望事項」に集約し、本文はその裁定が通った前提の最終形で書く
- **コードはゼロから新規実装**(既存プロジェクトからのコードコピー禁止)。ただし Mizu-threejs / Mizu-ts で実証済みの知見・パターンは積極的に採用し、出典ファイルパスを本文と §10 来歴表に明記する
- スタック: three.js ^0.185(唯一のランタイム依存)+ TypeScript strict + Vite(GH Pages, `base:'./'`)。WebGL2 必須。シェーダは GLSL3 の `.ts` テンプレートリテラル(Vite 設定ゼロ・文字列合成可能 — Mizu-threejs `src/render/shaders/*.ts` の方式を踏襲)
- 性能目標: デスクトップ(Apple Silicon, DPR2)で tier0 60fps、モバイル中級機で tier3 60fps。**最重要要件は海のクオリティ — 本書の主役は §2 Ocean v2**

---

## §0 目的と Look 定義

**アートステートメント(3行)**

> 夜明け直後の凪いだ外洋。ガラスの球が朝の低い太陽を受けて虹彩にきらめき、その内側で小さな海が育っていく。
> 水は生まれ、雫となって落ち、水位を上げ、やがて球ごと海へ還る — 「水になる」円環を、静謐な環境映像として永遠に繰り返す。
> 画面の主役はどこまでも続く海そのもの。長いスウェルのうねり、ターコイズに透ける波頭、繊細な glitter が、観る者の呼吸をゆっくりにする。

**参照イメージの言語化**(実装が迷ったらここへ戻る)

- 光: 仰角 ~14° の暖色の太陽(#ffd19a 系)。逆光気味の海に長い光の道(sun path)が走り、その中で無数の微小な glint が明滅する
- 海: 手前は青緑(ターコイズを含む)、遠方へ深青 → 大気ヘイズでパステルの空に溶ける。波は「凪 + 長いスウェル」で、白波はごく控えめ。球の着水時だけフォームリングが花のように開いて消える
- 球: シャボン玉と硝子の中間。輪郭はフレネルの明るいリム、面はうっすら虹彩(パステルの干渉色)。内水面との境界(メニスカス)が #007fff の細い光の帯
- 空: 淡い蒼穹。太陽側の地平が桃色に暖まり、反対側は青灰。雲はごく薄い気配だけ
- トーン: 彩度抑えめ・ドリーミー・上品。bloom は「発光体の周りにほんのり」— 白飛びの塊は作らない(Mizu-threejs 実測教訓: threshold 1.15、`src/render/PostPipeline.ts`)
- 水のアイデンティティカラーは Mizu 伝統の **#007fff**(出典: Mizu-ts `src/core/renderers/DropletRenderer.ts` の SHADOW_COLOR / グラデ終端)。ただし外海は自然色に寄せ、#007fff は「球の中の水・雫・メニスカス」に集中させて意味を持たせる

---

## §1 シーン構成と RenderSystem インターフェース

### 1.1 世界と描画の前提(裁定済み)

- y-up 右手系、**海面 world y=0**。球体 R ∈ [1.1, 1.7]、中心リング(半径 ≈ 4.5、y ∈ [2.8, 5.2])に最大 7 個(モバイル 5)
- カメラ fov 45°、原点(リング中心)からの距離 9〜11 を自動ドリフト(§8)。near 0.1 / far 1200
- sim は固定 60Hz。renderer は `render(view, alpha)` で prev/curr を **頂点シェーダ lerp**(`mix(aPrev, aCurr, uAlpha)`)。シェーダの時間はすべて `uStepF = view.step + alpha`、`uTimeSec = uStepF / 60` から導出(決定論・タブ復帰でも破綻しない)
- three のライト/フォグ機構は不使用。**`uSunDir`/`uSunColor` は Environment が唯一の所有者**で、全マテリアルが同一の値オブジェクトを共有(知見採用: Mizu-threejs `src/render/Environment.ts` の SunUniforms パターン)。距離フォグは各シェーダが共有 `sky(dir)` へ mix する(背景と数学的に一致 — 継ぎ目が原理的に出ない。同 `src/render/shaders/sky.ts` の方式)

### 1.2 契約(叩き台の再掲 + レンダラー側インターフェース)

```ts
// src/contract/RenderView.ts(裁定叩き台。変更提案は文末「裁定希望事項」)
BubbleView   { data /* stride8: [ax,ay,az,R, waterLevelYLocal, fill01, wobble, statePacked] */,
               prevData, count, version }
AtomView     { posr /*[x,y,z,r]*/, prevPosr, colorKind /*[r,g,b,kindIndex]*/, count, version }
DropletView  { posr, prevPosr, aux /*[phase,swayAmp,spawnStep,seed]*/, count, version }
SplashEventView { data /*[x,z,radius,strength]*/, count }   // 球の海面着水(フレーム内 append、持ち越しなし)
InnerRippleView { data /*[bubbleIndex,localX,localZ,strength]*/, count } // 雫の球内水面着水
SkyRenderView   { step, bubbles, atoms, droplets, splashes, ripples }

export interface MizuRenderer {
  render(view: SkyRenderView, alpha: number): void;  // alpha ∈ [0,1) — 裁定希望 #1
  resize(): void;
  dispose(): void;
}
```

```ts
// src/render/RenderSystem.ts — サブシステム差し込み口
// (知見採用: Mizu-threejs src/render/RenderSystem.ts。prerender 差し込みと applyTier を追加)
export interface FrameInfo {
  readonly camera: PerspectiveCamera;
  readonly alpha: number;    // 補間係数
  readonly stepF: number;    // view.step + alpha
  readonly timeSec: number;  // stepF / 60
}
export interface RenderSystem {
  readonly object: Object3D;
  update(view: SkyRenderView, frame: FrameInfo): void;   // 属性/uniform 反映(JS submit のみ)
  prerender?(renderer: WebGLRenderer): void;             // FBO パス(RippleField が使用)
  applyTier?(tier: QualityTier): void;                   // §9 の 7 ノブ反映
  dispose(): void;
}
```

SceneRenderer のフレームシーケンス(パスグラフ):

```
[A] ripple splat      → rippleCurr(RGBA16F、加算 instanced quads — SplashEventView + SplatScheduler)
[B] ripple integrate  → rippleNext(全画面三角形、波動方程式 + フォーム減衰、ピンポン swap)
[C] Main RenderPass   → HDR HalfFloat ターゲット(MSAA 0 — §9.4 ANGLE 教訓)
[D] UnrealBloomPass   → 半解像度ミップチェーン(threshold 1.15 / strength 0.32 / radius 0.55)
[E] OutputPass        → ACES + sRGB + ビネット(OutputShader へ文字列注入 — 追加パスなし。
                        知見採用: Mizu-threejs src/render/PostPipeline.ts injectVignette / shaders/vignette.ts)
```

WebGLRenderer 設定(知見採用: Mizu-threejs `src/render/SceneRenderer.ts`): `{ antialias:false, alpha:false, stencil:false, powerPreference:'high-performance' }`、`toneMapping = ACESFilmicToneMapping`、`toneMappingExposure = 1.06`、`outputColorSpace = SRGBColorSpace`、`renderer.debug.checkShaderErrors = false`(prod)。実効 DPR = `min(devicePixelRatio, dprCap) × renderScale`。`document.visibilitychange` で rAF 停止(スクリーンセーバー礼節+電池)。

### 1.3 描画順・ブレンド規約と draw call 予算表

全オブジェクト `frustumCulled = false`(少数・常時可視)+ `matrixAutoUpdate = false`(座標は属性/uniform 持ち)。不透明群 → スカイ → 半透明群(加算優位)の固定順。**シーン draw 10 + FBO 2 = 12 draw/frame(予算 18 に対し余裕 6)**。

| order | システム | draw | 概算三角形 | ブレンド / depth | 備考 |
|--:|---|--:|--:|---|---|
| — | [A] ripple splat | 1 | ≤ 2×イベント数 | 加算(ONE,ONE)/ dT off dW off | instanced quad、FBO |
| — | [B] ripple integrate | 1 | 1 | なし | 全画面三角形、FBO |
| 0 | AtomSystem(発光インポスター) | 1 | ~800(≤400 quad×2) | **不透明 + discard** / dW on | early-z 有効(§5) |
| 1 | DropletSystem(雫インポスター) | 1 | ~800 | 不透明 + discard / dW on | 〃 |
| 2 | **OceanSystem(Ocean v2)** | 1 | ~55k(tier0) | 不透明 / dW on | 最大のフィル食い(§2) |
| 3 | Environment(解析スカイ) | 1 | 1 | dW off / **LessEqualDepth** | far-plane 全画面三角形(§7) |
| 4 | InnerWater 体積(全球) | 1 | ~9k(icosa d3 ×7) | αブレンド / **dW on** | §4(a) |
| 5 | InnerWater キャップ(全球) | 1 | ~8.4k | αブレンド / dW on | §4(b) |
| 6 | BubbleGlass backside | 1 | ~35.8k(icosa d4 ×7) | **加算** / dW off | §3 |
| 7 | BubbleGlass frontside | 1 | ~35.8k | αブレンド(低α+加算光)/ dW off | §3 |
| 8 | LabelSystem(文字) | 1 | ~800 | **加算** / dW off | 順序非依存(§5) |
| 9 | SpraySystem(しぶき) | 1 | ~4k(≤2048 quad) | 加算 / dW off | §6 |
| — | [D] bloom 内部 | (≤12 パス) | — | — | 半解像度以下 |
| — | [E] output(+vignette) | 1 | 1 | — | 注入統合 |

三角形合計 ≈ 150k/frame(60fps で 9M tri/s)— Mizu-threejs 実測(300k tri + 2.9M tri の原子群で 60fps、`docs/architecture.md` §6)から 2 桁の余裕。**本作の勝負は頂点数ではなく Ocean のフラグメント品質に全振りする**。

半透明の順序戦略(知見採用: Mizu-threejs `src/render/LabelSystem.ts` — 加算は順序非依存): ガラス/ラベル/スプレーは加算優位に設計し、球間ソートを不要化。唯一 αブレンドが濃い内水(order 4-5)は depthWrite ON + 「原子・雫は常に球内水面より上」というシム不変条件で正しく閉じる(§4)。7 球の前後関係のみ、毎フレーム CPU で距離ソートしてインスタンス順を書き換える(7×64B = 448B の書き換え — 自明)。

---

## §2 Ocean v2(本書の主役)

### 2.0 Mizu-threejs 水面の不足分析(実シェーダ精読より)

出典: `/Users/takahiroshimabukuro/shimabox/github/Mizu-threejs/src/render/shaders/waterSurface.ts` / `waterUpdate.ts` / `waterSplat.ts`、`src/render/WaterSurface.ts`。

| # | 不足 | 実物の根拠 | Ocean v2 での対応 |
|--:|---|---|---|
| 1 | **うねり不在・完全な平坦** | 頂点変位はリップルテクスチャのみ: `wp.y += texture(uHeight, uv).r`(waterSurface.ts L26)。着水がなければ数学的な平面 | (a) Gerstner 8 成分のアンビエントスウェル |
| 2 | **法線が単調** | リップルの 4 タップ中心差分 + `NORMAL_GAIN 2.5` の誇張だけ(L53-61)。マイクロファセットがなく「濡れたガラス板」 | (a)(c) 解析導関数の全周波数法線 + glitter 用ジッタ |
| 3 | **色が2色補間で単調** | `mix(shallow #079, deep #023, sqrt(facing))`(L71-73)のみ。散乱・波高依存・青緑がない | (c) Beer-Lambert + 波頭擬似 SSS(ターコイズ) |
| 4 | **フォーム不実在** | 「クレスト輝き」は `smoothstep(height)×0.35` の白加算(L82-83)。テクスチャも寿命も形状もない | (d) ヤコビアン波頭フォーム + 着水フォームリング(専用チャネル) |
| 5 | **スペキュラが1点のみ** | `pow(dot(n,h),200)` の単一ローブ(L79)。sun path のきらめき(glitter)なし | (c) タイトスペキュラ + マイクロ glitter 場 |
| 6 | **反射が空だけ** | `sky(reflect)` のみ(L68)。シーン中の物体は一切映らない | (e) ≤7 球の解析的球面反射 |
| 7 | **一様グリッドで水平線がない** | bounds+マージンの PlaneGeometry 255²(WaterSurface.ts L204)。世界の縁で海が切れる | (f) 放射リング LOD グリッドで半径 600u まで |

一方で **リップルの土台(RG16F ピンポン波動方程式 + インスタンススプラット注入 + k≤0.5 無条件安定 + 境界フェード)は実証済みの優れた設計**であり、Ocean v2 はこれを (b) にそのまま採用・拡張する(出典: `waterUpdate.ts` / `waterSplat.ts` / `WaterSurface.ts` prerender)。

### 2.1 (a) アンビエントスウェル — Gerstner 波 8 成分

**波テーブル**(TS 定数 → シェーダへテンプレートリテラル埋め込み。埋め込み手法の知見: Mizu-threejs `src/render/shaders/droplet.ts` の FALL_SPEED_GLSL)。分散関係は深水波 `φ̇ = √(g_eff·w)`、**g_eff = 2.4**(実世界 9.8 の約 1/4 — 「時間がゆっくり流れる海」のドリーミー演出。周期はスウェルで ~6.5s)。

| i | 帯域 | λ [u] | A [u] | Q(横変位係数) | 風向 [deg] | φ̇ [rad/s] | 評価場所 |
|--:|---|--:|--:|--:|--:|--:|---|
| 0 | swell | 16.0 | 0.130 | 1.96 | +15 | 0.97 | 頂点+frag法線 |
| 1 | swell | 11.0 | 0.100 | 1.58 | −12 | 1.17 | 〃 |
| 2 | mid | 6.5 | 0.055 | 1.32 | +38 | 1.52 | 〃 |
| 3 | mid | 4.2 | 0.040 | 1.00 | −30 | 1.90 | 〃 |
| 4 | mid | 2.6 | 0.025 | 0.83 | +8 | 2.41 | 〃 |
| 5 | chop | 1.6 | 0.014 | 0.89 | +55 | 3.07 | **frag 法線のみ** |
| 6 | chop | 1.0 | 0.009 | 0.71 | −48 | 3.88 | 〃 |
| 7 | chop | 0.62 | 0.005 | 0.59 | +22 | 4.93 | 〃 |

- 主風向 ≈ +12°、成分は ±50° に散らす(単調な縞を防ぐ)。振幅和(頂点)0.35u — 球の底(y ≥ 1.1)と交差しない
- **ループ防止条件**: Σ Qᵢ·wᵢ·Aᵢ = 0.49 < 1(ヤコビアンが負にならない = 波が巻かない)。フォーム閾値(d)はこの余裕内で調整
- **位相の精度対策**: `θ = w·dot(D,xz) + φ` の φ は **CPU が毎フレーム `mod(φ̇·t, 2π)` を uniform 配列 `uPhase[8]` で供給**(t が数時間に達しても fp32 位相が破綻しない。シェーダ内 `uTime × φ̇` は不採用)
- 呼吸: `uSwellGain = 1 + 0.15·sin(2π·t/90s)` を振幅に乗算(凪がわずかに満ち引きする)

**共有 GLSL チャンク `gerstner.ts`**(ocean 頂点・フラグメント両方から連結):

```glsl
uniform vec4 uWaveA[8];   // [dirX, dirZ, w, amp]
uniform vec4 uWaveB[8];   // [Q, phase(CPU で mod 2π), 0, 0]
uniform float uSwellGain;

vec3 gerstnerOffset(vec2 xz, int lo, int hi) {          // 頂点: lo=0, hi=5
  vec3 off = vec3(0.0);
  for (int i = lo; i < hi; i++) {
    vec2 D = uWaveA[i].xy; float w = uWaveA[i].z; float A = uWaveA[i].w * uSwellGain;
    float th = w * dot(D, xz) + uWaveB[i].y;
    float s = sin(th), c = cos(th);
    off += vec3(uWaveB[i].x * A * D.x * c, A * s, uWaveB[i].x * A * D.z * c);
  }
  return off;
}

// 法線勾配とヤコビアン(フォーム用)を同一ループで返す — フラグメントで 8 波フル評価
void gerstnerDeriv(vec2 xz, out vec3 grad, out float jac) {
  vec2 dH = vec2(0.0); float qs = 0.0;
  float jxx = 1.0, jzz = 1.0, jxz = 0.0;
  for (int i = 0; i < 8; i++) {
    vec2 D = uWaveA[i].xy; float w = uWaveA[i].z; float A = uWaveA[i].w * uSwellGain;
    float Q = uWaveB[i].x;
    float th = w * dot(D, xz) + uWaveB[i].y;
    float s = sin(th), c = cos(th), wA = w * A;
    dH  += D * (wA * c);                 // ∂y/∂x, ∂y/∂z
    qs  += Q * wA * s;                   // 縦圧縮
    jxx -= Q * wA * D.x * D.x * s;
    jzz -= Q * wA * D.z * D.z * s;
    jxz -= Q * wA * D.x * D.z * s;
  }
  grad = vec3(dH.x, qs, dH.y);
  jac = jxx * jzz - jxz * jxz;           // 1 = 無変形、→0 = 波頭圧縮(フォーム)
}
```

頂点は波 0–4 で xz+y 変位(chop 5–7 は 0.6u 以下の波長で頂点解像度未満 — 変位させるとジオメトリがエイリアスするため**フラグメント法線専任**)。フラグメントは 8 波の解析導関数で法線を再構成する(頂点法線補間より常に鮮鋭。頂点との整合は同一テーブル・同一位相なので保証される)。

### 2.2 (b) インタラクティブリップル — 中央アクション域の GPU ハイトフィールド

**知見採用(パターンごと)**: Mizu-threejs `src/render/WaterSurface.ts` のピンポン FBO + インスタンススプラット注入 + `waterUpdate.ts` の 5 タップ波動方程式カーネル。本作はフィールドを世界全体ではなく**中央アクション域(球の落下着水が起こる範囲)に集中**させ、テクセル密度を 10 倍にする。

- 領域: 原点中心 **24×24u(半径 ~12u)**。着水点は球リング半径 4.5 の直下(±R)なので余裕 2 倍
- フォーマット: **RGBA16F 384²(tier0)** ピンポン ×2 ≈ 2.4MB。**R = height, G = velocity, B = foam energy, A = 予備**(フォームは §2.4)。テクセル = 0.0625u — リップル波長 ≥ 0.3u を解像
- カーネル(1 sim-step = 1 積分。60Hz 固定なので dt 項は係数に畳む):

```glsl
// rippleUpdate.frag — 全画面三角形。k ≤ 0.5 で無条件安定(Mizu-threejs 実証値を踏襲)
vec4 f  = texture(uField, vUv);
vec4 fl = texture(uField, vUv - vec2(texel.x, 0.0));   // 以下 4 近傍
...
float avg = 0.25 * (fl.r + fr.r + fd.r + fu.r);
float v = (f.g + (avg - f.r) * uK) * uVelDamp;         // uK = 0.45, uVelDamp = 0.997
float h = (f.r + v) * uHeightDamp;                     // uHeightDamp = 0.9993(DC ドリフト排除)

float foamAvg = 0.25 * (fl.b + fr.b + fd.b + fu.b);
float foam = mix(f.b, foamAvg, 0.35) * uFoamDecay;     // 微拡散 + 減衰(0.988/step ≈ 半減 1.0s)
foam += clamp(abs(v) * uFoamFromMotion - 0.0015, 0.0, 0.012);  // 強い波動の場所は自然に白く

float edge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
float fade = smoothstep(0.0, 0.06, edge);              // 境界フェード = 端の反射リング吸収
fragColor = vec4(clamp(h, -0.28, 0.28) * fade, v * fade, min(foam, 1.5) * fade, 0.0);
```

安定条件: `uK ≤ 0.5` が離散波動方程式の無条件安定域(Mizu-threejs `waterUpdate.ts` 冒頭コメント+数百同時着水の実運用で実証)。加えて高さクランプ ±0.28u と境界フェードで、大強度スプラット連打でも発散しない。

- **スプラット注入**: SplashEventView `[x, z, radius, strength]` → 1 イベント = 1 instanced quad を**加算ブレンドで速度チャネル G に**書く(高さ R には触れない — 運動量注入は波形が自然で、エネルギー爆発しにくい。`waterSplat.ts` の実証知見)。中心ガウス(押し下げ)+ B チャネルへフォームリングを同時注入:

```glsl
// rippleSplat.frag(vLocal = quad ±1, vStrength = イベント strength, vR0 = リング半径/quad 半径)
float d = length(vLocal);
float g = exp(-4.0 * d * d) * (1.0 - smoothstep(0.6, 1.0, d * d));   // 縁ハードゼロ(加算の四角残滓防止)
float ring = exp(-pow((d - vR0) * 7.0, 2.0));                        // クラウン位置のフォーム
fragColor = vec4(0.0, -uSplatGain * vStrength * g, uFoamGain * vStrength * ring, 0.0);
```

- **SplatScheduler(NEW)**: 球の着水 1 イベントを「主スプラット + 遅延サブスプラット(+8, +14, +22 step、強度 ×0.4/0.25/0.15、位置 ±0.3R ジッタ)」に展開するレンダー内キュー。単発ガウスより着水が「ドプン」と多段に読める。スプレー粒子(§6)の落着点にも微小スプラットを 2〜3 個予約(弾道は決定論なので落下時刻・地点は spawn 時に閉形式で計算できる)
- **Gerstner との法線合成**: 両者とも y=h(x,z) の高さ場なので**勾配の線形加算**で合成する(角度合成より安価で、勾配が小さい領域では厳密に一致):

```glsl
vec3 grad; float jac;
gerstnerDeriv(wpXZ, grad, jac);
vec2 rippleGrad = vec2(hr - hl, hu - hd) / (2.0 * uRippleTexelWorld);  // 4 タップ中心差分
float rippleMask = 1.0 - smoothstep(10.5, 12.0, length(wpXZ - uRippleCenter)); // 域外フェード
vec3 n = normalize(vec3(-(grad.x + rippleGrad.x * rippleMask),
                        1.0 - grad.y,
                        -(grad.z + rippleGrad.y * rippleMask)));
```

  破綻対策: リップルは **Gerstner 変位後のワールド xz** でサンプル(横変位 ≤ 0.25u < 4 texel なのでリングの歪みは知覚未満)。かつアクション域内はスウェル振幅を 25% 減衰(`uSwellGain × mix(0.75, 1.0, smoothstep(6,12,r))`)してリングの読み取りやすさを確保する。それでも破綻したら §11 リスク2 の Plan-B
- 頂点はリップル高さを 1 タップの vertex texture fetch で変位に加算(中央は §2.6 のグリッドが最密なので変位が立体に見える)

### 2.3 (c) シェーディング — フレネル / Beer-Lambert / 擬似SSS / スペキュラ+glitter / 空気遠近

パレット(sRGB 表記、実装は linear 化した const vec3):

```
uDeepColor   #05253c   深青(直下視・遠方)
uMidColor    #0d4d6e   中間(斜め視)
uSssColor    #2fc0a8   ターコイズ(波頭透過光)
uFoamColor   #eef7f5   フォーム(わずかに暖白)
uMizuBlue    #007fff   アイデンティティ(スプラット直後のリング内側にだけ 5% 混ぜる)
```

フラグメント統合フロー(疑似 GLSL — `sky()` チャンクと gerstner チャンクを文字列連結):

```glsl
void main() {
  // 1) 法線(8 波解析導関数 + リップル勾配合成 — §2.2)と基本ベクトル
  vec3 n = ...; float jac = ...;
  vec3 viewDir = normalize(vWorldPos - cameraPosition);
  float dist = distance(vWorldPos, cameraPosition);
  float facing = max(dot(-viewDir, n), 0.0);

  // 2) フォーム量を先に確定(フレネルを殺すため)— §2.4
  float foam = foamMask(vWorldPos.xz, jac, rippleField.b);

  // 3) フレネル(Schlick、水の F0 = 0.02。フォームは粗面 → 反射抑制)
  float fresnel = (0.02 + 0.98 * pow(1.0 - facing, 5.0)) * (1.0 - 0.85 * foam);

  // 4) 反射 = 解析スカイ + 解析的球面反射(§2.5、ANALYTIC_REFLECTIONS define)
  vec3 rdir = reflect(viewDir, n);
  rdir.y = abs(rdir.y);                       // 水面下向き反射レイの黒ずみ防止
  #ifdef ANALYTIC_REFLECTIONS
    vec3 reflected = reflectEnv(vWorldPos, rdir);
  #else
    vec3 reflected = sky(rdir);
  #endif

  // 5) 水体色: Beer-Lambert 近似(視線が水中を走る光路長 ∝ 1/facing)+ 波高で青緑へ
  vec3 body = mix(uMidColor, uDeepColor, pow(facing, 0.6));
  float thin = clamp(vWaveY / uSwellAmpSum, 0.0, 1.0);       // 波頭 = 薄い水 = 明るい
  body = mix(body, uSssColor * 0.35, 0.25 * thin);

  // 6) 波頭の擬似 SSS: 太陽を向いた視線 × 波頭 × グレージングでターコイズが灯る
  float behindSun = pow(max(dot(viewDir, uSunDir), 0.0), 4.0);
  float crest = smoothstep(0.15, 0.9, thin + rippleH * 2.5);
  vec3 sss = uSssColor * (1.6 * behindSun * crest * pow(1.0 - facing, 2.0));
  body += sss;

  vec3 color = mix(body, reflected, fresnel);

  // 7) 太陽スペキュラ(タイト)+ マイクロ glitter(ジッタ法線の超高指数ローブ)
  vec3 halfDir = normalize(uSunDir - viewDir);
  color += uSunColor * (4.0 * pow(max(dot(n, halfDir), 0.0), 600.0));      // HDR — bloom が拾う
  vec2 guv = vWorldPos.xz * 6.5 + vec2(0.13, -0.11) * uTimeSec;
  vec3 jitter = texture(uNoise, guv).rgb * 2.0 - 1.0;                      // 焼き込み値ノイズ(§2.4)
  vec3 gn = normalize(n + jitter * 0.16);
  float glint = pow(max(dot(gn, halfDir), 0.0), 1400.0);
  color += uSunColor * min(glint * 3.5, 3.5) * exp(-dist * 0.02);          // 遠方フェード = エイリアス対策

  // 8) フォーム合成(§2.4)— 反射より後、フォグより前
  vec3 foamLit = uFoamColor * mix(0.55, 1.0, max(uSunDir.y, 0.0) * 0.8 + 0.2);
  color = mix(color, foamLit, foam);

  // 9) 距離フォグ / 空気遠近: sky(viewDir) へ溶かす(背景と厳密一致 — 継ぎ目ゼロ)
  float fog = 1.0 - exp(-pow(dist / 260.0, 1.35));
  color = mix(color, sky(viewDir), fog);

  fragColor = vec4(color, 1.0);
}
```

- Beer-Lambert の「深さ」は実底が無いので**視線角プロキシ**(直下視 = 光路長最大 → deep)+ 波高補正。Mizu-threejs の 2 色 mix(不足 #3)との違いは、(i) ターコイズ第 3 色が波の形に応じて入る、(ii) SSS が太陽方位に依存する、(iii) フォーム・glitter が空間周波数の高い変化を足す — 「単調な色」を三方向から潰す
- HDR 上限規約: glitter ≤ 3.5 / スペキュラ ≤ 4.0 / SSS ≤ 1.6。bloom threshold 1.15(§1.2)を上回るのはスペキュラ系のみ — 海全体が bloom で膨らまない(Mizu-threejs の「白い横帯」教訓: `PostPipeline.ts` BLOOM_THRESHOLD コメント)

### 2.4 (d) フォーム — 波頭 + 着水フォームリング

**2 系統を 1 つの foamMask に合成**:

1. **波頭フォーム(ヤコビアン)**: §2.1 の `jac`(1 = 無変形 → 0 = 波頭圧縮)。凪の海なので出現は稀 — スウェルが重なった瞬間だけ筋状に湧く: `crestFoam = smoothstep(0.30, 0.65, 1.0 - jac)`
2. **着水フォームリング**: リップルフィールド **B チャネル**(§2.2 で注入・減衰・微拡散)。球着水で開くリング + SplatScheduler のサブスプラットで多重リング化。減衰 0.988/step で約 3s 残存

```glsl
float foamMask(vec2 xz, float jac, float foamE) {
  float crestFoam = smoothstep(0.30, 0.65, 1.0 - jac);
  float f = clamp(foamE * 1.2 + crestFoam * 0.5, 0.0, 1.0);
  float breakup = texture(uNoise, xz * 1.7 + vec2(uTimeSec * 0.01)).g;   // 泡のちぎれ感
  return f * smoothstep(0.30, 0.70, breakup + f * 0.5);
}
```

**ノイズテクスチャ方針**: 外部アセットは持たない(GH Pages 完結・ゼロから実装の原則)。起動時に **256² RGBA8 を手続き生成して焼き込み**(`NoiseTexture.ts`): R = fbm 値ノイズ 3 オクターブ、G = 別位相 fbm(フォーム breakup 用)、B = リッジノイズ(空の雲気 §7)、A = ハッシュ白色(glitter ジッタ用)。RepeatWrapping + mipmap。全シェーダがこの 1 枚を共有(テクスチャユニット節約)。

### 2.5 (e) [ティア制] 解析的球面反射 — 海に球が映る

球は最大 7 個と少ないため、キューブマップも平面反射カメラも使わず、**海のフラグメントシェーダ内で reflect レイ × 球の交差を閉形式で解く**。これが「世界がひとつながりである」実感を作る最重要ディテール。

```glsl
uniform vec4 uBubblePosR[8];   // [cx,cy,cz,R](補間済み値を CPU が毎フレーム設定)
uniform vec4 uBubbleMisc[8];   // [waterLevelYLocal/R, fill01, seed, state]
uniform int  uBubbleCount;

vec3 reflectEnv(vec3 ro, vec3 rd) {
  vec3 env = sky(rd);
  float bestT = 1e9; int hit = -1;
  for (int i = 0; i < uBubbleCount; i++) {                 // ≤7 回
    vec3 oc = ro - uBubblePosR[i].xyz;
    float b = dot(oc, rd);
    float c = dot(oc, oc) - uBubblePosR[i].w * uBubblePosR[i].w;
    float disc = b * b - c;
    if (disc > 0.0) {
      float t = -b - sqrt(disc);
      if (t > 0.0 && t < bestT) { bestT = t; hit = i; }
    }
  }
  if (hit >= 0) {                                          // 簡易ガラス球シェード(≈30 ALU)
    vec3 p = ro + rd * bestT;
    vec3 n = (p - uBubblePosR[hit].xyz) / uBubblePosR[hit].w;
    float rim = pow(1.0 - abs(dot(n, -rd)), 2.0);
    vec3 glassy = sky(reflect(rd, n)) * 0.35
                + irid(rim * 2.0 + uBubbleMisc[hit].z * 0.61) * rim * 0.35;   // §3 の虹彩と同系
    float water = smoothstep(uBubbleMisc[hit].x + 0.05, uBubbleMisc[hit].x - 0.2, n.y);
    glassy = mix(glassy, LINEAR_MIZU_BLUE * 0.5, water * 0.55);               // 内水の青が映る
    env = mix(env, glassy + sky(rd) * 0.25, clamp(rim + 0.35, 0.0, 1.0));
  }
  return env;
}
```

**コスト見積もり**: ループ 7 球 × ~13 ALU(dot×3, FMA, 比較, まれに sqrt)≈ 91 ALU + ヒット時シェード ~35 ALU(sky() 2 回込み)。海の画面被覆 ~50% として tier0 デスクトップ(4.1Mpx)で ≈ 2.0M px × ~110 ALU ≈ 0.22 GALU ≈ **+0.4〜0.6ms(Apple M 級)** — 予算内(§9)。モバイルでは `analyticReflections` ノブで **off**(#define 切替でループごと消滅、シェーダ 2 変種のみ)。海面が揺れているため反射像は歪んで「らしく」なる — 精密なガラスシェーディング再現は不要で、リム+虹彩+内水の青の 3 要素で十分球と分かる。

### 2.6 (f) ジオメトリ — 放射リンググリッド

- **原点中心の放射グリッド(静的・world 固定)**: カメラは原点周りを周回するだけ(§8)なので、中心密・遠方疎の放射メッシュが全アングルで最適。追従再メッシュ不要
- リング半径は等比数列 r₀ = 0.5 → r₉₅…₁₄₃ ≈ 600(成長率 ~1.051)。**tier0: 144 リング × 192 セグメント ≈ 27.6k セル ≈ 55k tri / 28k 頂点**(indexed)。中心 24 リングは r ≤ 12(アクション域)に集中し、リップル変位(texel 0.0625u)を頂点でも受けられる密度
- 検算: 最短の頂点変位波 λ=2.6u に対し r=10 でリング間隔 ≈ 0.53u(≈5 頂点/λ ✓)、方位方向 10·2π/192 ≈ 0.33u ✓。chop 波(λ<2.6)は頂点に入れない(§2.1)ので頂点エイリアスなし
- **水平線**: 最外周 600u、フォグは ~350u で sky() に完全一致 → メッシュの縁は不可視。カメラ高 ~5u から 600u 先の縁は水平線下 0.5° — `sky()` の水平線下色(§7)が海フォグ色と同一なので継ぎ目ゼロ(Mizu-threejs `sky.ts` の below 色の手法を拡張採用)
- 頂点シェーダ: Gerstner 0–4 変位 + リップル 1 タップ変位。28k 頂点 × ~70 ALU ≈ 2 MALU — 無視できる
- ティア: §9 表の oceanGridDensity(144×192 / 120×160 / 96×128 / 72×96)。ジオメトリは各密度を初回生成でキャッシュし参照差し替え(知見採用: Mizu-threejs `AtomSystem.ts` baseLod パターン)

---

## §3 球体ガラス(BubbleGlassSystem)

**構成**: `InstancedBufferGeometry` over `IcosahedronGeometry(1, 4)`(5120 tri / 2562 頂点。モバイル d3)。インスタンス属性は BubbleView data/prevData をラップした **aCurrA/aCurrB/aPrevA/aPrevB**(vec4 ×4)。バッファは InnerWaterSystem と共有(アップロード 1 回)。**backside → frontside の 2 draw**。

- **backside パス(加算, BackSide, depthWrite off)**: 球の内側の面のリム発光。ガラスの「厚みの向こう側」が透けて見える効果 — 半透明球の実在感の要
- **frontside パス(αブレンド, FrontSide, depthWrite off)**: 低 α の吸収 tint(alpha ≈ 0.06)+ 加算的な光(フレネルリム、虹彩、太陽スペキュラ、sky 屈折)。「加算優位」なので球同士の描画順にほぼ非感応(§1.3)

頂点シェーダ(状態駆動の変形 — statePacked: 整数部 = 状態 / 小数部 = 進行度 0..1、裁定希望 #2):

```glsl
vec3 center = mix(aPrevA.xyz, aCurrA.xyz, uAlpha);
float R     = mix(aPrevA.w,  aCurrA.w,  uAlpha);
float wobble = mix(aPrevB.z, aCurrB.z, uAlpha);
float state = floor(aCurrB.w), prog = fract(aCurrB.w);
float seed = fract(float(gl_InstanceID) * 0.61803398875);   // 黄金比ハッシュ(atom.ts の知見)

vec3 p = position;                                          // 単位球 = 法線
// Growing: 誕生時のスケールイン(弾性オーバーシュート)
float grow = (state == 0.0) ? 0.6 + 0.5 * prog - 0.1 * sin(prog * 9.0) : 1.0;
// Straining(水 6 割・落下予備): 縦に呼吸 + 表面さざ波。wobble ∈ [0,1] は sim 供給
float strain = (state == 2.0) ? prog : 0.0;
float stretchY = 1.0 + strain * 0.10 + ((state == 3.0) ? 0.14 * prog : 0.0);  // Falling は雫形に伸びる
p *= vec3(inversesqrt(stretchY), stretchY, inversesqrt(stretchY));            // 体積近似保存
p += position * wobble * 0.05 * sin(p.y * 7.0 + uTimeSec * 12.0 + seed * 6.283);
// Splashing: 膜の拡張 + 消滅は α 側。Dormant: 縮退(scale 0 → ラスタ 0 = 実質カリング)
float pop = (state == 4.0) ? 1.0 + 0.25 * prog : 1.0;
float alive = (state == 5.0) ? 0.0 : 1.0;
vec3 wp = center + p * R * grow * pop * alive;
```

フラグメント(front 側の骨子):

```glsl
float ndv = abs(dot(nWorld, -viewDir));
float fresnel = 0.04 + 0.96 * pow(1.0 - ndv, 3.0);
// 薄膜干渉の虹彩: 視角 + シード + 微時間で位相が回る cos パレット(パステルに抑制)
vec3 irid(float x) { return 0.5 + 0.5 * cos(6.28318 * (x + vec3(0.00, 0.33, 0.67))); }
vec3 filmTint = irid(pow(1.0 - ndv, 1.4) * 2.2 + vSeed * 0.61 + uTimeSec * 0.015);
// 屈折は解析スカイ(IOR ~1.02 の薄殻 — 背景の透過感は低 α が担う。グラブパスは不採用 §11)
vec3 color = sky(refract(viewDir, nWorld, 0.98)) * 0.10
           + sky(reflect(viewDir, nWorld)) * fresnel * 0.55
           + filmTint * fresnel * 0.16;
// メニスカス: 内水面と接する円周の発光帯(waterLevelYLocal からの距離のガウス帯)
float yl = vLocalPos.y;                        // 単位球ローカル y(−1..1)
float wl = vWaterLevel;                        // waterLevelYLocal / R(補間済み)
color += LINEAR_MIZU_BLUE * exp(-pow((yl - wl) / 0.05, 2.0)) * (0.6 + 0.8 * vFill) * 1.4;  // HDR
color += LINEAR_MIZU_BLUE * smoothstep(wl + 0.02, wl - 0.25, yl) * 0.05;  // 水没部のうっすら青
// Splashing のポップ: フレネル閃光(指数減衰)+ α フェード。膜片は §6 が担当
float flash = vState == 4.0 ? 6.0 * exp(-vProg * 5.0) : 0.0;
color *= 1.0 + flash * fresnel;
float alpha = (0.06 + fresnel * 0.30) * (vState == 4.0 ? 1.0 - vProg : 1.0);
fragColor = vec4(color, alpha);
```

- メニスカスの帯は球面と水平面の交円をローカル y のガウスで正確に包む(交円上の点はすべて y = wl)。fill が高いほど明るく — 「満ちてきた」緊張感の表現
- Splashing 完了(→ Dormant)で SplashEventView が湧き(sim 側)、§2.2 のスプラット・§2.4 のフォームリング・§6 のバーストが同一イベントから連鎖する

---

## §4 球内の水(InnerWaterSystem — 体積 + 水面キャップ、各 1 draw)

per-instance 属性は §3 と同一バッファを共有(waterLevel, R, anchor, fill, state が全部入っている)。**7 球ぶんを体積 1 draw + キャップ 1 draw**。

### (a) 水体積 — 前面 1 パス + 解析コード長 Beer-Lambert

内向き球メッシュ + クリップの素朴案は「近い壁が描けず空洞に見える」問題があるため、**FrontSide 1 パスで、視線が球内水体を貫く長さ(コード長)を解析的に求めて吸収に使う**(球なので閉形式、レイマーチ不要):

```glsl
// フラグメント = 球前面(半径 0.985R に微inset)の点。waterLevel 平面より上は discard
if (vLocalPos.y > vWaterLevel + 0.002) discard;
vec3 rd = normalize(vWorldPos - cameraPosition);
vec3 oc = vWorldPos - vCenter;
float b = dot(oc, rd);
float tExit = -b + sqrt(max(b * b - dot(oc, oc) + vR * vR, 0.0));   // 球の出口距離
float tPlane = (rd.y > 0.0) ? (vWaterPlaneY - vWorldPos.y) / rd.y : 1e9;  // 水面平面でクリップ
float len = clamp(min(tExit, tPlane), 0.0, 2.0 * vR);
vec3 absorb = exp(-len / vR * vec3(1.9, 0.75, 0.35));               // 青が生き残る(#007fff 系)
vec3 color = mix(LINEAR_MIZU_BLUE * 0.85, LINEAR_MIZU_DEEP, 1.0 - absorb.b)
           + uSssColor * 0.10 * texture(uNoise, vLocalPos.xz * 2.0 + uTimeSec * 0.05).r; // 揺らぎ
float alpha = clamp(0.55 + 0.45 * (1.0 - absorb.b), 0.0, 0.92);
fragColor = vec4(color, alpha);
```

- αブレンド + **depthWrite ON**(§1.3): 背景(海・空)は order 2-3 で描画済み、原子/雫(order 0-1)はシム不変条件「常に球内水面より上」により水体の背後に隠れるケースがない — ソート不要で閉じる
- 薄い(fill 小)ときは絞れた円盤状に見え、満水に近づくほど濃い青の塊になる — fill01 の視覚化はコード長が自動でやってくれる

### (b) 水面キャップ — ミニ海

単位円盤グリッド(24 リング × 48 セグメント ≈ 1.2k tri)を per-instance で cap 半径にスケール: `capR = sqrt(max(R² − wl², 0)) × 0.985`(頂点シェーダ内で R と waterLevelYLocal から導出 — CPU 前処理なし)。

- **頂点**: 広域の緩い揺れのみ(2 成分 sin、振幅 0.008R — 球が Straining のとき wobble 連動で ×3)。ワールドへは anchor + (localX·capR, wl·R, localZ·capR)
- **フラグメント法線**: InnerRippleView 由来のリップルを**解析リング波として法線摂動**(頂点変位より高周波が出せて安価)。イベントはレンダー側リングバッファ(球ごと最大 6 本、古い順上書き)に保持し uniform `uInnerRipples[7][6]` = [x, z, birthStepF, strength] で供給:

```glsl
for (int k = 0; k < 6; k++) {
  vec4 rp = uInnerRipples[vInstance * 6 + k];
  vec2 d = vCapLocal - rp.xy;                     // cap ローカル(世界単位)
  float dist = length(d) + 1e-4;
  float age = (uStepF - rp.z) / 60.0;             // 秒
  float radius = 0.9 * age;                       // 伝播速度 0.9 u/s
  float env = exp(-6.0 * abs(dist - radius)) * exp(-1.8 * age) * rp.w;
  n.xz -= (d / dist) * env * sin(40.0 * (dist - radius)) * 0.6;
}
```

- **シェーディング = 海と同一パレットのミニ海**: fresnel × sky(reflect) + uMizuBlue 基調の水体色 + 波頭の uSssColor + 小さな太陽グリント(pow 300)。縁(cap 半径の 92% 以遠)はメニスカス帯(§3)と同じ #007fff 発光で滑らかに接続
- 深い青 ⇄ 外海の自然色 のコントラストが「球の中の水は濃い(=Mizu の水)」という物語を作る

---

## §5 原子とラベル、雫

**原子(H / O / H₂ 本体)**: `InstancedBufferGeometry` の**ビルボード・インポスター 1 draw**。円外 discard + 不透明 + depthWrite ON(ソート不要・early-z 有効)。技法選定の根拠: Mizu-threejs で同型インポスターが **15 万個 60fps** を実証済み(`src/render/DropletSystem.ts` / `docs/architecture.md` §6)なので、≤512 個の本作では余裕をもって最高品質側に振れる。シェーディングは発光球(ホットコア → 原子色、フレネルリム、パルス `0.9+0.1·sin`)— HDR の出し方は「素地 <1・正対コアのみ >1」(密集時に白帯化しない教訓: `src/render/shaders/atom.ts` のコメントと実装)。

- 属性: `aPosR` + `aPosRPrev` + `aColorKind`(kindIndex は contract の KIND_INDEX 表 — 裁定希望 #4)。頂点で `mix(aPosRPrev.xyz, aPosR.xyz, uAlpha)`
- スポーン/消滅フレームは prev = curr を sim パッカーが保証(lerp 筋の防止 — 裁定希望 #3)

**ラベル(H / O / H₂ の文字)**: 自前グリフアトラス + **加算ブレンド 1 draw**(troika は 1 Text = 1 draw なので不採用 — 判断ごと踏襲)。知見採用(verbatim 級):

- アトラス焼き込み: 1024×256 canvas に 256² セル ×4(H / O / H₂ / 予備)、**セル順 = KIND_INDEX**、H₂ の下付きは「小フォント + ベースライン下げ」の 2 フォントトリック(出典: Mizu-threejs `src/render/LabelAtlas.ts`、原典 Mizu-ts `src/core/renderers/SubscriptTextRenderer.ts`)
- AtomSystem の属性バッファを**そのまま共有**(追加アップロードゼロ)、billboard quad ~1.6×r をカメラ方向へ ~1.1×r 浮かせ、`aColorKind.w` でセル選択、加算 = 順序非依存・depthTest on / depthWrite off(出典: `src/render/LabelSystem.ts` / `shaders/label.ts`)
- 発光強度 1.2(加算の重なりで焼けない実測値 — LabelSystem.ts の教訓)。labelDensity ティアで先頭 N 割描画

**雫(球内を落ちる水滴)**: billboard インポスター 1 draw。フラグメントは Mizu 伝統の**白コア → #007fff リム**+フレネル+解析スカイ反射/屈折(出典: Mizu-threejs `src/render/shaders/droplet.ts`、原典 Mizu-ts `DropletRenderer.ts` のグラデ)。

- `aux = [phase, swayAmp, spawnStep, seed]`: **sway の位置成分は sim が posr に焼き込み済み**(裁定希望 #6)。レンダラーは位置に足さず、`spawnStep` の pop-in(`smoothstep(0, 10, uStepF - spawnStep)` で半径 0→1)と `seed` の tint 微変動のみに使う — 二重揺れの防止
- prev/curr lerp は原子と同一機構。落下は 60Hz 補間で完全に滑らか

---

## §6 スプレー/しぶきパーティクル(SpraySystem)

**ステートレス弾道**: CPU は spawn 時に 1 回書くだけ、以後の運動は毎フレームシェーダ内で閉形式評価(アップロードほぼゼロ・巻き戻し可能・決定論)。

- リングバッファ: 容量 2048(モバイル 1024)× 2 attribute(vec4 ×2 = 32B/個): `aSpawn = [p0x, p0y, p0z, spawnStepF]`、`aVel = [v0x, v0y, v0z, kindSize]`(kindSize = 種別 2bit + サイズ + シードのパック)。書き込みは `addUpdateRange` の 1 連続レンジ(知見採用: Mizu-threejs のバッファ運用一式)
- 頂点シェーダ:

```glsl
float age = (uStepF - aSpawn.w) / 60.0;                  // 秒
vec3 p = aSpawn.xyz + aVel.xyz * age + 0.5 * vec3(0, -5.4, 0) * age * age;  // g_eff = 5.4(ドリーミー)
float life = 0.8 + fract(aVel.w * 7.31) * 0.9;
float fade = smoothstep(0.0, 0.08, age) * (1.0 - smoothstep(life * 0.7, life, age));
float kill = (age < 0.0 || age > life || p.y < -0.05) ? 0.0 : 1.0;   // 死 = 縮退 quad(ラスタ 0)
vec3 wp = p + (uCamRight * position.x + uCamUp * position.y) * size * fade * kill;
```

- フラグメント: 円 discard + 白→ターコイズの微グラデ + フレネル風縁 + 太陽ハイライト。加算ブレンド・depthWrite off(順序非依存)。HDR ≤ 1.8(bloom は最輝点のみ拾う)
- **発生源**(レンダー側でイベント監視):
  - 球の着水(SplashEventView): **クラウンリング 40〜80 個**(strength 比例)— 上向き 55〜75°、速度 2.2〜4.2 u/s、リング状方位分布 + 中央コラム数個。着水点のフォームリング(§2.4)と同時に開く
  - 球のポップ(statePacked が Splashing へ遷移した瞬間を prevData 比較で検出): **膜片 20〜40 個** — 球面上のランダム点から接線方向 + 外向き、サイズ大きめ・虹彩 tint(§3 と同じ irid())で「ガラス膜が千切れて光る」
- スプレーの着水は SplatScheduler(§2.2)へ 2〜3 個の微スプラットを予約 — 弾道が閉形式なので落着時刻/地点は spawn 時に確定計算できる

---

## §7 空と環境(Environment)

**手法**: `scene.background` は使わず、far-plane に貼り付く**全画面三角形 + LessEqualDepth + depthWrite off** を最後段の不透明として描く(覆われていないピクセルだけシェーディング — 知見採用: Mizu-threejs `src/render/Environment.ts` / `shaders/sky.ts` の NDC 三角形 + 逆射影 varying 方式)。

**sky() 共有チャンク**(全シェーダの反射/屈折/フォグ光源 — 裁定済み #8)。朝の Look に合わせ、**太陽方位で地平線色が回る**:

```glsl
uniform vec3 uSunDir;     // Environment が唯一の所有者(仰角 14°、方位は構図固定)
uniform vec3 uSunColor;   // #ffd19a 系(linear)

vec3 sky(vec3 dir) {
  float h = dir.y;
  float sunAz = max(dot(normalize(vec3(dir.x, 0.0, dir.z)),
                        normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0);
  vec3 horizon = mix(HORIZON_COOL /* #a9c3d6 */, HORIZON_WARM /* #f2c39d */, pow(sunAz, 3.0));
  vec3 col = mix(horizon, ZENITH /* #6a93bd 淡い蒼穹 */, pow(clamp(h, 0.0, 1.0), 0.55));
  col = mix(col, BELOW /* 海フォグと同系の #12303f */, smoothstep(0.0, -0.12, h));
  float s = max(dot(dir, uSunDir), 0.0);
  col += uSunColor * (0.30 * pow(s, 16.0) + 3.2 * pow(s, 900.0));   // ハロー + ディスク(HDR)
  return col;
}
```

- **雲気(バックドロップ専用)**: `#define SKY_BACKDROP` 時のみ、焼き込みノイズ(§2.4 B チャネル)を方向射影 UV でサンプルし、地平線近くに +0.05 の薄い層を漂わせる(2 fetch)。**反射・フォグに使う共有 sky() はノイズなしの軽量核のまま**(全マテリアルの ALU を守る。反射像に雲が無い差は知覚不能)
- 水平線の継ぎ目: BELOW 色はフォグ飽和した海色と同一系に調整(§2.6)。海のフォグ先が `sky(viewDir)` そのものなので構造的に一致する
- 太陽は不動(スクリーンセーバーの「時刻」は変えない)。uSunDir/uSunColor は Environment がコンストラクタで確定し、全システムのマテリアルに同一参照を配る

---

## §8 カメラリグ(CameraRig — OrbitControls 不使用の自動漂流)

操作なし・環境映像のため、Mizu-threejs の OrbitControls(`src/render/CameraRig.ts`)は**採用しない**。ハンドロールの決定論的ドリフト+マウス視差:

```
基準軌道(リサージュ的、非整数比の周期で永久に非反復):
  azimuth  θ(t) = θ₀ + 2π · t / 240s               (ゆっくり 1 周 4 分)
  radius   ρ(t) = 10.0 + 0.8 · sin(2π t / 97s)
  height   y(t) = 4.6 + 0.6 · sin(2π t / 61s + 1.3)
  注視点   target(t) = (0.4·sin(2π t/91s), 3.7 + 0.25·sin(2π t/53s), 0.4·cos(2π t/73s))
  fov 45° / near 0.1 / far 1200
マウス視差(ポインタ正規化 nx, ny ∈ [−1,1]):
  Δyaw = 3.5°·nx、Δpitch = 2.0°·ny、Δpos = (0.30·nx, −0.20·ny, 0) u(カメラローカル)
  平滑: フレームレート非依存の指数追従 k = 1 − exp(−dt/τ)、τ = 0.45s(damping)
```

- t はウォールクロックではなく `timeSec = stepF/60`(sim 停止=カメラ停止で全体が一体で止まる)
- `prefers-reduced-motion: reduce`: ドリフトの t を 12s(良構図)で凍結+視差無効。海・波・球の演出は継続(コンテンツそのものsince、酔い要因はカメラ運動)。`matchMedia` の change 監視で動的切替
- `?m=1`(ベンチ)時: 視差無効 + t=0 起点の決定論軌道(再現性)
- 水面下防止: y(t) − Δpos.y の最小値 3.74 > 0 で構造的に潜らない(クランプ不要だが assert は置く)
- モバイル: ジャイロは使わない(許可ダイアログが「操作なし」の世界観を壊す)。タッチは視差の代わりに無視 — ドリフトのみ

---

## §9 パフォーマンス予算と ANGLE/モバイル制約

### 9.1 フレーム予算内訳(render 層のみ。sim の CPU は別予算)

前提: desktop tier0 = Apple Silicon / DPR2 / 2560×1600(4.1Mpx)。mobile tier3 = 中級 Android / 390×844 CSS / dprCap 1.75 × renderScale 0.66(≈ 0.45Mpx)。

| ステージ | desktop tier0 [ms] | mobile tier3 [ms] | 備考 |
|---|--:|--:|---|
| CPU: rig + uniform 更新 + イベント処理 | 0.15 | 0.30 | 7 球ソート・リップルリングバッファ込み |
| CPU: attribute アップロード(§9.2) | 0.05 | 0.10 | ~40KB/frame |
| CPU: three encode(12 draw) | 0.15 | 0.35 | |
| GPU: [A][B] リップル(384²/256²) | 0.10 | 0.12 | ~9 タップ × 147k/65k texel |
| GPU: 原子 + 雫 + ラベル | 0.15 | 0.15 | ≤1.3k quad、フィル小 |
| GPU: **Ocean v2** | 1.90 | 3.40 | 被覆 ~50%、~380/~250 ALU + 7 tex(反射 off で −130 ALU) |
| GPU: スカイ | 0.30 | 0.45 | 残ピクセルのみ(LessEqual) |
| GPU: 内水 体積+キャップ | 0.35 | 0.60 | 球被覆 ~12% ×2 層 |
| GPU: ガラス back+front | 0.50 | 0.90 | ~12% ×2 パス、虹彩 ~60 ALU |
| GPU: スプレー | 0.10 | 0.15 | バースト時のみ実質 |
| GPU: bloom(半解像度) | 1.20 | 1.60 | tier3 は 0.25 スケール |
| GPU: output + vignette | 0.30 | 0.50 | 注入統合で 1 パス |
| **合計** | **CPU 0.35 / GPU 4.9** ✓ | **CPU 0.75 / GPU 8.6** ✓ | 16.7ms 内に sim 予算の余地十分 |

### 9.2 帯域(instanced attribute アップロード量/フレーム)

| ビュー | 計算 | バイト/frame |
|---|---|--:|
| bubbles(curr+prev) | 7 × 8 float × 2 × 4B | 448 B |
| atoms(posr+prev+colorKind) | ≤512 × 12 float × 4B | ≤24.6 KB |
| droplets(posr+prev+aux) | ≤512 × 12 float × 4B | ≤24.6 KB |
| splash → スプラット instanced | ≤16 × 4 float × 4B | 256 B |
| spray spawn(バースト時のみ) | ≤80 × 8 float × 4B | 2.6 KB |
| uniform 群(波位相・リップルリング等) | — | ~1 KB |
| **計** | | **≤ 54 KB/frame ≈ 3.2 MB/s** |

Mizu-threejs の 3.6MB/**frame**(15 万雫)と比べ 2 桁軽い — アップロードは論点にならない。運用は同じ規約で統一: `DynamicDrawUsage` + `clearUpdateRanges()/addUpdateRange(0, count×stride)` の**一括 1 レンジ** + version 変化時の再ラップ(出典: `DropletSystem.ts` / `AtomSystem.ts`)。

### 9.3 AdaptiveQuality — 7 ノブ × 5 ティア

制御ロジックは実証済みの **rAF デルタ EMA(α=0.1)+ 非対称ヒステリシス**(down: EMA>15ms が 30 フレーム / up: EMA<11ms が 600 フレーム / 外乱 250ms 超はストリーク破棄)を採用(出典: Mizu-threejs `src/render/AdaptiveQuality.ts`)。`?q=<0..4>` でティア固定、`?m=1` で tier0 固定+視差無効。モバイル判定(app 層 — 裁定希望 #9)時は初期ティア 2 から開始。

| tier | renderScale | oceanGridDensity | rippleSimResolution | analyticReflections | bloomScale | labelDensity | dprCap |
|--:|--:|---|--:|:--:|--:|--:|--:|
| 0 | 1.00 | 144×192(55k tri) | 384² | **on** | 0.50 | 1.00 | 2.00 |
| 1 | 0.85 | 144×192 | 384² | on | 0.50 | 1.00 | 2.00 |
| 2 | 0.75 | 120×160(38k) | 320² | on | 0.25 | 0.75 | 2.00 |
| 3 | 0.66 | 96×128(24k) | 256² | **off** | 0.25 | 0.50 | 1.75 |
| 4 | 0.50 | 72×96(14k) | 192² | off | 0(off) | 0.35 | 1.50 |

- renderScale/dprCap: `setPixelRatio(min(dpr, dprCap) × renderScale)` + composer.setSize(出典: `SceneRenderer.ts` resize / `PostPipeline.ts` setSize)
- oceanGridDensity: LOD キャッシュの参照差し替え(§2.6)。rippleSimResolution: ターゲット再生成・波はリセット(出典: `WaterSurface.ts` setResolution — textureSize() 由来のタップ幅でシェーダは解像度非依存)
- analyticReflections: `#define ANALYTIC_REFLECTIONS` の material 2 変種を事前コンパイルし参照切替(needsUpdate 再コンパイルのヒッチ回避)
- bloomScale: UnrealBloomPass.setSize の「×2 渡し」の罠込みで踏襲(出典: `PostPipeline.ts` applyBloomSize のコメント)

### 9.4 ANGLE / モバイル制約(既知の実測教訓)

1. **MSAA×HalfFloat FBO は使わない**: ANGLE-Metal で samples 4 → 27fps、samples 2 → 36fps の実測(出典: Mizu-threejs `AdaptiveQuality.ts` 冒頭コメント / `docs/architecture.md` §7-1)。全ティア MSAA 0、AA は renderScale と「fwidth ベースの縁 smoothstep」(インポスター円縁・フォーム縁・glitter フェード)で代替
2. HalfFloat レンダーターゲットは three が要求する `EXT_color_buffer_float` 前提(WebGL2 ではほぼ普遍)。リップルの RGBA16F 読み書きも同 拡張圏内
3. シェーダは冒頭 `precision highp float` を明示(モバイル mediump では波位相・コード長計算が破綻)。位相は CPU mod 2π 供給(§2.1)で経時劣化ゼロ
4. iOS の DPR3 は dprCap で抑制。`powerPreference: 'high-performance'`、`visibilitychange` で rAF 停止
5. bufferSubData のドライバストール対策は「単一連続レンジ」原則で予防(本作は転送量が微小なので顕在化しない見込み。Plan-B のダブルバッファ・オーファニングは設計として温存 — 出典: マスタープラン リスク4)

---

## §10 ファイル構成ツリー + LOC 見積もり(来歴付き)

来歴: **NEW** = 本作新規設計 / **採用** = 知見・パターンの採用元(コードコピーではない)。

```
src/
  contract/RenderView.ts        ~90   採用: Mizu-threejs src/contract/RenderView.ts(view/interface 構造、所有権コメント規約)
  contract/WorldSpec.ts         ~50   採用: 同 src/contract/WorldSpec.ts(依存ゼロ最下層、KIND_INDEX、容量定数)
  render/RenderSystem.ts        ~30   採用: 同 src/render/RenderSystem.ts(object/update/prerender/dispose + applyTier 追加)
  render/SceneRenderer.ts       ~230  採用: 同 src/render/SceneRenderer.ts(パス順・resize/DPR・ResizeObserver+matchMedia 再アーム・ティア適用)
  render/CameraRig.ts           ~140  NEW(リサージュドリフト+視差+reduced-motion。OrbitControls 不採用)
  render/Environment.ts         ~130  採用: 同 src/render/Environment.ts(far-plane 三角形、LessEqualDepth、SunUniforms 単一所有)
  render/NoiseTexture.ts        ~80   NEW(値ノイズ/fbm/リッジ/ハッシュの 256² RGBA8 焼き込み)
  render/AdaptiveQuality.ts     ~140  採用: 同 src/render/AdaptiveQuality.ts(EMA+非対称ヒステリシス+外乱破棄。ティア表は 7 ノブに拡張)
  render/PostPipeline.ts        ~160  採用: 同 src/render/PostPipeline.ts(HDR HalfFloat・MSAA0・bloom setSize ×2 の罠・vignette 文字列注入)
  render/ocean/OceanSystem.ts   ~260  NEW(波テーブル・uPhase 供給・反射球 uniform・ティア変種切替)
  render/ocean/OceanGeometry.ts ~90   NEW(放射リンググリッド生成 + LOD キャッシュ)
  render/ocean/RippleField.ts   ~230  採用: 同 src/render/WaterSurface.ts(ピンポン FBO・スプラット instanced 注入・境界フェード・setResolution)
  render/ocean/SplatScheduler.ts ~90  NEW(遅延サブスプラット/フォームリング/スプレー落着の予約キュー)
  render/bubbles/BubbleGlassSystem.ts ~240  NEW(2 パス instanced 球、state 変形、メニスカス、虹彩)
  render/bubbles/InnerWaterSystem.ts  ~260  NEW(体積コード長シェード+キャップ、リップルリングバッファ)
  render/atoms/AtomSystem.ts    ~170  採用: 同 src/render/AtomSystem.ts(instanced+ゼロコピー/一括レンジ+HDR コア設計)+ prev/curr lerp
  render/atoms/LabelAtlas.ts    ~90   採用: 同 src/render/LabelAtlas.ts(KIND_INDEX 順セル、2 フォント下付きトリック — 原典 Mizu-ts SubscriptTextRenderer.ts)
  render/atoms/LabelSystem.ts   ~130  採用: 同 src/render/LabelSystem.ts(バッファ共有・加算 1draw・intensity 1.2 の教訓)
  render/atoms/DropletSystem.ts ~150  採用: 同 src/render/DropletSystem.ts + shaders/droplet.ts(インポスター、白→#007fff、pop-in)
  render/particles/SpraySystem.ts ~200 NEW(ステートレス弾道リングバッファ、イベント監視 spawn)
  render/shaders/sky.ts         ~90   採用: 同 shaders/sky.ts(共有チャンク+バックドロップ分離)を朝パレット/方位依存に再設計
  render/shaders/gerstner.ts    ~110  NEW(オフセット+導関数+ヤコビアン共有チャンク)
  render/shaders/ocean.ts       ~260  NEW(§2 の頂点/フラグメント本体)
  render/shaders/rippleUpdate.ts ~60  採用: 同 shaders/waterUpdate.ts(5 タップ波動方程式)+ フォームチャネル拡張
  render/shaders/rippleSplat.ts ~55   採用: 同 shaders/waterSplat.ts(速度チャネル注入・縁ハードゼロ)+ フォームリング
  render/shaders/glass.ts       ~180  NEW(§3)
  render/shaders/innerWater.ts  ~150  NEW(§4a)
  render/shaders/innerCap.ts    ~130  NEW(§4b)
  render/shaders/atom.ts        ~80   採用: 同 shaders/atom.ts(素地<1/コア>1 の HDR 設計・黄金比ハッシュ)
  render/shaders/label.ts       ~65   採用: 同 shaders/label.ts(セル選択・加算カバレッジ)
  render/shaders/droplet.ts     ~95   採用: 同 shaders/droplet.ts(円 discard・球面法線再構成・伝統色)
  render/shaders/spray.ts       ~90   NEW(§6 弾道+縮退 quad 消滅)
  render/shaders/vignette.ts    ~35   採用: 同 shaders/vignette.ts(OutputShader 注入チャンク)
  app/main.ts ほか              ~180  採用: 同 app 構成(固定 60Hz アキュムレータ+alpha 算出は本作 NEW)
────────────────────────────────────────
render 層合計 ≈ 4,350 LOC(シェーダ ~1,400 含む)
```

補助知見(判断ごと採用): bloom threshold 1.15(`PostPipeline.ts`)/ 「加算は順序非依存・depthWrite off」(`LabelSystem.ts`)/ instanced インポスターのスケール実証(`DropletSystem.ts` + `docs/architecture.md` §6)/ `?m=1` ティア固定のベンチ再現性思想(`webgl-3d-remake-plan.md` 凍結契約)。

---

## §11 リスク Top3 + Plan-B

1. **Ocean v2 フラグメントの過重**(8 波導関数 + 解析反射 + glitter + フォームで ~380 ALU。中級 GPU / 高 DPR で予算超過の恐れ)
   - 一次対策: ティアラダー(renderScale → 反射 off → grid/ripple 縮小)が §9.3 の順で正確にここを削る
   - **Plan-B**: (i) 反射ループを「カメラに近い 3 球」に制限(CPU が毎フレーム選抜 — uniform 詰め替えのみ)、(ii) glitter をタイトスペキュラへ統合(−25 ALU)、(iii) フラグメント導関数を chop 3 波だけにし swell は頂点法線補間で受ける(−60 ALU、遠景の鮮鋭さを少し捨てる)
2. **Gerstner × リップルの合成破綻**(スウェル斜面上でリングが歪む/変位二重取りで縁が浮く)
   - 一次対策: 勾配線形加算 + アクション域スウェル 25% 減衰 + 変位後 xz サンプリング(§2.2)
   - **Plan-B**: 段階後退 — (i) リップルを頂点変位から外し法線のみに(高さの二重取りが消える)、(ii) それでも駄目ならアクション域(r<12)を「凪の窓」としてスウェル振幅を 60% まで減衰(演出上も「球が落ちる聖域」として成立する)
3. **半透明スタックの順序/オーバードロー**(ガラス 2 パス ×7 + 内水 2 層 + スプレーが重なる画角で fill 爆発・順序破綻)
   - 一次対策: 加算優位設計・固定 renderOrder・7 球の CPU 距離ソート(§1.3)・内水 depthWrite ON
   - **Plan-B**: (i) ガラス backside パスをティア 3+ で off(1 draw 減 + fill 半減。虹彩は front だけでも成立)、(ii) 内水体積を NoBlending の不透明(α=1)に落とす(見た目の損失は「球越しの海の透け」のみ)

**Watchlist**(Top3 未満): fp16 リップルの量子化(振幅 0.28u / fp16 精度 ~1e-3 → 問題なし、ただし velDamp を 1.0 に近づけ過ぎると残留ノイズが見える — 0.997 を下限に)/ glitter の bloom フリッカ(HDR クランプ 3.5 + 距離フェードで抑制、実機で要確認)/ 長時間運転での uStepF fp32 精度(step が 2^24 ≈ 77 時間で劣化 — age 系は `uStepF - spawnStep` の差分なので実質無害、位相は CPU mod 済み)。

---

## 裁定希望事項

1. **render() シグネチャに補間係数**: `MizuRenderer.render(view: SkyRenderView, alpha: number)`(alpha ∈ [0,1) は app 層の固定タイムステップ・アキュムレータが算出)を契約に明記したい。
2. **statePacked のエンコード裁定**: 整数部 = 状態(0=Growing / 1=Brewing / 2=Straining / 3=Falling / 4=Splashing / 5=Dormant)、小数部 = 進行度 0..1 を提案。Splashing の進行度はポップ演出(§3)と膜片バースト(§6)の駆動に必須。
3. **prev/curr の index 整合の保証**: swap-remove/スポーンをまたぐフレームでも「同 index = 同エンティティ」で prevPosr と posr が対応し、スポーン時は prev = curr(pop-in は aux.spawnStep 側で行うため、lerp 由来のスジは不可)を sim 側パッカーの不変条件として明文化したい。
4. **容量・種別定数を contract へ**: BUBBLE_CAPACITY=8 / ATOM_CAPACITY=512 / DROPLET_CAPACITY=512 / SPLASH_CAPACITY=16 / INNER_RIPPLE_CAPACITY=64、および KIND_INDEX 対応表(H=0 / O=1 / H2=2)。uniform 配列の固定長とアトラスセル順がこれに依存する。
5. **InnerRippleView の localX/localZ の単位**: 球中心原点のローカル世界単位(−R..+R)と解釈する。正規化座標([−1,1])なら要修正なので確定したい。
6. **球内雫の sway の所在確認**: sway の位置成分は sim が posr に焼き込み済みで、レンダラーは位置に加算しない(aux.phase/swayAmp は非位置系の演出のみに使用)ことの確認。二重揺れ防止。
7. **SplashEventView.strength の定義**: 落下速度 × R³ に比例する正規化値(0..1)を希望。スプラット強度・フォーム量・スプレー個数を単一係数で駆動する。
8. **BubbleView の anchor/waterLevel の意味確認**: [ax,ay,az] は「球中心のワールド座標」、waterLevelYLocal は「中心からのローカル y オフセット(−R..+R)」であることの確認。
9. **モバイル判定の所在**: 球数 5 は sim 構成、レンダラーは count ≤ 8 を無条件に受ける。モバイル判定(UA/pointer coarse)は app 層に置き、sim(球数)と render(初期ティア 2)の双方へ注入する形にしたい。
10. **`?m=1` の意味論**: tier0 固定に加え、マウス視差無効 + カメラ軌道 t=0 起点(ベンチ再現性)。sim 側にも seed 固定の決定論運転を希望。
