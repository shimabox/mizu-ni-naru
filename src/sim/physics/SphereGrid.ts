import { ATOM_VIEW_CAPACITY } from '../../contract/WorldSpec';
import type { Atom } from '../chem/Atom';

/**
 * 球に外接する AABB の一様グリッド索引(design-sim §3.4)。
 * counting sort 実装の知見: Mizu-threejs/src/sim/physics/SpatialGrid3D.ts —
 * バケツ配列を持たず counts → prefix sum → entries に詰める。定常アロケーション
 * ゼロ。安定ソート(挿入順で列挙)。範囲外セルはクランプ。
 *
 * - ローカル AABB [−R_inner, R_inner]³ を軸あたり 4 セル(64 セル)で切る。
 *   cell = R_inner/2 = 0.47R ≥ MAX_COLLISION_DISTANCE = 2·r_H2 = 0.18R —
 *   衝突しうる 2 粒子が必ず 3×3×3 近傍に収まる不変条件を満たす
 * - 球外の空セル(体積比 ≈48%)は Int32 のカウントに過ぎず無駄にならない。
 *   球面分割の座標変換コストの方が高くつく(§3.4 の判断)
 * - インスタンスは 1 個を全球で使い回す(球ごとに rebuild → detect)
 */
export const GRID_DIM = 4;
const CELL_COUNT = GRID_DIM * GRID_DIM * GRID_DIM;

export class SphereGrid {
  public readonly starts = new Int32Array(CELL_COUNT + 1);
  public readonly entries = new Int32Array(ATOM_VIEW_CAPACITY);
  private readonly counts = new Int32Array(CELL_COUNT);
  private readonly cursor = new Int32Array(CELL_COUNT);
  private readonly cellOfAtom = new Int32Array(ATOM_VIEW_CAPACITY);
  private invCell = 1;
  private halfExtent = 1;

  /** 軸座標 → セル座標(0..3 にクランプ)。 */
  public axisCell(v: number): number {
    const c = Math.floor((v + this.halfExtent) * this.invCell);
    return c < 0 ? 0 : c >= GRID_DIM ? GRID_DIM - 1 : c;
  }

  /** counting sort による再構築。dead な原子は登録しない。 */
  public rebuild(atoms: readonly Atom[], rInner: number): void {
    this.halfExtent = rInner;
    this.invCell = GRID_DIM / (2 * rInner);
    const counts = this.counts;
    const cellOfAtom = this.cellOfAtom;
    counts.fill(0);
    const n = Math.min(atoms.length, ATOM_VIEW_CAPACITY);
    for (let i = 0; i < n; i++) {
      const a = atoms[i];
      if (a.dead) {
        cellOfAtom[i] = -1;
        continue;
      }
      const c =
        this.axisCell(a.x) +
        GRID_DIM * (this.axisCell(a.y) + GRID_DIM * this.axisCell(a.z));
      cellOfAtom[i] = c;
      counts[c]++;
    }
    const starts = this.starts;
    const cursor = this.cursor;
    let acc = 0;
    for (let c = 0; c < CELL_COUNT; c++) {
      starts[c] = acc;
      cursor[c] = acc;
      acc += counts[c];
    }
    starts[CELL_COUNT] = acc;
    for (let i = 0; i < n; i++) {
      const c = cellOfAtom[i];
      if (c >= 0) this.entries[cursor[c]++] = i; // 安定(挿入順保存)
    }
  }
}
