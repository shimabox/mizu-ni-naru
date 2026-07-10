import type { Atom } from '../chem/Atom';
import type { CollisionDetector } from './CollisionDetector';

/**
 * 総当たり衝突検出 — テストオラクル(design-sim §3.4。知見:
 * Mizu-ts/src/physics/BruteForceCollisionDetector.ts)。
 * GridDetector とペア集合が一致することをプロパティテストで固定する。
 */
export class BruteForceDetector implements CollisionDetector {
  public findPairs(
    atoms: readonly Atom[],
    _rInner: number,
    outPairs: number[],
  ): number {
    outPairs.length = 0;
    let pairs = 0;
    const n = atoms.length;
    for (let i = 0; i < n; i++) {
      const a = atoms[i];
      if (a.dead) continue;
      for (let j = i + 1; j < n; j++) {
        const b = atoms[j];
        if (b.dead) continue;
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
    return pairs;
  }
}
