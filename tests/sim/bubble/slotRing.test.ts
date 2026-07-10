import { describe, expect, it } from 'vitest';
import {
  type SlotPlacement,
  SlotRing,
  emptyPlacement,
} from '../../../src/sim/bubble/SlotRing';
import {
  ANGLE_JITTER,
  FALLBACK_Y_OUTER,
  RADIAL_JITTER,
  RING_INNER_RADIUS,
  RING_OUTER_RADIUS,
  RING_Y_MAX,
  RING_Y_MIN,
  R_MAX,
  R_MIN,
  SEPARATION_MARGIN,
} from '../../../src/sim/config';
import { Mulberry32 } from '../../../src/sim/core/Random';

/** desktop 12 = 内 5 + 外 7 / mobile 7 = 内 3 + 外 4(A30)。 */
const INNER_OF: Record<number, number> = { 12: 5, 7: 3 };

const rollAll = (slotCount: number, seed: number): SlotPlacement[] => {
  const ring = new SlotRing(slotCount);
  const rng = new Mulberry32(seed);
  const placements: (SlotPlacement | null)[] = new Array(slotCount).fill(null);
  for (let i = 0; i < slotCount; i++) {
    const out = emptyPlacement();
    ring.rollInto(rng, i, placements, out);
    placements[i] = out;
  }
  return placements as SlotPlacement[];
};

describe('SlotRing(§2.3 / A30 — 二重リング配置と決定的分離チェック)', () => {
  it('配置は設計帯に収まる(R、リング半径の内外振り分け、y、bob 位相)', () => {
    for (const slotCount of [12, 7]) {
      const innerCount = INNER_OF[slotCount];
      const placements = rollAll(slotCount, 1);
      placements.forEach((out, i) => {
        expect(out.r).toBeGreaterThanOrEqual(R_MIN);
        expect(out.r).toBeLessThanOrEqual(R_MAX);
        const ringRadius =
          i < innerCount ? RING_INNER_RADIUS : RING_OUTER_RADIUS;
        const radius = Math.hypot(out.baseX, out.baseZ);
        expect(radius).toBeGreaterThanOrEqual(
          ringRadius - RADIAL_JITTER - 1e-9,
        );
        expect(radius).toBeLessThanOrEqual(ringRadius + RADIAL_JITTER + 1e-9);
        expect(out.baseY).toBeGreaterThanOrEqual(RING_Y_MIN);
        expect(out.baseY).toBeLessThanOrEqual(RING_Y_MAX);
        expect(out.bobPhaseY).toBeGreaterThanOrEqual(0);
        expect(out.bobPhaseY).toBeLessThan(2 * Math.PI);
      });
    }
  });

  it('基準角: 内 2πi/5・外 2πj/7 + π/7 の近傍(角ジッター ±0.06 rad 以内)', () => {
    const innerCount = INNER_OF[12];
    const outerCount = 12 - innerCount;
    const placements = rollAll(12, 2);
    placements.forEach((out, i) => {
      const theta = Math.atan2(out.baseZ, out.baseX);
      const expected =
        i < innerCount
          ? (2 * Math.PI * i) / innerCount
          : (2 * Math.PI * (i - innerCount)) / outerCount +
            Math.PI / outerCount;
      let d = Math.abs(theta - expected);
      d = d % (2 * Math.PI);
      if (d > Math.PI) d = 2 * Math.PI - d;
      expect(d).toBeLessThanOrEqual(ANGLE_JITTER + 1e-9);
    });
  });

  it('分離チェック: 全スロットのペア間中心距離 ≥ R_a + R_b + margin(リング横断・seed 掃引)', () => {
    for (const slotCount of [12, 7]) {
      for (let seed = 1; seed <= 20; seed++) {
        const placements = rollAll(slotCount, seed);
        for (let a = 0; a < slotCount; a++) {
          for (let b = a + 1; b < slotCount; b++) {
            const pa = placements[a];
            const pb = placements[b];
            const d = Math.hypot(
              pa.baseX - pb.baseX,
              pa.baseY - pb.baseY,
              pa.baseZ - pb.baseZ,
            );
            expect(
              d,
              `slots=${slotCount} seed=${seed} pair=${a},${b}`,
            ).toBeGreaterThanOrEqual(pa.r + pb.r + SEPARATION_MARGIN);
          }
        }
      }
    }
  });

  it('境界際の others に対して再ロールで分離を解く(有界・決定的な追加消費)', () => {
    const ring = new SlotRing(12);
    // 外リングのスロット 5(基準角 π/7)の近くに内リングの他者 — y 再ロールで
    // 解ける近接ペア(A30 の 5.1° 近接格子を模す)
    const theta = Math.PI / 7;
    const blocker: SlotPlacement = {
      r: R_MAX,
      baseX: RING_INNER_RADIUS * Math.cos(theta),
      baseY: (RING_Y_MIN + RING_Y_MAX) / 2,
      baseZ: RING_INNER_RADIUS * Math.sin(theta),
      bobPhaseY: 0,
      bobPhaseX: 0,
    };
    let separatedCount = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const rng = new Mulberry32(seed);
      const out = emptyPlacement();
      ring.rollInto(rng, 5, [blocker], out);
      const d = Math.hypot(
        out.baseX - blocker.baseX,
        out.baseY - blocker.baseY,
        out.baseZ - blocker.baseZ,
      );
      if (d >= out.r + blocker.r + SEPARATION_MARGIN) separatedCount++;
    }
    expect(separatedCount).toBeGreaterThan(15);
  });

  it('分離不能な others では決定的フォールバック(ジッターなし基準位置 + リング別 y)', () => {
    const ring = new SlotRing(12);
    // 外リングのスロット 5 のジッター箱全域を覆う巨大な他者(半径 5)
    const theta = Math.PI / 7;
    const blocker: SlotPlacement = {
      r: 5,
      baseX: RING_OUTER_RADIUS * Math.cos(theta),
      baseY: (RING_Y_MIN + RING_Y_MAX) / 2,
      baseZ: RING_OUTER_RADIUS * Math.sin(theta),
      bobPhaseY: 0,
      bobPhaseX: 0,
    };
    const out = emptyPlacement();
    ring.rollInto(new Mulberry32(5), 5, [blocker], out);
    expect(out.baseX).toBeCloseTo(RING_OUTER_RADIUS * Math.cos(theta), 10);
    expect(out.baseZ).toBeCloseTo(RING_OUTER_RADIUS * Math.sin(theta), 10);
    expect(out.baseY).toBeCloseTo(FALLBACK_Y_OUTER, 10);
  });

  it('同 seed からは同一配置(決定論)', () => {
    expect(rollAll(7, 77)).toEqual(rollAll(7, 77));
  });
});
