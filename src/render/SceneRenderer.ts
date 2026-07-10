import {
  ACESFilmicToneMapping,
  type DataTexture,
  SRGBColorSpace,
  Scene,
  WebGLRenderer,
} from 'three';
import type { SkyRenderView, SkyRenderer } from '../contract/RenderView';
import { STEP_HZ } from '../contract/WorldSpec';
import { CameraRig } from './CameraRig';
import { Environment } from './Environment';
import { createNoiseTexture } from './NoiseTexture';
import { PostPipeline } from './PostPipeline';
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
 * SkyRenderer 実装(design-render §1.2)。
 *
 * Phase 2: PostPipeline(HDR HalfFloat → bloom → output+vignette)経由の
 * 描画に移行。共有ノイズテクスチャ(NoiseTexture)と太陽 uniform
 * (Environment 単一所有)を全サブシステムに配る。
 */
export class SceneRenderer implements SkyRenderer {
  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly cameraRig: CameraRig;
  private readonly systems: RenderSystem[] = [];
  private readonly maxPixelRatio: number;
  private readonly noiseTexture: DataTexture;
  private readonly post: PostPipeline;

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
    this.noiseTexture = createNoiseTexture();

    const environment = new Environment();
    this.addSystem(environment);

    this.post = new PostPipeline(
      this.renderer,
      this.scene,
      this.cameraRig.camera,
    );

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
    for (const system of this.systems) {
      system.prerender?.(this.renderer);
    }
    this.post.render();
  }

  public resize(): void {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    const pixelRatio = Math.min(window.devicePixelRatio, this.maxPixelRatio);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.post.setSize(width, height, pixelRatio);
    this.cameraRig.setAspect(width / height);
  }

  public dispose(): void {
    for (const system of this.systems) {
      system.dispose();
    }
    this.post.dispose();
    this.noiseTexture.dispose();
    this.cameraRig.dispose();
    this.renderer.dispose();
  }

  private addSystem(system: RenderSystem): void {
    this.systems.push(system);
    this.scene.add(system.object);
  }
}
