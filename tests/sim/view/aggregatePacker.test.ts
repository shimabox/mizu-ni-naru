import { describe, expect, it } from 'vitest';
import {
  ATOM_VIEW_CAPACITY,
  BUBBLE_STATE,
  DROPLET_VIEW_CAPACITY,
  DT,
  RIPPLE_VIEW_CAPACITY,
  SPLASH_VIEW_CAPACITY,
} from '../../../src/contract/WorldSpec';
import { MizuNiNaruSim } from '../../../src/sim/MizuNiNaruSim';
import {
  ATOM_MAX_SPEED_RATIO,
  BOB_AMP,
  R_MAX,
  SHELL_RATIO,
} from '../../../src/sim/config';

/**
 * 補間契約(design-sim §1.4 / §7.3、裁定 A4)。
 * prev/curr の同一インデックス = 同一エンティティを、
 * 「1 step の移動量は物理上限を超えない」ことで外形的に固定する
 * (エンティティ対応が 1 つでもズレれば移動量が跳ねて検出される)。
 */
describe('AggregatePacker — 補間契約(§1.4)', () => {
  it('BubbleView.count は常に slotCount(Dead 含む — A18)、dense prefix 容量内', () => {
    const sim = new MizuNiNaruSim();
    sim.init({ seed: 11, slotCount: 7 });
    for (let s = 0; s < 1200; s++) {
      sim.step();
      const v = sim.view();
      expect(v.bubbles.count).toBe(7);
      expect(v.atoms.count).toBeLessThanOrEqual(ATOM_VIEW_CAPACITY);
      expect(v.droplets.count).toBeLessThanOrEqual(DROPLET_VIEW_CAPACITY);
      expect(v.splashes.count).toBeLessThanOrEqual(SPLASH_VIEW_CAPACITY);
      expect(v.ripples.count).toBeLessThanOrEqual(RIPPLE_VIEW_CAPACITY);
    }
  });

  it('view() は安定オブジェクト(毎フレーム同一参照)', () => {
    const sim = new MizuNiNaruSim();
    sim.init({ seed: 1, slotCount: 5 });
    const v1 = sim.view();
    sim.step();
    const v2 = sim.view();
    expect(v2).toBe(v1);
    expect(v2.atoms.posr).toBe(v1.atoms.posr);
    expect(v2.bubbles.data).toBe(v1.bubbles.data);
    expect(v1.atoms.version).toBe(0); // 固定容量 — 再確保は起きない
  });

  it('原子の prev→curr 移動量は物理上限以下(エンティティ対応のズレ検出)', () => {
    const sim = new MizuNiNaruSim();
    sim.init({ seed: 7, slotCount: 7 });
    // 上限: 原子ウォーク v_max·DT + アンカー移動(bob/落下)≈ 0.1 u/step + 余裕
    const maxAtomMove = ATOM_MAX_SPEED_RATIO * R_MAX * DT + 0.15;
    let worst = 0;
    let radiusMismatches = 0;
    let samples = 0;
    for (let s = 0; s < 2400; s++) {
      sim.step();
      const v = sim.view();
      const { posr, prevPosr, count } = v.atoms;
      for (let i = 0; i < count; i++) {
        const o = i * 4;
        const d = Math.hypot(
          posr[o] - prevPosr[o],
          posr[o + 1] - prevPosr[o + 1],
          posr[o + 2] - prevPosr[o + 2],
        );
        worst = Math.max(worst, d);
        if (posr[o + 3] !== prevPosr[o + 3]) radiusMismatches++; // 半径はレーン一致
        samples++;
      }
    }
    expect(samples).toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(maxAtomMove);
    expect(radiusMismatches).toBe(0);
  });

  it('雫の prev→curr 移動量は物理上限以下 + スポーンフレーム prev = curr', () => {
    const sim = new MizuNiNaruSim();
    sim.init({ seed: 7, slotCount: 7 });
    const maxDropMove = 4.0 * (0.095 * R_MAX) * DT + 0.2; // 落下 + sway + anchor
    let worstMove = 0;
    let spawnFrameMoves = 0;
    let spawnFramesSeen = 0;
    let samples = 0;
    for (let s = 1; s <= 2400; s++) {
      sim.step();
      const v = sim.view();
      const { posr, prevPosr, aux, count } = v.droplets;
      for (let i = 0; i < count; i++) {
        const o = i * 4;
        const d = Math.hypot(
          posr[o] - prevPosr[o],
          posr[o + 1] - prevPosr[o + 1],
          posr[o + 2] - prevPosr[o + 2],
        );
        if (aux[o + 2] === v.step) {
          spawnFramesSeen++;
          if (d !== 0) spawnFrameMoves++; // スポーンフレームは prev = curr(規約 2)
        } else {
          worstMove = Math.max(worstMove, d);
        }
        samples++;
      }
    }
    expect(samples).toBeGreaterThan(0);
    expect(spawnFramesSeen).toBeGreaterThan(0);
    expect(spawnFrameMoves).toBe(0);
    expect(worstMove).toBeLessThanOrEqual(maxDropMove);
  });

  it('原子のスポーンフレームは prev = curr(aux.spawnStep で判定 — A6)', () => {
    const sim = new MizuNiNaruSim();
    sim.init({ seed: 3, slotCount: 7 });
    let spawnFramesSeen = 0;
    for (let s = 1; s <= 600; s++) {
      sim.step();
      const v = sim.view();
      const { posr, prevPosr, aux, count } = v.atoms;
      for (let i = 0; i < count; i++) {
        const o = i * 4;
        if (aux[o] === v.step) {
          spawnFramesSeen++;
          expect(prevPosr[o]).toBe(posr[o]);
          expect(prevPosr[o + 1]).toBe(posr[o + 1]);
          expect(prevPosr[o + 2]).toBe(posr[o + 2]);
        }
      }
    }
    expect(spawnFramesSeen).toBeGreaterThan(0); // 空虚テスト防止
  });

  it('world = anchor + local: 全原子・全雫はいずれかの球の内殻内にある', () => {
    const sim = new MizuNiNaruSim();
    sim.init({ seed: 5, slotCount: 7 });
    let outside = 0;
    let samples = 0;
    for (let s = 0; s < 900; s++) {
      sim.step();
      const v = sim.view();
      const bubbles = v.bubbles.data;
      const check = (x: number, y: number, z: number, r: number): boolean => {
        for (let b = 0; b < v.bubbles.count; b++) {
          const bo = b * 8;
          const d = Math.hypot(
            x - bubbles[bo],
            y - bubbles[bo + 1],
            z - bubbles[bo + 2],
          );
          if (d <= SHELL_RATIO * bubbles[bo + 3] - r + 1e-4) return true;
        }
        return false;
      };
      for (let i = 0; i < v.atoms.count; i++) {
        const o = i * 4;
        if (
          !check(
            v.atoms.posr[o],
            v.atoms.posr[o + 1],
            v.atoms.posr[o + 2],
            v.atoms.posr[o + 3],
          )
        ) {
          outside++;
        }
        samples++;
      }
      for (let i = 0; i < v.droplets.count; i++) {
        const o = i * 4;
        if (
          !check(
            v.droplets.posr[o],
            v.droplets.posr[o + 1],
            v.droplets.posr[o + 2],
            v.droplets.posr[o + 3],
          )
        ) {
          outside++;
        }
        samples++;
      }
    }
    expect(samples).toBeGreaterThan(0);
    expect(outside).toBe(0);
  });

  it('球の prevData: 再ロールフレームは prev = curr、それ以外は前 step 値', () => {
    const sim = new MizuNiNaruSim();
    sim.init({ seed: 13, slotCount: 5 });
    const prevSnapshot = new Float32Array(5 * 8);
    let respawnsSeen = 0;
    let normalFrames = 0;
    let mismatches = 0;
    // Dead → Spawning の再ロールを跨ぐ長さを回す
    for (let s = 1; s <= 60 * 220; s++) {
      const before = sim.view().bubbles.data.slice(0, 5 * 8);
      prevSnapshot.set(before);
      sim.step();
      const v = sim.view();
      for (let b = 0; b < 5; b++) {
        const bo = b * 8;
        const stateBefore = Math.floor(prevSnapshot[bo + 7]);
        const stateNow = Math.floor(v.bubbles.data[bo + 7]);
        const respawned =
          stateBefore === BUBBLE_STATE.Dead &&
          stateNow === BUBBLE_STATE.Spawning;
        if (respawned) {
          respawnsSeen++;
          for (let k = 0; k < 8; k++) {
            if (v.bubbles.prevData[bo + k] !== v.bubbles.data[bo + k]) {
              mismatches++;
            }
          }
        } else if (s > 1) {
          normalFrames++;
          // prevData は「前 step の curr」そのもの
          for (let k = 0; k < 8; k++) {
            if (v.bubbles.prevData[bo + k] !== prevSnapshot[bo + k]) {
              mismatches++;
            }
          }
        }
      }
    }
    expect(respawnsSeen).toBeGreaterThan(0); // 再ロールを実際に跨いだ
    expect(normalFrames).toBeGreaterThan(0);
    expect(mismatches).toBe(0);
  });

  it('球アンカーの prev→curr 移動量は bob/落下の上限以下', () => {
    const sim = new MizuNiNaruSim();
    sim.init({ seed: 21, slotCount: 7 });
    // bob 微動 ≪ 落下最大 ≈ 7.5·DT = 0.125。余裕 2 倍
    const maxAnchorMove = 0.25;
    let worst = 0;
    for (let s = 1; s <= 60 * 200; s++) {
      sim.step();
      const v = sim.view();
      for (let b = 0; b < 7; b++) {
        const bo = b * 8;
        const stateNow = Math.floor(v.bubbles.data[bo + 7]);
        if (stateNow === BUBBLE_STATE.Dead) continue;
        const d = Math.hypot(
          v.bubbles.data[bo] - v.bubbles.prevData[bo],
          v.bubbles.data[bo + 1] - v.bubbles.prevData[bo + 1],
          v.bubbles.data[bo + 2] - v.bubbles.prevData[bo + 2],
        );
        worst = Math.max(worst, d);
      }
    }
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(maxAnchorMove);
  });

  it('bob の振幅は BOB_AMP 帯(アンカーが基準位置近傍で呼吸する)', () => {
    const sim = new MizuNiNaruSim();
    sim.init({ seed: 2, slotCount: 7 });
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    // 最初の 5 s(Spawning + Drifting 序盤、落下なし)の slot 0
    for (let s = 0; s < 300; s++) {
      sim.step();
      const y = sim.view().bubbles.data[1];
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    expect(maxY - minY).toBeLessThanOrEqual(2 * BOB_AMP + 0.4); // + サグ分
  });
});
