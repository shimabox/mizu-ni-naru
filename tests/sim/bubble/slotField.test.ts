import { describe, expect, it } from 'vitest';
import { SlotField } from '../../../src/sim/bubble/SlotField';
import type { SlotPlacement } from '../../../src/sim/bubble/SlotRing';
import { emptyPlacement } from '../../../src/sim/bubble/SlotRing';
import {
  FIELD_RADIUS_MAX,
  FIELD_RADIUS_MIN,
  RING_Y_MAX,
  RING_Y_MIN,
  R_MAX,
  R_MIN,
  SEPARATION_MARGIN,
} from '../../../src/sim/config';
import { Mulberry32 } from '../../../src/sim/core/Random';

const rollAll = (fieldCount: number, seed: number): SlotPlacement[] => {
  const field = new SlotField(fieldCount);
  const rng = new Mulberry32(seed);
  const placements: (SlotPlacement | null)[] = new Array(fieldCount).fill(null);
  for (let i = 0; i < fieldCount; i++) {
    const out = emptyPlacement();
    field.rollInto(rng, i, placements, out);
    placements[i] = out;
  }
  return placements as SlotPlacement[];
};

describe('SlotField(§2.3 拡張 — 外側環状フィールド配置、A32、A35 で半径帯拡張)', () => {
  it('配置は設計帯に収まる(R、半径 [FIELD_RADIUS_MIN,FIELD_RADIUS_MAX] 近傍、y、bob 位相)', () => {
    const placements = rollAll(28, 1);
    const jitterSlack = 2; // 角/半径ジッターの余裕込みで大まかに帯を確認
    for (const out of placements) {
      expect(out.r).toBeGreaterThanOrEqual(R_MIN);
      expect(out.r).toBeLessThanOrEqual(R_MAX);
      const radius = Math.hypot(out.baseX, out.baseZ);
      expect(radius).toBeGreaterThanOrEqual(FIELD_RADIUS_MIN - jitterSlack);
      expect(radius).toBeLessThanOrEqual(FIELD_RADIUS_MAX + jitterSlack);
      expect(out.baseY).toBeGreaterThanOrEqual(RING_Y_MIN);
      expect(out.baseY).toBeLessThanOrEqual(RING_Y_MAX);
      expect(out.bobPhaseY).toBeGreaterThanOrEqual(0);
      expect(out.bobPhaseY).toBeLessThan(2 * Math.PI);
    }
  });

  it('半径は外側ほど間隔が開く(密度が外へ薄くなる — 幾何スパイラル)', () => {
    const placements = rollAll(28, 3);
    const radii = placements
      .map((p) => Math.hypot(p.baseX, p.baseZ))
      .sort((a, b) => a - b);
    const firstHalfGaps: number[] = [];
    const secondHalfGaps: number[] = [];
    for (let i = 1; i < radii.length; i++) {
      const gap = radii[i] - radii[i - 1];
      (i < radii.length / 2 ? firstHalfGaps : secondHalfGaps).push(gap);
    }
    const mean = (xs: number[]): number =>
      xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(secondHalfGaps)).toBeGreaterThan(mean(firstHalfGaps));
  });

  it('分離チェック: 全スロットのペア間中心距離 ≥ R_a + R_b + margin(seed 掃引)', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const placements = rollAll(28, seed);
      for (let a = 0; a < placements.length; a++) {
        for (let b = a + 1; b < placements.length; b++) {
          const pa = placements[a];
          const pb = placements[b];
          const d = Math.hypot(
            pa.baseX - pb.baseX,
            pa.baseY - pb.baseY,
            pa.baseZ - pb.baseZ,
          );
          expect(d, `seed=${seed} pair=${a},${b}`).toBeGreaterThanOrEqual(
            pa.r + pb.r + SEPARATION_MARGIN,
          );
        }
      }
    }
  });

  it('近リング(既存配置)との境界横断分離も解く(others に外部配置を含める)', () => {
    const nearRingBlockers: SlotPlacement[] = [
      {
        r: R_MAX,
        baseX: 6.5,
        baseY: 4.3,
        baseZ: 0,
        bobPhaseY: 0,
        bobPhaseX: 0,
      },
    ];
    const field = new SlotField(7);
    const rng = new Mulberry32(9);
    const out = emptyPlacement();
    // フィールド最初のスロット(半径 8 付近)を近リング外縁のすぐ外に置く
    field.rollInto(rng, 0, nearRingBlockers, out);
    const d = Math.hypot(
      out.baseX - nearRingBlockers[0].baseX,
      out.baseY - nearRingBlockers[0].baseY,
      out.baseZ - nearRingBlockers[0].baseZ,
    );
    expect(d).toBeGreaterThanOrEqual(
      out.r + nearRingBlockers[0].r + SEPARATION_MARGIN - 1e-9,
    );
  });

  it('同 seed からは同一配置(決定論)', () => {
    expect(rollAll(7, 77)).toEqual(rollAll(7, 77));
  });
});
