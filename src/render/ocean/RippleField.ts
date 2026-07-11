import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  ClampToEdgeWrapping,
  Color,
  CustomBlending,
  Group,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  OneFactor,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  type Texture,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import type { SkyRenderView } from '../../contract/RenderView';
import {
  MAX_STEPS_PER_FRAME,
  SPLASH_VIEW_CAPACITY,
} from '../../contract/WorldSpec';
import type { FrameInfo, QualityTier, RenderSystem } from '../RenderSystem';
import {
  RIPPLE_FOAM_GAIN,
  RIPPLE_SPLAT_FRAGMENT_GLSL,
  RIPPLE_SPLAT_GAIN,
  RIPPLE_SPLAT_VERTEX_GLSL,
  RIPPLE_TINT_GAIN,
} from '../shaders/rippleSplat';
import {
  RIPPLE_FOAM_DECAY,
  RIPPLE_HEIGHT_DAMP,
  RIPPLE_K,
  RIPPLE_TINT_DECAY,
  RIPPLE_UPDATE_FRAGMENT_GLSL,
  RIPPLE_UPDATE_VERTEX_GLSL,
  RIPPLE_VEL_DAMP,
} from '../shaders/rippleUpdate';
import { SPLAT_OUT_STRIDE, SplatScheduler } from './SplatScheduler';

/** アクション域は原点中心 24×24u(半径 ~12u — design-render §2.2)。 */
export const RIPPLE_HALF_EXTENT = 12;
/** tier0 の解像度(384² → テクセル 0.0625u)。 */
export const RIPPLE_RESOLUTION = 384;
/** ティア → rippleSimResolution(design-render §9.3)。 */
const RESOLUTION_BY_TIER: readonly number[] = [384, 384, 320, 256, 192];
/** 1 フレームに描けるスプラット上限(instanced quad 容量)。 */
const SPLAT_CAPACITY = 64;

/**
 * ocean シェーダと共有する uniform 値オブジェクト(SunUniforms パターン)。
 * texture はピンポン swap のたびに prerender が差し替える。
 */
export interface RippleUniforms {
  readonly uRipple: { value: Texture | null };
  readonly uRippleTexelUv: { value: number };
  readonly uRippleTexelWorld: { value: number };
  readonly uRippleHalfExtent: { value: number };
}

/**
 * 中央アクション域の GPU ハイトフィールド(design-render §2.2)。
 *
 * RGBA16F 384² ピンポン(R=height / G=velocity / B=foam / A=Mizu tint)。
 * prerender(メイン描画前)で [A] スプラット加算注入 → [B] 波動方程式積分
 * (1 sim-step = 1 積分)→ swap。ocean はその出力を RIPPLE_FIELD define で
 * 法線・頂点変位・フォームに読む。
 *
 * A27 ガード: この FBO はメイン RenderPass(readBuffer 向け)からのみ
 * サンプルされ、bloom 連鎖・画面パスとは一切交差しない。
 */
export class RippleField implements RenderSystem {
  /** シーンには何も置かない(FBO 専用システム)。 */
  public readonly object = new Group();
  public readonly uniforms: RippleUniforms;
  public readonly scheduler = new SplatScheduler();

  private readonly targets: readonly [WebGLRenderTarget, WebGLRenderTarget];
  private readonly camera = new Camera();
  private readonly splatScene = new Scene();
  private readonly updateScene = new Scene();
  private readonly splatGeometry: InstancedBufferGeometry;
  private readonly splatMaterial: ShaderMaterial;
  private readonly updateMaterial: ShaderMaterial;
  private readonly updateGeometry: BufferGeometry;
  private readonly splatData: Float32Array;
  private readonly ringData: Float32Array;
  private readonly splatAttr: InstancedBufferAttribute;
  private readonly ringAttr: InstancedBufferAttribute;
  private readonly clearColor = new Color(0x000000);
  private readonly savedClearColor = new Color();

  private current = 0;
  private initialized = false;
  private pendingSteps = 0;
  private splatCount = 0;
  private lastViewStep = -1;
  private resolution = RIPPLE_RESOLUTION;

  constructor() {
    this.object.matrixAutoUpdate = false;

    const makeTarget = (): WebGLRenderTarget =>
      new WebGLRenderTarget(RIPPLE_RESOLUTION, RIPPLE_RESOLUTION, {
        type: HalfFloatType,
        format: RGBAFormat,
        depthBuffer: false,
        stencilBuffer: false,
        magFilter: LinearFilter,
        minFilter: LinearFilter,
        wrapS: ClampToEdgeWrapping,
        wrapT: ClampToEdgeWrapping,
        generateMipmaps: false,
      });
    this.targets = [makeTarget(), makeTarget()];

    this.uniforms = {
      uRipple: { value: this.targets[0].texture },
      uRippleTexelUv: { value: 1 / RIPPLE_RESOLUTION },
      uRippleTexelWorld: {
        value: (2 * RIPPLE_HALF_EXTENT) / RIPPLE_RESOLUTION,
      },
      uRippleHalfExtent: { value: RIPPLE_HALF_EXTENT },
    };

    // ── [A] スプラット: instanced quad、加算(ONE, ONE)
    this.splatData = new Float32Array(SPLAT_CAPACITY * 4);
    this.ringData = new Float32Array(SPLAT_CAPACITY * 2);
    this.splatGeometry = new InstancedBufferGeometry();
    this.splatGeometry.setAttribute(
      'position',
      new BufferAttribute(
        new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]),
        3,
      ),
    );
    this.splatGeometry.setIndex(
      new BufferAttribute(new Uint16Array([0, 1, 2, 2, 1, 3]), 1),
    );
    this.splatAttr = new InstancedBufferAttribute(this.splatData, 4);
    this.ringAttr = new InstancedBufferAttribute(this.ringData, 2);
    this.splatGeometry.setAttribute('aSplat', this.splatAttr);
    this.splatGeometry.setAttribute('aRing', this.ringAttr);
    this.splatGeometry.instanceCount = 0;

    this.splatMaterial = new ShaderMaterial({
      vertexShader: RIPPLE_SPLAT_VERTEX_GLSL,
      fragmentShader: RIPPLE_SPLAT_FRAGMENT_GLSL,
      uniforms: {
        uHalfExtent: { value: RIPPLE_HALF_EXTENT },
        uSplatGain: { value: RIPPLE_SPLAT_GAIN },
        uFoamGain: { value: RIPPLE_FOAM_GAIN },
        uTintGain: { value: RIPPLE_TINT_GAIN },
      },
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneFactor,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const splatMesh = new Mesh(this.splatGeometry, this.splatMaterial);
    splatMesh.frustumCulled = false;
    splatMesh.matrixAutoUpdate = false;
    this.splatScene.add(splatMesh);

    // ── [B] 積分: 全画面三角形
    this.updateGeometry = new BufferGeometry();
    this.updateGeometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    this.updateMaterial = new ShaderMaterial({
      vertexShader: RIPPLE_UPDATE_VERTEX_GLSL,
      fragmentShader: RIPPLE_UPDATE_FRAGMENT_GLSL,
      uniforms: {
        uField: { value: null },
        uTexel: {
          value: [1 / RIPPLE_RESOLUTION, 1 / RIPPLE_RESOLUTION],
        },
        uK: { value: RIPPLE_K },
        uVelDamp: { value: RIPPLE_VEL_DAMP },
        uHeightDamp: { value: RIPPLE_HEIGHT_DAMP },
        uFoamDecay: { value: RIPPLE_FOAM_DECAY },
        uTintDecay: { value: RIPPLE_TINT_DECAY },
      },
      depthTest: false,
      depthWrite: false,
    });
    const updateMesh = new Mesh(this.updateGeometry, this.updateMaterial);
    updateMesh.frustumCulled = false;
    updateMesh.matrixAutoUpdate = false;
    this.updateScene.add(updateMesh);
  }

  public update(view: SkyRenderView, _frame: FrameInfo): void {
    // 経過 step の把握(0-step フレーム = 積分なし、初回 = 積分 1 のみ)
    if (this.lastViewStep < 0) {
      this.pendingSteps = 1;
    } else {
      this.pendingSteps = Math.min(
        Math.max(view.step - this.lastViewStep, 0),
        MAX_STEPS_PER_FRAME,
      );
    }

    // SplashEventView の取り込み(step が進んだフレームだけ — 0-step
    // フレームで同一イベントを二重注入しないためのガード)
    if (view.step !== this.lastViewStep) {
      const splashes = view.splashes;
      const n = Math.min(splashes.count, SPLASH_VIEW_CAPACITY);
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        this.scheduler.addSplash(
          view.step,
          splashes.data[o],
          splashes.data[o + 1],
          splashes.data[o + 2],
          splashes.data[o + 3],
        );
      }
      this.lastViewStep = view.step;
    }

    this.splatCount = this.collectSplats(view.step);
  }

  public prerender(renderer: WebGLRenderer): void {
    const savedAutoClear = renderer.autoClear;
    const savedTarget = renderer.getRenderTarget();
    renderer.getClearColor(this.savedClearColor);
    const savedClearAlpha = renderer.getClearAlpha();
    renderer.autoClear = false;

    if (!this.initialized) {
      // 未初期化 VRAM(NaN の可能性)を必ずゼロで潰す
      renderer.setClearColor(this.clearColor, 0);
      for (const target of this.targets) {
        renderer.setRenderTarget(target);
        renderer.clear(true, false, false);
      }
      this.initialized = true;
    }

    // [A] splat → current(加算)
    if (this.splatCount > 0) {
      renderer.setRenderTarget(this.targets[this.current]);
      renderer.render(this.splatScene, this.camera);
    }

    // [B] integrate ×経過 step → ピンポン swap
    for (let s = 0; s < this.pendingSteps; s++) {
      this.updateMaterial.uniforms.uField.value =
        this.targets[this.current].texture;
      renderer.setRenderTarget(this.targets[1 - this.current]);
      renderer.render(this.updateScene, this.camera);
      this.current = 1 - this.current;
    }

    this.uniforms.uRipple.value = this.targets[this.current].texture;

    renderer.setRenderTarget(savedTarget);
    renderer.setClearColor(this.savedClearColor, savedClearAlpha);
    renderer.autoClear = savedAutoClear;
  }

  /**
   * rippleSimResolution ノブ(§9.3)。ターゲットを setSize で再生成し波は
   * リセットする(テクスチャが入れ替わるため未初期化 VRAM を prerender で
   * ゼロクリアさせる — initialized=false)。シェーダはタップ幅を uTexel /
   * uRippleTexelUv/World から読むため解像度非依存(再コンパイル不要)。
   */
  public applyTier(tier: QualityTier): void {
    const size = RESOLUTION_BY_TIER[tier];
    if (size === this.resolution) return;
    this.resolution = size;
    for (const target of this.targets) target.setSize(size, size);
    this.uniforms.uRippleTexelUv.value = 1 / size;
    this.uniforms.uRippleTexelWorld.value = (2 * RIPPLE_HALF_EXTENT) / size;
    (this.updateMaterial.uniforms.uTexel.value as [number, number])[0] =
      1 / size;
    (this.updateMaterial.uniforms.uTexel.value as [number, number])[1] =
      1 / size;
    this.initialized = false;
  }

  public dispose(): void {
    for (const target of this.targets) {
      target.dispose();
    }
    this.splatGeometry.dispose();
    this.splatMaterial.dispose();
    this.updateGeometry.dispose();
    this.updateMaterial.dispose();
  }

  /** 期日到来スプラットを instanced quad 属性へ展開する。 */
  private collectSplats(step: number): number {
    const count = this.scheduler.collectDue(step, COLLECT_BUF, SPLAT_CAPACITY);
    for (let i = 0; i < count; i++) {
      const src = i * SPLAT_OUT_STRIDE;
      const o4 = i * 4;
      this.splatData[o4] = COLLECT_BUF[src]; // x
      this.splatData[o4 + 1] = COLLECT_BUF[src + 1]; // z
      this.splatData[o4 + 2] = COLLECT_BUF[src + 2]; // quadRadius
      this.splatData[o4 + 3] = COLLECT_BUF[src + 3]; // strength
      this.ringData[i * 2] = COLLECT_BUF[src + 4]; // ringR0
      this.ringData[i * 2 + 1] = COLLECT_BUF[src + 5]; // tintGain
    }
    if (count > 0) {
      this.splatAttr.clearUpdateRanges();
      this.splatAttr.addUpdateRange(0, count * 4);
      this.splatAttr.needsUpdate = true;
      this.ringAttr.clearUpdateRanges();
      this.ringAttr.addUpdateRange(0, count * 2);
      this.ringAttr.needsUpdate = true;
    }
    this.splatGeometry.instanceCount = count;
    return count;
  }
}

/** collectDue の受け皿(定常状態での new 禁止 — 横断規律)。 */
const COLLECT_BUF = new Float32Array(SPLAT_CAPACITY * SPLAT_OUT_STRIDE);
