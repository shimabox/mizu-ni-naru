# mizu-ni-naru(水になる)マスタープラン

- 作成: 2026-07-10(オーケストレーター)。**本書が最上位の正** — `design-sim.md` / `design-render.md` と矛盾する場合は本書 §4 の裁定表が優先する
- 三部構成: 本書(裁定・フェーズ・検証)+ [design-sim.md](./design-sim.md)(シミュレーション層詳細)+ [design-render.md](./design-render.md)(レンダリング層詳細)
- 体制: オーケストレーター(Claude)は**実装をしない**。各フェーズをサブエージェントに委任し、受入ゲートで検証する最終確認者である

---

## §1 Context と実現可否

**世界観(ユーザー要件)**: 半透明の球体が空中に何個も浮かんでいる。中では文字 H / O が漂い、H+H→H2、H2+O→水(雫)。雫は球の底に溜まり続け、水中に入った H/O などは消滅する。水が約6割溜まると球は落下し、下界の海に着水して弾け「水になる」。新しい球が生まれ、永遠に繰り返される。

**実現可否: WebGL(three.js)で確実に実現可能。** 根拠: 同作者の Mizu-threejs が「原子 9,000 体のフルパイプライン ≈2.5ms/step、雫 30 万粒 60fps」を実測済み。本作の粒子規模はその 1/40〜1/1000(ワースト原子 182 体・雫 448 粒)であり、シミュレーション負荷は最初から問題にならない。勝負は**海と球の美しさ(フラグメント品質)とペーシング(リズム)**に移る — それぞれ design-render §2(Ocean v2)と design-sim §5(運動論)が主戦場。

## §2 ユーザー決定事項(2026-07-10 確定・変更不可)

| # | 事項 | 決定 |
|--:|---|---|
| U1 | 実装ベース | **ゼロから新規実装**。Mizu-threejs / Mizu-ts のコードコピー禁止。実証済みの知見・パターンの採用は可(出典パス明記) |
| U2 | 落下先 | **下界の海へ落ち、水になる**。かつ**海のクオリティは Mizu-threejs の水面を明確に超えること**(最重要要件) |
| U3 | カメラ/操作 | 自動でゆったり漂うカメラ + マウス視差。**スクリーンセーバー的**。クリック注入などの操作は無し |
| U4 | 公開/環境 | GitHub Pages 公開 + モバイル対応(AdaptiveQuality) |

## §3 世界ルールの実装解釈(ユーザー確認事項)

設計上、原文ルールに演出・工学の解釈を加えた箇所。**却下されたら design-sim の該当ノブを差し替える**(設計は破綻しない):

1. **水面は「たまに溶ける弾む床」**(design-sim §3.3/§5.2): 原子が水面に触れると通常は「ぽよん」と跳ね、確率 5%(P_DISSOLVE)で水に溶けて消える。完全吸収面にすると原子が反応する前に全部水没し、雫がほぼ生まれなくなる(運動論で定量済み: 溶解 2.8 体/s > 供給 1.5 体/s)。「水中に入った H/O は消滅する」は保存(入ったら必ず消滅。入りにくくしただけ)
2. **反応で原子は再湧きしない**(原典 Mizu からの変更): 供給は「凝結スポナー」(水面より上の空域に H/O が少しずつ凝結して現れる)のみ。物質は 原子→H2→雫→球内の水→海 へ一方通行 — 「すべてはやがて水になる」。H2 は両親 H の中点に生まれる
3. **着水の瞬間に球は弾けて中身ごと水になる**(Splashing 0.8s): 中の原子・雫・水は即時消え、海の波紋・フォームリング・しぶきの FX がそれを覆う
4. **海面上昇の永続化は非目標**: 海は無限シンク(波紋と輝きで受け止める)

## §4 契約裁定(並列設計の裁定希望 22 件 + オーケストレーター検出 3 件)

design-sim / design-render の文末「裁定希望事項」への裁定。**本表が最終決定**。

| # | 事項 | 出典 | 裁定 |
|--:|---|---|---|
| A1 | `SkyRenderer.render(view, alpha)` シグネチャ(alpha ∈ [0,1)) | render#1 | **承認**(design-sim §1.2 の契約に含まれている形で確定) |
| A2 | statePacked = `stateIndex + min(progress01, 0.999)`、状態別 progress 意味、prevData の statePacked lerp 禁止 | render#2 + sim#3 | **承認**(design-sim §1.3 の仕様で確定) |
| A3 | **FSM 状態名の統一**(検出: sim=Spawning/Drifting/Dead、render=Growing/Brewing/Dormant) | 検出 | **sim 名で統一**: `Spawning:0, Drifting:1, Straining:2, Falling:3, Splashing:4, Dead:5`。インデックスは両設計で同一のため render のシェーダ断片(数値比較)は無変更で有効。render 文中の Growing/Brewing/Dormant は同インデックスの別名と読み替える |
| A4 | prev/curr の index 整合(同 index = 同エンティティ、スポーン時 prev=curr、3 本同時 swap) | render#3 | **承認**。design-sim §1.4 規約 1-2 を契約コメント本文とし、補間契約テストで固定 |
| A5 | 容量定数の contract 移管 | render#4 vs sim§1.1 | **sim 値で確定 + BUBBLE_CAPACITY 追加**: `BUBBLE_CAPACITY=8` / `ATOM_VIEW_CAPACITY=256` / `DROPLET_VIEW_CAPACITY=512` / `SPLASH_VIEW_CAPACITY=8` / `RIPPLE_VIEW_CAPACITY=64` / `KIND_INDEX={H:0,O:1,H2:2}`。render の uniform 配列は 8 固定。render §9.2 帯域表の atoms ≤512 は 256 に読み替え(余裕が増える方向) |
| A6 | **AtomView.aux 追加**: stride4 `[spawnStep, seed, 0, 0]` | sim#4 | **承認**。凝結スポーンのフェードイン + パルス位相に使用。⚠ render §5 の原子パルスは `gl_InstanceID` 黄金比ハッシュではなく **aux.seed 駆動に差し替えること**(swap-remove で index が動くとパルス位相が飛ぶ潜在バグの解消)。帯域 +4KB/frame(無視できる)。ラベルのフェードも同バッファ共有 |
| A7 | InnerRippleView の用途拡張(雫着水 0.6〜1.0 + 溶解 0.3) | sim#2 | **承認**。render のリングバッファ(球ごと 6 本)は strength スケール対応済み |
| A8 | InnerRipple の localX/Z 単位 | render#5 | **球ローカル世界単位(−R..+R)で確定** |
| A9 | 雫の sway は sim が posr に焼き込み済み(render は位置加算禁止、aux は pop-in/tint のみ) | render#6 | **確認・確定**(design-sim §4.1 カーネルが焼き込む) |
| A10 | SplashEventView の semantics | render#7 vs sim#7 | **sim 案で確定**: `radius = R`、`strength = min(1, vImpact/4)`(速度項のみ)。render がサイズ込みの駆動係数を欲しい場合は `strength × (radius/R_MAX)³` を内部導出する |
| A11 | BubbleView の意味確認(anchor=球中心ワールド座標、waterLevelYLocal=中心からの y オフセット、値域 ±R_inner) | render#8 | **確認・確定** |
| A12 | fill01 の分母 = V_inner(R_inner = 0.94R)。F_FULL=0.6 は「見えている空洞の 6 割」 | sim#1 | **承認**。契約コメントに明記 |
| A13 | シェル半径の二本立て(検出: sim SHELL_RATIO=0.94 vs render 水描画 0.985R) | sim#9b + 検出 | **意図的二本立てとして承認**: 台帳・粒子境界は `SHELL_RATIO=0.94`(sim)、水の見た目半径は `WATER_VISUAL_RATIO=0.985`(render — 水がガラスに接して見える)。**水面平面の高さ waterLevelYLocal が唯一の真実**。体積↔水位はどのみち VOLUME_GAIN で演出的なので視覚差は問題にならない |
| A14 | 水面の確率透過 P_DISSOLVE=0.05 | sim#5 | **承認**(§3-1 でユーザー確認)。「重なれば必ず反応・確率なし」は化学反応の規約であり境界物理には適用しない |
| A15 | HHFusion 中点生成・再湧きなし | sim#6 | **承認**(§3-2 でユーザー確認) |
| A16 | モバイル判定の所在 | render#9 | **app 層で確定**(viewport width < 768)。sim へ `slotCount=5`、render へ初期 tier2 を注入。render は count ≤ 8 を無条件に受ける |
| A17 | `?m=1` の意味論 | render#10 | **承認**: overlay 表示 + tier0 固定 + マウス視差無効 + カメラ軌道 t=0 起点。**seed は独立**(`?seed=` を明示指定。m=1 が seed を固定することはない) |
| A18 | BubbleView.count = 常に SLOT_COUNT(Dead 含む) | sim#10 | **承認**。render は state==Dead を縮退 quad(scale 0)で非描画 — render §3 設計済み |
| A19 | StatsOverlay 行契約は本作で新規定義(SimCounts が正。threejs の凍結行形式は継承しない) | sim#11 | **承認**。ベンチハーネスを将来移植する場合はパーサ側を合わせる |
| A20 | RNG サブストリーム移行(hash(rootSeed, slot, generation))を Plan-B 予約 | sim#8 | **承認**(現行は単一ストリーム。ゴールデン運用が痛くなったら発動) |
| A21 | モバイル縦画面のフレーミング | sim#9a | **方針確定**: 全リングの常時収容は非目標。海 + 2〜4 球が映る構図を優先(球がフレームに出入りするのは演出として正)。Phase 4 の校正項目(owner: render) |
| A22 | 球の per-generation 視覚シード(検出: render §2.5 uniform に seed があるが BubbleView に無い) | 検出 | **契約に seed は追加しない**。render が `hash(slot, R, anchor ジッタ)` から導出(世代ごとに R・ジッタが再ロールされるので自然に変わる) |
| A23 | mobile ペーシング(≈24s は帯上限際) | sim#12 | **校正で判定**: `scripts/calibrate` の受入帯(T_fill 90〜150s / 落下間隔 15〜25s)で実測し、外れたら mobile プリセット(SPAWN_INTERVAL / F_FULL / INITIAL_FILL_MAX)の別値を許可 |
| A24 | 雫の消滅位置(検出: 吸収は「下端接触」判定なので最終描画位置は水面の僅か上) | 検出 | **対処不要と裁定**: 60Hz で残差 ≤0.008u + InnerRipple FX が覆う。実機で気になったら「吸収 step に y を水面へクランプして 1 step 残す」を render 協定なしで sim 側修正可 |
| A25 | 「原子・雫は常に球内水面より上」不変条件(render §4 の depth 戦略が依存) | 検出 | **契約の文書化不変条件に昇格**(sim §3.3/§4.1 が保証、プロパティテスト対象) |
| A26 | **文字が主役**(2026-07-11 ユーザー指示)— 原子を発光球で囲わない | ユーザー | design-render §5 の「発光球+ラベル」を上書き: 発光球インポスターは削除、文字そのもの(per-atom 色+暗色縁取り、通常アルファブレンド)が粒子。`fb87140` で実装済み |
| A27 | **画面パスは bloom FBO 連鎖を再サンプルしない**(黒フレーム対策)| 検出+ユーザー報告 | Chrome/ANGLE Metal の提示段不具合により、画面へ描くパスが UnrealBloom 連鎖の産物を読むと全面黒フレームが混入(CDP screencast 実測 16〜39 枚/20s → 修正後 0 枚/60s)。bloom は二重化した自前ターゲットに閉じ、シーン内加算三角形が前フレーム bloom を適用(1 フレーム遅延+帰還打ち消し)。`29ea69c`。**Phase 3 以降のポスト/FBO 追加時もこの制約を厳守** |
| A28 | **マウスでグリグリ動かしたい**(2026-07-11 ユーザー指示 — U3 改訂) | ユーザー | ドラッグでオービット+ホイールでズーム(クランプ付き)、操作をやめて ≈5s で自動ドリフトへ滑らかに復帰(Mizu-threejs CameraRig の実証パターン)。パン無効・水面下潜行防止クランプ維持。モバイルは 1 本指オービット+ピンチズーム。`prefers-reduced-motion` と `?m=1`(決定論軌道)は不変 |
| A29 | **落下をもっと自然に**(2026-07-11 ユーザー指示) | ユーザー | Falling 中のぐにゃぐにゃ(wobble 変形+雫型ストレッチ 0.14)を大幅減: 落下開始で wobble を数百 ms で減衰させ、ストレッチは ≤0.04 の微小な空力感のみ。剛体的でまっすぐな落下に。値は視覚調整で確定 |
| A30 | **球体を増やしたい**(2026-07-11 ユーザー指示) | ユーザー | SLOT_COUNT: desktop 7→**12** / mobile 5→**7**。凍結契約の容量定数を裁定により改訂: BUBBLE_CAPACITY 8→16 / ATOM_VIEW_CAPACITY 256→512 / DROPLET_VIEW_CAPACITY 512→1024 / SPLASH_VIEW_CAPACITY 8→16(改訂はこの 4 定数のみ、view 構造は不変)。配置は単一リング→**緩い二重リング**(内 r≈3.6×5 球 + 外 r≈6.3×7 球、高さ帯 y 2.6〜6.0 に拡大、3D 分離チェック維持)。カメラ基準距離を再フレーミング。落下間隔の受入帯を 15〜25s → **11〜20s** に改訂(賑やかさはユーザー要望)、校正再実行。海の解析反射はカメラに近い 8 球に CPU 選抜制限(コスト維持) |
| A31 | **球内で出来る水が白っぽすぎる**(2026-07-11 ユーザー指示) | ユーザー | 雫の白コア支配をやめ、溜まった水と同じ #007fff 系の透明な水色を本体に(フレネル縁・空の映り込みは控えめに残す)。球内水面キャップの白いスペキュラ/反射も抑え、体積の青と連続した「同じ水」に見せる |
| A32 | **球体をもっともっと多く+遠くは簡略描画**(2026-07-11 ユーザー指示) | ユーザー | **球体フィールド + 距離 LOD**: desktop 合計 40(近リング 12 は現状のまま+外側に環状フィールド 28)/ mobile 14(7+7)。全球リアル sim(sim コストは自明)。LOD: ガラス/内水ジオメトリを距離 3 段階(icosa d4/d3/d2)、**文字は距離カットオフ**(遠方は判読不能なので描かない)、キャップ波紋 uniform は近傍 12 球のみ、海の解析反射は近傍 8 のまま。契約容量再改訂(A30 と同手続き): BUBBLE_CAPACITY 64 / ATOM 2048 / DROPLET 4096 / SPLASH 64 / RIPPLE 128。遠方の着水はリップル場外なのでスプレー+ポップのみ(知覚上十分)。近リングのリズム帯(11〜20s)は不変、シーン全体では数秒に 1 回どこかで球が還る |
| A33 | **着水の水しぶきが光りすぎ**(2026-07-11 ユーザー指示) | ユーザー | 「もっと水しぶきっぽく。そんなに光らせなくていい」— スプレーの加算グロー/HDR を抑え(bloom に乗せない ≤1.0)、白〜水色の細かい飛沫が弧を描いて落ちる表現に。粒を細かく・数をやや増やし、太陽色の tint を弱める |
| A34 | **原子が球内水面で跳ねるとき「ポチャ」**(2026-07-11 ユーザー指示) | ユーザー | 跳ね返り(mirror反射)時に InnerRipple イベント(strength 0.15)を発火。球ごとに 18 step(0.3s)の決定的レート制限(直近発火 step を記録)。契約変更なし(InnerRippleView は strength を既に持つ)。ゴールデン再記録 |
| A35 | **球体をもっともっと多く(第2弾)**(2026-07-11 ユーザー指示) | ユーザー | SLOT_COUNT desktop 40→**96** / mobile 14→**24**。フィールド半径 [8,26]→**[8,45]**(外へ薄く)。契約容量再改訂: BUBBLE_CAPACITY 128 / ATOM 4096 / DROPLET 8192 / SPLASH 128 / RIPPLE 256。LOD バケットは必要なら 3 段化を許可し **draw call 予算を ≤20 に改訂**。sim step コスト実測を報告(desktop 相当で ≤2ms/step 目安)。近リングのリズム不変 |
| A36 | **水しぶきがまだ光って見える**(2026-07-11 ユーザー指示 — A33 の追撃) | ユーザー | 根本対策: スプレーの**加算ブレンドを廃止**し通常アルファブレンド(白い泡の粒が「物」として見える)へ。フォーム色の拡散光沢のみ・HDR なし・太陽 tint 最小。同時に鳴る球ポップのフレネル閃光(×6 HDR)も ≤2 に減衰し bloom バーストを抑える。しぶきは「光」ではなく「水」 |
| A37 | **しぶきがまだ光って見える — 白いからかも、少し水色に**(2026-07-11 ユーザー指示 — A36 の追撃) | ユーザー | 純白は暗い海上で最大コントラスト=「光」と誤読される。しぶきを淡い水色(白 8 : 水色 2 目安、下面はさらに青く)+ やや透過(向こうの海が透ける)に。加えて球ポップ閃光を bloom 閾値未満(2.0→≤1.05)に — しぶきと同時発火する bloom バーストの残党を根絶 |
| A38 | **着水グローの真犯人特定**(2026-07-11 — A33/36/37 の完結編) | 検出+ユーザー | 切り分け実験(同一 seed の同一着水をトグル別に撮り比べ)で、スプレー/スペキュラ/glitter/ポップ閃光は全て無罪、真犯人は**リップル場 B チャネルのフォーム**と判明: 波動由来フォーム生成(+0.006/step)が減衰 0.988 と釣り合い、96 球世界(A35)の連続着水でアクション域全面が飽和白(表示 ~238)に張り付き、着水ごとに白面が明滅していた。生成しきい値/上限と減衰を再調整(定常 ~0.5→~0.27)、リング注入 0.8→0.55、フォーム被覆上限 0.85、フォーム色を淡水色 #e2eef2 化し、フォーム上のスペキュラ/glitter もフレネル同様に減衰(泡は拡散面)。凪の海は数値不変(c230 2635→2617) |
| A39 | **球内の水の色が濃い — もう少し薄く**(2026-07-11 ユーザー指示) | ユーザー | Beer-Lambert 吸収を弱め(1.9/0.75/0.35 → 1.2/0.5/0.24)、深色ミックス 0.6 倍、基調 MIZU_BLUE×0.85→0.95、透過 α 上限 0.92→0.8。キャップ(ミニ海)も同係数系で追従(A31 の「体積と地続き」原則維持)。#007fff のアイデンティティは保ったまま、向こうの景色がうっすら通る薄い水色に |
| A40 | **もっと溜まってから落ちてほしい → 満水閾値をランダム帯に**(2026-07-11 ユーザー指示) | ユーザー | F_FULL 固定 0.6 を廃し、**球ごとに [0.8, 0.95] の一様ランダム**(世代ロール)— 満水位置に個性が出る。リズム保存: VOLUME_GAIN を帯平均 0.875 比で再スケール(15→≈22)、INITIAL_FILL_MAX 0.75。高 fill で凝結スポナーの空域帯が反転しうるため崩壊ガード(決定的フォールバック)を追加。契約はコメントのみ更新。ゴールデン再記録・校正帯は不変で PASS |
| A41 | **もっと多くの球体で壮大に — 遠くは小さく透明、たまに落ちる**(2026-07-11 ユーザー指示) | ユーザー | **render 専用の書き割りフィールド**(sim・契約・リズム不変): 250 個(mobile 100)の非シミュレーション球を r∈[40,180] に散布。距離フェード+擬似水位、個別周期(60〜300s)で状態レスに「浮遊→降下→消滅→再出現」(uStepF+ハッシュ導出、決定論)。追加 draw ≤2 |
| A42 | **球サイズをもっとバラバラに**(2026-07-11 ユーザー指示・承認済み) | ユーザー | R の全体帯を [0.75, 2.3](比率≈3倍)へ拡大、分布は小径多数・大径稀の偏り(u² シェーピング等)。**身の丈ロール**: 近リングはサイト間隔が詰まるため上限 1.8、巨大球(R≥2.0)は外側フィールド限定(遠くのシルエット・近くの繊細さ)。ペーシングは設計のスケール不変性(design-sim §5.4)により無影響。契約はコメントの R 範囲のみ更新(A40 と同手続き)。書き割り(A41)も同傾向のばらつきを適用。ゴールデン再記録 |
| A43 | **下から見ると波紋が見えない**(2026-07-11 ユーザー指示) | ユーザー | 波紋は水面キャップ(上面)のみで、下からは体積(depthWrite ON)が遮蔽して何も起きていないように見える。修正: 体積シェーダに同じ InnerRipple リングバッファ uniform を渡し、**水中を透過する光の輪**(コースティクス風の明暗同心円、水面からの深度で減衰)として描画(改訂: 初版は水入射点の深度で減衰させたため真下からは最深部入射となり輪が消えていた。視線と水面平面の交点(tPlane 交点)の (x,z) で波紋を評価し減衰を弱める方式に修正 — 「下から水面の模様を見上げる」物理に一致)。雫着水+原子ポチャの両イベントが下・横からも見える |
| A44 | **球ごとに水の色味をランダムに**(2026-07-11 ユーザー指示) | ユーザー | 現在色を**最濃端**とし、球ごとのハッシュ係数(A22 方式: slot+R から導出、世代ごとに変化、契約変更なし)で薄い透明な水色まで変化。体積・キャップ・メニスカスが同係数で追従(「その球の水」として一貫)(追補: 薄い側の下限を引き上げ — 変化幅を約半分に圧縮(WATER_TINT_MAX=0.55)、最薄でも明確に青い水 — 2026-07-11 ユーザー指示) |
| A45 | **落下直前の「ぶにぶに」を控えめに**(2026-07-11 ユーザー指示 — A29 の補遺) | ユーザー | A29 で意図的に残した Straining の予兆 wobble が強すぎた。無くさず**振幅を〜4 割に縮小**(wobble 視覚ゲインと stretch ランプの減衰)。「よく見ると張り詰めている」程度の上品な予兆に |
| A46 | **A44 の取り違え訂正 — 雫(H2+O で生まれる水)の色をランダムに**(2026-07-11 ユーザー指示) | ユーザー | A44 は「球体の中で発生する水」を溜まった水と誤読(溜まった水の色変化はユーザー判断で存置)。本来の要望は**雫の個体差**: aux.seed 由来の係数で、現在色を最濃端として薄い透明な水色まで雫ごとに変化(A44 追補の圧縮を共有 — 最薄でも青い水)。render 完結(DropletView.aux.seed は既存) |
| A48 | **球体内の水、全体的にもう少し濃く**(2026-07-11 ユーザー指示) | ユーザー | A39 で薄めた基調を部分的に戻し、per-bubble レンジ全体を濃い方へシフト(吸収係数・基調彩度・α を A39 前後の中間目安から視覚調整)。A44/A47 の濃淡個性はレンジごと平行移動で維持 |
| A49 | **公開は Cloudflare(U4 改訂)**(2026-07-11 ユーザー決定) | ユーザー | GitHub Pages を廃止: deploy.yml と GITHUB_PAGES スイッチを撤去し、Vite base は常に `./`(相対)— `https://app.orukubami.sh/mizu-ni-naru/` のサブパス配下で dist/ がそのまま動く。デプロイはユーザー自身。CI(ci.yml)は存置 |
| A50 | **AdaptiveQuality が過敏でぼやける — くっきり優先に**(2026-07-11 ユーザー指示) | ユーザー | 一時的な環境ノイズ(バックグラウンド負荷等)で 30 フレームの下降ストリークが容易に成立し、600 フレームの上昇ストリークに時間がかかるため「一度ぼやけると居着く」。ユーザーは「くっきりめのほうがよい」と明言 — down 側の閾値を緩め(DOWN_THRESHOLD_MS 引き上げ・DOWN_STREAK_FRAMES 増加)、真に継続的な低フレームレートのみで降格するよう調整。up 側は現状維持(戻りは慎重でよい) |
| A51 | **遠くの球体が多角形に見える — 丸く見えるように**(2026-07-11 ユーザー指示) | ユーザー | 遠距離 LOD の低ポリゴン球(BubbleGlassSystem 遠距離 icosa detail2 ≈80tri、BackdropBubbles icosa detail1 ≈20tri)がファセット(多角形の稜線)を露呈。A42 でサイズ上限が 2.3 まで拡大し「遠距離判定だが画面上ではまだ大きい」球が増えたため顕在化。分割レベルを引き上げて滑らかに(draw call 数は不変、三角形数のみ増加 — 予算内で調整) |
| A52 | **60fps 維持。エフェクトは文字の解像度より価値が高い**(2026-07-11 ユーザー指示 — A50 の改訂・優先順位確定) | ユーザー | 「bloom・書き割り・しぶき・波紋解像度・映り込み・海グリッドは文字の解像度より価値が高い」— 降格は renderScale/dprCap を先に削り(1.00→0.85→0.75→0.66→0.55)、世界の空気を作るエフェクト群は tier2 まで完全温存・反射は tier3 まで生存。降格感度は再強化(18ms/60 フレーム)で 60fps を能動的に維持。文字は解像度低下に備えアトラスの縁取り・フィルタリングを頑健化(「文字の見せ方もあるだろうし」)。球体ジオメトリの分割レベル(A51)はティア対象外 — どのティアでも球は丸い(妥協しない) |
| A53 | **球内の水位上昇を滑らかに**(2026-07-12 ユーザー指示) | ユーザー | 雫吸収の体積が 1 step で即時反映され階段状に見えていた。WaterBody を二層化: 台帳 V_ledger(即時・質量保存の正)と表示水位 V_eased(指数追従 τ≈0.6s、毎 step V += (V_ledger−V)·k)に分離し、**契約に出す waterLevelYLocal/fill01 と球内の物理相互作用(吸収・バウンド・F_FULL 判定)はすべて V_eased 基準**(見た目と挙動の一致)。決定論(k は定数)・単調性(台帳は増加のみ)・質量台帳テスト(V_ledger 基準)は不変。ゴールデン再記録 |
| A54 | **まだ多角形に見える — 中の水が多角形では?**(2026-07-12 ユーザー指摘 — 仮説的中) | ユーザー | A51 はガラスと書き割りのみ引き上げ、水の体積ジオメトリ(近 d3=320tri/遠 d1=80tri)を直し忘れていた。A48 で水がほぼ不透明になり水のシルエットが球体知覚を支配するため「滑らかなガラスの内側にカクカクの水」が露呈。水の体積をガラスと同レベルに統一(近 d4/遠 d3)、水面キャップ遠距離も 8×16→16×32 に引き上げ |
| A55 | **世界そのものが球体である気配**(2026-07-12 ユーザー着想) | ユーザー | 「周りを見るとこれ自体も球体なのだ」という入れ子の気配を、明示的な演出(カメラを引いて外から見せる等)ではなく**匂わせる**方向で表現。(a) 海の放射グリッドに極めて微弱な惑星曲率(中心からの距離で y をわずかに沈める)、(b) 空のグレージング角(水平線付近)に球体ガラスと同系の虹彩フレネルをごく薄く適用。ユーザー確認: 「控えめな気配、匂わせる方向でいい」「イメージにぴったり」。派手にしない・発見として明示しないことが要件そのもの(2026-07-12 追記: ユーザーフィードバックで強度を約2〜3倍に強化) |
| A56 | **球の高さ帯を拡大**(2026-07-12 ユーザー着想) | ユーザー | 「もっと高い位置にあってもいい。数は増やさなくていい、ランダムに配置」— 近リング・フィールド共通の高さ帯 y∈[2.6,6.0] の上限を **9.0** に拡大(下限は維持)。落下物理(design-sim §2.4、線形抗力付き加速)は既に「じわっと加速」する設計のため追加のスケーリングは不要 — ユーザー確認「徐々に早く落ちればいいんじゃないの？」どおり、高い球はそのまま長めに加速しながら落ちる。カメラフレーミングが新高さ帯に追従できるか要確認 |
| A57 | **しぶきの色を球の水色に完全一致**(2026-07-12 ユーザー指摘・決定) | ユーザー | 「しぶきの色って変えられる？着水した球体の中の水の色にできる？」→ コード確認で現行しぶき色が実質ほぼ白(foamTop≈白)だったことが判明、ユーザー「今が水色っぽくない」で確定。契約変更なしで実現: 着水位置とその瞬間 Splashing 状態の球のアンカー位置を突き合わせて球を特定、その水色ハッシュ(A44/A47 と同一計算をJS側に複製)から RGB を算出し、しぶき粒子の spawn 時 instanced attribute(aTint)として焼き込む。粒子色は完全一致(ブレンドではない) |
| A58 | **多角形が再発 — 原因は高さ帯拡大(A56)による LOD 境界移動**(2026-07-12 ユーザー報告) | ユーザー+検出 | A51/A54 で一度解消したが、A56 の高さ帯拡大(2.6〜9.0)で近リング寄りの球が y 方向の距離だけで LOD_NEAR_DISTANCE(15u、A32)を超えるケースが増え、画面上まだ大きい球が遠距離バケットの旧 detail3(320tri)ファセットを再び露呈した。切り分け実験で確定: ①BackdropBubbles を強制非表示にしても稜線は残存(書き割りは原因でない)②全球を強制的に near バケット相当に寄せる/遠距離ジオメトリを detail3→4 に引き上げると稜線が消失(LOD 境界の問題と確定)。実測(seed=7 サンプル 1 フレーム): 遠距離判定 70/96 球中、y∈[7.6, 8.6] 帯(A56 以前は存在し得なかった範囲)の新規ケースが dist 15.1〜18.7u に集中。sim の高さ帯(config.ts、変更禁止)・LOD_NEAR_DISTANCE 自体には触れず、`BubbleGlassSystem`/`InnerWaterSystem` の遠距離バケットジオメトリ(グラス・水の体積)を近距離と同じ detail4(500tri)に統一して解消(draw call 数不変、三角形数のみ+約10.5%〈desktop 実測 694,369→766,933 tri〉)。before/after スクリーンショットで稜線消失を確認 |
| A59 | **しぶきの膜片(kind 1)がまだ白っぽい — 水滴と混ざって見える**(2026-07-12 ユーザー報告) | ユーザー | A57 は水滴(kind 0)のみ球の水色に一致させ、膜片(kind 1、球ポップ時の破片)は意図的に旧フォールバック色(FALLBACK_TINT、旧 foamTop)のまま残していた。同じ着水/ポップの瞬間に両方が同時に湧くため色が混ざって見える。`SpraySystem.ingestPops` はポップしたスロット/半径を常に把握しているため、水滴と同じ `bubbleWaterColor`(A57 と同一計算)をその場で算出し `aTint` に焼き込むよう変更(FALLBACK_TINT は kind 0 の一致球なしフォールバック専用に用途を限定)。spray.ts の虹彩合成ロジック(`irid()` ベースの film ミックス)自体は不変 — ベース色だけを球の水色に統一 |
| A60 | **多角形が4度目の再発 — 真犯人は BackdropBubbles(書き割り球)だった**(2026-07-12 ユーザー報告・オーケストレーター確定) | 検出 | A51/A54/A58 は実シム球(BubbleGlassSystem/InnerWaterSystem)のみを修正しており、**遠景の書き割り球(A41 BackdropBubbles、最大250個)のジオメトリは A51 で detail1→2 にしたきり放置**されていた。擬似水面が頂点ローカル座標の smoothstep(`vLocal.y`)で表現されているため、detail2(180tri)の低ポリ球ではシルエット・水面境界とも稜線が露呈。実機スクショで手前の実シム球(滑らか)と背景の書き割り球(多角形)の対比を確認して確定。対処: ベースジオメトリを他システムと同じ detail4(500tri)に統一し、水面境界の判定も三角形内の線形補間(`vLocal.y`)から正規化後の法線(`normalize(vLocal).y`、球面上の真の高さ)へ切替 — 頂点密度に依存せず境界線が真の球面曲率に沿う |
| A61 | **しぶきの色混在(白っぽい/水色)が再発 — 原因調査**(2026-07-12 ユーザー報告) | ユーザー+検出 | A57/A59 で一度対処したが、ユーザーが再度「白っぽいのと水色ので混ざっている」と報告。切り分け実験で原因を確定: ①ヘッドレス sim 計装(seed 7・96 球・8 分相当、A56 環境)で `resolveSplashTint` のフォールバック発火率を実測 → 0/305(0%)、Falling→Splashing は同一 step 内で完結するため常に厳密一致(d²=0)。フォールバック容疑はシロ。②実機で着水の瞬間を rAF 同期の `splashesTotal` カウンタで確実に捕捉(5 件)、拡大クロップで観察した結果、同一バーストの中で水滴(kind 0)は水色、膜片(kind 1)は白っぽい粒(ピンク〜マゼンタの虹彩縁取り)として混在しているのを視覚確認。③シェーダ計算を JS で再現し数値検証: `spray.ts` の膜片 `film = mix(vTint, irid(...)*0.4 + vec3(0.5), 0.6)` の mix 比率 0.6 が高すぎ、`vec3(0.5)`(中間灰色)側の重みが同一 vTint でも彩度を大きく奪っていた(同じ球の水色から出た kind 0 の彩度 0.65〜0.89 に対し kind 1 は 0.07〜0.60 まで低下)。虹彩ハイライト項(候補2)は core=1 時でも寄与比 ~0.09〜0.10 と小さく主因ではない。膜片の mix 比率を 0.6→0.2 に低減し実機で before/after 撮影・視覚確認(白っぽさ/ピンク縁取りが明確に減少、虹彩の気配は残存)。フォームリング(候補4、海面の白い泡)は別システムとして正しく残存(修正対象外) |
| A62 | **まだ球体が角ばって見える — 高さ帯を狭める**(2026-07-12 ユーザー報告) | ユーザー | A60 後もユーザーが「少し角ばって見える」と報告。オーケストレーターの検証では明確な再現は得られなかったが、ユーザーの体感を優先し、ユーザー提案どおり高さ帯(A56 で 9.0 に拡大)を縮小する方向で対応。**対処**: `RING_Y_MAX` を 9.0→**7.5**(A56 拡大幅 3.0 のちょうど半分を戻す妥協値、A56 の意図「もっと高い位置」も半分残す)。校正実測(desktop/mobile 各 seed 7/42/123/2026 × 900s)は全帯 PASS(desktop T_fill 134.8s・近リング間隔 11.6s / mobile T_fill 103.4s・近リング間隔 15.5s — ノブ調整不要)。ゴールデン再記録(bubbles/atoms/droplets の位置チェックサムのみ変化、RNG 呼び順・個体群動態・化学は不変)。**効果検証(最重要)**: 変更前(9.0)/変更後(7.5)で同一シード(seed=7)・同一カメラ操作(合成 pointer/wheel イベントで大きく見上げドラッグ+ズームイン)による before/after スクリーンショットを比較。**どちらの高さ帯でも稜線(ファセット)は再現できなかった** — 至近距離まで寄った巨大な球(画面の大半を占める)を含め、シルエット・シェーディングとも滑らかで多角形は視認できず。コード確認でも裏付け: A58/A60 により近距離・遠距離バケット・書き割り球のジオメトリはすべて detail4(500tri)に統一済みで、LOD 境界(LOD_NEAR_DISTANCE=15u)を跨いでも分割レベルが変わらないため、そもそも高さに起因する LOD 境界ファセット機構自体が存在しない。→ **高さ変更単独では体感差の物的証拠を再現できず、detail4→5への引き上げも「効果を確認できないまま解像度/三角形数を上げる」ことになるため見送り**(効果が測れない変更は入れない)。ユーザー要望どおり高さ帯は縮小して着地(7.5)、視覚的な体感改善はユーザー自身の実機確認を待つ。黒フレームプローブ(96×96×120)0/120、コンソールエラー 0 |
| A63 | **高さ帯を9.0に復元**(2026-07-12 ユーザー指示) | ユーザー | A62 で高さ帯を7.5に狭めたが、狭めてもファセット再現に差が出ないことが検証済みだった(LOD境界機構はA58/A60で既に消滅)。効果が実証できない制約だけを残す理由がないため、オーケストレーターが本番(旧コミット)とローカルを比較して報告した上でユーザーが「9.0までに戻してもらっていい」と判断。RING_Y_MAX を 7.5→9.0 に復元(A56相当) |
| A64 | **favicon を丸みのある表現に変更**(2026-07-12 ユーザー報告) | ユーザー | ユーザーから「iconが水っぽくてとてもいいのですけど、もっと丸っぽくてもいいです」とのフィードバック。💧(水滴)絵文字は涙型・雫型で丸みに欠ける。絵文字グリフはフォント依存で丸さが保証されないため、最終的に index.html の favicon data URI を `<text>` 絵文字ではなく円のベクター図形(`<circle>` + ハイライト用 `<ellipse>`、作品の水色 #94d6eb を使用)に変更し、確実な丸さを担保 |
| A65 | **初期化時の実球出現を1個からの段階湧きに変更**(2026-07-12 ユーザー報告) | ユーザー | ユーザーから「最初の画面表示時、実球(近リング+外側フィールド合わせて数十個)がいきなり全部同時に描画されて、動き的に『グッ』と丸くなる感じで違和感がある」「実球は1個から始めて徐々に増やす」との報告・提案。調査で根本原因を特定: `MizuNiNaruSim.init()` が全スロットに同期的に `rollSlot(i, true)` を呼び、`rollSlot` の末尾で必ず `fsm.enterSpawning()` するため全実球が t=0 で一斉に Spawning 状態へ入り、`glass.ts` に既存の Spawning 専用 grow アニメ(§ 小さめから膨らんでオーバーシュートする「ポヨン」演出)が同時発火して「集団でグッと丸くなる」ように見えていた。**対処**(レンダー側 glass.ts/BackdropBubbles.ts は無改修): `init()` で全スロット `rollSlot(i, true)` 実行直後、1 個(index 0)を除く全スロットについて `rollSlot` が設定した Spawning を上書きし、`BubbleFsm.enterDead()`(新設、`enterSpawning()` と対称)で既存の Splashing→Dead 遷移と同じ着地状態(Dead + `RESPAWN_DELAY_MIN_S`〜`RESPAWN_DELAY_MAX_S`(4〜10s)の乱数遅延でロールした `deadDurationSteps`)にし、`world.drainWater()` で fill01 を 0 に戻す。これにより既存の Dead→RespawnDue→rollSlot 再湧き機構(新規アニメ機構の追加なし)にそのまま乗り、個々の球が既存の grow アニメごと時間差で自然に湧いてくる。headless 検証(seed=7・96 球)で `bubblesActive` が t=0 に 1 から始まり 10 秒以内に 96 全個へ到達することを確認。ゴールデン再記録(init の RNG 消費順が変わるため — 変更管理手順に基づく正当な再記録、テストコメント参照)。**今回見送った拡張案**(ユーザーが「まずはこれを試して、必要なら次を考える」と保留): 初期スタッガー幅を短いバースト窓(0〜3s 等)に絞る新定数の追加、Spawning のスケール/不透明度イーズインの新規実装(既に glass.ts にあるため不要と判明済み) |
| A66 | **初期湧きのバースト窓を0〜3秒に短縮**(2026-07-12 ユーザー報告) | ユーザー | A65 で段階湧きは実現したが、その `deadDurationSteps` ロールに通常プレイ中の再湧き用定数 `RESPAWN_DELAY_MIN_S`/`RESPAWN_DELAY_MAX_S`(4〜10s)をそのまま流用していたため、最初の画面が最大10秒近く実球1個だけの寂しい状態になりうる、とユーザーから「最初にひとつだけだと寂しい」との報告。A65 で保留していた拡張案(短いバースト窓への短縮)を実施。**対処**: `config.ts` に初期化専用の新定数 `INITIAL_SPAWN_STAGGER_MIN_S=0`/`INITIAL_SPAWN_STAGGER_MAX_S=3` を追加(通常再湧きの `RESPAWN_DELAY_MIN_S`/`MAX_S` とは明確に別物とコメントで明示、既存定数は無変更)。`MizuNiNaruSim.init()` の段階湧きループで `deadDurationSteps` のロール元をこの新定数に差し替え(通常プレイ中の Splashing→Dead→再湧き経路〈`BubbleFsm.ts`〉は無改修)。初期可視スロット(index 0)の扱いは不変。`rng.next()` の呼び出し回数・順序は不変だがロール結果の数値範囲が変わるため以降の RNG 消費がカスケードし、ゴールデン再記録(テストコメントの再記録(14)参照)。headless 検証(seed=7・96 球)で `bubblesActive` が t=0 に 1、t=2.5s に 82、**t=3.0s で 96 全個(100%)に到達**することを確認 |
| A67 | **初期可視スロット(index 0)の座標固定を修正**(2026-07-12 ユーザー報告) | ユーザー | ユーザーから「最初の1個の描画位置は固定なのか?」との質問。調査で根本原因を特定: `SlotRing.rollInto()` は分離チェック用にまず「ジッターなしのフォールバック基準位置」のスコアを `minMargin(...)` で計算し、0 以上(重なりなし)ならジッター抽選ループに一切入らず確定する早期最適化を持つ。`MizuNiNaruSim.init()` は全スロットを index 昇順に `rollSlot(i, true)` するため、index 0 は世界が完全に空の状態でロールされ、渡される `others` が全 null になる(`minMargin` は others が空/全 null なら常に +Infinity を返す仕様)。結果、フォールバック候補のスコアが必ず `+Infinity ≥ 0` となって即座に `solved=true` になり、`theta0=0`(内リング先頭)の無ジッターな基準位置 `(ringRadius, FALLBACK_Y_INNER, 0)` がそのまま採用されていた ── INITIAL_VISIBLE_SLOT(index 0)の baseX/baseZ が seed によらず常に同一(r と bob 位相のみ乱数で変化)。再湧き時(`initial=false`)は others に必ず他スロットの実配置が入るため無関係、`SlotField.ts`(外側フィールド)にも index 0 は来ないため無関係と確認済み。**対処**(スコープを最小化): `SlotRing.rollInto()` に「others が完全に空(全 null)」の分岐を追加し、この場合に限り無ジッターのフォールバック候補を採用せず、既存のジッター式(角±ANGLE_JITTER・半径±RADIAL_JITTER・y∈[RING_Y_MIN,RING_Y_MAX])を1回だけ適用した候補をそのまま採用する(他球が存在しないため分離チェック自体が不要)。others が空でない通常時の分岐・RNG 消費順・早期終了最適化は完全に不変。headless 検証(seed=7/42/123・slotCount=12・1 step 進行)で index 0 の `slot.placement.baseX/baseY/baseZ` が seed ごとに異なることを数値で確認(例: seed=7 → baseX=3.733/baseZ=-0.196、seed=42 → baseX=3.676/baseZ=-0.023、seed=123 → baseX=3.495/baseZ=-0.135)。others が空の index 0 のみ `rng.next()` を追加で3回消費するため init() 以降の全 RNG 消費がカスケードし、ゴールデン再記録(テストコメントの再記録(15)参照。副次的に 96 球スモークの absorbedTotal が 300 step 時点で偶然 0 になり「空虚テスト防止」assertion に抵触したため、steps を 300→400 に調整 — スモーク対象の構成自体は無変更) |
| A68 | **初期段階湧きを desktop 限定にし、mobile は従来の一斉出現に戻す**(2026-07-12 ユーザー報告) | ユーザー | A65〜A66 で導入した「初期化時の実球を1個から段階的に湧かせる」演出について、ユーザーから「スマホの場合は今まで通り(=段階湧き演出を適用せず、全実球が t=0 で一斉に Spawning する元の挙動)にしたい。desktop は現状の段階湧きのままでよい」との要望。**対処**: `MizuNiNaruSim.init()` で `pacing`(`slotCount <= SLOT_COUNT_MOBILE` なら `'mobile'`、それ以外は `'desktop'`。既存判定を流用、新規判定は追加せず)を判定済みの箇所を活用し、A65〜A66 の段階湧きループ(index 0 以外の全スロットを `enterDead` + `deadDurationSteps` ロールで Dead に上書きするループ)全体を `pacing === 'desktop'` の条件でガード。mobile はこのループをまるごとスキップするため、全スロットが直前の `rollSlot(i, true)` で設定した Spawning のまま(= A65 導入前の挙動、全実球が t=0 で一斉出現)に戻る。desktop 分岐の中身は無改修(A65/A66 の演出・定数 `INITIAL_SPAWN_STAGGER_MIN_S`/`MAX_S` はそのまま存続)。**A67(`SlotRing.rollInto` の index 0 座標多様性修正)は演出とは独立した一般修正のため mobile/desktop 問わず無条件に有効なまま**(others が空の状態で最初にロールされるのは mobile でも index 0 のままのため影響を受けない)。mobile はこの分岐変更により init() の RNG 消費順が A65 導入前の状態に戻るため、ゴールデン主系列(slotCount=12・mobile 扱い)を再記録(テストコメントの再記録(16)参照)。96 球スモーク(desktop 扱い)はこの変更で分岐が desktop 側を通るため数値上不変(実測でビット単位一致を確認)。headless 検証(seed=7)で t=0 の `bubblesActive` が mobile(slotCount=24)で 24/24(一斉出現)、mobile 相当の slotCount=12 でも 12/12、desktop(slotCount=96)で従来どおり 1/96(段階湧き維持)であることを確認 |
| A69 | **BackdropBubbles のインスタンスバッファを desktop 決め打ちから max(desktop,mobile) 確保に修正**(2026-07-12 ユーザー報告) | ユーザー | ユーザーから「BACKDROP_COUNT_MOBILE を変えても最大値決まっていない?そんなに変わらない気がする」との報告。調査で原因を特定: `BackdropBubbles.ts` は per-instance 属性 `aIdx` バッファおよび初期 `uCount` uniform を `BACKDROP_COUNT_DESKTOP` の値決め打ちで確保しており、「desktop の値は常に mobile 以上」という暗黙の前提に依存していた。ユーザーが動作確認のため `BACKDROP_COUNT_DESKTOP` をローカルで一時的に `BACKDROP_COUNT_MOBILE`(100)より小さい値に変更していたため前提が崩れ、`update()` が mobile 判定時に設定する `instanceCount` がバッファ容量を超えてしまい、`BACKDROP_COUNT_MOBILE` を変更しても実際にはバッファ側で頭打ちになって反映されない状態になっていた。**対処**: `BACKDROP_COUNT_DESKTOP`/`BACKDROP_COUNT_MOBILE` の定義直後に `BACKDROP_COUNT_BUFFER = Math.max(BACKDROP_COUNT_DESKTOP, BACKDROP_COUNT_MOBILE)` を新設し、`aIdx` の確保サイズ・初期化ループの上限・初期 `uCount` 値をすべてこの max 値に切り替え(`update()` 側の mobile/desktop 判定ロジック自体は無改修 — 正しかったのはロジックでなくバッファ確保側)。クラス doc コメントも「固定バッファ desktop 個ぶん」から「両者の大きい方(`BACKDROP_COUNT_BUFFER`)ぶん」に更新。render 専用ファイルのため sim/RNG/ゴールデンには一切影響なし |
| A70 | **pacing 判定の推測ロジックを isMobile 明示指定に変更(desktop/mobile のスロット数を揃える変更は別タスクへ分離)**(2026-07-12 ユーザー要望) | ユーザー | ユーザーから「`SLOT_COUNT_DESKTOP`/`BACKDROP_COUNT_DESKTOP`/`BACKDROP_COUNT_MOBILE` を desktop/mobile 同値に揃えたい」との要望があり調査したところ、`MizuNiNaruSim.init()`(`src/sim/MizuNiNaruSim.ts`)が `pacing`(`'desktop' | 'mobile'`)を `options.pacing ?? (this.slotCount <= SLOT_COUNT_MOBILE ? 'mobile' : 'desktop')` という「`SLOT_COUNT_DESKTOP` は必ず `SLOT_COUNT_MOBILE` より大きい」という暗黙の前提に依存した推測ロジックで決めていることが判明。将来 desktop/mobile のスロット数を同値(あるいは desktop ≤ mobile)に揃える変更が入ると、実機の PC(`src/app/main.ts` の `isMobile = window.innerWidth < 768` が false)でアクセスしても `pacing` が常に `'mobile'` に誤判定され、スポーン間隔・近リング数が mobile 用の値になるほか、A65〜A68 で実装した「PC限定の1個からの段階湧き」演出(`pacing === 'desktop'` 分岐)が PC でも丸ごと無効化される脆弱性を発見した。真の原因は、`main.ts` が実際には既に正しい viewport 幅ベースの `isMobile` 判定(裁定 A16)を持っているにもかかわらず、`sim.init({ seed, slotCount })` 呼び出し時にこの `isMobile` を渡さず、契約(`SimInitOptions.pacing?`、`src/contract/RenderView.ts` — 省略時 slotCount から導出、と既にコメントされている正式なオプション)を使わずに `slotCount` の数値だけから pacing を「再推測」させていたこと。**今回のスコープ**(ユーザー指示により、数値変更〈`SLOT_COUNT_DESKTOP=24`・`BACKDROP_COUNT_DESKTOP`/`MOBILE=76` への統一〉は別タスクに切り出し、今回は推測ロジックの根本修正のみを実施): (1) `src/app/main.ts` の `sim.init(...)` 呼び出しに、既に計算済みの `isMobile` から `pacing: isMobile ? 'mobile' : 'desktop'` を明示的に渡すよう変更(`MizuNiNaruSim.init()` 側のフォールバック推測ロジック自体は、pacing を明示指定しない他の呼び出し元〈テストの主系列など〉のために削除せず残す)。(2) `tests/sim/mizuNiNaruSim.golden.test.ts` の 96 球スモーク(`runGolden(SLOT_COUNT_DESKTOP, 400)`)にも `pacing: 'desktop'` を明示指定するオプションを `runGolden` に追加して渡すよう変更(desktop/mobile のスロット数を将来揃える変更が入っても desktop pacing 経路のテストカバレッジが失われないための予防線)。現時点では `SLOT_COUNT_DESKTOP=96 > SLOT_COUNT_MOBILE=24` のため明示指定してもフォールバック推測と同じ `'desktop'` に解決され、ゴールデンチェックサムはビット単位で不変(実測で再記録不要と確認済み)。(3) `scripts/calibrate.mts` の `run()` にも同様に `pacing` を明示指定するパラメータを追加し、`desktop`/`mobile` プリセットそれぞれの `pacing` を渡すよう修正(CI 対象外の手動校正ツールだが同じ脆弱性を持っていたため合わせて対応)。**今回見送った項目**(ユーザー指示によりスコープ外): `SLOT_COUNT_DESKTOP` を 96→24 に、`BACKDROP_COUNT_DESKTOP`/`BACKDROP_COUNT_MOBILE` を 250/100→76/76 に変更する数値統一そのもの、およびそれに伴う `WorldSpec.ts`/`BackdropBubbles.ts` のコメント更新(いずれも別タスクで実施予定)。headless 検証(seed=7・slotCount=SLOT_COUNT_DESKTOP=96)で、pacing 省略時と `pacing: 'desktop'` 明示指定時のどちらも t=0 の `bubblesActive` が 1/96(段階湧き)で一致することを確認 — 現状値では挙動に差は出ないが、将来の数値統一時に main.ts 側の推測ロジック依存を断っておくための予防修正であることを実証した。`npm run test`/`lint`/`typecheck`/`depcruise`/`build` は全て通過(ゴールデン再記録なし) |
| A71 | **球数を desktop/mobile 統一(実球 24・書き割り 76)**(2026-07-12 ユーザー要望) | ユーザー | A70 でスコープ外として見送った数値統一を実施。**前提**: 直前の A70(コミット `b3ec45a`+`289fc12`)で `src/app/main.ts` の `sim.init()` が `pacing: isMobile ? 'mobile' : 'desktop'` を明示的に渡すよう修正済みであり、`SLOT_COUNT_DESKTOP`/`SLOT_COUNT_MOBILE` の大小関係に依存した pacing 推測ロジックの誤判定リスクが実アプリから解消されていたため、以前保留していた球数統一を安全に実施できる状態になっていた。**ユーザー要望**: `src/contract/WorldSpec.ts` の `SLOT_COUNT_DESKTOP` を 96→24 に変更(`SLOT_COUNT_MOBILE` は既に 24 のため変更不要)。`src/render/backdrop/BackdropBubbles.ts` の `BACKDROP_COUNT_DESKTOP` を 250→76、`BACKDROP_COUNT_MOBILE` を 100→76 に変更。**対処**: (1) 上記 2 定数を変更し、`SLOT_COUNT_DESKTOP===SLOT_COUNT_MOBILE`(24)・`BACKDROP_COUNT_DESKTOP===BACKDROP_COUNT_MOBILE`(76)に統一。`BackdropBubbles.update()` 内の「`view.bubbles.count <= SLOT_COUNT_MOBILE` で mobile/desktop を推定」する推測ロジック(A32/A40 §7.1 と同型)は残したが、両定数が同値になったため結果は常に 76 に解決され実害が無いことを確認(コメントに明記)。(2) `WorldSpec.ts` の `BUBBLE_CAPACITY=128` 等の容量系コメント(A35 決定時の「≥SLOT_COUNT_DESKTOP=96」表記)を、A35 時点由来の値であり現在の 24/24 に対しては十分な余裕がある旨に更新。`BackdropBubbles.ts` のクラス doc コメント(旧「desktop 250 / mobile 100」)を新値に更新。`src/sim/config.ts` の `NEAR_RING_COUNT_DESKTOP/MOBILE` doc コメント(旧「desktop 96 = 近12+フィールド84」)を、定数自体は不変(12/7)だが desktop の内訳が「近12+フィールド12」に変わった旨に更新。(3) `MizuNiNaruSim.ts` の `nearCount = min(nearTarget, slotCount) = min(12, 24) = 12` が意図通り機能し、desktop が「近リング12 + 外側フィールド12」の新しい内訳になることを確認(破綻なし)。**golden テスト**: `tests/sim/mizuNiNaruSim.golden.test.ts` の `EXPECTED_SMOKE_96`(`runGolden(SLOT_COUNT_DESKTOP, 400, 'desktop')`)は `SLOT_COUNT_DESKTOP` を直接参照しているため自動的に 24 球で走るようになり、RNG 消費・トラジェクトリが全面的に変わったためチェックサムを再記録(再記録(17))。実体が 96 球でなくなったため定数名を `EXPECTED_SMOKE_96` → `EXPECTED_SMOKE_DESKTOP` に改称し、参照箇所・テスト説明文字列も追随して更新。主系列(12 球・mobile pacing)は `SLOT_COUNT_DESKTOP` を参照しないため無変更で、実行してビット単位一致を確認。`tests/contract/worldSpec.test.ts` の `expect(SLOT_COUNT_DESKTOP).toBe(96)` も `toBe(24)` に更新。**検証**: `npm run test`(28 ファイル・224 件全通過)/`lint`/`typecheck`/`depcruise`/`build` を `mise exec --` 経由で全通過。headless で `slotCount=SLOT_COUNT_DESKTOP`(=24)・`pacing:'desktop'` を明示指定して init し、`bubblesActive` が t=0 で 1、以降段階的に増えて t≈2.95s(A66 の 0〜3s 窓内)で 24 全球に到達することを実測で確認(A65〜A68 の段階湧きが 24 球構成でも正しく機能) |
| A72 | **Spawning の grow アニメを smoothstep 化しオーバーシュートと不連続ジャンプを解消**(2026-07-13 ユーザー報告) | ユーザー | ユーザーから「球体が出現するときはもっと自然でいい。最後にぐっと膨らむ感じとかいらない」との報告。調査で原因を特定: `src/render/shaders/glass.ts`(頂点シェーダ `main()` 内)と `src/render/shaders/innerWater.ts`(`BUBBLE_STATE_TRANSFORM_GLSL` の `bubbleTransform()` 内)の**両方に独立して(import 共有ではなく完全に別個の GLSL 文字列定数として)**同一の Spawning 用 grow 式 `float grow = (state == 0.0) ? 0.6 + 0.5 * prog - 0.1 * sin(prog * 9.0) : 1.0;` が重複定義されていた(`prog` は Spawning 進行度 0→1、持続時間は `src/sim/config.ts` の `SPAWNING_DURATION_S=2.0`)。この式を prog=0→1 で評価すると単調増加でなく、prog≈0.1 で一旦 0.57 まで沈み、prog≈0.6 で 0.977 まで戻った後 prog≈0.8 で再び 0.92 まで沈み、prog→1 の終盤で 1.0 を 5.8% 超える 1.058 までオーバーシュートしてから収束する非単調な波形になっており、これが「最後にぐっと膨らむ」の直接原因だった。さらに Spawning→Drifting 状態遷移の瞬間に grow 値が 1.058→1.0(Drifting 以降は常に固定 1.0)へ不連続にジャンプする問題も併発していた。**対処**: 両ファイルの grow 式を、`float growEase = prog * prog * (3.0 - 2.0 * prog); float grow = (state == 0.0) ? 0.6 + 0.4 * growEase : 1.0;` という smoothstep 型の式に置き換え(始点 0.6 は既存踏襲)。`growEase` は prog∈[0,1] で単調増加(導関数 `6*prog*(1-prog) ≥ 0`)かつ growEase(0)=0・growEase(1)=1 のため、grow は prog=0 で 0.6、prog=1 で厳密に 1.0 になり、非 Spawning 状態の固定値 1.0 と連続的に接続する(オーバーシュート・沈み込みなし、加速→減速の自然なイーズインアウト)。glass.ts と innerWater.ts の重複定義であることを確認済みのため両方を同一の式に修正し、ガラス殻と内部の水が食い違って出現するリスクを排除。A52(球体はティア間でも妥協なく球に見える)や Straining/Falling/Splashing 等の他 state の変形ロジックには一切触れておらず、変更範囲は Spawning の grow 式のみ。**検証**: このシェーダー文字列変更はレンダー層のみで sim/RNG には一切関与しないため、`npm run test`(vitest、28 ファイル・224 件全通過)を実行しゴールデンテストへの影響がないことを確認(再記録不要、実測でビット単位一致)。`npm run lint`(biome check、95 ファイル、警告なし)・`npm run typecheck`(tsc、tsconfig.json / tsconfig.sim.json 両方)・`npm run build`(vite build 成功)を `mise exec --` 経由ですべて通過 |
| A73 | **自動カメラのズームイン/アウトをはっきり体感できる強さに拡大**(2026-07-13 ユーザー要望) | ユーザー | ユーザーから「いま視点が自動で動くだけだと思うが、ズームイン/アウトも自動で行ってくれてもいい」との要望。調査で `src/render/CameraRig.ts` の `update()` に既存の自動ドリフト軌道(リサージュ的、非整数比周期)の一部として `radius = (13.2 + 1.0 * Math.sin((TWO_PI * t) / 97)) * (1 - 0.42 * pb)` という距離(ズーム相当)の自動振動が**既に実装済み**であることが判明したが、基準値 13.2 に対し振幅 1.0(≈7.6%)しかなく体感できないレベルだった。**対処**(案A: 既存 sin 項の振幅調整のみ、新規状態変数・新規ロジックは追加せず): 振幅を `1.0`→`2.5`(≈基準値の18.9%)に拡大。周期 97s・基準値 13.2 は変更なし。**検算**: `radius` は target 基準の実効距離 `baseDist = hypot(dirX,dirY,dirZ)`(水平成分は radius にほぼ一致、垂直成分に height/target.y の振動を含む)としてクランプ前に評価される。横画面(pb=0)で `baseDist` は約10.7〜15.9 u、縦画面最悪ケース(pb=1、`portraitBlend` により基準距離・高さとも縮小)でも約6.2〜9.3 u と算出し、いずれも `DIST_MIN=9.0`(縦画面は `distMin = DIST_MIN*(1-0.42*pb)` でスケールされ pb=1 時 5.22)〜`DIST_MAX=28` の範囲内に収まり、自動軌道単体ではクランプが発動しないことを確認。手動ズーム(ホイール/ピンチの `offLogDist`)は `baseDist` に対して独立に `Math.exp(offLogDist)` を乗算後に同じ `[distMin, DIST_MAX]` へクランプされ、クランプ後に `offLogDist` を巻き戻す既存ロジック(199〜212行目)のため振幅拡大の影響を受けず従来どおり安全に頭打ちされる。`prefers-reduced-motion` 時は `t` が `REDUCED_MOTION_FREEZE_T=12` に凍結されるため `radius` は定数化され、振幅を変えても自動ズームを含む全自動軌道が引き続き静止することをコード上で確認。**変更範囲**: `src/render/CameraRig.ts` の該当 sin 項の定数 `1.0`→`2.5` の1箇所のみ(他のカメラロジック・オービット軌道・状態変数は無改修)。sim 層(RNG/ゴールデン)に無関係のため再記録不要と確認。**検証**: `npm run test`(28 ファイル・224 件全通過)/`lint`/`typecheck`/`build` を `mise exec --` 経由で全通過 |
| A74 | **球体内の着水・跳ね波紋が発生しないことがある不具合を修正(RIPPLE_NEAR_COUNT を SLOT_COUNT から導出)**(2026-07-13 ユーザー報告) | ユーザー | ユーザーから「球体内で水が着水するときやHが跳ねるときの波紋が発生していないときがある」との報告。調査で原因を特定: `src/render/shaders/innerWater.ts` の `RIPPLE_NEAR_COUNT`(InnerRipple uniform を張る球数)が、裁定 A32(当時 96/24 球構成)で「カメラ近傍 12 球のみ波紋描画対象にする」負荷対策として導入されて以来ずっと `12` の決め打ちのままで、`src/contract/WorldSpec.ts` の `SLOT_COUNT_DESKTOP`/`SLOT_COUNT_MOBILE` とは完全に独立した値だった。`BubbleInstanceBuffers.sync()` はカメラ距離で全球を遠→近ソートし、末尾(最近傍)から `RIPPLE_NEAR_COUNT` 個だけに `rippleIndexBySlot` を割り当て、それ以外は `vSlot=-1` として `innerWater.ts`/`innerCap.ts` フラグメントシェーダの波紋ループ自体をスキップする(微波のみ)実装になっている。裁定 A71 で球数が 24/24 に統一された後もこの `12` は追随修正されなかったため、常に球の半数(12/24)が波紋描画対象外のまま固定され、かつカメラが自動ドリフト(A73 等)でどの球が「近傍12球」に入るかが時々刻々変わるため、ユーザーには「同じように着水・跳ねが起きても波紋が出るときと出ないときがある」ランダムな不具合として見えていた。過去の類似バグ(裁定 A69 — `BackdropBubbles.ts` の `aIdx` バッファが `BACKDROP_COUNT_DESKTOP` 決め打ちで確保されており `BACKDROP_COUNT_MOBILE` を変えても反映されなかった問題)と同型の「決め打ち値が参照元の定数改定に追随していなかった」バグ。**対処**: A69 の `BACKDROP_COUNT_BUFFER = Math.max(BACKDROP_COUNT_DESKTOP, BACKDROP_COUNT_MOBILE)` パターンを踏襲し、`innerWater.ts` に `SLOT_COUNT_DESKTOP`/`SLOT_COUNT_MOBILE`(`../../contract/WorldSpec`)を import した上で `RIPPLE_NEAR_COUNT = Math.max(SLOT_COUNT_DESKTOP, SLOT_COUNT_MOBILE)` に変更(render 層から contract 層への import は master-plan §6 アーキテクチャ図で許可済み、`BubbleInstanceBuffers.ts` が既に `BUBBLE_CAPACITY` を同じ経路で import している前例あり)。現在は両者とも 24 のため `RIPPLE_NEAR_COUNT` は 12→24 になり、全球が波紋描画対象になる。将来 desktop/mobile のスロット数が再び分かれても決め打ちに戻らないよう max 導出のまま維持する設計。`grep -rn RIPPLE_NEAR_COUNT src/` で全参照箇所(`innerWater.ts` 定義元、`innerCap.ts` の re-export、`BubbleInstanceBuffers.ts` の `sync()` 内 `rippleStart` 算出、`InnerWaterSystem.ts` の `rippleCursor`/`rippleUniform` 配列確保)を洗い出し、いずれも定数参照でハードコードなし=連動して自動的に追随することを確認。uniform 配列サイズ `uInnerRipples[RIPPLE_NEAR_COUNT * RIPPLES_PER_BUBBLE]`(innerWater.ts/innerCap.ts 双方)もテンプレートリテラルで定数を参照しているため自動追随。ドキュメントコメントは A32 時代の「カメラ近傍12球のみ」という決め打ち説明から、A71 の球数統一を踏まえた現状の説明(SLOT_COUNT から導出、現在24)に更新(`innerWater.ts`/`innerCap.ts`/`InnerWaterSystem.ts` 内の「12球」と書かれていた箇所も `RIPPLE_NEAR_COUNT` 参照の表現に更新)。**制約順守**: 波紋の見た目・強度・減衰ロジックには一切触れず、定数の導出元を変えるのみ。**検証**: このファイルは render 層のみで sim/RNG に一切関与しないため golden 再記録は不要と判断し実測で確認 — `npm run test`(vitest)は sim 層タイムアウトによるものと思われる 4〜7 件の flaky 失敗があったが、変更前の `main`(`git stash` で退避して同一テストを実行)でも同一テストが同様にタイムアウトで失敗することを確認済みで、今回の変更に起因するものではないと判断(該当テストは全て `tests/sim/**` の sim 層テストで、変更対象の render 層コードとは無関係)。`npm run lint`(biome、フォーマット指摘を修正の上で通過)・`npm run typecheck`(tsconfig.json/tsconfig.sim.json 両方)・`npm run depcruise`(71 modules・210 dependencies・違反なし — render→contract の新規 import も許可済みと確認)・`npm run build`(vite build 成功)を `mise exec --` 経由ですべて通過 |
| A75 | **自動ズームを単一 sin の呼吸から2波合成のビートパターンに変更(A73 の追撃フィードバック)**(2026-07-13 ユーザー追撃要望) | ユーザー | A73(振幅 1.0→2.5 拡大)適用後もユーザーから「もっと動きをだしてもいいという意図でした」「大げさに言うと突然ズームするとかそういうイメージです」「それを自然な感じで」との追撃フィードバック。A73 は単一 sin 波の振幅を上げただけだったため、常時なだらかに伸び縮みするだけの単調な「呼吸」のままで、ユーザーが求めていた「通常はゆったり漂いつつ時々はっきり分かる`グッと寄る/離れる`起伏のある動き」(ただし急停止・急発進のような不自然なジャンプは避け、あくまで滑らかな軌道の範囲内)には届いていなかったことが根本原因と判明。**対処**: `src/render/CameraRig.ts` の `update()` 内 `radius` 式を、周期の異なる2波の合成に変更。before: `radius = (13.2 + 2.5 * Math.sin((TWO_PI * t) / 97)) * (1 - 0.42 * pb)`。after: `radius = (13.2 + 2.3 * Math.sin((TWO_PI * t) / 37) + 1.2 * Math.sin((TWO_PI * t) / 23 + 0.9)) * (1 - 0.42 * pb)`。周期 37s・23s は既存の azimuth(240s)/height(61s)/target.x,y,z(91s/53s/73s)/旧 radius(97s)のいずれとも非整数比かつ倍数関係にならない素数を選定(既存周期との共振・単純な周期一致を回避)。振幅合計は 2.3+1.2=3.5(基準距離 13.2 の ≈26.5%、指示の目安 25〜35% レンジ内)とし、A73 の単一振幅 2.5(≈18.9%)より大きくしつつクランプに張り付かない範囲に収めた。2波の位相差(0.9 rad)により、山と山が強め合う瞬間は振幅がほぼ合計値(3.5)近くまで達し「グッと寄る/離れる」明瞭な起伏になり、打ち消し合う瞬間は振幅が小さくなり穏やかな呼吸に戻る非周期的に見えるビートパターンになる(式自体は滑らかな sin の和で不連続点を含まないため急停止・急発進は発生しない)。**検算**(Node 一時スクリプトで `baseDist = hypot(dirX,dirY,dirZ)` を dt=0.02s 刻み・horizon=10000s でサンプリングして実施、既存の azimuth/height/target 式は不変のためそのまま流用): 横画面(pb=0)で `baseDist` は [9.213, 17.285] u に収まり、`DIST_MIN=9.0`〜`DIST_MAX=28` の範囲内でクランプは一度も発動せず(timeBelow=0.000%)。縦画面最悪ケース(pb=1、`distMin = DIST_MIN*(1-0.42*pb) = 5.220`)では `baseDist` が [5.165, 10.322] u となり、ごく僅かに `distMin` を下回る瞬間があるが(timeBelow=0.062%、最大深度 0.0555u ≈ 振幅合計の1.6%)、これは「張り付き」ではなく極端な pb=1 条件下での一瞬の接触に過ぎないことを確認。手動ズーム(`offLogDist` 由来の `Math.exp(offLogDist)` 乗算)は `radius` 式変更後も 208〜212 行目のクランプ+巻き戻しロジックに一切手を加えていないため、`radius` がどう変化しても同じ安全域に頭打ちされる構造は不変(コード上で確認、ロジック自体は無改修)。**大きな寄りの発生頻度**: 振幅合計の 85% 以上(≈16.18 以上、または ≈10.22 以下)に達する「明瞭な寄り/離れ」イベントを horizon=10000s でカウントしたところ 128〜130 回発生し、平均間隔 ≈77〜78 秒(指示の目安「数十秒〜1分程度に1回」に近いレンジ)で、かつ発生タイミングは 45.1s, 116.4s, 229.4s, 301.2s, 344.6s... のように等間隔ではなく不規則に見える分布になっていることを確認(2周期 37s/23s の非整数比により真の周期は LCM(37,23)=851s だが、その間隔ははるかに長く体感上は非反復に見える)。**変更範囲**: `src/render/CameraRig.ts` の `radius` 式のみ(`height`・`azimuth`・`target` 等の他カメラロジック・状態変数は一切無改修)。sim 層(RNG/ゴールデン)に無関係のため再記録不要と確認。**検証**: `npm run test`(vitest、28 ファイル・224 件全通過)・`npm run lint`(biome check、95 ファイル、警告なし)・`npm run typecheck`(tsconfig.json/tsconfig.sim.json 両方)・`npm run build`(vite build 成功)を `mise exec --` 経由ですべて通過 |

## §5 確定契約サマリ(Phase 0 で凍結するもの)

```ts
// contract/WorldSpec.ts — 裁定 A3/A5 反映(全文は design-sim §1.1 ベース + 本表)
SEA_LEVEL = 0                         // y-up 右手系、海面 y=0、単位 u
STEP_HZ = 60; DT = 1/60; MAX_STEPS_PER_FRAME = 3
KIND_INDEX = { H: 0, O: 1, H2: 2 }
BUBBLE_STATE = { Spawning:0, Drifting:1, Straining:2, Falling:3, Splashing:4, Dead:5 }
SLOT_COUNT_DESKTOP = 7; SLOT_COUNT_MOBILE = 5
BUBBLE_CAPACITY = 8
ATOM_VIEW_CAPACITY = 256; DROPLET_VIEW_CAPACITY = 512
SPLASH_VIEW_CAPACITY = 8; RIPPLE_VIEW_CAPACITY = 64

// contract/RenderView.ts — design-sim §1.2 に対する裁定差分:
//   AtomView に aux: Float32Array を追加(stride 4: [spawnStep, seed, 0, 0] — A6)
// 他フィールドは design-sim §1.2 の全文どおり。
// 不変条件(コメント明記): prev/curr 同 index = 同エンティティ、スポーン時 prev=curr、
//   BubbleView.count は常に SLOT_COUNT、原子・雫は常に球内水面より上(A25)、
//   statePacked の prev は lerp 禁止、fill01 の分母は V_inner(A12)
SimLike { init(SimInitOptions), step(), view(): SkyRenderView, counts(): SimCounts }
SkyRenderer { render(view, alpha), resize(), dispose() }
```

**URL パラメータ(app 層)**: `seed`(RNG シード) / `m=1`(overlay+tier0+視差off+カメラt=0) / `q=0..4`(ティア固定) / `dpr`(DPR 上限) / `sim=stub`(StubSim 差し替え) / `slots`(スロット数上書き、デバッグ用)。

## §6 アーキテクチャ概要

```
src/
  contract/   WorldSpec.ts RenderView.ts            依存ゼロ(凍結契約)
  sim/        config core/ bubble/ chem/ reactions/ physics/ droplets/ water/ view/
              MizuNiNaruSim.ts StubSim.ts           純ロジック・DOM/three 禁止(≈2,190 LOC)
  render/     SceneRenderer CameraRig Environment NoiseTexture AdaptiveQuality PostPipeline
              ocean/(OceanSystem OceanGeometry RippleField SplatScheduler)
              bubbles/(BubbleGlassSystem InnerWaterSystem)
              atoms/(AtomSystem LabelAtlas LabelSystem DropletSystem)
              particles/(SpraySystem) shaders/(14 本)  three はここだけ(≈4,350 LOC)
  app/        main.ts accumulator.ts urlParams.ts StatsOverlay.ts   合成ルート(≈330 LOC)
```

- 強制: dependency-cruiser(contract 依存ゼロ / sim ↛ render・app・npm / render ↛ sim / no-circular)+ 2 tsconfig(`tsconfig.sim.json` は lib:["ES2022"] で DOM 排除)
- ループ: rAF → accumulator(≤3 step)→ `sim.step()`×n → `renderer.render(sim.view(), alpha)`。120Hz 端末でも世界速度不変(threejs の既知問題への回答)
- 主ループのパスグラフ・draw call 予算(12/18)は design-render §1.3、CPU 予算(≈0.06ms/step)は design-sim §8

**ツールチェーン**(Mizu シリーズ踏襲): Vite 8 / TypeScript 6 strict / three ^0.185(唯一のランタイム依存)/ Biome / Vitest 4(sim=node 環境既定)/ dependency-cruiser / mise(Node 22)/ GitHub Actions(CI: lint→depcruise→typecheck×2→test→build、deploy: Pages・`GITHUB_PAGES` 環境変数で base 切替)。

## §7 実装フェーズと受入ゲート

体制: 各フェーズを**実装サブエージェント**に委任(design 文書の該当 § を仕様として渡す)。オーケストレーターは着手指示・中間レビュー・受入ゲート検証のみ。**ゲートを通らない限り次フェーズに進まない**。

### Phase 0 — 骨格と契約凍結(scaffold)
- 内容: `git init`、package.json / mise / Biome / Vitest / depcruise / 2 tsconfig / CI・Pages workflow、`index.html`(タイトル「水になる」)、**contract 2 ファイル実装(§5 の確定形)**、StubSim(球 FSM と雫の合成アニメを本物の view 型で放出)、app 骨格(accumulator + urlParams)、空シーン(スカイ + 自動カメラのみ)
- 受入ゲート: `npm run lint / typecheck / test / build` 全通過、depcruise ルールが**違反をエラーにすることの実証**(わざと違反を书いて落ちるのを確認して戻す)、dev サーバで朝空とカメラドリフトが映る、accumulator 純関数テスト(60/120Hz・スパイク)通過。**以降 contract は凍結**(変更は本書の裁定追記が必要)
- 並列性: 完了後、Phase 1 と 2 は**並列で着手可**(render は StubSim で先行)

### Phase 1 — シミュレーション完成(design-sim 全編)
- 内容: M2 chem/physics(オラクルテスト付き)→ M3 droplets/water(CapLut)→ M4 bubble FSM + 集約パッカー + ゴールデン → M5 校正スクリプト
- 受入ゲート: テスト ≈120 本全通過(ゴールデン 2 回実行同一 / 球面境界 / 質量台帳 / 水位単調 / LUT 誤差帯 / FSM 遷移 / grid vs BruteForce / 補間契約)、**校正受入帯: T_fill ∈ [90,150]s・落下間隔 ∈ [15,25]s(desktop 7 球・seed 掃引)**。外れたらノブ優先順位(SPAWN_INTERVAL → VOLUME_GAIN → P_DISSOLVE)で再校正
- オーケストレーター検証: テスト実行 + 校正 CSV の分布確認 + `?sim=stub` ↔ 実 sim の view 互換確認

### Phase 2 — レンダリング中核(世界が一周する)
- 内容: BubbleGlass(2 パス+状態変形+メニスカス)、InnerWater(体積+キャップ)、Atom/Label/Droplet(prev/curr lerp、aux.seed パルス)、Ocean v2 の (a)(c)(f)(Gerstner+シェーディング+放射グリッド — リップル/フォーム/反射はまだ)、Environment(sky チャンク)、CameraRig、PostPipeline
- 受入ゲート: 実 sim 接続で**フルサイクル**(誕生→充填→張り→落下→着水消滅→再誕生)が視認できる、desktop tier0 60fps(`?m=1` 実測)、**120Hz 相当検証**(alpha 補間でワープ・スジが無いこと — 補間契約の実機確認)、固定 seed + カメラ t=0 のスクリーンショットセットをオーケストレーターが目視レビュー(アートステートメント整合)
- 備考: StubSim 駆動で Phase 1 完了前に着手可(M1 戦略)

### Phase 3 — Ocean v2 完成(最重要要件の山場)
- 内容: RippleField(RGBA16F ピンポン+フォームチャネル)、SplatScheduler(多段着水)、フォーム 2 系統、擬似 SSS + glitter、**解析的球面反射**、SpraySystem(クラウン+膜片)、球ポップ演出、InnerRipple 波紋
- 受入ゲート: ①60fps 維持(tier0 desktop、`?m=1`)②固定シード・複数カメラ角のスクリーンショットセットで **Mizu-threejs の水面とサイドバイサイド比較 — 明確に上回ること**(凪の質感 / 着水の読みやすさ / フォームの繊細さ / 球の映り込み)③長時間安定(30 分連続で発散・ドリフト・フリッカ無し)。**最終判定はユーザーのレビュー**(スクリーンショット+デモ URL 提出)
- リスク対応: design-render §11 の Plan-B ラダー(反射 3 球制限 / glitter 統合 / 導関数削減、リップル法線化 / 凪の窓)

### Phase 4 — 品質適応・モバイル・公開
- 内容: AdaptiveQuality(7 ノブ × 5 ティア + EMA ヒステリシス)、モバイル(slotCount=5、初期 tier2、縦画面フレーミング校正 — A21、タッチは視差なしドリフトのみ)、`prefers-reduced-motion`、StatsOverlay(SimCounts 準拠の新契約)、README(日本語・Mizu シリーズ様式: デモ GIF / URL パラメータ表 / 開発手順)、GitHub Pages デプロイ
- 受入ゲート: Playwright モバイルエミュレーション(390×844)+ CPU スロットリングで tier3 60fps 近傍、ティア遷移がヒッチなし(material 2 変種の事前コンパイル確認)、reduced-motion でカメラ停止・世界継続、CI 緑、Pages で公開 URL が動作。実機(ユーザーの iPhone/Android)確認は任意でユーザーに依頼

### 横断規律(全フェーズ)
- 定常状態での new 禁止(GC スパイク予防 — コードレビュー規約)、シェーダは `precision highp float`、ESM import 束縛の hot path 剥がし(threejs で 10 倍差の実測がある)
- コミット単位はフェーズ内マイルストーン毎。各ゲートで `npm run lint && npm run typecheck && npm run test && npm run build` を全通過させてから次へ

## §8 検証方法(オーケストレーターの受入プロトコル)

1. **自動**: lint / depcruise / typecheck×2 / test / build(CI と同一)。ゴールデン・校正帯・補間契約が最重要トリップワイヤ
2. **視覚**: dev サーバ起動 → Playwright / Chrome DevTools MCP で `?seed=7&m=1`(決定論構図)のスクリーンショット取得 → アートステートメント(design-render §0)と照合。Phase 3 は Mizu-threejs デモとのサイドバイサイド
3. **性能**: `?m=1` オーバーレイの FPS/Frame/Update 読取り + DevTools パフォーマンストレース(GPU 時間の内訳が §9 予算表と乖離していないか)
4. **決定論**: 同一 seed 2 回起動のスクリーンショット一致(ピクセル比較はカメラ t=0 + tier 固定で可能)
5. **ユーザーレビュー**: Phase 2 / 3 / 4 の各ゲート後にスクリーンショット・デモ手順を提出し GO を得る(特に Phase 3 の海はユーザーが最終判定者)

## §9 リスク統合 Top5 + Plan-B

| # | リスク | 一次対策 | Plan-B |
|--:|---|---|---|
| 1 | **ペーシング見積外れ**(運動論 ±50% — 製品はリズムそのもの) | ノブ 3 つに絞った校正スクリプト + 受入帯(design-sim §7.5/§10-1) | 決定的閉ループスポナー(fill 進行が目標カーブ±20% 外で間隔を毎 10s ±10% 補正 — 決定論と両立) |
| 2 | **Ocean v2 フラグメント過重**(~380 ALU) | ティアラダーが正確に海を削る(design-render §9.3) | 反射 3 球制限 → glitter 統合 → 導関数 3 波化(§11-1) |
| 3 | **prev/curr 補間契約の綻び**(120Hz でワープ) | 契約テスト + StubSim で M1 から実機検証(design-sim §10-2) | renderer に snap モード(alpha=1)で視覚劣化に逃がして修正 |
| 4 | **Gerstner × リップル合成破綻** | 勾配線形加算 + アクション域スウェル減衰 + 変位後サンプル(design-render §2.2) | リップルを法線のみに → 「凪の窓」演出(§11-2) |
| 5 | **エージェント実装の契約逸脱**(オーケストレーション固有) | Phase 0 で contract 凍結 + depcruise/tsconfig の機械強制 + ゴールデンのトリップワイヤ + ゲート毎のオーケストレーターレビュー | 逸脱検出時は該当フェーズを契約基準で差し戻し(裁定変更が必要なら本書 §4 に追記してから) |

## §10 未決事項(実装中に確定)

- モバイル縦画面のカメラ構図パラメータ(A21 — Phase 4 校正)
- mobile ペーシングの最終値(A23 — 校正帯で判定)
- 球ポップの膜片の見た目の最終調整(虹彩片 vs 水滴片の配合 — Phase 3 でユーザーレビュー)

## §11 次のアクション

1. ユーザーの **GO**(本プラン + §3 の解釈 4 点の承認)
2. Phase 0 サブエージェント起動(本書 §5-§6 + design-sim §1 を仕様として委任)
3. 以降、各ゲートで検証 → 報告 → 次フェーズ
