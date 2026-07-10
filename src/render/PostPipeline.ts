import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  HalfFloatType,
  Mesh,
  type PerspectiveCamera,
  type Scene,
  ShaderMaterial,
  type Texture,
  Vector2,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

/**
 * ポストパイプライン(design-render §1.2 [C][D][E])。
 *
 * - [C] Main RenderPass → HDR HalfFloat ターゲット。**MSAA 0**
 *   (ANGLE-Metal で MSAA×HalfFloat が激遅の実測教訓 — §9.4-1)
 * - [D] BloomMipsPass(UnrealBloomPass 変種)— threshold 1.15 / strength 0.32 /
 *   radius 0.55。白飛びの塊を作らない(海の素地は bloom 閾値未満、
 *   スペキュラ系のみ拾う)
 * - [E] OutputPass(ACES + sRGB)へ**ビネットを文字列注入**(追加パスなし)
 *
 * ## bloom の適用経路(Chrome/ANGLE Metal 黒フレーム回避 — 重要)
 *
 * 素の UnrealBloomPass は最終段で合成結果を readBuffer(HDR ターゲット)へ
 * 加算で書き戻し、OutputPass がそれをサンプルして画面へ描く。この構成は
 * Chrome/ANGLE Metal(macOS)で「コンポジタが全面黒フレームを間欠提示する」
 * 不具合(激しいちらつき・約 1 回/秒)を誘発する。計装(CDP screencast の
 * 全フレーム輝度解析)での実測:
 *
 * - 書き戻しあり(素の構成): 黒 16-39 枚/20s
 * - bloom パスは全て実行するが結果を画面系が一切サンプルしない: 黒 0 枚
 * - 合成結果を OutputPass で直接サンプル(専用ターゲット/blit コピー/
 *   1 フレーム遅延の各変種): 黒 1-8 枚/15-20s(軽減するが残る)
 * - canvas 自体の内容(captureStream)は常に正常 = 提示(present)段の問題
 *
 * つまり「画面へ描くパスが、同一フレーム内で FBO パス連鎖の産物を
 * サンプルする」ことが引き金になる。そこで bloom の適用は
 * **シーン内の加算フルスクリーン三角形(BloomApplyMesh)**で行う:
 *
 * 1. RenderPass: シーン(BloomApplyMesh が「前フレーム」の合成結果を
 *    加算描画)→ readBuffer
 * 2. BloomMipsPass: readBuffer から明部抽出 → ミップぼかし → 合成を
 *    自前ターゲット(二重化)へ。**画面系はこれを今フレームは読まない**
 * 3. OutputPass: readBuffer のみサンプルして画面へ(トーンマップ+ビネット)
 *
 * これで全テクスチャが「フレーム内で 1 回書き→以後読みのみ」となり、
 * 画面パスの入力は readBuffer だけになる(黒フレーム 0 を実測確認)。
 * 代償は bloom の 1 フレーム遅延(60Hz で 17ms — 知覚不能)と、
 * 明部抽出の入力に前フレームの bloom が含まれる二次項(閾値 1.15 未満の
 * グロー裾野は再抽出されないため実質無視できる)。
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

const BLUR_DIRECTION_X = new Vector2(1, 0);
const BLUR_DIRECTION_Y = new Vector2(0, 1);

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

/**
 * OutputShader のフラグメントへビネットを文字列注入する(純関数)。
 *
 * three ^0.185 の OutputShader は `// color space` コメントで
 * トーンマップ節と色空間節が区切られている前提(バージョン固定依存)。
 * マーカー欠落(three 更新等)時は null を返し、呼び元はビネットなしで
 * 動作継続する。
 */
export const patchOutputShader = (fragmentShader: string): string | null => {
  const colorMarker = '// color space';
  if (
    !fragmentShader.includes(colorMarker) ||
    !fragmentShader.includes('varying vec2 vUv;')
  ) {
    return null;
  }
  return fragmentShader
    .replace('varying vec2 vUv;', VIGNETTE_UNIFORMS_GLSL)
    .replace(colorMarker, `${VIGNETTE_APPLY_GLSL}\n\t${colorMarker}`);
};

const BLOOM_APPLY_VERTEX_GLSL = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = position.xy * 0.5 + 0.5;
	gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * 明部抽出(LuminosityHighPassShader 相当)+ **前フレーム bloom の差し引き**。
 * シーン内加算(BloomApplyMesh)により readBuffer には前フレームの bloom が
 * 含まれるため、そのまま抽出すると加算の帰還ループで発散する。
 * 同じテクスチャを差し引いて一次項を正確に打ち消す。
 */
const HIGH_PASS_FRAGMENT_GLSL = /* glsl */ `
#include <common>
uniform sampler2D tDiffuse;
uniform sampler2D uPrevBloom;
uniform float luminosityThreshold;
uniform float smoothWidth;
varying vec2 vUv;
void main() {
	vec4 texel = texture2D( tDiffuse, vUv );
	texel.rgb = max( texel.rgb - texture2D( uPrevBloom, vUv ).rgb, vec3( 0.0 ) );
	float v = luminance( texel.xyz );
	float alpha = smoothstep( luminosityThreshold, luminosityThreshold + smoothWidth, v );
	gl_FragColor = mix( vec4( 0.0 ), texel, alpha );
}
`;

const HIGH_PASS_VERTEX_GLSL = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const BLOOM_APPLY_FRAGMENT_GLSL = /* glsl */ `
uniform sampler2D uBloomTexture;
varying vec2 vUv;
void main() {
	gl_FragColor = vec4(texture2D(uBloomTexture, vUv).rgb, 1.0);
}
`;

/**
 * bloom 合成結果(前フレーム)をシーン描画の最後に加算する
 * NDC フルスクリーン三角形(ファイル冒頭ドキュメント参照)。
 * transparent + renderOrder 最大で不透明・透明全ての後に描く。
 */
class BloomApplyMesh {
  public readonly mesh: Mesh;
  private readonly geometry: BufferGeometry;
  private readonly material: ShaderMaterial;

  constructor() {
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    this.material = new ShaderMaterial({
      vertexShader: BLOOM_APPLY_VERTEX_GLSL,
      fragmentShader: BLOOM_APPLY_FRAGMENT_GLSL,
      uniforms: { uBloomTexture: { value: null } },
      blending: AdditiveBlending,
      premultipliedAlpha: true,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.renderOrder = 1000;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
  }

  public update(texture: Texture, visible: boolean): void {
    this.material.uniforms.uBloomTexture.value = texture;
    this.mesh.visible = visible;
  }

  public dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * UnrealBloomPass 変種: 明部抽出 → ミップ毎の分離ガウシアン → 5 ミップ合成
 * までは同一だが、**readBuffer への加算書き戻しを行わない**。
 * 合成結果は二重化した自前ターゲットに書き、翌フレームに BloomApplyMesh が
 * シーン内で加算する(ファイル冒頭ドキュメント参照)。
 *
 * renderToScreen / stencil mask は本パイプラインでは未使用のため対応しない。
 */
class BloomMipsPass extends UnrealBloomPass {
  private readonly quad = new FullScreenQuad();
  private readonly savedClearColor = new Color();
  /** 合成専用ターゲット ×2(今フレーム書き / 前フレーム読みの二重化)。 */
  private readonly compositeTargets = [
    new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false }),
    new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false }),
  ] as const;
  /** 明部抽出(前フレーム bloom 差し引き版 — HIGH_PASS_FRAGMENT_GLSL)。 */
  private readonly highPassMaterial = new ShaderMaterial({
    vertexShader: HIGH_PASS_VERTEX_GLSL,
    fragmentShader: HIGH_PASS_FRAGMENT_GLSL,
    uniforms: {
      tDiffuse: { value: null },
      uPrevBloom: { value: null },
      luminosityThreshold: { value: 1 },
      smoothWidth: { value: 0.01 },
    },
  });
  private compositeIndex = 0;
  private framesRendered = 0;

  /** 両バッファが有効な内容を持つか(起動直後/リサイズ直後は false)。 */
  public get warmedUp(): boolean {
    return this.framesRendered >= 2;
  }

  /**
   * フレーム先頭で呼ぶ: 書き込み先を入れ替え、BloomApplyMesh が今フレーム
   * サンプルすべき「前フレームの合成結果」を返す。
   */
  public advanceFrame(): Texture {
    this.compositeIndex = 1 - this.compositeIndex;
    return this.compositeTargets[1 - this.compositeIndex].texture;
  }

  public override setSize(width: number, height: number): void {
    super.setSize(width, height);
    // トップミップ(renderTargetsHorizontal[0])と同解像度
    for (const target of this.compositeTargets) {
      target.setSize(
        Math.max(1, Math.round(width / 2)),
        Math.max(1, Math.round(height / 2)),
      );
    }
    // リサイズでバッファ内容が失われる → 両方書き直すまで加算を止める
    this.framesRendered = 0;
  }

  public override render(
    renderer: WebGLRenderer,
    _writeBuffer: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget,
  ): void {
    renderer.getClearColor(this.savedClearColor);
    const savedClearAlpha = renderer.getClearAlpha();
    const savedAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setClearColor(this.clearColor, 0);

    // 0. 初回/リサイズ直後: 両合成バッファをゼロ初期化
    //    (未初期化 VRAM の NaN が差し引き経由で伝播しないように)
    if (this.framesRendered === 0) {
      for (const target of this.compositeTargets) {
        renderer.setRenderTarget(target);
        renderer.clear();
      }
    }

    // 1. 明部抽出(readBuffer は読むだけ — 書き戻しなし)。
    //    前フレームの bloom 加算分を差し引く(帰還ループ防止)
    const highPass = this.highPassMaterial.uniforms;
    highPass.tDiffuse.value = readBuffer.texture;
    highPass.uPrevBloom.value =
      this.compositeTargets[1 - this.compositeIndex].texture;
    highPass.luminosityThreshold.value = this.threshold;
    this.quad.material = this.highPassMaterial;
    renderer.setRenderTarget(this.renderTargetBright);
    renderer.clear();
    this.quad.render(renderer);

    // 2. ミップ毎の分離ガウシアン(H → V)
    let input = this.renderTargetBright;
    for (let i = 0; i < this.nMips; i++) {
      const blur = this.separableBlurMaterials[i];
      this.quad.material = blur;
      blur.uniforms.colorTexture.value = input.texture;
      blur.uniforms.direction.value = BLUR_DIRECTION_X;
      renderer.setRenderTarget(this.renderTargetsHorizontal[i]);
      renderer.clear();
      this.quad.render(renderer);
      blur.uniforms.colorTexture.value =
        this.renderTargetsHorizontal[i].texture;
      blur.uniforms.direction.value = BLUR_DIRECTION_Y;
      renderer.setRenderTarget(this.renderTargetsVertical[i]);
      renderer.clear();
      this.quad.render(renderer);
      input = this.renderTargetsVertical[i];
    }

    // 3. 5 ミップ合成 → 今フレーム側の compositeTarget(読むのは vertical 群のみ)
    this.quad.material = this.compositeMaterial;
    this.compositeMaterial.uniforms.bloomStrength.value = this.strength;
    this.compositeMaterial.uniforms.bloomRadius.value = this.radius;
    this.compositeMaterial.uniforms.bloomTintColors.value =
      this.bloomTintColors;
    renderer.setRenderTarget(this.compositeTargets[this.compositeIndex]);
    renderer.clear();
    this.quad.render(renderer);

    if (this.framesRendered < 2) this.framesRendered++;

    renderer.setClearColor(this.savedClearColor, savedClearAlpha);
    renderer.autoClear = savedAutoClear;
  }

  public override dispose(): void {
    this.quad.dispose();
    this.highPassMaterial.dispose();
    for (const target of this.compositeTargets) {
      target.dispose();
    }
    super.dispose();
  }
}

export class PostPipeline {
  private readonly composer: EffectComposer;
  private readonly bloomPass: BloomMipsPass;
  private readonly bloomApply: BloomApplyMesh;
  private readonly outputPass: OutputPass;
  private readonly target: WebGLRenderTarget;
  private readonly scene: Scene;
  private bloomScale = DEFAULT_BLOOM_SCALE;
  private deviceWidth = 1;
  private deviceHeight = 1;

  constructor(
    renderer: WebGLRenderer,
    scene: Scene,
    camera: PerspectiveCamera,
  ) {
    this.scene = scene;

    // HDR HalfFloat・MSAA 0(samples 既定 0)・depth あり
    this.target = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      samples: 0,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.composer = new EffectComposer(renderer, this.target);

    this.composer.addPass(new RenderPass(scene, camera));

    this.bloomPass = new BloomMipsPass(
      new Vector2(1, 1),
      BLOOM_STRENGTH,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD,
    );
    this.composer.addPass(this.bloomPass);

    // bloom はシーン内加算(前フレーム分)— ファイル冒頭ドキュメント参照
    this.bloomApply = new BloomApplyMesh();
    scene.add(this.bloomApply.mesh);

    this.outputPass = new OutputPass();
    this.injectVignette();
    this.composer.addPass(this.outputPass);
  }

  public render(): void {
    // 前フレームの合成結果をシーン加算メッシュへ(準備が整うまで非表示)
    this.bloomApply.update(
      this.bloomPass.advanceFrame(),
      this.bloomScale > 0 && this.bloomPass.warmedUp,
    );
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
    this.scene.remove(this.bloomApply.mesh);
    this.bloomApply.dispose();
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
   * OutputShader へビネットを注入する(patchOutputShader)。
   * マーカー欠落(three 更新等)時はビネットなしで動作継続。
   */
  private injectVignette(): void {
    const material = this.outputPass.material;
    const patched = patchOutputShader(material.fragmentShader);
    if (patched === null) return;
    material.fragmentShader = patched;
    material.uniforms.uVignetteStrength = { value: 0.32 };
    material.uniforms.uVignetteStart = { value: 0.6 };
    material.needsUpdate = true;
  }
}
