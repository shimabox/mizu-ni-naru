import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  type PerspectiveCamera,
} from 'three';
import type { SkyRenderView } from '../../contract/RenderView';
import { BUBBLE_CAPACITY } from '../../contract/WorldSpec';
import { RIPPLE_NEAR_COUNT } from '../shaders/innerCap';

const STRIDE = 8;
const V4 = 4;

/**
 * 全球の CPU 距離ソート(design-render §1.3)— 遠→近のインスタンス順。
 * αブレンドの正順(painter's order)。挿入ソート・割付なし(≤ BUBBLE_CAPACITY 要素)。
 * 純ロジック(テスト対象)。outOrder には count 個のスロット番号が書かれる。
 */
export const sortBubblesFarToNear = (
  data: Float32Array,
  count: number,
  camX: number,
  camY: number,
  camZ: number,
  outOrder: Int32Array,
): void => {
  const d2 = SORT_KEYS;
  for (let i = 0; i < count; i++) {
    const o = i * STRIDE;
    const dx = data[o] - camX;
    const dy = data[o + 1] - camY;
    const dz = data[o + 2] - camZ;
    d2[i] = dx * dx + dy * dy + dz * dz;
    outOrder[i] = i;
  }
  for (let i = 1; i < count; i++) {
    const key = outOrder[i];
    const keyD = d2[key];
    let j = i - 1;
    while (j >= 0 && d2[outOrder[j]] < keyD) {
      outOrder[j + 1] = outOrder[j];
      j--;
    }
    outOrder[j + 1] = key;
  }
};
const SORT_KEYS = new Float64Array(BUBBLE_CAPACITY);

/**
 * 球の per-generation 視覚シード(裁定 A22 — 契約に seed は無い)。
 * R は世代ごとに再ロールされるので hash(slot, R) で世代ごとに自然に変わる。
 * 純ロジック(テスト対象)。
 */
export const bubbleVisualSeed = (slot: number, r: number): number => {
  const x = Math.sin(slot * 12.9898 + r * 783.233) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * 距離 LOD の近/遠バケット境界(u — 裁定 A32、視覚調整値)。
 * カメラからの距離がこれ未満なら高ディテール(near)、以上なら低ディテール
 * (far)ジオメトリで描画する(BubbleGlassSystem / InnerWaterSystem が使用)。
 */
export const LOD_NEAR_DISTANCE = 15;
const LOD_NEAR_DISTANCE_SQ = LOD_NEAR_DISTANCE * LOD_NEAR_DISTANCE;

/** バケット単位のインスタンス属性一式(near/far で共通の形)。 */
export interface BubbleBucket {
  readonly currA: InstancedBufferAttribute;
  readonly currB: InstancedBufferAttribute;
  readonly prevA: InstancedBufferAttribute;
  readonly prevB: InstancedBufferAttribute;
  /** [rippleIndex(0..RIPPLE_NEAR_COUNT-1 または -1), seed] — 裁定 A32。 */
  readonly misc: InstancedBufferAttribute;
  count: number;
}

class MutableBucket implements BubbleBucket {
  public readonly currA: InstancedBufferAttribute;
  public readonly currB: InstancedBufferAttribute;
  public readonly prevA: InstancedBufferAttribute;
  public readonly prevB: InstancedBufferAttribute;
  public readonly misc: InstancedBufferAttribute;
  public count = 0;

  public readonly fCurrA = new Float32Array(BUBBLE_CAPACITY * V4);
  public readonly fCurrB = new Float32Array(BUBBLE_CAPACITY * V4);
  public readonly fPrevA = new Float32Array(BUBBLE_CAPACITY * V4);
  public readonly fPrevB = new Float32Array(BUBBLE_CAPACITY * V4);
  public readonly fMisc = new Float32Array(BUBBLE_CAPACITY * 2);

  constructor() {
    this.currA = makeAttribute(this.fCurrA, V4);
    this.currB = makeAttribute(this.fCurrB, V4);
    this.prevA = makeAttribute(this.fPrevA, V4);
    this.prevB = makeAttribute(this.fPrevB, V4);
    this.misc = makeAttribute(this.fMisc, 2);
  }

  public upload(): void {
    const n = this.count;
    uploadRange(this.currA, n * V4);
    uploadRange(this.currB, n * V4);
    uploadRange(this.prevA, n * V4);
    uploadRange(this.prevB, n * V4);
    uploadRange(this.misc, n * 2);
  }
}

const makeAttribute = (
  array: Float32Array,
  itemSize: number,
): InstancedBufferAttribute => {
  const attribute = new InstancedBufferAttribute(array, itemSize);
  attribute.setUsage(DynamicDrawUsage);
  return attribute;
};

const uploadRange = (
  attribute: InstancedBufferAttribute,
  length: number,
): void => {
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, length);
  attribute.needsUpdate = true;
};

/**
 * BubbleView の共有インスタンス属性(design-render §3 / §4、裁定 A32 で
 * 距離 LOD 2 バケット化)。
 *
 * BubbleGlassSystem(back/front)と InnerWaterSystem(体積/キャップ)が
 * 同一の near/far バケットを共有する — アップロードは 1 回。
 * SceneRenderer が毎フレーム systems 更新の前に sync() を 1 度だけ呼ぶ。
 *
 * - 全球をカメラ距離で遠→近ソートし(painter's order)、LOD_NEAR_DISTANCE
 *   を境に near/far バケットへ振り分ける。ソート順は距離単調なので
 *   境界前後で連続した区間になり、各バケット内でも遠→近順が保たれる
 *   (バケット毎に far メッシュ→near メッシュの順で描画すれば全体の
 *   painter's order も保たれる — renderOrder は「基準値」「基準値+0.5」)
 * - InnerRipple 追跡はカメラ近傍 RIPPLE_NEAR_COUNT 球のみ(A32、LOD バケットとは
 *   独立): 全体ソート順の末尾(最近傍)から rippleIndex 0..N-1 を割り当てる
 * - aCurrA/aPrevA: [ax, ay, az, R]
 * - aCurrB/aPrevB: [waterLevelYLocal, fill01, wobble, statePacked]
 *   (statePacked は curr のみ読む — prev lerp 禁止)
 * - aMisc: [rippleIndex, seed]
 */
export class BubbleInstanceBuffers {
  public readonly near: BubbleBucket;
  public readonly far: BubbleBucket;
  /** 生スロット番号 → rippleIndex(0..RIPPLE_NEAR_COUNT-1、対象外は -1)。 */
  public readonly rippleIndexBySlot = new Int32Array(BUBBLE_CAPACITY).fill(-1);

  private readonly nearImpl = new MutableBucket();
  private readonly farImpl = new MutableBucket();
  private readonly order = new Int32Array(BUBBLE_CAPACITY);

  constructor() {
    this.near = this.nearImpl;
    this.far = this.farImpl;
  }

  public sync(view: SkyRenderView, camera: PerspectiveCamera): void {
    const bubbles = view.bubbles;
    const count = Math.min(bubbles.count, BUBBLE_CAPACITY);
    const cam = camera.position;
    sortBubblesFarToNear(bubbles.data, count, cam.x, cam.y, cam.z, this.order);

    this.rippleIndexBySlot.fill(-1);
    const rippleStart = Math.max(count - RIPPLE_NEAR_COUNT, 0);

    let nearN = 0;
    let farN = 0;
    for (let i = 0; i < count; i++) {
      const slot = this.order[i];
      const src = slot * STRIDE;
      const dx = bubbles.data[src] - cam.x;
      const dy = bubbles.data[src + 1] - cam.y;
      const dz = bubbles.data[src + 2] - cam.z;
      const d2 = dx * dx + dy * dy + dz * dz;

      const rippleIdx = i >= rippleStart ? i - rippleStart : -1;
      if (rippleIdx >= 0) this.rippleIndexBySlot[slot] = rippleIdx;
      const seed = bubbleVisualSeed(slot, bubbles.data[src + 3]);

      const bucket = d2 < LOD_NEAR_DISTANCE_SQ ? this.nearImpl : this.farImpl;
      const dst = d2 < LOD_NEAR_DISTANCE_SQ ? nearN++ : farN++;
      this.writeInstance(bucket, dst, slot, rippleIdx, seed, bubbles);
    }
    this.nearImpl.count = nearN;
    this.farImpl.count = farN;
    this.nearImpl.upload();
    this.farImpl.upload();
  }

  private writeInstance(
    bucket: MutableBucket,
    dst: number,
    slot: number,
    rippleIdx: number,
    seed: number,
    bubbles: SkyRenderView['bubbles'],
  ): void {
    const src = slot * STRIDE;
    const o = dst * V4;
    for (let k = 0; k < V4; k++) {
      bucket.fCurrA[o + k] = bubbles.data[src + k];
      bucket.fCurrB[o + k] = bubbles.data[src + V4 + k];
      bucket.fPrevA[o + k] = bubbles.prevData[src + k];
      bucket.fPrevB[o + k] = bubbles.prevData[src + V4 + k];
    }
    bucket.fMisc[dst * 2] = rippleIdx;
    bucket.fMisc[dst * 2 + 1] = seed;
  }
}
