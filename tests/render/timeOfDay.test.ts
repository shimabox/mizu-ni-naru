import { Color } from 'three';
import { describe, expect, it } from 'vitest';
import {
  createTimeOfDayState,
  localTimeMinutes,
  normalizeTimeMinutes,
  sampleTimeOfDay,
} from '../../src/render/TimeOfDay';

describe('TimeOfDay', () => {
  it('時刻を一日の循環へ正規化する', () => {
    expect(normalizeTimeMinutes(1440)).toBe(0);
    expect(normalizeTimeMinutes(-30)).toBe(1410);
    expect(normalizeTimeMinutes(Number.NaN)).toBe(0);
  });

  it('ローカル時刻を小数分へ変換する', () => {
    const date = new Date(2026, 6, 14, 21, 30, 30);
    expect(localTimeMinutes(date)).toBe(21 * 60 + 30.5);
  });

  it('08:00は従来の朝景を保存する', () => {
    const state = sampleTimeOfDay(8 * 60, createTimeOfDayState());
    expect(state.sunDir.x).toBeCloseTo(0.485, 2);
    expect(state.sunDir.y).toBeCloseTo(0.242, 2);
    expect(state.sunDir.z).toBeCloseTo(-0.841, 2);
    expect(state.sunColor.getHex()).toBe(new Color(0xffd19a).getHex());
    expect(state.horizonCool.getHex()).toBe(0xa9c3d6);
    expect(state.horizonWarm.getHex()).toBe(0xf2c39d);
    expect(state.zenith.getHex()).toBe(0x6a93bd);
    expect(state.below.getHex()).toBe(0x12303f);
    expect(state.starVisibility).toBe(0);
    expect(state.exposure).toBe(1.06);
  });

  it('昼は星を消し、夜は空と露出を静かに落とす', () => {
    const target = createTimeOfDayState();
    const noon = sampleTimeOfDay(12 * 60, target);
    expect(noon.starVisibility).toBe(0);
    expect(noon.exposure).toBeGreaterThan(1);

    const night = sampleTimeOfDay(21 * 60, target);
    expect(night).toBe(target);
    expect(night.starVisibility).toBe(1);
    expect(night.exposure).toBeLessThan(0.7);
    expect(night.zenith.r + night.zenith.g + night.zenith.b).toBeLessThan(0.02);
  });

  it('夕方は暖色の地平線を保つ', () => {
    const sunset = sampleTimeOfDay(18 * 60 + 15, createTimeOfDayState());
    expect(sunset.horizonWarm.r).toBeGreaterThan(sunset.horizonWarm.b);
    expect(sunset.horizonWarm.r).toBeGreaterThan(sunset.horizonCool.r);
    expect(sunset.starVisibility).toBe(0);
  });
});
