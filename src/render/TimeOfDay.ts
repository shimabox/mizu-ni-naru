import { Color, Vector3 } from 'three';

const MINUTES_PER_DAY = 24 * 60;
const DEG = Math.PI / 180;

interface TimeKeyframe {
  readonly minute: number;
  readonly sunDir: Vector3;
  readonly sunColor: Color;
  readonly horizonCool: Color;
  readonly horizonWarm: Color;
  readonly zenith: Color;
  readonly below: Color;
  readonly starVisibility: number;
  readonly exposure: number;
}

export interface TimeOfDayState {
  minutes: number;
  readonly sunDir: Vector3;
  readonly sunColor: Color;
  readonly horizonCool: Color;
  readonly horizonWarm: Color;
  readonly zenith: Color;
  readonly below: Color;
  starVisibility: number;
  exposure: number;
}

const direction = (altitudeDeg: number, azimuthDeg: number): Vector3 => {
  const altitude = altitudeDeg * DEG;
  const azimuth = azimuthDeg * DEG;
  const horizontal = Math.cos(altitude);
  return new Vector3(
    horizontal * Math.cos(azimuth),
    Math.sin(altitude),
    horizontal * Math.sin(azimuth),
  ).normalize();
};

const litColor = (hex: number, intensity = 1): Color =>
  new Color(hex).multiplyScalar(intensity);

const frame = (
  minute: number,
  altitudeDeg: number,
  azimuthDeg: number,
  sunHex: number,
  sunIntensity: number,
  palette: readonly [number, number, number, number],
  starVisibility: number,
  exposure: number,
): TimeKeyframe => ({
  minute,
  sunDir: direction(altitudeDeg, azimuthDeg),
  sunColor: litColor(sunHex, sunIntensity),
  horizonCool: new Color(palette[0]),
  horizonWarm: new Color(palette[1]),
  zenith: new Color(palette[2]),
  below: new Color(palette[3]),
  starVisibility,
  exposure,
});

// 既存の朝景を核に、夜紺→薄明→水色→夕映え→青の時間を連続させる。
// 08:00は従来の固定スカイと同じ色・太陽方向・露出に合わせ、基準景を保存する。
const NIGHT = [0x0a1630, 0x171c38, 0x020713, 0x010208] as const;
const PRE_DAWN = [0x263752, 0x8e5260, 0x0b1730, 0x030712] as const;
const DAWN = [0x596b86, 0xf08f67, 0x1b3154, 0x07111f] as const;
const MORNING = [0xa9c3d6, 0xf2c39d, 0x6a93bd, 0x12303f] as const;
const NOON = [0x9fc8df, 0xefd1b2, 0x568fc7, 0x123244] as const;
const AFTERNOON = [0x9ab4cc, 0xedbd91, 0x557fae, 0x102b3d] as const;
const SUNSET = [0x9b6975, 0xff7852, 0x2b406c, 0x0b1729] as const;
const BLUE_HOUR = [0x263958, 0xb75e60, 0x0b1833, 0x030812] as const;

const KEYFRAMES: readonly TimeKeyframe[] = [
  frame(0, 34, -58, 0xb9caf0, 0.18, NIGHT, 1, 0.68),
  frame(285, 28, -66, 0xb9caf0, 0.16, NIGHT, 1, 0.68),
  frame(330, 16, -74, 0xc0cdf0, 0.12, PRE_DAWN, 0.65, 0.76),
  frame(375, 3, -78, 0xffa064, 0.72, DAWN, 0.08, 0.94),
  frame(480, 14, -60, 0xffd19a, 1, MORNING, 0, 1.06),
  frame(720, 48, -18, 0xffedc7, 1.04, NOON, 0, 1.08),
  frame(990, 25, 28, 0xffc083, 1, AFTERNOON, 0, 1.05),
  frame(1095, 3, 58, 0xff824f, 1.08, SUNSET, 0, 0.98),
  frame(1155, 12, -62, 0xacc0eb, 0.1, BLUE_HOUR, 0.3, 0.82),
  frame(1230, 30, -58, 0xb9caf0, 0.18, NIGHT, 1, 0.68),
  frame(1440, 34, -58, 0xb9caf0, 0.18, NIGHT, 1, 0.68),
];

export const normalizeTimeMinutes = (minutes: number): number => {
  if (!Number.isFinite(minutes)) return 0;
  return ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
};

export const localTimeMinutes = (date: Date): number =>
  date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;

export const createTimeOfDayState = (): TimeOfDayState => ({
  minutes: 0,
  sunDir: new Vector3(),
  sunColor: new Color(),
  horizonCool: new Color(),
  horizonWarm: new Color(),
  zenith: new Color(),
  below: new Color(),
  starVisibility: 0,
  exposure: 1,
});

/** targetを再利用し、時刻キーフレーム間を滑らかに補間する。 */
export const sampleTimeOfDay = (
  minutes: number,
  target: TimeOfDayState,
): TimeOfDayState => {
  const normalized = normalizeTimeMinutes(minutes);
  let before = KEYFRAMES[0];
  let after = KEYFRAMES[1];
  for (let i = 1; i < KEYFRAMES.length; i++) {
    if (normalized <= KEYFRAMES[i].minute) {
      before = KEYFRAMES[i - 1];
      after = KEYFRAMES[i];
      break;
    }
  }
  const span = after.minute - before.minute;
  const linearT = span > 0 ? (normalized - before.minute) / span : 0;
  const t = linearT * linearT * (3 - 2 * linearT);

  target.minutes = normalized;
  target.sunDir.lerpVectors(before.sunDir, after.sunDir, t).normalize();
  target.sunColor.copy(before.sunColor).lerp(after.sunColor, t);
  target.horizonCool.copy(before.horizonCool).lerp(after.horizonCool, t);
  target.horizonWarm.copy(before.horizonWarm).lerp(after.horizonWarm, t);
  target.zenith.copy(before.zenith).lerp(after.zenith, t);
  target.below.copy(before.below).lerp(after.below, t);
  target.starVisibility =
    before.starVisibility * (1 - t) + after.starVisibility * t;
  target.exposure = before.exposure * (1 - t) + after.exposure * t;
  return target;
};
