/**
 * 原子(H / O / H2)の単一データクラス(design-sim §3.1)。
 * kind 別クラスは作らない — 挙動差は半径のみで、ReactionRegistry が kindIndex で
 * 引くため単一クラスで足りる(thin composition の知見:
 * Mizu-threejs/src/sim/particles/H.ts ほか)。
 *
 * - 座標は球ローカル(球中心原点)。prev(px,py,pz)は補間契約(§1.4)用に
 *   毎 step のパイプライン段 0 で記録する
 * - dead フラグは同一フレーム多重反応の死亡ペアガード + sweep 用
 */
export class Atom {
  public kindIndex: number; // KIND_INDEX(0=H, 1=O, 2=H2)
  public r: number; // 半径(u)= ATOM_RADIUS_RATIO[kind] × 球 R
  public x: number;
  public y: number;
  public z: number;
  public px: number;
  public py: number;
  public pz: number;
  public vx = 0;
  public vy = 0;
  public vz = 0;
  public colR: number;
  public colG: number;
  public colB: number;
  public seed: number; // AtomView.aux[1](render のパルス位相 — 裁定 A6)
  public spawnStep: number; // AtomView.aux[0](フェードイン用)
  public dead = false;

  constructor(
    kindIndex: number,
    r: number,
    x: number,
    y: number,
    z: number,
    colR: number,
    colG: number,
    colB: number,
    seed: number,
    spawnStep: number,
  ) {
    this.kindIndex = kindIndex;
    this.r = r;
    this.x = x;
    this.y = y;
    this.z = z;
    this.px = x;
    this.py = y;
    this.pz = z;
    this.colR = colR;
    this.colG = colG;
    this.colB = colB;
    this.seed = seed;
    this.spawnStep = spawnStep;
  }
}
