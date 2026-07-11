import type { SimCounts } from '../contract/RenderView';

/**
 * StatsOverlay(`?m=1` — 裁定 A19: 表示契約は本作で新規定義。
 * threejs シリーズの凍結行形式は継承しない)。
 *
 * **凍結契約 v1(本作固有)** — 行の意味と順序:
 * ```
 * FPS: <rAF 実測 FPS の EMA>
 * Frame: <rAF デルタ [ms] の EMA>
 * Update: <sim.step()×n + renderer.render() の JS 実行時間 [ms]>
 * H: <生存 H> O: <生存 O> H2: <生存 H2> Droplets: <生存雫(全球合計)>
 * Bubbles: <Dead 以外のスロット数>
 * Fill: <アクティブ球の平均 fill01>
 * Tier: <現在の品質ティア 0..4>
 * ```
 * SimCounts(contract/RenderView.ts)準拠。FPS/Frame/Update は app/main.ts の
 * ループが計測する rAF タイミングをそのまま渡す(本クラスは表示のみ)。
 */
export class StatsOverlay {
  private readonly el: HTMLDivElement;
  private fpsEma = 60;
  private frameEma = 1000 / 60;

  constructor() {
    this.el = document.createElement('div');
    this.el.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'margin:0',
      'padding:6px 10px',
      'background:rgba(0,0,0,0.55)',
      'color:#eaf6ff',
      'font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'white-space:pre',
      'z-index:1000',
      'pointer-events:none',
      'user-select:none',
    ].join(';');
    document.body.appendChild(this.el);
  }

  /**
   * @param frameDtMs rAF デルタ [ms](復帰直後は 1000/60 相当を渡す)
   * @param updateMs sim.step()×n + renderer.render() の JS 実行時間 [ms]
   * @param counts SimCounts(sim.counts())
   * @param tier 現在の品質ティア 0..4
   */
  public update(
    frameDtMs: number,
    updateMs: number,
    counts: SimCounts,
    tier: number,
  ): void {
    const fps = 1000 / Math.max(frameDtMs, 1e-3);
    this.fpsEma += (fps - this.fpsEma) * 0.1;
    this.frameEma += (frameDtMs - this.frameEma) * 0.1;
    this.el.textContent =
      `FPS: ${this.fpsEma.toFixed(1)}\n` +
      `Frame: ${this.frameEma.toFixed(2)}ms\n` +
      `Update: ${updateMs.toFixed(2)}ms\n` +
      `H: ${counts.h} O: ${counts.o} H2: ${counts.h2} Droplets: ${counts.droplets}\n` +
      `Bubbles: ${counts.bubblesActive}\n` +
      `Fill: ${counts.meanFill01.toFixed(3)}\n` +
      `Tier: ${tier}`;
  }

  public dispose(): void {
    this.el.remove();
  }
}
