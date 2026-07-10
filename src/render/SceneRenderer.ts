import {
  ACESFilmicToneMapping,
  SRGBColorSpace,
  Scene,
  WebGLRenderer,
} from 'three';
import type { SkyRenderView, SkyRenderer } from '../contract/RenderView';
import { STEP_HZ } from '../contract/WorldSpec';
import { CameraRig } from './CameraRig';
import { Environment } from './Environment';
import type { FrameInfo, RenderSystem } from './RenderSystem';

/** 既定の DPR 上限(Retina 超のフィル爆発防止 — design-render §1.2)。 */
const DEFAULT_MAX_PIXEL_RATIO = 2;

export interface SceneRendererOptions {
  /** DPR 上限(`?dpr=` — 実効 DPR = min(devicePixelRatio, これ))。 */
  readonly maxPixelRatio?: number;
  /** false でマウス視差を無効化(`?m=1`)。 */
  readonly parallax?: boolean;
}

/**
 * SkyRenderer 実装(design-render §1.2)。Phase 0 は空シーン:
 * 朝スカイ(Environment)+ 自動漂流カメラ(CameraRig)のみ。
 * PostPipeline は Phase 2 — 現状は composer なしの直接レンダ
 * (ACES + sRGB は renderer 設定でキャンバス出力時に適用される)。
 */
export class SceneRenderer implements SkyRenderer {
  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly cameraRig: CameraRig;
  private readonly systems: RenderSystem[] = [];
  private readonly maxPixelRatio: number;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options?: SceneRendererOptions,
  ) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.outputColorSpace = SRGBColorSpace;

    this.maxPixelRatio = options?.maxPixelRatio ?? DEFAULT_MAX_PIXEL_RATIO;

    this.scene = new Scene();
    this.cameraRig = new CameraRig({ parallax: options?.parallax ?? true });

    const environment = new Environment();
    this.addSystem(environment);

    this.resize();
  }

  public render(view: SkyRenderView, alpha: number): void {
    const stepF = view.step + alpha;
    const frame: FrameInfo = {
      camera: this.cameraRig.camera,
      alpha,
      stepF,
      timeSec: stepF / STEP_HZ,
    };
    this.cameraRig.update(frame.timeSec);
    for (const system of this.systems) {
      system.update(view, frame);
    }
    this.renderer.render(this.scene, this.cameraRig.camera);
  }

  public resize(): void {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio, this.maxPixelRatio),
    );
    this.renderer.setSize(width, height, false);
    this.cameraRig.setAspect(width / height);
  }

  public dispose(): void {
    for (const system of this.systems) {
      system.dispose();
    }
    this.cameraRig.dispose();
    this.renderer.dispose();
  }

  private addSystem(system: RenderSystem): void {
    this.systems.push(system);
    this.scene.add(system.object);
  }
}
