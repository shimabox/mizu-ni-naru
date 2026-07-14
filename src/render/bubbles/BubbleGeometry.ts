import { IcosahedronGeometry } from 'three';

/**
 * 前景の主役球に共用する分割レベル。
 *
 * detail 4(500 triangles)では、固定構図で大きく映る球の外周に直線区間が
 * 残った。GlassとInnerWater volumeは別meshで同じ輪郭を描くため、片方だけ
 * 高密度化しても角ばりが残る。detail 6(980 triangles)を共通factoryから
 * 生成し、両レイヤーの輪郭密度が再びずれないようにする。
 */
export const FOREGROUND_BUBBLE_DETAIL = 6;

export const createForegroundBubbleGeometry = (): IcosahedronGeometry =>
  new IcosahedronGeometry(1, FOREGROUND_BUBBLE_DETAIL);
