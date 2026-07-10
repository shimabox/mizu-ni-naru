/**
 * plain mutable な 3 成分ベクトル(知見: Mizu-threejs/src/sim/core/Vec3.ts —
 * クラスにせずオブジェクトリテラルで持つ。sim は three.Vector3 を知らない)。
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
