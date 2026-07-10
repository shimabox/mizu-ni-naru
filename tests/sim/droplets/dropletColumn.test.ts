import { describe, expect, it } from 'vitest';
import { DT } from '../../../src/contract/WorldSpec';
import {
  DROPLET_CAP_PER_BUBBLE,
  DROPLET_FALL_SPEED_PER_R,
} from '../../../src/sim/config';
import {
  type AbsorbSink,
  DropletColumn,
} from '../../../src/sim/droplets/DropletColumn';

const R_INNER = 1.316;

class RecordingSink implements AbsorbSink {
  public absorbed: { x: number; z: number; r: number }[] = [];
  public onAbsorb(x: number, z: number, r: number): void {
    this.absorbed.push({ x, z, r });
  }
}

const spawnAt = (
  col: DropletColumn,
  y: number,
  x = 0,
  z = 0,
  r = 0.1,
  step = 0,
): void => col.spawn(x, y, z, r, 1.23, 0.03, 0.5, step);

describe('DropletColumn(§4.1 — RNG フリーカーネル)', () => {
  it('spawn はスポーンフレーム prev = curr で書き込む', () => {
    const col = new DropletColumn();
    spawnAt(col, 0.5, 0.1, -0.2, 0.08, 42);
    expect(col.count).toBe(1);
    for (let k = 0; k < 4; k++) {
      expect(col.prevPosr[k]).toBe(col.posr[k]);
    }
    expect(col.aux[0]).toBeCloseTo(1.23, 6);
    expect(col.aux[1]).toBeCloseTo(0.03, 6);
    expect(col.aux[2]).toBe(42);
    expect(col.aux[3]).toBeCloseTo(0.5, 6);
  });

  it('満杯なら捨てて droppedTotal を数える(優雅な劣化)', () => {
    const col = new DropletColumn();
    for (let i = 0; i < DROPLET_CAP_PER_BUBBLE + 3; i++) {
      spawnAt(col, 0.5);
    }
    expect(col.count).toBe(DROPLET_CAP_PER_BUBBLE);
    expect(col.droppedTotal).toBe(3);
  });

  it('カーネルは RNG を一切持たない(step が Random に触れないシグネチャ)', () => {
    // 型シグネチャ上 Random を受け取らないこと自体が保証。ここでは
    // 実行で位相・振幅(スポーン時確定)だけから決定的に動くことを固定する
    const run = (): Float32Array => {
      const col = new DropletColumn();
      spawnAt(col, 0.8, 0.1, 0.05);
      const sink = new RecordingSink();
      for (let i = 0; i < 60; i++) col.step(-1.2, R_INNER, sink);
      return col.posr.slice(0, 4);
    };
    expect(run()).toEqual(run());
  });

  it('落下速度は 4r/s(1 step で y −= 4r·DT)、prev に旧位置が残る', () => {
    const col = new DropletColumn();
    const r = 0.1;
    spawnAt(col, 0.5, 0, 0, r);
    const sink = new RecordingSink();
    col.step(-1.2, R_INNER, sink);
    expect(col.prevPosr[1]).toBeCloseTo(0.5, 6);
    expect(col.posr[1]).toBeCloseTo(0.5 - DROPLET_FALL_SPEED_PER_R * r * DT, 6);
  });

  it('sway は位置に焼き込まれる(裁定 A9 — render は位置加算禁止の前提)', () => {
    const col = new DropletColumn();
    spawnAt(col, 0.5);
    const sink = new RecordingSink();
    col.step(-1.2, R_INNER, sink);
    // swayAmp > 0 なので x/z が動く(cos の値がゼロでない位相を選んでいる)
    expect(Math.abs(col.posr[0]) + Math.abs(col.posr[2])).toBeGreaterThan(0);
  });

  it('球内クランプ: sway が球殻を突き抜けない(|p| ≤ R_inner − r)', () => {
    const col = new DropletColumn();
    const r = 0.1;
    // 殻ぎりぎりの横位置に置く
    const rEff = R_INNER - r;
    col.spawn(rEff * 0.999, 0, 0, r, 0, 5.0, 0.5, 0); // 大きな swayAmp
    const sink = new RecordingSink();
    for (let i = 0; i < 300; i++) {
      col.step(-1.3, R_INNER, sink);
      if (col.count === 0) break;
      const x = col.posr[0];
      const y = col.posr[1];
      const z = col.posr[2];
      expect(Math.hypot(x, y, z)).toBeLessThanOrEqual(rEff + 1e-5);
    }
  });

  it('吸収: y ≤ waterY + r で sink 通知し列から消える', () => {
    const col = new DropletColumn();
    const r = 0.1;
    const waterY = -0.5;
    spawnAt(col, waterY + r + 0.01, 0.2, -0.1, r);
    const sink = new RecordingSink();
    let steps = 0;
    while (col.count > 0 && steps < 100) {
      col.step(waterY, R_INNER, sink);
      steps++;
    }
    expect(col.count).toBe(0);
    expect(sink.absorbed).toHaveLength(1);
    expect(sink.absorbed[0].r).toBeCloseTo(r, 6);
  });

  it('生存雫は常に水面より上(y > waterY + r — A25)', () => {
    const col = new DropletColumn();
    const waterY = -0.4;
    for (let i = 0; i < 8; i++) {
      spawnAt(col, 0.2 + i * 0.1, i * 0.05, -i * 0.03, 0.08 + i * 0.002);
    }
    const sink = new RecordingSink();
    for (let s = 0; s < 400; s++) {
      col.step(waterY, R_INNER, sink);
      for (let i = 0; i < col.count; i++) {
        const o = i * 4;
        expect(col.posr[o + 1]).toBeGreaterThan(waterY + col.posr[o + 3]);
      }
    }
    expect(sink.absorbed.length).toBe(8);
  });

  it('swap-remove は posr/prevPosr/aux の 3 本同時(生き残りの対応が保たれる)', () => {
    const col = new DropletColumn();
    const waterY = -0.5;
    const r = 0.1;
    // 0 番だけ吸収間際、1・2 番は高み
    spawnAt(col, waterY + r + 0.005, 0.9, 0.9, r, 10);
    spawnAt(col, 0.8, 0.1, 0.2, r, 11);
    spawnAt(col, 0.9, -0.2, 0.3, r, 12);
    const sink = new RecordingSink();
    col.step(waterY, R_INNER, sink);
    expect(sink.absorbed).toHaveLength(1);
    expect(col.count).toBe(2);
    // 末尾(spawnStep=12)が index 0 に移っている。aux も一緒に動く
    expect(col.aux[2]).toBe(12);
    expect(col.aux[4 + 2]).toBe(11);
    // prev と curr が同一エンティティを指す(y の減少はちょうど落下 + 0)
    for (let i = 0; i < col.count; i++) {
      const o = i * 4;
      expect(col.prevPosr[o + 1] - col.posr[o + 1]).toBeCloseTo(
        DROPLET_FALL_SPEED_PER_R * col.posr[o + 3] * DT,
        5,
      );
    }
  });

  it('swap-remove の i 再処理: 連続吸収でも取りこぼさない(全滅エッジ)', () => {
    const col = new DropletColumn();
    const waterY = -0.5;
    const r = 0.1;
    for (let i = 0; i < 5; i++) {
      spawnAt(col, waterY + r + 0.001, i * 0.1, 0, r);
    }
    const sink = new RecordingSink();
    col.step(waterY, R_INNER, sink);
    expect(col.count).toBe(0);
    expect(sink.absorbed).toHaveLength(5);
  });

  it('clear で全滅(Splashing の中身クリア用)', () => {
    const col = new DropletColumn();
    spawnAt(col, 0.5);
    spawnAt(col, 0.6);
    col.clear();
    expect(col.count).toBe(0);
  });
});
