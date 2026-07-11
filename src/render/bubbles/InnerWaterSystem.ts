import {
  BufferAttribute,
  BufferGeometry,
  Color,
  type DataTexture,
  FrontSide,
  Group,
  IcosahedronGeometry,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  Vector4,
} from 'three';
import type { SkyRenderView } from '../../contract/RenderView';
import {
  BUBBLE_CAPACITY,
  BUBBLE_STATE,
  RIPPLE_VIEW_CAPACITY,
} from '../../contract/WorldSpec';
import type { SunUniforms } from '../Environment';
import type { FrameInfo, RenderSystem } from '../RenderSystem';
import {
  INNER_CAP_FRAGMENT_GLSL,
  INNER_CAP_VERTEX_GLSL,
  RIPPLES_PER_BUBBLE,
  RIPPLE_NEAR_COUNT,
} from '../shaders/innerCap';
import {
  INNER_WATER_FRAGMENT_GLSL,
  INNER_WATER_VERTEX_GLSL,
} from '../shaders/innerWater';
import type {
  BubbleBucket,
  BubbleInstanceBuffers,
} from './BubbleInstanceBuffers';

/** 「発火していない」を示す誕生 stepF(age が巨大 → 減衰で消滅)。 */
const RIPPLE_DEAD_BIRTH = -1e6;

/** キャップの単位円盤グリッド(近距離: 24 リング × 48 セグメント — §4b)。 */
const CAP_RINGS_NEAR = 24;
const CAP_SEGMENTS_NEAR = 48;
/**
 * 遠距離 LOD(A32、A54 で引き上げ)。8×16 は水面キャップの円弧が多角形に
 * 見えるほど粗く、ガラス(detail2 相当)との滑らかさの差が目立っていた。
 * 16×32 に倍増しガラスと同程度の見た目粒度に揃える。
 */
const CAP_RINGS_FAR = 16;
const CAP_SEGMENTS_FAR = 32;

const createCapDiskGeometry = (
  rings: number,
  segments: number,
): BufferGeometry => {
  const vertexCount = 1 + rings * segments;
  const positions = new Float32Array(vertexCount * 3);
  let p = 3;
  for (let k = 0; k < rings; k++) {
    const r = (k + 1) / rings;
    for (let s = 0; s < segments; s++) {
      const theta = (2 * Math.PI * s) / segments;
      positions[p] = r * Math.cos(theta);
      positions[p + 1] = 0;
      positions[p + 2] = r * Math.sin(theta);
      p += 3;
    }
  }
  const triCount = segments + (rings - 1) * segments * 2;
  const indices = new Uint16Array(triCount * 3);
  let i = 0;
  const ringStart = (k: number): number => 1 + k * segments;
  for (let s = 0; s < segments; s++) {
    const s1 = (s + 1) % segments;
    indices[i++] = 0;
    indices[i++] = ringStart(0) + s1;
    indices[i++] = ringStart(0) + s;
  }
  for (let k = 0; k < rings - 1; k++) {
    const inner = ringStart(k);
    const outer = ringStart(k + 1);
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      indices[i++] = inner + s;
      indices[i++] = inner + s1;
      indices[i++] = outer + s;
      indices[i++] = inner + s1;
      indices[i++] = outer + s1;
      indices[i++] = outer + s;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return geometry;
};

/**
 * 球内の水(design-render §4、裁定 A32 で距離 LOD 2 バケット化)— 体積 2 draw
 * (near/far)+ 水面キャップ 2 draw(near/far)。
 *
 * per-instance 属性は BubbleGlassSystem と同一の BubbleInstanceBuffers
 * (near/far バケット)を共有。InnerRippleView のイベントはレンダー側
 * リングバッファ(カメラ近傍 RIPPLE_NEAR_COUNT 球 × 6 本、古い順上書き)に
 * 保持し、uniform `uInnerRipples`として解析リング波をキャップの法線と
 * 体積の透過光(水中を通る明暗の輪 — A43)の双方に注入する(A7/A8/A32)。
 * volumeMaterial / capMaterial は同一の JS 配列(this.rippleUniform)を
 * 参照するため更新は ingestRipples() の 1 箇所で両方に反映される。
 */
export class InnerWaterSystem implements RenderSystem {
  public readonly object: Group;

  private readonly volumeNearGeometry: InstancedBufferGeometry;
  private readonly volumeFarGeometry: InstancedBufferGeometry;
  private readonly capNearGeometry: InstancedBufferGeometry;
  private readonly capFarGeometry: InstancedBufferGeometry;
  private readonly volumeMaterial: ShaderMaterial;
  private readonly capMaterial: ShaderMaterial;
  private readonly buffers: BubbleInstanceBuffers;

  private readonly rippleUniform: Vector4[];
  private readonly rippleCursor = new Int32Array(RIPPLE_NEAR_COUNT);
  private readonly lastState = new Int32Array(BUBBLE_CAPACITY).fill(
    BUBBLE_STATE.Dead,
  );

  constructor(
    sun: SunUniforms,
    buffers: BubbleInstanceBuffers,
    noiseTexture: DataTexture,
  ) {
    this.buffers = buffers;

    this.rippleUniform = [];
    for (let i = 0; i < RIPPLE_NEAR_COUNT * RIPPLES_PER_BUBBLE; i++) {
      this.rippleUniform.push(new Vector4(0, 0, RIPPLE_DEAD_BIRTH, 0));
    }

    const sssColor = new Color(0x2fc0a8);

    // A54: 「まだ多角形に見える — 中の水が多角形では?」(ユーザー指摘・仮説的中)。
    // A51 はガラスと書き割りのみ引き上げ、水の体積ジオメトリを直し忘れていた。
    // A48 で水がほぼ不透明になり水のシルエットが球体知覚を支配するため、
    // ガラス(near detail4 / far detail2)と同レベルまで引き上げてカクつきを解消する。
    const volumeNearBase = new IcosahedronGeometry(1, 4); // 近距離ディテール(A54 — ガラス近距離と同一detail4に統一)
    const volumeFarBase = new IcosahedronGeometry(1, 3); // 遠距離 LOD(A54 — detail1→detail3 に引き上げ、シルエットをガラスに揃える)
    this.volumeNearGeometry = makeInstanced(volumeNearBase, buffers.near);
    this.volumeFarGeometry = makeInstanced(volumeFarBase, buffers.far);
    this.volumeMaterial = new ShaderMaterial({
      vertexShader: INNER_WATER_VERTEX_GLSL,
      fragmentShader: INNER_WATER_FRAGMENT_GLSL,
      uniforms: {
        uAlpha: { value: 0 },
        uTimeSec: { value: 0 },
        uStepF: { value: 0 },
        uNoise: { value: noiseTexture },
        uSssColor: { value: sssColor },
        // A43: キャップと同じリングバッファ配列を共有(体積側でも水中の
        // 光の輪として評価 — 更新は ingestRipples() の 1 箇所のみ)
        uInnerRipples: { value: this.rippleUniform },
      },
      transparent: true,
      depthTest: true,
      depthWrite: true, // §1.3 — A25 不変条件でソート不要に閉じる
      side: FrontSide,
    });

    const capNearBase = createCapDiskGeometry(
      CAP_RINGS_NEAR,
      CAP_SEGMENTS_NEAR,
    );
    const capFarBase = createCapDiskGeometry(CAP_RINGS_FAR, CAP_SEGMENTS_FAR);
    this.capNearGeometry = makeInstanced(capNearBase, buffers.near);
    this.capFarGeometry = makeInstanced(capFarBase, buffers.far);
    this.capMaterial = new ShaderMaterial({
      vertexShader: INNER_CAP_VERTEX_GLSL,
      fragmentShader: INNER_CAP_FRAGMENT_GLSL,
      uniforms: {
        uSunDir: sun.uSunDir,
        uSunColor: sun.uSunColor,
        uAlpha: { value: 0 },
        uTimeSec: { value: 0 },
        uStepF: { value: 0 },
        uSssColor: { value: sssColor },
        uInnerRipples: { value: this.rippleUniform },
      },
      transparent: true,
      depthTest: true,
      depthWrite: true,
      side: FrontSide,
    });

    this.object = new Group();
    this.object.matrixAutoUpdate = false;
    // renderOrder: far バケット(基準値)→ near バケット(+0.5)で遠→近を維持(§1.3)
    const volumeFarMesh = new Mesh(this.volumeFarGeometry, this.volumeMaterial);
    volumeFarMesh.renderOrder = 4;
    const volumeNearMesh = new Mesh(
      this.volumeNearGeometry,
      this.volumeMaterial,
    );
    volumeNearMesh.renderOrder = 4.5;
    const capFarMesh = new Mesh(this.capFarGeometry, this.capMaterial);
    capFarMesh.renderOrder = 5;
    const capNearMesh = new Mesh(this.capNearGeometry, this.capMaterial);
    capNearMesh.renderOrder = 5.5;
    for (const mesh of [
      volumeFarMesh,
      volumeNearMesh,
      capFarMesh,
      capNearMesh,
    ]) {
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      this.object.add(mesh);
    }
  }

  public update(view: SkyRenderView, frame: FrameInfo): void {
    this.volumeNearGeometry.instanceCount = this.buffers.near.count;
    this.volumeFarGeometry.instanceCount = this.buffers.far.count;
    this.capNearGeometry.instanceCount = this.buffers.near.count;
    this.capFarGeometry.instanceCount = this.buffers.far.count;

    this.volumeMaterial.uniforms.uAlpha.value = frame.alpha;
    this.volumeMaterial.uniforms.uTimeSec.value = frame.timeSec;
    this.volumeMaterial.uniforms.uStepF.value = frame.stepF;
    this.capMaterial.uniforms.uAlpha.value = frame.alpha;
    this.capMaterial.uniforms.uTimeSec.value = frame.timeSec;
    this.capMaterial.uniforms.uStepF.value = frame.stepF;

    this.ingestRipples(view);
  }

  public dispose(): void {
    this.volumeNearGeometry.dispose();
    this.volumeFarGeometry.dispose();
    this.capNearGeometry.dispose();
    this.capFarGeometry.dispose();
    this.volumeMaterial.dispose();
    this.capMaterial.dispose();
  }

  /**
   * InnerRippleView → カメラ近傍 RIPPLE_NEAR_COUNT 球のリングバッファ
   * (古い順上書き)+ 再誕生でクリア(A32: rippleIndexBySlot 経由の間接参照)。
   */
  private ingestRipples(view: SkyRenderView): void {
    const bubbles = view.bubbles;
    const count = Math.min(bubbles.count, BUBBLE_CAPACITY);
    const rippleIndexBySlot = this.buffers.rippleIndexBySlot;
    for (let slot = 0; slot < count; slot++) {
      const state = Math.floor(bubbles.data[slot * 8 + 7]);
      if (
        state === BUBBLE_STATE.Spawning &&
        this.lastState[slot] !== BUBBLE_STATE.Spawning
      ) {
        // スロット再利用(世代交代)— 前世代の波紋を消す(近傍追跡中のみ)
        const rIdx = rippleIndexBySlot[slot];
        if (rIdx >= 0) {
          const base = rIdx * RIPPLES_PER_BUBBLE;
          for (let k = 0; k < RIPPLES_PER_BUBBLE; k++) {
            this.rippleUniform[base + k].set(0, 0, RIPPLE_DEAD_BIRTH, 0);
          }
          this.rippleCursor[rIdx] = 0;
        }
      }
      this.lastState[slot] = state;
    }

    const ripples = view.ripples;
    const n = Math.min(ripples.count, RIPPLE_VIEW_CAPACITY);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const slot = ripples.data[o];
      if (slot < 0 || slot >= BUBBLE_CAPACITY) continue;
      const rIdx = rippleIndexBySlot[slot];
      if (rIdx < 0) continue; // 遠方球(カメラ近傍 12 球の対象外)は微波のみ(A32)
      const cursor = this.rippleCursor[rIdx];
      this.rippleUniform[rIdx * RIPPLES_PER_BUBBLE + cursor].set(
        ripples.data[o + 1], // localX(球ローカル世界単位 — A8)
        ripples.data[o + 2], // localZ
        view.step,
        ripples.data[o + 3], // strength
      );
      this.rippleCursor[rIdx] = (cursor + 1) % RIPPLES_PER_BUBBLE;
    }
  }
}

const makeInstanced = (
  base: IcosahedronGeometry | BufferGeometry,
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
