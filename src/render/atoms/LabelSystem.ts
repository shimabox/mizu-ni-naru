import {
  type CanvasTexture,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { SkyRenderView } from '../../contract/RenderView';
import type { FrameInfo, QualityTier, RenderSystem } from '../RenderSystem';
import { LABEL_FRAGMENT_GLSL, LABEL_VERTEX_GLSL } from '../shaders/label';
import type { AtomViewAttributes } from './AtomViewAttributes';
import { createLabelAtlasTexture } from './LabelAtlas';
import { createBillboardQuadGeometry, writeCameraBasis } from './billboard';

/** 距離カットオフ(裁定 A32)。判読できなくなる距離の視覚調整値(u)。 */
const LABEL_CUTOFF_DISTANCE = 15;
const LABEL_CUTOFF_FADE = 4;
/**
 * ティア → labelDensity(design-render §9.3)。負荷時は文字数そのものを間引く。
 * A52 最終: 文字数そのものは tier2 まで温存、削減は tier3〜4 のみ(ただし
 * 解像度低下(renderScale)は tier1 から先に始まる — 文字のくっきりさは
 * LabelAtlas 側の頑健化で補う)。
 */
const DENSITY_BY_TIER: readonly number[] = [1.0, 1.0, 1.0, 0.75, 0.5];

/**
 * 原子 = 文字(design-render §5 改: 文字が主役)— 1 draw。
 * 発光球インポスターは廃止し、文字そのものが粒子として漂う。
 * 縁取り焼き込みアトラス + per-atom 着色 + **通常アルファブレンド**
 * (加算は白い空で消えるため不採用)。depthTest on / depthWrite off。
 * 距離カットオフ(A32): カメラから遠い球の文字は頂点シェーダで縮退(draw
 * call は増やさない)— LOD バケット境界(LOD_NEAR_DISTANCE)とおおむね揃える。
 */
export class LabelSystem implements RenderSystem {
  public readonly object: Mesh;

  private readonly geometry: InstancedBufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly atlas: CanvasTexture;
  private readonly attributes: AtomViewAttributes;
  private generation = -1;
  private labelDensity = 1.0;

  constructor(attributes: AtomViewAttributes) {
    this.attributes = attributes;
    this.atlas = createLabelAtlasTexture();

    const quad = createBillboardQuadGeometry();
    this.geometry = new InstancedBufferGeometry();
    this.geometry.setIndex(quad.getIndex());
    this.geometry.setAttribute('position', quad.getAttribute('position'));
    this.geometry.instanceCount = 0;

    this.material = new ShaderMaterial({
      vertexShader: LABEL_VERTEX_GLSL,
      fragmentShader: LABEL_FRAGMENT_GLSL,
      uniforms: {
        uAtlas: { value: this.atlas },
        uAlpha: { value: 0 },
        uStepF: { value: 0 },
        uCamRight: { value: new Vector3(1, 0, 0) },
        uCamUp: { value: new Vector3(0, 1, 0) },
        uLabelCutoffDist: { value: LABEL_CUTOFF_DISTANCE },
        uLabelCutoffFade: { value: LABEL_CUTOFF_FADE },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });

    this.object = new Mesh(this.geometry, this.material);
    this.object.renderOrder = 8; // 半透明群の最後(§1.3)
    this.object.frustumCulled = false;
    this.object.matrixAutoUpdate = false;
    this.syncAttributes();
  }

  public update(_view: SkyRenderView, frame: FrameInfo): void {
    this.syncAttributes();
    // labelDensity(§9.3): 負荷時は末尾から間引く(頻度は毎フレーム一定なので
    // ちらつかない — 集約パッカーの並びは決定的でフレーム間で安定)
    this.geometry.instanceCount = Math.floor(
      this.attributes.count * this.labelDensity,
    );
    const uniforms = this.material.uniforms;
    uniforms.uAlpha.value = frame.alpha;
    uniforms.uStepF.value = frame.stepF;
    writeCameraBasis(
      frame.camera,
      uniforms.uCamRight.value as Vector3,
      uniforms.uCamUp.value as Vector3,
    );
  }

  public applyTier(tier: QualityTier): void {
    this.labelDensity = DENSITY_BY_TIER[tier];
  }

  public dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.atlas.dispose();
  }

  private syncAttributes(): void {
    if (this.generation === this.attributes.generation) return;
    this.generation = this.attributes.generation;
    this.geometry.setAttribute('aPosR', this.attributes.posR);
    this.geometry.setAttribute('aPosRPrev', this.attributes.posRPrev);
    this.geometry.setAttribute('aColorKind', this.attributes.colorKind);
    this.geometry.setAttribute('aAux', this.attributes.aux);
  }
}
