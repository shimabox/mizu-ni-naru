import {
  type BufferAttribute,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
} from 'three';
import type { SkyRenderView } from '../../contract/RenderView';
import { SLOT_COUNT_MOBILE } from '../../contract/WorldSpec';
import type { SunUniforms } from '../Environment';
import type { FrameInfo, QualityTier, RenderSystem } from '../RenderSystem';
import {
  BACKDROP_FRAGMENT_GLSL,
  BACKDROP_VERTEX_GLSL,
} from '../shaders/backdrop';

/** 遠景フィールドの個体数(裁定 A41 — 「もっと多くの球体で壮大に」)。 */
export const BACKDROP_COUNT_DESKTOP = 250;
export const BACKDROP_COUNT_MOBILE = 100;
/**
 * ティア → backdropCount 比率(Phase 4 AdaptiveQuality の追加ノブ)。
 * A52 最終: エフェクト(世界の空気)は解像度より優先度が高いため tier2 まで
 * 完全温存(1.0)、削減は tier3 以降のみ。
 */
const COUNT_FRACTION_BY_TIER: readonly number[] = [1.0, 1.0, 1.0, 0.6, 0.3];

/**
 * 遠景の書き割り球体フィールド(design-render 拡張 — 裁定 A41)。
 *
 * sim・契約・リズムには一切触れない **render 専用の装飾レイヤー**。
 * BubbleGlassSystem/InnerWaterSystem と違い BubbleInstanceBuffers を使わず、
 * per-instance の属性は `aIdx`(0..N-1)1 個だけ — 位置・サイズ・水位・
 * 落下周期はすべて shaders/backdrop.ts の頂点シェーダが `uTimeSec` と
 * ハッシュから毎フレーム閉形式で導出する(状態を持たない = 巻き戻し可能、
 * JS 側のアップロードは構築時 1 回のみ)。
 *
 * インスタンス数は desktop 250 / mobile 100(A41)を固定バッファ 250 個ぶん
 * 確保し、`geometry.instanceCount` だけを毎フレーム安く切り替える
 * (SkyRenderView に slotCount が無いため `bubbles.count` から
 * MizuNiNaruSim と同じ判定式で mobile/desktop を推定 — §7.1 のパシング
 * 判定と同型)。頂点シェーダの `uCount` も同じ値を渡し、間引いても
 * 半径帯 [40,180] 全域に薄く広がる螺旋配置を保つ。
 *
 * 1 material・1 mesh・1 draw(A35 の draw call 予算 ≤20 内、追加 ≤2 の枠に収まる)。
 * 前面のみの軽量αブレンド(BubbleGlassSystem のような back/front 2 パスは
 * 遠景では過剰品質のため行わない)。
 */
export class BackdropBubbles implements RenderSystem {
  public readonly object: Mesh;

  private readonly geometry: InstancedBufferGeometry;
  private readonly material: ShaderMaterial;
  private countFraction = 1.0;

  constructor(sun: SunUniforms) {
    const base = new IcosahedronGeometry(1, 2); // 遠景・小径 — A51: detail1→2 でファセット低減
    this.geometry = new InstancedBufferGeometry();
    this.geometry.setIndex(base.getIndex());
    this.geometry.setAttribute(
      'position',
      base.getAttribute('position') as BufferAttribute,
    );
    base.dispose();

    const aIdx = new Float32Array(BACKDROP_COUNT_DESKTOP);
    for (let i = 0; i < BACKDROP_COUNT_DESKTOP; i++) aIdx[i] = i;
    this.geometry.setAttribute('aIdx', new InstancedBufferAttribute(aIdx, 1));
    this.geometry.instanceCount = 0; // 初回 update() まで描かない

    this.material = new ShaderMaterial({
      vertexShader: BACKDROP_VERTEX_GLSL,
      fragmentShader: BACKDROP_FRAGMENT_GLSL,
      uniforms: {
        uTimeSec: { value: 0 },
        uCount: { value: BACKDROP_COUNT_DESKTOP },
        uSunDir: sun.uSunDir,
        uSunColor: sun.uSunColor,
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });

    this.object = new Mesh(this.geometry, this.material);
    this.object.frustumCulled = false; // 位置は頂点シェーダが導出(bbox 不明)
    this.object.matrixAutoUpdate = false;
    // renderOrder: スカイ(3)の直後・近景の半透明群(InnerWater 4〜/Glass 6〜)の前
    // — 遠景を先に敷いてから近景を重ねる painter's order(§1.3 と同じ考え方)
    this.object.renderOrder = 3.5;
  }

  public update(view: SkyRenderView, frame: FrameInfo): void {
    // slotCount は契約に無いため MizuNiNaruSim と同じ判定式(bubbles.count ベース)
    // を使う(A32/A40 §7.1 と同型 — mobile ⇔ SLOT_COUNT_MOBILE 以下)
    const base =
      view.bubbles.count <= SLOT_COUNT_MOBILE
        ? BACKDROP_COUNT_MOBILE
        : BACKDROP_COUNT_DESKTOP;
    // backdropCount ノブ(Phase 4): ティアで比率を落とす(250→150→75 等)
    const count = Math.max(0, Math.floor(base * this.countFraction));
    this.geometry.instanceCount = count;
    this.material.uniforms.uCount.value = count;
    this.material.uniforms.uTimeSec.value = frame.timeSec;
  }

  /**
   * countFraction のみを変える — **球体ジオメトリの分割レベル(detail2)は
   * ティア非対象**(A52 不変条件「球体は球に見えるように、妥協しない」)。
   * 減らすのは遠景球の個数だけで、残った球 1 個ずつの丸さは全ティアで不変。
   */
  public applyTier(tier: QualityTier): void {
    this.countFraction = COUNT_FRACTION_BY_TIER[tier];
  }

  public dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
