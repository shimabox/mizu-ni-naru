import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { SkyRenderView } from '../../contract/RenderView';
import { DROPLET_VIEW_CAPACITY } from '../../contract/WorldSpec';
import type { SunUniforms } from '../Environment';
import type { FrameInfo, RenderSystem } from '../RenderSystem';
import { DROPLET_FRAGMENT_GLSL, DROPLET_VERTEX_GLSL } from '../shaders/droplet';
import { createBillboardQuadGeometry, writeCameraBasis } from './billboard';

const V4 = 4;

/**
 * 雫インポスター(design-render §5、裁定 A31)— 1 draw・不透明 + discard・
 * depthWrite ON。溜まった水と同じ #007fff 系の水色が本体(A31 — 白コアなし)。
 * sway は sim が posr に焼き込み済み(A9)なので位置には何も足さない。
 * aux は pop-in(spawnStep)と tint(seed)のみ。
 */
export class DropletSystem implements RenderSystem {
  public readonly object: Mesh;

  private readonly geometry: InstancedBufferGeometry;
  private readonly material: ShaderMaterial;
  private posR: InstancedBufferAttribute;
  private posRPrev: InstancedBufferAttribute;
  private aux: InstancedBufferAttribute;
  private lastArray: Float32Array;
  private lastUploadedStep = -1;

  constructor(sun: SunUniforms) {
    const quad = createBillboardQuadGeometry();
    this.geometry = new InstancedBufferGeometry();
    this.geometry.setIndex(quad.getIndex());
    this.geometry.setAttribute('position', quad.getAttribute('position'));
    this.geometry.instanceCount = 0;

    const empty = new Float32Array(DROPLET_VIEW_CAPACITY * V4);
    this.lastArray = empty;
    this.posR = wrap(empty);
    this.posRPrev = wrap(new Float32Array(DROPLET_VIEW_CAPACITY * V4));
    this.aux = wrap(new Float32Array(DROPLET_VIEW_CAPACITY * V4));
    this.applyAttributes();

    this.material = new ShaderMaterial({
      vertexShader: DROPLET_VERTEX_GLSL,
      fragmentShader: DROPLET_FRAGMENT_GLSL,
      uniforms: {
        ...sun,
        uAlpha: { value: 0 },
        uStepF: { value: 0 },
        uCamRight: { value: new Vector3(1, 0, 0) },
        uCamUp: { value: new Vector3(0, 1, 0) },
      },
      transparent: false,
      depthTest: true,
      depthWrite: true,
    });

    this.object = new Mesh(this.geometry, this.material);
    this.object.renderOrder = 1; // 不透明: 原子の次(§1.3)
    this.object.frustumCulled = false;
    this.object.matrixAutoUpdate = false;
  }

  public update(view: SkyRenderView, frame: FrameInfo): void {
    const droplets = view.droplets;
    let rewrapped = false;
    if (this.lastArray !== droplets.posr) {
      // 再確保(実運用では発生しない想定)— 再ラップ
      this.lastArray = droplets.posr;
      this.posR = wrap(droplets.posr);
      this.posRPrev = wrap(droplets.prevPosr);
      this.aux = wrap(droplets.aux);
      this.applyAttributes();
      rewrapped = true;
    }
    if (rewrapped || this.lastUploadedStep !== view.step) {
      this.lastUploadedStep = view.step;
      const length = droplets.count * V4;
      for (const attribute of [this.posR, this.posRPrev, this.aux]) {
        attribute.clearUpdateRanges();
        attribute.addUpdateRange(0, length);
        attribute.needsUpdate = true;
      }
    }
    this.geometry.instanceCount = droplets.count;

    const uniforms = this.material.uniforms;
    uniforms.uAlpha.value = frame.alpha;
    uniforms.uStepF.value = frame.stepF;
    writeCameraBasis(
      frame.camera,
      uniforms.uCamRight.value as Vector3,
      uniforms.uCamUp.value as Vector3,
    );
  }

  public dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }

  private applyAttributes(): void {
    this.geometry.setAttribute('aPosR', this.posR);
    this.geometry.setAttribute('aPosRPrev', this.posRPrev);
    this.geometry.setAttribute('aAux', this.aux);
  }
}

const wrap = (array: Float32Array): InstancedBufferAttribute => {
  const attribute = new InstancedBufferAttribute(array, V4);
  attribute.setUsage(DynamicDrawUsage);
  return attribute;
};
