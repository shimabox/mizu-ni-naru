import {
  BufferAttribute,
  BufferGeometry,
  type PerspectiveCamera,
  type Vector3,
} from 'three';

/** ビルボード quad(corner ∈ [-1,1]² — 画面空間 CCW)。 */
export const createBillboardQuadGeometry = (): BufferGeometry => {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(
      new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]),
      3,
    ),
  );
  geometry.setIndex(
    new BufferAttribute(new Uint16Array([0, 1, 2, 2, 1, 3]), 1),
  );
  return geometry;
};

/** カメラの右/上ベクトルを uniform Vector3 へ書く(割付なし)。 */
export const writeCameraBasis = (
  camera: PerspectiveCamera,
  right: Vector3,
  up: Vector3,
): void => {
  const e = camera.matrixWorld.elements;
  right.set(e[0], e[1], e[2]);
  up.set(e[4], e[5], e[6]);
};
