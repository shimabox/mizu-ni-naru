import type { Atom } from '../chem/Atom';
import type { CollisionDetector } from './CollisionDetector';
import { GridDetector } from './GridDetector';

/**
 * 現行 GridDetector のペア列挙順を保つ、小規模個体群向け直接走査。
 *
 * 世界の反応順は `i → cell(j) → j` に依存するため、通常の `i → j` 総当たり
 * へは置換できない。衝突した少数の j だけを cell id 順へ挿入し、同一cell内は
 * 元の j 昇順を保つ。48原子を超える入力は従来gridへ戻し、O(n²)の悪化を避ける。
 *
 * GRID_DIM=4 のcell idは `x + 4 * (y + 4 * z)`。座標を別配列へ保持することで、
 * ペア走査中に除算・floorを繰り返さない。配列は構築時だけ確保する。
 */
export const DIRECT_SCAN_MAX_ATOMS = 48;

export class OrderedDirectDetector implements CollisionDetector {
  private readonly fallback = new GridDetector();
  private readonly cellId: Int8Array;
  private readonly cellX: Int8Array;
  private readonly cellY: Int8Array;
  private readonly cellZ: Int8Array;
  private readonly hitIndices: Int32Array;

  public constructor(
    private readonly directScanMaxAtoms = DIRECT_SCAN_MAX_ATOMS,
  ) {
    if (!Number.isInteger(directScanMaxAtoms) || directScanMaxAtoms < 1) {
      throw new Error('directScanMaxAtoms must be a positive integer');
    }
    this.cellId = new Int8Array(directScanMaxAtoms);
    this.cellX = new Int8Array(directScanMaxAtoms);
    this.cellY = new Int8Array(directScanMaxAtoms);
    this.cellZ = new Int8Array(directScanMaxAtoms);
    this.hitIndices = new Int32Array(directScanMaxAtoms);
  }

  public findPairs(
    atoms: readonly Atom[],
    rInner: number,
    outPairs: number[],
  ): number {
    const n = atoms.length;
    if (n > this.directScanMaxAtoms) {
      return this.fallback.findPairs(atoms, rInner, outPairs);
    }

    const cellId = this.cellId;
    const cellX = this.cellX;
    const cellY = this.cellY;
    const cellZ = this.cellZ;
    const invCell = 2 / rInner; // GRID_DIM / (2 * rInner), GRID_DIM = 4

    for (let i = 0; i < n; i++) {
      const atom = atoms[i];
      if (atom.dead) {
        cellId[i] = -1;
        continue;
      }
      const x = this.axisCell(atom.x, rInner, invCell);
      const y = this.axisCell(atom.y, rInner, invCell);
      const z = this.axisCell(atom.z, rInner, invCell);
      cellX[i] = x;
      cellY[i] = y;
      cellZ[i] = z;
      cellId[i] = x + 4 * (y + 4 * z);
    }

    outPairs.length = 0;
    const hitIndices = this.hitIndices;
    let pairCount = 0;

    for (let i = 0; i < n; i++) {
      const a = atoms[i];
      if (a.dead) continue;

      const ax = cellX[i];
      const ay = cellY[i];
      const az = cellZ[i];
      let hitCount = 0;

      for (let j = i + 1; j < n; j++) {
        const b = atoms[j];
        if (b.dead) continue;
        if (
          Math.abs(cellX[j] - ax) > 1 ||
          Math.abs(cellY[j] - ay) > 1 ||
          Math.abs(cellZ[j] - az) > 1
        ) {
          continue;
        }

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        const rr = a.r + b.r;
        if (dx * dx + dy * dy + dz * dz >= rr * rr) continue;

        // j自体は昇順に来るため、cell idだけで安定挿入すれば
        // `(cell(j), j)` が現行GridDetectorと同じ順になる。
        const jCell = cellId[j];
        let insertAt = hitCount;
        while (insertAt > 0 && cellId[hitIndices[insertAt - 1]] > jCell) {
          hitIndices[insertAt] = hitIndices[insertAt - 1];
          insertAt--;
        }
        hitIndices[insertAt] = j;
        hitCount++;
      }

      for (let hit = 0; hit < hitCount; hit++) {
        outPairs.push(i, hitIndices[hit]);
        pairCount++;
      }
    }

    return pairCount;
  }

  private axisCell(value: number, halfExtent: number, invCell: number): number {
    const cell = Math.floor((value + halfExtent) * invCell);
    return cell < 0 ? 0 : cell >= 4 ? 3 : cell;
  }
}
