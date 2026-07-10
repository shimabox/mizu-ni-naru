import type { Object3D, PerspectiveCamera, WebGLRenderer } from 'three';
import type { SkyRenderView } from '../contract/RenderView';

/** 品質ティア(0 = 最高)。ラダー本体は Phase 4(AdaptiveQuality)。 */
export type QualityTier = 0 | 1 | 2 | 3 | 4;

/**
 * フレーム情報(design-render §1.2)。シェーダの時間はすべて
 * stepF = view.step + alpha / timeSec = stepF / 60 から導出する
 * (決定論・タブ復帰でも破綻しない)。
 */
export interface FrameInfo {
  readonly camera: PerspectiveCamera;
  readonly alpha: number; // 補間係数 ∈ [0,1)
  readonly stepF: number; // view.step + alpha
  readonly timeSec: number; // stepF / 60
}

/** サブシステム差し込み口(design-render §1.2)。 */
export interface RenderSystem {
  readonly object: Object3D;
  /** 属性/uniform 反映(JS submit のみ — GPU パスは prerender で) */
  update(view: SkyRenderView, frame: FrameInfo): void;
  /** FBO パス(RippleField が使用 — Phase 3) */
  prerender?(renderer: WebGLRenderer): void;
  /** 品質ティア反映(Phase 4) */
  applyTier?(tier: QualityTier): void;
  dispose(): void;
}
