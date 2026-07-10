import {
  AdditiveBlending,
  BackSide,
  FrontSide,
  Group,
  IcosahedronGeometry,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
} from 'three';
import type { SkyRenderView } from '../../contract/RenderView';
import type { SunUniforms } from '../Environment';
import type { FrameInfo, RenderSystem } from '../RenderSystem';
import {
  GLASS_BACK_FRAGMENT_GLSL,
  GLASS_FRONT_FRAGMENT_GLSL,
  GLASS_VERTEX_GLSL,
} from '../shaders/glass';
import type { BubbleInstanceBuffers } from './BubbleInstanceBuffers';

/**
 * 球体ガラス(design-render §3)。
 *
 * IcosahedronGeometry(1, 4) の instanced 2 draw(backside 加算 →
 * frontside αブレンド)。インスタンス属性は BubbleInstanceBuffers を
 * InnerWaterSystem と共有(アップロード 1 回)。加算優位設計なので
 * 球間ソートにほぼ非感応(前後関係は buffers の遠→近順が担保)。
 */
export class BubbleGlassSystem implements RenderSystem {
  public readonly object: Group;

  private readonly geometry: InstancedBufferGeometry;
  private readonly backMaterial: ShaderMaterial;
  private readonly frontMaterial: ShaderMaterial;
  private readonly buffers: BubbleInstanceBuffers;

  constructor(sun: SunUniforms, buffers: BubbleInstanceBuffers) {
    this.buffers = buffers;
    const base = new IcosahedronGeometry(1, 4);
    this.geometry = new InstancedBufferGeometry();
    this.geometry.setIndex(base.getIndex());
    this.geometry.setAttribute('position', base.getAttribute('position'));
    this.geometry.setAttribute('aCurrA', buffers.currA);
    this.geometry.setAttribute('aCurrB', buffers.currB);
    this.geometry.setAttribute('aPrevA', buffers.prevA);
    this.geometry.setAttribute('aPrevB', buffers.prevB);
    this.geometry.setAttribute('aMisc', buffers.misc);
    this.geometry.instanceCount = 0;

    const makeMaterial = (fragment: string, back: boolean): ShaderMaterial => {
      const material = new ShaderMaterial({
        vertexShader: GLASS_VERTEX_GLSL,
        fragmentShader: fragment,
        uniforms: {
          uSunDir: sun.uSunDir,
          uSunColor: sun.uSunColor,
          uAlpha: { value: 0 },
          uTimeSec: { value: 0 },
        },
        transparent: true,
        depthTest: true,
        depthWrite: false,
        side: back ? BackSide : FrontSide,
      });
      if (back) material.blending = AdditiveBlending;
      return material;
    };

    this.backMaterial = makeMaterial(GLASS_BACK_FRAGMENT_GLSL, true);
    this.frontMaterial = makeMaterial(GLASS_FRONT_FRAGMENT_GLSL, false);

    this.object = new Group();
    this.object.matrixAutoUpdate = false;
    const backMesh = new Mesh(this.geometry, this.backMaterial);
    backMesh.renderOrder = 6;
    const frontMesh = new Mesh(this.geometry, this.frontMaterial);
    frontMesh.renderOrder = 7;
    for (const mesh of [backMesh, frontMesh]) {
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      this.object.add(mesh);
    }
  }

  public update(_view: SkyRenderView, frame: FrameInfo): void {
    // 属性は BubbleInstanceBuffers.sync(SceneRenderer が毎フレーム 1 回)済み
    this.geometry.instanceCount = this.buffers.count;
    this.backMaterial.uniforms.uAlpha.value = frame.alpha;
    this.backMaterial.uniforms.uTimeSec.value = frame.timeSec;
    this.frontMaterial.uniforms.uAlpha.value = frame.alpha;
    this.frontMaterial.uniforms.uTimeSec.value = frame.timeSec;
  }

  public dispose(): void {
    this.geometry.dispose();
    this.backMaterial.dispose();
    this.frontMaterial.dispose();
  }
}
