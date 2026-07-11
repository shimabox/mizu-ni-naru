import { KIND_INDEX } from '../../contract/WorldSpec';
import {
  ATOM_RADIUS_RATIO,
  H_TARGET,
  O_TARGET,
  SPAWN_MAX_TRIES,
} from '../config';
import type { Random } from '../core/Random';
import type { Atom } from './Atom';
import type { AtomFactory } from './AtomFactory';

/**
 * 凝結スポナー(design-sim §3.6 — 裁定 A15: 唯一の供給源)。
 * 「水面より上の空域に、H / O を目標個数まで少しずつ補充」。
 *
 * - 種の選択: 相対不足の大きい方((H_TARGET−h)/H_TARGET vs (O_TARGET−o)/O_TARGET、
 *   同率は H 優先)— 化学量論 2:1 の消費に自動追従する決定的ルール。
 *   不足ゼロなら何もしない(RNG 消費なし)
 * - 位置: 有界棄却サンプリング。空域 AABB(x,z ∈ [−L,L]、y ∈ [y_w+m, R_eff−m]、
 *   L = R_eff、m = 2r)に一様 3 点(RNG 3 回/試行: x, y, z の順)→ 球内 +
 *   既存粒子と非重畳なら採用。最大 16 試行、全滅なら天頂寄り既定点
 *   (採用率 ≈1/1.9 なので 16 回全滅は実質ゼロ)。試行数可変でも単一ストリームの
 *   決定論は保たれる(§7.1 — 有界・決定的な条件付き消費)
 * - **崩壊ガード(A40)**: F_FULL の帯が [0.8, 0.95] に上がったことで、水面が
 *   高い球では空域帯そのものが反転しうる(y_w + m > R_eff − m、fill01 ≈0.88 超)。
 *   この場合は棄却ループへ入る前に即 null を返す(下記 `if (yMax <= yMin)`)—
 *   無限試行・NaN・負範囲サンプリングを構造的に排除する。RNG は一切消費しない
 *   ため決定論も保たれる(このタイミングでは「もう溜まっている」ので次の
 *   Straining 遷移まで補充を止めても視覚上問題ない)
 * - クロック(試行するか否か)は呼び出し側(BubbleWorld / FSM)が持つ
 */
export class Spawner {
  private readonly rng: Random;
  private readonly factory: AtomFactory;

  constructor(rng: Random, factory: AtomFactory) {
    this.rng = rng;
    this.factory = factory;
  }

  /**
   * 1 体のスポーンを試行する。採用時は生成した Atom を返す(呼び出し側が
   * atoms へ挿入し台帳を更新する)。不足ゼロ・空域ゼロなら null(RNG 消費なし)。
   */
  public trySpawn(
    atoms: readonly Atom[],
    h: number,
    o: number,
    waterY: number,
    rInner: number,
    bubbleR: number,
    nowStep: number,
  ): Atom | null {
    const defH = (H_TARGET - h) / H_TARGET;
    const defO = (O_TARGET - o) / O_TARGET;
    if (defH <= 0 && defO <= 0) return null;
    const kindIndex = defH >= defO ? KIND_INDEX.H : KIND_INDEX.O;

    const r = ATOM_RADIUS_RATIO[kindIndex] * bubbleR;
    const rEff = rInner - r;
    const m = 2 * r;
    const yMin = waterY + m;
    const yMax = rEff - m;
    // A40 崩壊ガード: 帯が [0.8,0.95] のため高 fill 側では反転しうる
    // (yMax < yMin)。棄却ループに入る前に判定し無限試行・NaN を排除する
    if (yMax <= yMin) return null; // 空域なし(水がほぼ満杯)— RNG 消費なし

    const rng = this.rng;
    let x = 0;
    let y = yMax; // フォールバック: 天頂寄り既定点(0, yMax, 0)
    let z = 0;
    for (let t = 0; t < SPAWN_MAX_TRIES; t++) {
      const cx = (2 * rng.next() - 1) * rEff;
      const cy = yMin + rng.next() * (yMax - yMin);
      const cz = (2 * rng.next() - 1) * rEff;
      if (cx * cx + cy * cy + cz * cz > rEff * rEff) continue; // 球外
      if (this.overlaps(atoms, cx, cy, cz, r)) continue;
      x = cx;
      y = cy;
      z = cz;
      break;
    }
    return this.factory.createAtom(kindIndex, x, y, z, bubbleR, nowStep);
  }

  private overlaps(
    atoms: readonly Atom[],
    x: number,
    y: number,
    z: number,
    r: number,
  ): boolean {
    for (let i = 0; i < atoms.length; i++) {
      const a = atoms[i];
      if (a.dead) continue;
      const dx = a.x - x;
      const dy = a.y - y;
      const dz = a.z - z;
      const rr = a.r + r;
      if (dx * dx + dy * dy + dz * dz < rr * rr) return true;
    }
    return false;
  }
}
