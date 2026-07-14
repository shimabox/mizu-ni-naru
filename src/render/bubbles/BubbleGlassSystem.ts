import {
  AdditiveBlending,
  BackSide,
  type BufferAttribute,
  type BufferGeometry,
  FrontSide,
  Group,
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
import { createForegroundBubbleGeometry } from './BubbleGeometry';
import type {
  BubbleBucket,
  BubbleInstanceBuffers,
} from './BubbleInstanceBuffers';

/**
 * 球体ガラス(design-render §3、裁定 A32 で距離 LOD 2 バケット化)。
 *
 * IcosahedronGeometry の instanced 2 draw(backside 加算 → frontside
 * αブレンド)を near/far バケットそれぞれに張る(計 4 draw)。近距離・
 * 遠距離とも detail6。インスタンス属性は
 * BubbleInstanceBuffers を InnerWaterSystem と共有(アップロード 1 回)。
 * 加算優位設計なので球間ソートにほぼ非感応(前後関係は buffers の
 * 遠→近順 + renderOrder の far→near 順が担保)。
 *
 * A58「多角形が再発」切り分け実験の結論: LOD_NEAR_DISTANCE(15u)は camera
 * との 3D ユークリッド距離のみで判定するため、A56 で高さ帯上限が
 * 6.0→9.0 に拡大されたことで、近リング寄りの水平距離が近い球でも
 * 「カメラより 5u 前後高い」だけで容易に 15u を超え、遠距離バケットへ
 * 押し出されるケースが増えた(実測: 遠距離判定のうち y∈[7.6,8.6] 帯の
 * 新規ケースが dist 15.1〜18.7u に集中)。この種の球は画面上ではまだ
 * 大きく近いため、旧 detail3(320tri)のファセットがフレネルの縁で
 * 露呈した。実験(全球を強制的に near バケットへ寄せる/detail3→4 に
 * 引き上げる)で稜線が消えることを確認 — LOD_NEAR_DISTANCE 自体や
 * sim の高さ帯(config.ts、変更禁止)には触れず、遠距離バケットの
 * ジオメトリ品質を近距離と同じ detail4 まで引き上げて解消する
 * (draw call 数は不変、三角形数のみ +約 10%)。
 *
 * 2026-07-14の固定画像比較では、そのdetail4(500tri)にも大きく映る球の
 * 外周へ短い直線区間が残った。shader法線は既に球面正規化されており、原因は
 * 面内陰影ではなくシルエット密度だった。detail5にも平坦部が残り、detail6
 * (980tri)で解消したため、GlassとInnerWater volumeを共通factoryから生成する。
 * 片方だけでは青い水体または透明リムのどちらかに角ばりが残る。
 *
 * A52 不変条件(「球体は球に見えるように、妥協しない」): 本クラスは
 * applyTier を実装しない — near/far の分割レベル(detail6 固定)は
 * どのティアでも変わらない。品質ラダーで負荷を吸収する対象は他システムの
 * renderScale/dprCap・エフェクトノブのみで、主役である球体ジオメトリの
 * 丸さはティア制御の対象外。
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
    const nearBase = createForegroundBubbleGeometry();
    const farBase = createForegroundBubbleGeometry();
    this.nearGeometry = makeInstanced(nearBase, buffers.near);
    this.farGeometry = makeInstanced(farBase, buffers.far);

    const makeMaterial = (fragment: string, back: boolean): ShaderMaterial => {
      const material = new ShaderMaterial({
        vertexShader: GLASS_VERTEX_GLSL,
        fragmentShader: fragment,
        uniforms: {
          ...sun,
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
  base: BufferGeometry,
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
