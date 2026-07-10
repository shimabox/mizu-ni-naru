import type { SimLike, SkyRenderer } from '../contract/RenderView';
import { SLOT_COUNT_DESKTOP, SLOT_COUNT_MOBILE } from '../contract/WorldSpec';
import { SceneRenderer } from '../render/SceneRenderer';
import { MizuNiNaruSim } from '../sim/MizuNiNaruSim';
import { StubSim } from '../sim/StubSim';
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
  const slotCount =
    params.slots ??
    (window.innerWidth < 768 ? SLOT_COUNT_MOBILE : SLOT_COUNT_DESKTOP);

  // 既定は実 sim(Phase 1)。`?sim=stub` で StubSim(render 開発用の合成アニメ)
  const sim: SimLike =
    params.sim === 'stub' ? new StubSim() : new MizuNiNaruSim();
  sim.init({ seed, slotCount });

  const renderer: SkyRenderer = new SceneRenderer(canvas, {
    maxPixelRatio: params.dpr,
    parallax: !params.measure,
  });

  let remainder = 0;
  let lastTimestamp: number | undefined;
  let rafId = 0;

  const loop = (timestamp: DOMHighResTimeStamp): void => {
    // 復帰直後(lastTimestamp 無し)は 1 フレーム分として扱う
    const frameDtMs =
      lastTimestamp === undefined ? 1000 / 60 : timestamp - lastTimestamp;
    lastTimestamp = timestamp;

    const acc = accumulate(remainder, frameDtMs);
    remainder = acc.remainder;
    for (let i = 0; i < acc.steps; i++) {
      sim.step();
    }
    renderer.render(sim.view(), acc.alpha);

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
