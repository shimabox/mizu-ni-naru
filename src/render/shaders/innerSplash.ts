import {
  SLOT_COUNT_DESKTOP,
  SLOT_COUNT_MOBILE,
} from '../../contract/WorldSpec';
import { BUBBLE_STATE_TRANSFORM_GLSL } from './innerWater';

/** 製品構成で追跡する球数。現在はdesktop / mobileとも24。 */
export const INNER_SPLASH_TRACKED_BUBBLES = Math.max(
  SLOT_COUNT_DESKTOP,
  SLOT_COUNT_MOBILE,
);
/** simの内殻境界`SHELL_RATIO`と一致。render→sim依存を避ける文書化ミラー。 */
export const INNER_SPLASH_SHELL_RATIO = 0.94;
/** Straining / Fallingで使うglassの最大y伸長。粒子半径の境界余白に使う。 */
export const INNER_SPLASH_MAX_STRETCH = 1.1;

/**
 * 球内着水しぶき。
 *
 * 粒子は球ローカル座標の閉形式弾道で動かし、球中心のbob / Fallingには
 * `uBubbleFrame`で追従する。中心だけでなくbillboard半径まで含めて内殻へ
 * 収まる場合だけ描くため、視点や球の伸長状態に関係なく外へ出ない。
 */
export const INNER_SPLASH_VERTEX_GLSL = /* glsl */ `
precision highp float;
attribute vec4 aSpawn;    // [localX, localY, localZ, spawnStepF]
attribute vec4 aVelocity; // [vx/R, vy/R, vz/R, lifeSec]
attribute vec3 aBubble;   // [slot, R, size/R]
attribute vec3 aTint;
uniform float uStepF;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec4 uBubbleFrame[${INNER_SPLASH_TRACKED_BUBBLES}]; // [center.xyz, statePacked]
varying vec2 vCorner;
varying float vFade;
varying vec3 vTint;
${BUBBLE_STATE_TRANSFORM_GLSL}

const float G_INNER = 2.4; // R/s²: 球サイズに比例する短い弾道
const float SHELL_RATIO = ${INNER_SPLASH_SHELL_RATIO.toFixed(2)};
const float MAX_STRETCH = ${INNER_SPLASH_MAX_STRETCH.toFixed(1)};

void main() {
  float age = (uStepF - aSpawn.w) / 60.0;
  int slot = int(aBubble.x + 0.5);
  vec4 bubble = uBubbleFrame[slot];
  float state = floor(bubble.w);
  float prog = fract(bubble.w);
  float R = aBubble.y;
  float size = aBubble.z * R;

  vec3 localP = aSpawn.xyz
              + aVelocity.xyz * R * age
              - vec3(0.0, 0.5 * G_INNER * R * age * age, 0.0);
  float waterY = aSpawn.y - size * MAX_STRETCH;
  bool returnedToWater = age > 0.05 && localP.y - size <= waterY;
  bool insideShell = length(localP) + size * MAX_STRETCH <= SHELL_RATIO * R;
  bool alive = age >= 0.0 && age <= aVelocity.w
            && state < 4.0 && !returnedToWater && insideShell;

  vec4 tf = bubbleTransform(state, prog);
  vec3 transformed = localP
                   * vec3(inversesqrt(tf.y), tf.y, inversesqrt(tf.y))
                   * tf.x;
  vec3 center = bubble.xyz + transformed;
  float fade = smoothstep(0.0, 0.035, age)
             * (1.0 - smoothstep(aVelocity.w * 0.65, aVelocity.w, age));
  float visibleSize = size * tf.x * fade * (alive ? 1.0 : 0.0);
  vec3 wp = center
          + (uCamRight * position.x + uCamUp * position.y) * visibleSize;

  vCorner = position.xy;
  vFade = fade * (alive ? 1.0 : 0.0);
  vTint = aTint;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const INNER_SPLASH_FRAGMENT_GLSL = /* glsl */ `
precision highp float;
varying vec2 vCorner;
varying float vFade;
varying vec3 vTint;

void main() {
  float r2 = dot(vCorner, vCorner);
  if (r2 > 1.0) discard;
  float z = sqrt(max(1.0 - r2, 0.0));
  vec3 color = vTint * (0.82 + 0.18 * z);

  float edge = 1.0 - smoothstep(0.72, 1.0, sqrt(r2));
  gl_FragColor = vec4(color, edge * vFade * 0.82);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
