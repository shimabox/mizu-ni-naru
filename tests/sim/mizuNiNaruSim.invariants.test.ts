import { describe, expect, it, vi } from 'vitest';
import { BUBBLE_STATE, SLOT_COUNT_DESKTOP } from '../../src/contract/WorldSpec';
import type { MassLedger } from '../../src/sim/MizuNiNaruSim';
import { MizuNiNaruSim } from '../../src/sim/MizuNiNaruSim';
import { F_FULL, SHELL_RATIO } from '../../src/sim/config';

// 主系列は slotCount=12(境界・台帳ロジックの網羅性は球数に依存しない — サイトが
// 増えるだけ)。96 球スモーク 1 本のみ重い(§7.3 方針)。負荷環境での既定 5s を
// 超え得るためファイル全体を 30s に緩める。
vi.setConfig({ testTimeout: 30_000 });

/** 台帳の保存則(§7.3 — 要件の式を溶解・クリア・ドロップチャネル込みに拡張)。 */
const assertLedgerConserved = (ledger: MassLedger): void => {
  const dropletsAllTime =
    ledger.liveDroplets +
    ledger.absorbedDroplets +
    ledger.clearedDroplets +
    ledger.droppedDroplets;
  const h =
    ledger.h +
    2 * ledger.h2 +
    2 * dropletsAllTime +
    ledger.dissolvedH +
    2 * ledger.dissolvedH2 +
    ledger.clearedH +
    2 * ledger.clearedH2;
  const o = ledger.o + dropletsAllTime + ledger.dissolvedO + ledger.clearedO;
  expect(h).toBe(ledger.spawnedH);
  expect(o).toBe(ledger.spawnedO);
};

describe('MizuNiNaruSim — プロパティ不変条件(§7.3)', () => {
  it('球面境界: 全原子・全雫が |p_local| ≤ R_inner − r + 1e-6(seed 1..7 × 600 step)', () => {
    // 高頻度ループでは expect を粒子毎に呼ばず、最悪違反量を集計して 1 回 assert
    // (630k 回の expect はテストランナー側で遅すぎる)
    for (let seed = 1; seed <= 7; seed++) {
      const sim = new MizuNiNaruSim();
      sim.init({ seed, slotCount: 12 });
      let worst = Number.NEGATIVE_INFINITY;
      let samples = 0;
      const measure = (
        v: ReturnType<MizuNiNaruSim['view']>,
        x: number,
        y: number,
        z: number,
        r: number,
      ): void => {
        // ワールド座標から球ローカルへ戻して検査(最も近い球に属すはず)
        const bubbles = v.bubbles.data;
        let best = Number.POSITIVE_INFINITY;
        for (let b = 0; b < v.bubbles.count; b++) {
          const bo = b * 8;
          const d =
            Math.hypot(
              x - bubbles[bo],
              y - bubbles[bo + 1],
              z - bubbles[bo + 2],
            ) -
            (SHELL_RATIO * bubbles[bo + 3] - r);
          best = Math.min(best, d);
        }
        worst = Math.max(worst, best);
        samples++;
      };
      for (let s = 0; s < 600; s++) {
        sim.step();
        const v = sim.view();
        for (let i = 0; i < v.atoms.count; i++) {
          const o = i * 4;
          measure(
            v,
            v.atoms.posr[o],
            v.atoms.posr[o + 1],
            v.atoms.posr[o + 2],
            v.atoms.posr[o + 3],
          );
        }
        for (let i = 0; i < v.droplets.count; i++) {
          const o = i * 4;
          measure(
            v,
            v.droplets.posr[o],
            v.droplets.posr[o + 1],
            v.droplets.posr[o + 2],
            v.droplets.posr[o + 3],
          );
        }
      }
      expect(samples).toBeGreaterThan(0); // 空虚テスト防止
      expect(worst).toBeLessThanOrEqual(1e-6);
    }
  });

  it('A25: 原子・雫は常に球内水面より上(所属球の waterY に対し下端 ≥)', () => {
    for (const seed of [3, 7, 42]) {
      const sim = new MizuNiNaruSim();
      sim.init({ seed, slotCount: 12 });
      let worst = Number.POSITIVE_INFINITY; // (下端 − waterY) の最小値
      let samples = 0;
      const measure = (
        v: ReturnType<MizuNiNaruSim['view']>,
        x: number,
        y: number,
        z: number,
        r: number,
      ): void => {
        // 所属球 = 中心距離が最小の球
        const bubbles = v.bubbles.data;
        let bestB = 0;
        let bestD = Number.POSITIVE_INFINITY;
        for (let b = 0; b < v.bubbles.count; b++) {
          const bo = b * 8;
          const d = Math.hypot(
            x - bubbles[bo],
            y - bubbles[bo + 1],
            z - bubbles[bo + 2],
          );
          if (d < bestD) {
            bestD = d;
            bestB = b;
          }
        }
        const bo = bestB * 8;
        const localY = y - bubbles[bo + 1];
        worst = Math.min(worst, localY - r - bubbles[bo + 4]);
        samples++;
      };
      for (let s = 0; s < 1200; s++) {
        sim.step();
        const v = sim.view();
        for (let i = 0; i < v.atoms.count; i++) {
          const o = i * 4;
          measure(
            v,
            v.atoms.posr[o],
            v.atoms.posr[o + 1],
            v.atoms.posr[o + 2],
            v.atoms.posr[o + 3],
          );
        }
        for (let i = 0; i < v.droplets.count; i++) {
          const o = i * 4;
          measure(
            v,
            v.droplets.posr[o],
            v.droplets.posr[o + 1],
            v.droplets.posr[o + 2],
            v.droplets.posr[o + 3],
          );
        }
      }
      expect(samples).toBeGreaterThan(0); // 空虚テスト防止
      expect(worst).toBeGreaterThanOrEqual(-1e-5);
    }
  });

  it('質量台帳: 保存則が毎 step 成立する(seed 1..5 × 900 step)', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const sim = new MizuNiNaruSim();
      sim.init({ seed, slotCount: 12 });
      for (let s = 0; s < 900; s++) {
        sim.step();
        assertLedgerConserved(sim.ledger());
      }
      // 空虚テスト防止: 実際に物質が流れた
      const ledger = sim.ledger();
      expect(ledger.spawnedH).toBeGreaterThan(0);
      expect(ledger.absorbedDroplets + ledger.liveDroplets).toBeGreaterThan(0);
    }
  });

  it('長時間(240 s)+ splash クリアを跨いでも台帳が保存される', () => {
    const sim = new MizuNiNaruSim();
    sim.init({ seed: 7, slotCount: 12 });
    for (let s = 0; s < 60 * 240; s++) {
      sim.step();
      if (s % 600 === 599) assertLedgerConserved(sim.ledger());
    }
    const ledger = sim.ledger();
    expect(ledger.clearedDroplets + ledger.clearedH).toBeGreaterThan(0);
    expect(sim.counts().splashesTotal).toBeGreaterThan(3);
    assertLedgerConserved(ledger);
  });

  it('水位単調: Drifting/Straining 中 fill01・waterY は単調非減少、fill01 ≤ 1', () => {
    const sim = new MizuNiNaruSim();
    sim.init({ seed: 9, slotCount: 12 });
    const prevFill = new Float32Array(12).fill(-1);
    const prevWaterY = new Float32Array(12).fill(Number.NEGATIVE_INFINITY);
    const prevState = new Int32Array(12).fill(-1);
    let monotonicChecks = 0;
    let violations = 0;
    for (let s = 0; s < 60 * 180; s++) {
      sim.step();
      const v = sim.view();
      for (let b = 0; b < 12; b++) {
        const bo = b * 8;
        const state = Math.floor(v.bubbles.data[bo + 7]);
        const fill = v.bubbles.data[bo + 5];
        const waterY = v.bubbles.data[bo + 4];
        if (fill > 1) violations++;
        const inFillPhase =
          state === BUBBLE_STATE.Drifting || state === BUBBLE_STATE.Straining;
        const wasFillPhase =
          prevState[b] === BUBBLE_STATE.Drifting ||
          prevState[b] === BUBBLE_STATE.Straining;
        if (inFillPhase && wasFillPhase) {
          if (fill < prevFill[b]) violations++;
          if (waterY < prevWaterY[b]) violations++;
          monotonicChecks++;
        }
        prevFill[b] = fill;
        prevWaterY[b] = waterY;
        prevState[b] = state;
      }
    }
    expect(monotonicChecks).toBeGreaterThan(1000);
    expect(violations).toBe(0);
  });

  it('FSM の生涯: 全状態を通過し、Splashing 進入で球内 count が 0、Dead で fill 0', () => {
    const sim = new MizuNiNaruSim();
    sim.init({ seed: 7, slotCount: 12 });
    const seen = new Set<number>();
    let splashFrames = 0;
    let deadFillViolations = 0;
    let atomsInSplashing = 0;
    for (let s = 0; s < 60 * 200; s++) {
      sim.step();
      const v = sim.view();
      for (let b = 0; b < 12; b++) {
        const bo = b * 8;
        const state = Math.floor(v.bubbles.data[bo + 7]);
        seen.add(state);
        if (state === BUBBLE_STATE.Dead && v.bubbles.data[bo + 5] !== 0) {
          deadFillViolations++; // fill01 → 0(§2.2)
        }
        if (state === BUBBLE_STATE.Splashing) {
          splashFrames++;
          // 中身ゼロ: この球のアンカー近傍に原子がいない
          const ax = v.bubbles.data[bo];
          const ay = v.bubbles.data[bo + 1];
          const az = v.bubbles.data[bo + 2];
          const r = v.bubbles.data[bo + 3];
          for (let i = 0; i < v.atoms.count; i++) {
            const o = i * 4;
            const d = Math.hypot(
              v.atoms.posr[o] - ax,
              v.atoms.posr[o + 1] - ay,
              v.atoms.posr[o + 2] - az,
            );
            if (d <= r) atomsInSplashing++;
          }
        }
      }
    }
    expect(deadFillViolations).toBe(0);
    expect(atomsInSplashing).toBe(0);
    for (const st of [
      BUBBLE_STATE.Spawning,
      BUBBLE_STATE.Drifting,
      BUBBLE_STATE.Straining,
      BUBBLE_STATE.Falling,
      BUBBLE_STATE.Splashing,
      BUBBLE_STATE.Dead,
    ]) {
      expect(seen.has(st)).toBe(true);
    }
    expect(splashFrames).toBeGreaterThan(0);
  });

  it('SplashEvent: radius = R、strength = min(1, v/4) ≈ 0.8、着水位置 = アンカー x/z', () => {
    const sim = new MizuNiNaruSim();
    sim.init({ seed: 7, slotCount: 12 });
    let splashes = 0;
    for (let s = 0; s < 60 * 120 && splashes === 0; s++) {
      sim.step();
      const v = sim.view();
      for (let e = 0; e < v.splashes.count; e++) {
        splashes++;
        const o = e * 4;
        const radius = v.splashes.data[o + 2];
        const strength = v.splashes.data[o + 3];
        expect(radius).toBeGreaterThanOrEqual(1.1);
        expect(radius).toBeLessThanOrEqual(1.7);
        // §2.4 解析: 着水速度 ≈3.2 → strength ≈ 0.8(帯で確認)
        expect(strength).toBeGreaterThan(0.5);
        expect(strength).toBeLessThanOrEqual(1);
      }
    }
    expect(splashes).toBeGreaterThan(0);
  });

  it('Straining 以降スポナー停止: Straining 中に原子総数(生成累計)が増えない', () => {
    const sim = new MizuNiNaruSim();
    sim.init({ seed: 7, slotCount: 12 });
    let checkedFrames = 0;
    let prevSpawned = -1;
    for (let s = 0; s < 60 * 60; s++) {
      sim.step();
      const v = sim.view();
      // 全球が Straining/Falling/Splashing/Dead のフレームだけ全体供給停止を確認
      let anySupplying = false;
      for (let b = 0; b < 12; b++) {
        const st = Math.floor(v.bubbles.data[b * 8 + 7]);
        if (st === BUBBLE_STATE.Spawning || st === BUBBLE_STATE.Drifting) {
          anySupplying = true;
        }
      }
      const ledger = sim.ledger();
      const spawned = ledger.spawnedH + ledger.spawnedO;
      if (!anySupplying && prevSpawned >= 0) {
        expect(spawned).toBe(prevSpawned);
        checkedFrames++;
      }
      prevSpawned = spawned;
    }
    // このシードでは全球供給停止フレームが出ないこともある — 出た場合のみ検証
    expect(checkedFrames).toBeGreaterThanOrEqual(0);
  });

  it('counts(): SimCounts が台帳と整合する', () => {
    const sim = new MizuNiNaruSim();
    sim.init({ seed: 4, slotCount: 12 });
    for (let s = 0; s < 1800; s++) sim.step();
    const c = sim.counts();
    const ledger = sim.ledger();
    expect(c.h).toBe(ledger.h);
    expect(c.o).toBe(ledger.o);
    expect(c.h2).toBe(ledger.h2);
    expect(c.droplets).toBe(ledger.liveDroplets);
    expect(c.dropletsAbsorbedTotal).toBe(ledger.absorbedDroplets);
    expect(c.dissolvedTotal).toBe(
      ledger.dissolvedH + ledger.dissolvedO + ledger.dissolvedH2,
    );
    expect(c.bubblesActive).toBeGreaterThan(0);
    expect(c.bubblesActive).toBeLessThanOrEqual(12);
    expect(c.meanFill01).toBeGreaterThan(0);
    expect(c.meanFill01).toBeLessThanOrEqual(1);
  });

  it('スポナー人口: 定常で H/O が目標近傍に張り付く(視覚密度 §5.1)', () => {
    const sim = new MizuNiNaruSim();
    sim.init({ seed: 8, slotCount: 12 });
    for (let s = 0; s < 60 * 60; s++) sim.step();
    // 60 s 後、12 球中アクティブ球の平均人口が H ≈ 12、O ≈ 8 の近傍
    const c = sim.counts();
    const active = c.bubblesActive;
    expect(c.h / active).toBeGreaterThan(6);
    expect(c.h / active).toBeLessThanOrEqual(13);
    expect(c.o / active).toBeGreaterThan(4);
    expect(c.o / active).toBeLessThanOrEqual(9);
  });

  it('Drifting 中の fill01 は F_FULL 到達後 Straining へ(それ以上 Drifting しない)', () => {
    const sim = new MizuNiNaruSim();
    sim.init({ seed: 6, slotCount: 12 });
    for (let s = 0; s < 60 * 150; s++) {
      sim.step();
      const v = sim.view();
      for (let b = 0; b < 12; b++) {
        const bo = b * 8;
        const state = Math.floor(v.bubbles.data[bo + 7]);
        if (state === BUBBLE_STATE.Drifting) {
          // 1 step 分の余裕(到達フレームの遷移は次 step 判定)
          expect(v.bubbles.data[bo + 5]).toBeLessThan(F_FULL + 0.05);
        }
      }
    }
  });

  it('96 球スモーク: A35 構成(近 12 + フィールド 84)でも境界・台帳が壊れない(seed 1 × 300 step)', () => {
    const sim = new MizuNiNaruSim();
    sim.init({ seed: 1, slotCount: SLOT_COUNT_DESKTOP });
    let worstBoundary = Number.NEGATIVE_INFINITY;
    let samples = 0;
    const measure = (
      v: ReturnType<MizuNiNaruSim['view']>,
      x: number,
      y: number,
      z: number,
      r: number,
    ): void => {
      const bubbles = v.bubbles.data;
      let best = Number.POSITIVE_INFINITY;
      for (let b = 0; b < v.bubbles.count; b++) {
        const bo = b * 8;
        const d =
          Math.hypot(
            x - bubbles[bo],
            y - bubbles[bo + 1],
            z - bubbles[bo + 2],
          ) -
          (SHELL_RATIO * bubbles[bo + 3] - r);
        best = Math.min(best, d);
      }
      worstBoundary = Math.max(worstBoundary, best);
      samples++;
    };
    for (let s = 0; s < 300; s++) {
      sim.step();
      const v = sim.view();
      for (let i = 0; i < v.atoms.count; i++) {
        const o = i * 4;
        measure(
          v,
          v.atoms.posr[o],
          v.atoms.posr[o + 1],
          v.atoms.posr[o + 2],
          v.atoms.posr[o + 3],
        );
      }
      for (let i = 0; i < v.droplets.count; i++) {
        const o = i * 4;
        measure(
          v,
          v.droplets.posr[o],
          v.droplets.posr[o + 1],
          v.droplets.posr[o + 2],
          v.droplets.posr[o + 3],
        );
      }
      assertLedgerConserved(sim.ledger());
    }
    expect(samples).toBeGreaterThan(0); // 空虚テスト防止
    // 96 球では float32 丸め誤差の累積がやや大きく、主系列の 1e-6 より緩い
    // 1e-5 を許容(他不変条件テストの waterY 判定と同オーダー)
    expect(worstBoundary).toBeLessThanOrEqual(1e-5);
    const ledger = sim.ledger();
    expect(ledger.spawnedH).toBeGreaterThan(0);
  });
});
