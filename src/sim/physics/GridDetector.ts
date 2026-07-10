import type { Atom } from '../chem/Atom';
import type { CollisionDetector } from './CollisionDetector';
import { GRID_DIM, SphereGrid } from './SphereGrid';

/**
 * グリッド走査の衝突検出(design-sim §3.4 — 既定実装)。
 * 素朴な 27 セル走査 + 正準インデックス重複排除(j > i のみ採用)+ 二乗距離比較
 * (知見: Mizu-ts/src/physics/GridCollisionDetector.ts)。
 * Mizu-threejs の半近傍レンジ融合最適化は N≈26 では複雑さに見合わず不採用。
 * ペア列挙順は i 昇順 → 近傍セル走査順で決定的。
 */
export class GridDetector implements CollisionDetector {
  private readonly grid = new SphereGrid();

  public findPairs(
    atoms: readonly Atom[],
    rInner: number,
    outPairs: number[],
  ): number {
    const grid = this.grid;
    grid.rebuild(atoms, rInner);
    outPairs.length = 0;
    let pairs = 0;
    const n = atoms.length;
    for (let i = 0; i < n; i++) {
      const a = atoms[i];
      if (a.dead) continue;
      const cx = grid.axisCell(a.x);
      const cy = grid.axisCell(a.y);
      const cz = grid.axisCell(a.z);
      const zMin = cz > 0 ? cz - 1 : 0;
      const zMax = cz < GRID_DIM - 1 ? cz + 1 : GRID_DIM - 1;
      const yMin = cy > 0 ? cy - 1 : 0;
      const yMax = cy < GRID_DIM - 1 ? cy + 1 : GRID_DIM - 1;
      const xMin = cx > 0 ? cx - 1 : 0;
      const xMax = cx < GRID_DIM - 1 ? cx + 1 : GRID_DIM - 1;
      for (let z = zMin; z <= zMax; z++) {
        for (let y = yMin; y <= yMax; y++) {
          for (let x = xMin; x <= xMax; x++) {
            const c = x + GRID_DIM * (y + GRID_DIM * z);
            const end = grid.starts[c + 1];
            for (let e = grid.starts[c]; e < end; e++) {
              const j = grid.entries[e];
              if (j <= i) continue; // 正準重複排除(両者が互いを見るため片側のみ)
              const b = atoms[j];
              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const dz = b.z - a.z;
              const rr = a.r + b.r;
              if (dx * dx + dy * dy + dz * dz < rr * rr) {
                outPairs.push(i, j);
                pairs++;
              }
            }
          }
        }
      }
    }
    return pairs;
  }
}
