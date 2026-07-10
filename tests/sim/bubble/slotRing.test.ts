import { describe, expect, it } from 'vitest';
import {
  type SlotPlacement,
  SlotRing,
  emptyPlacement,
} from '../../../src/sim/bubble/SlotRing';
import {
  ANGLE_JITTER,
  RADIAL_JITTER,
  RING_RADIUS,
  RING_Y_MAX,
  RING_Y_MIN,
  R_MAX,
  R_MIN,
  SEPARATION_MARGIN,
} from '../../../src/sim/config';
import { Mulberry32 } from '../../../src/sim/core/Random';

describe('SlotRing(§2.3 — リング配置と決定的分離チェック)', () => {
  it('配置は設計帯に収まる(R、リング半径、y、bob 位相)', () => {
    const ring = new SlotRing(7);
    const rng = new Mulberry32(1);
    const out = emptyPlacement();
    for (let i = 0; i < 7; i++) {
      ring.rollInto(rng, i, [null], out);
      expect(out.r).toBeGreaterThanOrEqual(R_MIN);
      expect(out.r).toBeLessThanOrEqual(R_MAX);
      const radius = Math.hypot(out.baseX, out.baseZ);
      expect(radius).toBeGreaterThanOrEqual(RING_RADIUS - RADIAL_JITTER - 1e-9);
      expect(radius).toBeLessThanOrEqual(RING_RADIUS + RADIAL_JITTER + 1e-9);
      expect(out.baseY).toBeGreaterThanOrEqual(RING_Y_MIN);
      expect(out.baseY).toBeLessThanOrEqual(RING_Y_MAX);
      expect(out.bobPhaseY).toBeGreaterThanOrEqual(0);
      expect(out.bobPhaseY).toBeLessThan(2 * Math.PI);
    }
  });

  it('基準角 θᵢ = 2πi/slotCount 近傍(角ジッター ±0.06 rad 以内)', () => {
    const ring = new SlotRing(7);
    const rng = new Mulberry32(2);
    const out = emptyPlacement();
    for (let i = 0; i < 7; i++) {
      ring.rollInto(rng, i, [null], out);
      const theta = Math.atan2(out.baseZ, out.baseX);
      const expected = (2 * Math.PI * i) / 7;
      let d = Math.abs(theta - expected);
      if (d > Math.PI) d = 2 * Math.PI - d;
      expect(d).toBeLessThanOrEqual(ANGLE_JITTER + 1e-9);
    }
  });

  it('分離チェック: 全スロットのペア間中心距離 ≥ R_a + R_b + margin(seed 掃引)', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const ring = new SlotRing(7);
      const rng = new Mulberry32(seed);
      const placements: (SlotPlacement | null)[] = new Array(7).fill(null);
      for (let i = 0; i < 7; i++) {
        const out = emptyPlacement();
        ring.rollInto(rng, i, placements, out);
        placements[i] = out;
      }
      for (let a = 0; a < 7; a++) {
        for (let b = a + 1; b < 7; b++) {
          const pa = placements[a];
          const pb = placements[b];
          if (!pa || !pb) continue;
          const d = Math.hypot(
            pa.baseX - pb.baseX,
            pa.baseY - pb.baseY,
            pa.baseZ - pb.baseZ,
          );
          // フォールバック(ジッターなし基準位置)でも隣接間隔 3.91 は
          // 2·R_MAX + margin = 3.5 を上回る — 常に成立するはず
          expect(d).toBeGreaterThanOrEqual(pa.r + pb.r + SEPARATION_MARGIN);
        }
      }
    }
  });

  it('境界際の others に対して再ロールで分離を解く(有界・決定的な追加消費)', () => {
    const ring = new SlotRing(7);
    // 基準位置からギリギリ衝突圏(3.2 u)の他者 — ジッター(y ±1.2 / 水平 ±0.5)
    // で解けることが多い距離
    const blocker: SlotPlacement = {
      r: R_MAX,
      baseX: RING_RADIUS - 3.2,
      baseY: (RING_Y_MIN + RING_Y_MAX) / 2,
      baseZ: 0,
      bobPhaseY: 0,
      bobPhaseX: 0,
    };
    let separatedCount = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const rng = new Mulberry32(seed);
      const out = emptyPlacement();
      ring.rollInto(rng, 0, [blocker], out);
      const d = Math.hypot(
        out.baseX - blocker.baseX,
        out.baseY - blocker.baseY,
        out.baseZ - blocker.baseZ,
      );
      if (d >= out.r + blocker.r + SEPARATION_MARGIN) separatedCount++;
    }
    expect(separatedCount).toBeGreaterThan(15);
  });

  it('分離不能な others では決定的フォールバック(ジッターなし基準位置 + 帯中央 y)', () => {
    const ring = new SlotRing(7);
    // スロット 0 の基準位置そのものに重なる他者 — ジッター箱では逃げられない
    const blocker: SlotPlacement = {
      r: R_MAX,
      baseX: RING_RADIUS,
      baseY: (RING_Y_MIN + RING_Y_MAX) / 2,
      baseZ: 0,
      bobPhaseY: 0,
      bobPhaseX: 0,
    };
    const out = emptyPlacement();
    ring.rollInto(new Mulberry32(5), 0, [blocker], out);
    expect(out.baseX).toBeCloseTo(RING_RADIUS, 10);
    expect(out.baseZ).toBeCloseTo(0, 10);
    expect(out.baseY).toBeCloseTo((RING_Y_MIN + RING_Y_MAX) / 2, 10);
  });

  it('同 seed からは同一配置(決定論)', () => {
    const roll = (): SlotPlacement[] => {
      const ring = new SlotRing(5);
      const rng = new Mulberry32(77);
      const placements: (SlotPlacement | null)[] = new Array(5).fill(null);
      for (let i = 0; i < 5; i++) {
        const out = emptyPlacement();
        ring.rollInto(rng, i, placements, out);
        placements[i] = out;
      }
      return placements as SlotPlacement[];
    };
    expect(roll()).toEqual(roll());
  });
});
