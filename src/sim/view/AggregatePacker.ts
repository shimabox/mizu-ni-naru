import type { SkyRenderView } from '../../contract/RenderView';
import {
  ATOM_VIEW_CAPACITY,
  BUBBLE_CAPACITY,
  DROPLET_VIEW_CAPACITY,
  RIPPLE_VIEW_CAPACITY,
  SPLASH_VIEW_CAPACITY,
} from '../../contract/WorldSpec';
import type { Atom } from '../chem/Atom';
import type { DropletColumn } from '../droplets/DropletColumn';

const BUBBLE_STRIDE = 8;
const V4 = 4;

/** パッカーが読むスロットのスナップショット(MizuNiNaruSim が毎 step 更新)。 */
export interface PackSlot {
  ax: number;
  ay: number;
  az: number;
  prevAx: number;
  prevAy: number;
  prevAz: number;
  r: number;
  waterY: number;
  fill01: number;
  wobble: number;
  statePacked: number;
  /** このフレームで再ロールされた(prev = curr で書く — §1.4 規約 2)。 */
  justRespawned: boolean;
  atoms: readonly Atom[];
  droplets: DropletColumn;
}

/**
 * 集約パッカー(design-sim §1.4 — 裁定 A4/A6)。全球をワールド座標に集約済みの
 * typed array に詰める(安定 view オブジェクト・dense prefix・再パックの知見:
 * Mizu-threejs/src/sim/RenderViewPacker.ts。全球集約 + prev/curr 2 世代 +
 * ワールド変換は本設計固有)。
 *
 * 契約(§1.4 の規約):
 * 1. 順序: スロット index 昇順 → 球内エンティティ順(原子 = 挿入順、雫 = ストア順)。
 *    posr / prevPosr は同一順序・同一 count(同一インデックス = 同一エンティティ)
 * 2. prev = prevLocal + prevAnchor、curr = local + anchor。
 *    スポーンしたフレームは prev = curr(生成時の飛び込みグリッチなし)
 * 3. 容量固定。溢れたら新規を捨てて dropped 系カウンタで数える(version は 0 のまま)
 * 4. BubbleView は常に全スロット(count = slotCount、Dead は statePacked=5.x)
 * 5. 原子・雫はワールド集約済み。InnerRipple は球ローカル、splash はワールド x/z
 */
export class AggregatePacker {
  public droppedAtoms = 0;
  public droppedDroplets = 0;

  private readonly bubbleData = new Float32Array(
    BUBBLE_CAPACITY * BUBBLE_STRIDE,
  );
  private readonly bubblePrev = new Float32Array(
    BUBBLE_CAPACITY * BUBBLE_STRIDE,
  );
  /** スロットごとの前 step スナップショット(prevData の供給元)。 */
  private readonly prevPacked = new Float32Array(
    BUBBLE_CAPACITY * BUBBLE_STRIDE,
  );
  private readonly hasPrevPacked = new Uint8Array(BUBBLE_CAPACITY);
  private readonly atomPosr = new Float32Array(ATOM_VIEW_CAPACITY * V4);
  private readonly atomPrev = new Float32Array(ATOM_VIEW_CAPACITY * V4);
  private readonly atomColorKind = new Float32Array(ATOM_VIEW_CAPACITY * V4);
  private readonly atomAux = new Float32Array(ATOM_VIEW_CAPACITY * V4);
  private readonly dropPosr = new Float32Array(DROPLET_VIEW_CAPACITY * V4);
  private readonly dropPrev = new Float32Array(DROPLET_VIEW_CAPACITY * V4);
  private readonly dropAux = new Float32Array(DROPLET_VIEW_CAPACITY * V4);
  private readonly splashData = new Float32Array(SPLASH_VIEW_CAPACITY * V4);
  private readonly rippleData = new Float32Array(RIPPLE_VIEW_CAPACITY * V4);

  // 安定 view オブジェクト(毎フレーム同一参照、count / step のみ更新)
  private readonly viewObj = {
    step: 0,
    bubbles: {
      data: this.bubbleData,
      prevData: this.bubblePrev,
      count: 0,
      version: 0,
    },
    atoms: {
      posr: this.atomPosr,
      prevPosr: this.atomPrev,
      colorKind: this.atomColorKind,
      aux: this.atomAux,
      count: 0,
      version: 0,
    },
    droplets: {
      posr: this.dropPosr,
      prevPosr: this.dropPrev,
      aux: this.dropAux,
      count: 0,
      version: 0,
    },
    splashes: { data: this.splashData, count: 0 },
    ripples: { data: this.rippleData, count: 0 },
  };

  public view(): SkyRenderView {
    return this.viewObj;
  }

  /** step 冒頭: フレーム内イベント(splash / ripple)をクリアする。 */
  public beginStep(): void {
    this.viewObj.splashes.count = 0;
    this.viewObj.ripples.count = 0;
  }

  /** 海への着水イベント(裁定 A10: radius = R、strength = min(1, v/4))。 */
  public emitSplash(
    x: number,
    z: number,
    radius: number,
    strength: number,
  ): void {
    const view = this.viewObj.splashes;
    if (view.count >= SPLASH_VIEW_CAPACITY) return;
    const o = view.count * V4;
    this.splashData[o] = x;
    this.splashData[o + 1] = z;
    this.splashData[o + 2] = radius;
    this.splashData[o + 3] = strength;
    view.count++;
  }

  /** 球内水面イベント(裁定 A7/A8: localX/Z は球ローカル世界単位)。 */
  public emitRipple(
    bubbleIndex: number,
    localX: number,
    localZ: number,
    strength: number,
  ): void {
    const view = this.viewObj.ripples;
    if (view.count >= RIPPLE_VIEW_CAPACITY) return;
    const o = view.count * V4;
    this.rippleData[o] = bubbleIndex;
    this.rippleData[o + 1] = localX;
    this.rippleData[o + 2] = localZ;
    this.rippleData[o + 3] = strength;
    view.count++;
  }

  /** step 末尾: 全スロットを 1 本の view に詰める。 */
  public pack(slots: readonly PackSlot[], stepCount: number): void {
    let atomCount = 0;
    let dropCount = 0;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      const bo = i * BUBBLE_STRIDE;
      const bubbleData = this.bubbleData;
      bubbleData[bo] = s.ax;
      bubbleData[bo + 1] = s.ay;
      bubbleData[bo + 2] = s.az;
      bubbleData[bo + 3] = s.r;
      bubbleData[bo + 4] = s.waterY;
      bubbleData[bo + 5] = s.fill01;
      bubbleData[bo + 6] = s.wobble;
      bubbleData[bo + 7] = s.statePacked;
      // 再ロール(スポーン)フレームは prev = curr — 補間ワープなし
      if (this.hasPrevPacked[i] === 1 && !s.justRespawned) {
        this.bubblePrev.set(
          this.prevPacked.subarray(bo, bo + BUBBLE_STRIDE),
          bo,
        );
      } else {
        this.bubblePrev.set(bubbleData.subarray(bo, bo + BUBBLE_STRIDE), bo);
      }
      this.prevPacked.set(bubbleData.subarray(bo, bo + BUBBLE_STRIDE), bo);
      this.hasPrevPacked[i] = 1;

      // 原子(挿入順、ワールド集約、スポーンフレームは prev = curr)
      const atoms = s.atoms;
      for (let k = 0; k < atoms.length; k++) {
        if (atomCount >= ATOM_VIEW_CAPACITY) {
          this.droppedAtoms++;
          continue;
        }
        const a = atoms[k];
        const o = atomCount * V4;
        this.atomPosr[o] = s.ax + a.x;
        this.atomPosr[o + 1] = s.ay + a.y;
        this.atomPosr[o + 2] = s.az + a.z;
        this.atomPosr[o + 3] = a.r;
        const spawnedNow = a.spawnStep === stepCount;
        if (spawnedNow) {
          this.atomPrev[o] = this.atomPosr[o];
          this.atomPrev[o + 1] = this.atomPosr[o + 1];
          this.atomPrev[o + 2] = this.atomPosr[o + 2];
        } else {
          this.atomPrev[o] = s.prevAx + a.px;
          this.atomPrev[o + 1] = s.prevAy + a.py;
          this.atomPrev[o + 2] = s.prevAz + a.pz;
        }
        this.atomPrev[o + 3] = a.r;
        this.atomColorKind[o] = a.colR;
        this.atomColorKind[o + 1] = a.colG;
        this.atomColorKind[o + 2] = a.colB;
        this.atomColorKind[o + 3] = a.kindIndex;
        this.atomAux[o] = a.spawnStep;
        this.atomAux[o + 1] = a.seed;
        this.atomAux[o + 2] = 0;
        this.atomAux[o + 3] = 0;
        atomCount++;
      }

      // 雫(ストア順、ワールド集約、スポーンフレームは prev = curr)
      const col = s.droplets;
      for (let d = 0; d < col.count; d++) {
        if (dropCount >= DROPLET_VIEW_CAPACITY) {
          this.droppedDroplets++;
          continue;
        }
        const src = d * V4;
        const o = dropCount * V4;
        this.dropPosr[o] = s.ax + col.posr[src];
        this.dropPosr[o + 1] = s.ay + col.posr[src + 1];
        this.dropPosr[o + 2] = s.az + col.posr[src + 2];
        this.dropPosr[o + 3] = col.posr[src + 3];
        const spawnedNow = col.aux[src + 2] === stepCount;
        if (spawnedNow) {
          this.dropPrev[o] = this.dropPosr[o];
          this.dropPrev[o + 1] = this.dropPosr[o + 1];
          this.dropPrev[o + 2] = this.dropPosr[o + 2];
        } else {
          this.dropPrev[o] = s.prevAx + col.prevPosr[src];
          this.dropPrev[o + 1] = s.prevAy + col.prevPosr[src + 1];
          this.dropPrev[o + 2] = s.prevAz + col.prevPosr[src + 2];
        }
        this.dropPrev[o + 3] = col.posr[src + 3];
        this.dropAux[o] = col.aux[src];
        this.dropAux[o + 1] = col.aux[src + 1];
        this.dropAux[o + 2] = col.aux[src + 2];
        this.dropAux[o + 3] = col.aux[src + 3];
        dropCount++;
      }
    }
    this.viewObj.step = stepCount;
    this.viewObj.bubbles.count = slots.length; // 恒常(Dead 含む — 裁定 A18)
    this.viewObj.atoms.count = atomCount;
    this.viewObj.droplets.count = dropCount;
  }
}
