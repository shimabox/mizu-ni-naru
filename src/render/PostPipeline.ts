import {
  HalfFloatType,
  type PerspectiveCamera,
  type Scene,
  Vector2,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

/**
 * ポストパイプライン(design-render §1.2 [C][D][E])。
 *
 * - [C] Main RenderPass → HDR HalfFloat ターゲット。**MSAA 0**
 *   (ANGLE-Metal で MSAA×HalfFloat が激遅の実測教訓 — §9.4-1)
 * - [D] UnrealBloomPass — threshold 1.15 / strength 0.32 / radius 0.55。
 *   白飛びの塊を作らない(海の素地は bloom 閾値未満、スペキュラ系のみ拾う)
 * - [E] OutputPass(ACES + sRGB)へ**ビネットを文字列注入**(追加パスなし)
 *
 * トーンマップは OutputPass が renderer 設定(ACES/exposure)を読んで適用する。
 * シーン内マテリアルの `#include <tonemapping_fragment>` は、レンダーターゲット
 * への描画時には three が TONE_MAPPING を定義しないため no-op(二重適用なし)。
 */
const BLOOM_THRESHOLD = 1.15;
const BLOOM_STRENGTH = 0.32;
const BLOOM_RADIUS = 0.55;

/** bloom 解像度スケール(tier0-1 = 0.5 → 半解像度ミップチェーン)。 */
const DEFAULT_BLOOM_SCALE = 0.5;

const VIGNETTE_UNIFORMS_GLSL = /* glsl */ `
uniform float uVignetteStrength;
uniform float uVignetteStart;
varying vec2 vUv;
`;

/** トーンマップ後・色空間変換前に差し込むビネット(display-referred)。 */
const VIGNETTE_APPLY_GLSL = /* glsl */ `
	// vignette(注入 — design-render §1.2 [E])
	{
		float vd = length(vUv - 0.5) * 2.0;
		gl_FragColor.rgb *= 1.0 - uVignetteStrength * smoothstep(uVignetteStart, 1.42, vd);
	}
`;

export class PostPipeline {
  private readonly composer: EffectComposer;
  private readonly bloomPass: UnrealBloomPass;
  private readonly outputPass: OutputPass;
  private readonly target: WebGLRenderTarget;
  private bloomScale = DEFAULT_BLOOM_SCALE;
  private deviceWidth = 1;
  private deviceHeight = 1;

  constructor(
    renderer: WebGLRenderer,
    scene: Scene,
    camera: PerspectiveCamera,
  ) {
    // HDR HalfFloat・MSAA 0(samples 既定 0)・depth あり
    this.target = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      samples: 0,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.composer = new EffectComposer(renderer, this.target);

    this.composer.addPass(new RenderPass(scene, camera));

    this.bloomPass = new UnrealBloomPass(
      new Vector2(1, 1),
      BLOOM_STRENGTH,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD,
    );
    this.composer.addPass(this.bloomPass);

    this.outputPass = new OutputPass();
    this.injectVignette();
    this.composer.addPass(this.outputPass);
  }

  public render(): void {
    this.composer.render();
  }

  /** width/height は CSS ピクセル、pixelRatio は実効 DPR。 */
  public setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    this.deviceWidth = Math.max(1, Math.floor(width * pixelRatio));
    this.deviceHeight = Math.max(1, Math.floor(height * pixelRatio));
    this.applyBloomSize();
  }

  /** ティアの bloomScale ノブ(Phase 4)。0 で bloom パス無効。 */
  public setBloomScale(scale: number): void {
    this.bloomScale = scale;
    this.bloomPass.enabled = scale > 0;
    this.applyBloomSize();
  }

  public dispose(): void {
    this.bloomPass.dispose();
    this.outputPass.dispose();
    this.composer.dispose();
    this.target.dispose();
  }

  /**
   * UnrealBloomPass.setSize は内部で半分に割る(トップミップ = 渡した値 / 2)。
   * 実効スケール s を得るには「×2 渡し」が必要(Mizu-threejs applyBloomSize の罠)。
   */
  private applyBloomSize(): void {
    if (this.bloomScale <= 0) return;
    this.bloomPass.setSize(
      Math.max(2, Math.round(this.deviceWidth * this.bloomScale * 2)),
      Math.max(2, Math.round(this.deviceHeight * this.bloomScale * 2)),
    );
  }

  /**
   * OutputShader のフラグメントへビネットを文字列注入する(追加パスなし)。
   * three ^0.185 の OutputShader は「// color space」コメントで
   * トーンマップ節と色空間節が区切られている前提(バージョン固定依存)。
   */
  private injectVignette(): void {
    const material = this.outputPass.material;
    const marker = '// color space';
    const src = material.fragmentShader;
    if (!src.includes(marker)) {
      // マーカー欠落(three 更新等)時はビネットなしで動作継続
      return;
    }
    material.fragmentShader = src
      .replace('varying vec2 vUv;', VIGNETTE_UNIFORMS_GLSL)
      .replace(marker, `${VIGNETTE_APPLY_GLSL}\n\t${marker}`);
    material.uniforms.uVignetteStrength = { value: 0.32 };
    material.uniforms.uVignetteStart = { value: 0.6 };
    material.needsUpdate = true;
  }
}
