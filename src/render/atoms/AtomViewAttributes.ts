import { DynamicDrawUsage, InstancedBufferAttribute } from 'three';
import type { SkyRenderView } from '../../contract/RenderView';
import { ATOM_VIEW_CAPACITY } from '../../contract/WorldSpec';

const V4 = 4;

/**
 * AtomView をラップした共有インスタンス属性(design-render §5)。
 *
 * LabelSystem(文字 = 原子の本体)が InstancedBufferAttribute として
 * そのまま参照 — 追加アップロードゼロ。配列は sim 所有・インプレース変異
 * (ゼロコピー契約)なので、毎フレーム一括 1 レンジで needsUpdate を立てる。
 * 再確保(version++ / 配列差し替え)時は再ラップし generation を進める —
 * 利用側は generation を見て geometry.setAttribute し直す。
 */
export class AtomViewAttributes {
  public posR: InstancedBufferAttribute;
  public posRPrev: InstancedBufferAttribute;
  public colorKind: InstancedBufferAttribute;
  public aux: InstancedBufferAttribute;
  /** 再ラップ世代(利用側の setAttribute 同期用)。 */
  public generation = 0;
  public count = 0;

  private lastArray: Float32Array;

  constructor() {
    // 初期はプレースホルダ容量配列(初回 sync で view の実配列に再ラップ)
    const empty = new Float32Array(ATOM_VIEW_CAPACITY * V4);
    this.lastArray = empty;
    this.posR = wrap(empty);
    this.posRPrev = wrap(new Float32Array(ATOM_VIEW_CAPACITY * V4));
    this.colorKind = wrap(new Float32Array(ATOM_VIEW_CAPACITY * V4));
    this.aux = wrap(new Float32Array(ATOM_VIEW_CAPACITY * V4));
  }

  public sync(view: SkyRenderView): void {
    const atoms = view.atoms;
    if (this.lastArray !== atoms.posr) {
      this.lastArray = atoms.posr;
      this.posR = wrap(atoms.posr);
      this.posRPrev = wrap(atoms.prevPosr);
      this.colorKind = wrap(atoms.colorKind);
      this.aux = wrap(atoms.aux);
      this.generation++;
    }
    this.count = atoms.count;
    const length = atoms.count * V4;
    for (const attribute of [
      this.posR,
      this.posRPrev,
      this.colorKind,
      this.aux,
    ]) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, length);
      attribute.needsUpdate = true;
    }
  }
}

const wrap = (array: Float32Array): InstancedBufferAttribute => {
  const attribute = new InstancedBufferAttribute(array, V4);
  attribute.setUsage(DynamicDrawUsage);
  return attribute;
};
