import type { SimLike } from '../contract/RenderView';
import { SLOT_COUNT_DESKTOP, SLOT_COUNT_MOBILE } from '../contract/WorldSpec';
import { AdaptiveQuality } from '../render/AdaptiveQuality';
import type { QualityTier } from '../render/RenderSystem';
import { SceneRenderer } from '../render/SceneRenderer';
import { MizuNiNaruSim } from '../sim/MizuNiNaruSim';
import { StubSim } from '../sim/StubSim';
import { StatsOverlay } from './StatsOverlay';
import { accumulate } from './accumulator';
import { parseUrlParams } from './urlParams';

const params = parseUrlParams(window.location.search);

window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.querySelector<HTMLCanvasElement>('#myCanvas');
  if (!canvas) {
    throw new Error('Canvas element not found');
  }

  // seed 省略時は実行ごとにランダムな seed を 1 個引いて注入する
  // (sim コア内に Math.random() は存在しない — 決定論はこの 1 点に集約)
  const seed = params.seed ?? Math.floor(Math.random() * 0x100000000);

  // モバイル判定は app 層(viewport width < 768 — 裁定 A16)
  const isMobile = window.innerWidth < 768;
  const slotCount =
    params.slots ?? (isMobile ? SLOT_COUNT_MOBILE : SLOT_COUNT_DESKTOP);

  // 既定は実 sim(Phase 1)。`?sim=stub` で StubSim(render 開発用の合成アニメ)
  const sim: SimLike =
    params.sim === 'stub' ? new StubSim() : new MizuNiNaruSim();
  // pacing は SLOT_COUNT_DESKTOP/MOBILE の大小関係に依存した推測(sim 側の
  // フォールバック)に頼らず、app 層が既に持つ正しい isMobile から明示的に
  // 渡す(A70: 両定数が将来同値になっても推測ロジックが誤判定しないための
  // 予防的修正 — master-plan.md A70 参照)。
  sim.init({ seed, slotCount, pacing: isMobile ? 'mobile' : 'desktop' });

  // SceneRenderer を具象型で束縛(applyTier は SkyRenderer 契約外の拡張 API —
  // Phase 4 AdaptiveQuality 用。app 層は render 層に直接依存してよい)
  const renderer = new SceneRenderer(canvas, {
    maxPixelRatio: params.dpr,
    parallax: !params.measure,
    isMobile,
  });

  // 計測フック(E2E 検証・ベンチ用: SimCounts の読み出し。
  // StatsOverlay(Phase 4)が正式な表示契約 — これは読み取り専用の裏口)
  (window as unknown as { __mizuCounts?: unknown }).__mizuCounts = () =>
    sim.counts();

  // 品質ティア制御(裁定 A17/§9.3):
  // - `?m=1` は tier0 固定(視差無効・カメラ t=0 は SceneRenderer/CameraRig 側)
  // - `?q=0..4` はティア固定(AdaptiveQuality 自体を生成しない)
  // - それ以外は EMA ヒステリシス制御(モバイル初期 tier2 — 裁定 A16)
  let currentTier: QualityTier = 0;
  let adaptive: AdaptiveQuality | undefined;
  const setTier = (tier: QualityTier): void => {
    currentTier = tier;
    renderer.applyTier(tier);
  };
  if (params.measure) {
    setTier(0);
  } else if (params.q !== undefined) {
    setTier(params.q as QualityTier);
  } else {
    adaptive = new AdaptiveQuality(isMobile ? 2 : 0, setTier);
  }
  // テスト用の裏口(黒フレームプローブ等が手動でティア遷移を発火させる)。
  // 通常運用では AdaptiveQuality か固定ティアのみが呼ぶ
  (window as unknown as { __mizuApplyTier?: unknown }).__mizuApplyTier = (
    tier: QualityTier,
  ) => setTier(tier);
  (window as unknown as { __mizuTier?: unknown }).__mizuTier = () =>
    currentTier;

  const overlay = params.measure ? new StatsOverlay() : undefined;

  let remainder = 0;
  let lastTimestamp: number | undefined;
  let rafId = 0;

  const loop = (timestamp: DOMHighResTimeStamp): void => {
    // 復帰直後(lastTimestamp 無し)は 1 フレーム分として扱う
    const frameDtMs =
      lastTimestamp === undefined ? 1000 / 60 : timestamp - lastTimestamp;
    lastTimestamp = timestamp;

    adaptive?.update(frameDtMs);

    const updateStart = performance.now();
    const acc = accumulate(remainder, frameDtMs);
    remainder = acc.remainder;
    for (let i = 0; i < acc.steps; i++) {
      sim.step();
    }
    renderer.render(sim.view(), acc.alpha);
    const updateMs = performance.now() - updateStart;

    overlay?.update(frameDtMs, updateMs, sim.counts(), currentTier);

    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);

  // スクリーンセーバー礼節+電池: 非表示中は rAF を止める(復帰時に dt をリセット)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(rafId);
    } else {
      lastTimestamp = undefined;
      rafId = requestAnimationFrame(loop);
    }
  });

  const resizeObserver = new ResizeObserver(() => {
    renderer.resize();
  });
  resizeObserver.observe(canvas);
});
