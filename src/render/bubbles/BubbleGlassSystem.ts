import {
  AdditiveBlending,
  BackSide,
  type BufferAttribute,
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
import type {
  BubbleBucket,
  BubbleInstanceBuffers,
} from './BubbleInstanceBuffers';

/**
 * 球体ガラス(design-render §3、裁定 A32 で距離 LOD 2 バケット化)。
 *
 * IcosahedronGeometry の instanced 2 draw(backside 加算 → frontside
 * αブレンド)を near/far バケットそれぞれに張る(計 4 draw)。近距離は
 * detail4(現状品質)、遠距離は detail3(A51 — A32 の detail2 は A42 の
 * サイズ上限拡大(2.3)で遠距離でも画面上のフットプリントが大きくなり
 * ファセット(多角形の稜線)が視認できたため引き上げ。近距離 detail4 との
 * 中間品質)。インスタンス属性は BubbleInstanceBuffers を InnerWaterSystem と
 * 共有(アップロード 1 回)。加算優位設計なので球間ソートにほぼ非感応
 * (前後関係は buffers の遠→近順 + renderOrder の far→near 順が担保)。
 */
export class BubbleGlassSystem implements RenderSystem {
  public readonly object: Group;

  private readonly nearGeometry: InstancedBufferGeometry;
  private readonly farGeometry: InstancedBufferGeometry;
  private readonly backMaterial: ShaderMaterial;
  private readonly frontMaterial: ShaderMaterial;
  private readonly buffers: BubbleInstanceBuffers;

  constructor(sun: SunUniforms, buffers: BubbleInstanceBuffers) {
    this.buffers = buffers;
    const nearBase = new IcosahedronGeometry(1, 4); // 近距離ディテール(§3、不変)
    const farBase = new IcosahedronGeometry(1, 3); // 遠距離 LOD(A32 detail2 → A51 detail3)
    this.nearGeometry = makeInstanced(nearBase, buffers.near);
    this.farGeometry = makeInstanced(farBase, buffers.far);

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
    // renderOrder: far バケットを先に描く(基準値)→ near バケット(+0.5)。
    // 全体の遠→近 painter's order を維持する(§1.3)
    const backFar = new Mesh(this.farGeometry, this.backMaterial);
    backFar.renderOrder = 6;
    const backNear = new Mesh(this.nearGeometry, this.backMaterial);
    backNear.renderOrder = 6.5;
    const frontFar = new Mesh(this.farGeometry, this.frontMaterial);
    frontFar.renderOrder = 7;
    const frontNear = new Mesh(this.nearGeometry, this.frontMaterial);
    frontNear.renderOrder = 7.5;
    for (const mesh of [backFar, backNear, frontFar, frontNear]) {
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      this.object.add(mesh);
    }
  }

  public update(_view: SkyRenderView, frame: FrameInfo): void {
    // 属性は BubbleInstanceBuffers.sync(SceneRenderer が毎フレーム 1 回)済み
    this.nearGeometry.instanceCount = this.buffers.near.count;
    this.farGeometry.instanceCount = this.buffers.far.count;
    this.backMaterial.uniforms.uAlpha.value = frame.alpha;
    this.backMaterial.uniforms.uTimeSec.value = frame.timeSec;
    this.frontMaterial.uniforms.uAlpha.value = frame.alpha;
    this.frontMaterial.uniforms.uTimeSec.value = frame.timeSec;
  }

  public dispose(): void {
    this.nearGeometry.dispose();
    this.farGeometry.dispose();
    this.backMaterial.dispose();
    this.frontMaterial.dispose();
  }
}

const makeInstanced = (
  base: IcosahedronGeometry,
  bucket: BubbleBucket,
): InstancedBufferGeometry => {
  const geometry = new InstancedBufferGeometry();
  geometry.setIndex(base.getIndex());
  geometry.setAttribute(
    'position',
    base.getAttribute('position') as BufferAttribute,
  );
  geometry.setAttribute('aCurrA', bucket.currA);
  geometry.setAttribute('aCurrB', bucket.currB);
  geometry.setAttribute('aPrevA', bucket.prevA);
  geometry.setAttribute('aPrevB', bucket.prevB);
  geometry.setAttribute('aMisc', bucket.misc);
  geometry.instanceCount = 0;
  return geometry;
};
