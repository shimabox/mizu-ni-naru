import {
  BufferAttribute,
  BufferGeometry,
  InstancedBufferGeometry,
  Mesh,
  type PerspectiveCamera,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { SkyRenderView } from '../../contract/RenderView';
import type { FrameInfo, RenderSystem } from '../RenderSystem';
import { ATOM_FRAGMENT_GLSL, ATOM_VERTEX_GLSL } from '../shaders/atom';
import type { AtomViewAttributes } from './AtomViewAttributes';

/** ビルボード quad(corner ∈ [-1,1]² — 画面空間 CCW)。 */
export const createBillboardQuadGeometry = (): BufferGeometry => {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(
      new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]),
      3,
    ),
  );
  geometry.setIndex(
    new BufferAttribute(new Uint16Array([0, 1, 2, 2, 1, 3]), 1),
  );
  return geometry;
};

/** カメラの右/上ベクトルを uniform Vector3 へ書く(割付なし)。 */
export const writeCameraBasis = (
  camera: PerspectiveCamera,
  right: Vector3,
  up: Vector3,
): void => {
  const e = camera.matrixWorld.elements;
  right.set(e[0], e[1], e[2]);
  up.set(e[4], e[5], e[6]);
};

/**
 * 原子インポスター(design-render §5)— 1 draw・不透明 + discard・
 * depthWrite ON(early-z 有効)。prev/curr は頂点 lerp、パルス/フェードは
 * aux[spawnStep, seed] 駆動(裁定 A6)。
 */
export class AtomSystem implements RenderSystem {
  public readonly object: Mesh;

  private readonly geometry: InstancedBufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly attributes: AtomViewAttributes;
  private generation = -1;

  constructor(attributes: AtomViewAttributes) {
    this.attributes = attributes;

    const quad = createBillboardQuadGeometry();
    this.geometry = new InstancedBufferGeometry();
    this.geometry.setIndex(quad.getIndex());
    this.geometry.setAttribute('position', quad.getAttribute('position'));
    this.geometry.instanceCount = 0;

    this.material = new ShaderMaterial({
      vertexShader: ATOM_VERTEX_GLSL,
      fragmentShader: ATOM_FRAGMENT_GLSL,
      uniforms: {
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
    this.object.renderOrder = 0; // 不透明先頭(§1.3)
    this.object.frustumCulled = false;
    this.object.matrixAutoUpdate = false;
    this.syncAttributes();
  }

  public update(_view: SkyRenderView, frame: FrameInfo): void {
    // AtomViewAttributes.sync は SceneRenderer が毎フレーム 1 回実施済み
    this.syncAttributes();
    this.geometry.instanceCount = this.attributes.count;
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

  private syncAttributes(): void {
    if (this.generation === this.attributes.generation) return;
    this.generation = this.attributes.generation;
    this.geometry.setAttribute('aPosR', this.attributes.posR);
    this.geometry.setAttribute('aPosRPrev', this.attributes.posRPrev);
    this.geometry.setAttribute('aColorKind', this.attributes.colorKind);
    this.geometry.setAttribute('aAux', this.attributes.aux);
  }
}
