import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  type PerspectiveCamera,
} from 'three';
import type { SkyRenderView } from '../../contract/RenderView';
import { BUBBLE_CAPACITY } from '../../contract/WorldSpec';

const STRIDE = 8;
const V4 = 4;

/**
 * 7 球の CPU 距離ソート(design-render §1.3)— 遠→近のインスタンス順。
 * αブレンドの正順(painter's order)。挿入ソート・割付なし(≤8 要素)。
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
 * BubbleView の共有インスタンス属性(design-render §3 / §4)。
 *
 * BubbleGlassSystem(back/front)と InnerWaterSystem(体積/キャップ)が
 * 同一の InstancedBufferAttribute を共有する — アップロードは 1 回。
 * SceneRenderer が毎フレーム systems 更新の前に sync() を 1 度だけ呼ぶ。
 *
 * - aCurrA/aPrevA: [ax, ay, az, R]
 * - aCurrB/aPrevB: [waterLevelYLocal, fill01, wobble, statePacked]
 *   (statePacked は curr のみ読む — prev lerp 禁止)
 * - aMisc: [slot, seed](slot は uInnerRipples のインデックス、seed は A22)
 */
export class BubbleInstanceBuffers {
  public readonly currA: InstancedBufferAttribute;
  public readonly currB: InstancedBufferAttribute;
  public readonly prevA: InstancedBufferAttribute;
  public readonly prevB: InstancedBufferAttribute;
  public readonly misc: InstancedBufferAttribute;
  /** ソート済み描画順(order[i] = スロット番号)。 */
  public readonly order = new Int32Array(BUBBLE_CAPACITY);
  public count = 0;

  private readonly fCurrA = new Float32Array(BUBBLE_CAPACITY * V4);
  private readonly fCurrB = new Float32Array(BUBBLE_CAPACITY * V4);
  private readonly fPrevA = new Float32Array(BUBBLE_CAPACITY * V4);
  private readonly fPrevB = new Float32Array(BUBBLE_CAPACITY * V4);
  private readonly fMisc = new Float32Array(BUBBLE_CAPACITY * 2);

  constructor() {
    this.currA = this.makeAttribute(this.fCurrA, V4);
    this.currB = this.makeAttribute(this.fCurrB, V4);
    this.prevA = this.makeAttribute(this.fPrevA, V4);
    this.prevB = this.makeAttribute(this.fPrevB, V4);
    this.misc = this.makeAttribute(this.fMisc, 2);
  }

  public sync(view: SkyRenderView, camera: PerspectiveCamera): void {
    const bubbles = view.bubbles;
    const count = Math.min(bubbles.count, BUBBLE_CAPACITY);
    this.count = count;
    const cam = camera.position;
    sortBubblesFarToNear(bubbles.data, count, cam.x, cam.y, cam.z, this.order);

    for (let i = 0; i < count; i++) {
      const slot = this.order[i];
      const src = slot * STRIDE;
      const dst = i * V4;
      for (let k = 0; k < V4; k++) {
        this.fCurrA[dst + k] = bubbles.data[src + k];
        this.fCurrB[dst + k] = bubbles.data[src + V4 + k];
        this.fPrevA[dst + k] = bubbles.prevData[src + k];
        this.fPrevB[dst + k] = bubbles.prevData[src + V4 + k];
      }
      this.fMisc[i * 2] = slot;
      this.fMisc[i * 2 + 1] = bubbleVisualSeed(slot, bubbles.data[src + 3]);
    }

    this.upload(this.currA, count * V4);
    this.upload(this.currB, count * V4);
    this.upload(this.prevA, count * V4);
    this.upload(this.prevB, count * V4);
    this.upload(this.misc, count * 2);
  }

  private makeAttribute(
    array: Float32Array,
    itemSize: number,
  ): InstancedBufferAttribute {
    const attribute = new InstancedBufferAttribute(array, itemSize);
    attribute.setUsage(DynamicDrawUsage);
    return attribute;
  }

  private upload(attribute: InstancedBufferAttribute, length: number): void {
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, length);
    attribute.needsUpdate = true;
  }
}
