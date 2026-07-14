import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import {
  type BubbleBucket,
  BubbleInstanceBuffers,
  bubbleVisualSeed,
  sortBubblesFarToNear,
} from '../../src/render/bubbles/BubbleInstanceBuffers';
import { StubSim } from '../../src/sim/StubSim';

const STRIDE = 8;

const makeData = (anchors: [number, number, number][]): Float32Array => {
  const data = new Float32Array(anchors.length * STRIDE);
  anchors.forEach(([x, y, z], i) => {
    data[i * STRIDE] = x;
    data[i * STRIDE + 1] = y;
    data[i * STRIDE + 2] = z;
    data[i * STRIDE + 3] = 1.2; // R
  });
  return data;
};

describe('sortBubblesFarToNear(§1.3 の 7 球 CPU 距離ソート)', () => {
  it("カメラから遠い順に並ぶ(painter's order)", () => {
    const data = makeData([
      [0, 0, 1], // カメラ(0,0,10)から 9
      [0, 0, -5], // 15
      [0, 0, 7], // 3
      [0, 0, -1], // 11
    ]);
    const order = new Int32Array(8);
    sortBubblesFarToNear(data, 4, 0, 0, 10, order);
    expect(Array.from(order.slice(0, 4))).toEqual([1, 3, 0, 2]);
  });

  it('決定論・全スロットが一度ずつ現れる', () => {
    const anchors: [number, number, number][] = [];
    for (let i = 0; i < 7; i++) {
      anchors.push([Math.sin(i * 2.3) * 5, 3 + i * 0.1, Math.cos(i * 1.7) * 5]);
    }
    const data = makeData(anchors);
    const a = new Int32Array(8);
    const b = new Int32Array(8);
    sortBubblesFarToNear(data, 7, 3, 4, 8, a);
    sortBubblesFarToNear(data, 7, 3, 4, 8, b);
    expect(Array.from(a.slice(0, 7)).sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(a).toEqual(b);
  });
});

describe('bubbleVisualSeed(裁定 A22)', () => {
  it('[0,1) の値・決定論・スロット/R 掃引で十分に散らばる', () => {
    const s1 = bubbleVisualSeed(0, 1.3);
    expect(bubbleVisualSeed(0, 1.3)).toBe(s1);

    const seeds: number[] = [];
    for (let slot = 0; slot < 8; slot++) {
      for (const r of [1.1, 1.25, 1.4, 1.55, 1.7]) {
        const s = bubbleVisualSeed(slot, r);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThan(1);
        seeds.push(s);
      }
    }
    const mean = seeds.reduce((a, b) => a + b, 0) / seeds.length;
    const varSum =
      seeds.reduce((a, b) => a + (b - mean) ** 2, 0) / seeds.length;
    // 一様 [0,1) の分散 ≈ 0.083 — 半分以上の散らばりを要求
    expect(varSum).toBeGreaterThan(0.04);
  });
});

const bucketVersions = (bucket: BubbleBucket): number[] => [
  bucket.currA.version,
  bucket.currB.version,
  bucket.prevA.version,
  bucket.prevB.version,
  bucket.misc.version,
];

const bufferVersions = (buffers: BubbleInstanceBuffers): number[] => [
  ...bucketVersions(buffers.near),
  ...bucketVersions(buffers.far),
];

const bucketSnapshot = (bucket: BubbleBucket): number[] => [
  bucket.count,
  ...Array.from(bucket.currA.array.slice(0, bucket.count * 4)),
  ...Array.from(bucket.currB.array.slice(0, bucket.count * 4)),
  ...Array.from(bucket.prevA.array.slice(0, bucket.count * 4)),
  ...Array.from(bucket.prevB.array.slice(0, bucket.count * 4)),
  ...Array.from(bucket.misc.array.slice(0, bucket.count * 2)),
];

describe('BubbleInstanceBuffers upload gating', () => {
  it('同じstepでsort/LODが同じならcameraが微動しても再uploadしない', () => {
    const sim = new StubSim();
    sim.init({ seed: 7, slotCount: 7 });
    const camera = new PerspectiveCamera();
    camera.position.set(0, 5, 13);
    const buffers = new BubbleInstanceBuffers();

    buffers.sync(sim.view(), camera);
    expect(bufferVersions(buffers)).toEqual(Array(10).fill(1));
    camera.position.x += 1e-6;
    buffers.sync(sim.view(), camera);
    expect(bufferVersions(buffers)).toEqual(Array(10).fill(1));

    sim.step();
    buffers.sync(sim.view(), camera);
    expect(bufferVersions(buffers)).toEqual(Array(10).fill(2));
  });

  it('同じstepでもcameraでsort/LODが変われば参照実装と同じ内容を再uploadする', () => {
    const sim = new StubSim();
    sim.init({ seed: 11, slotCount: 7 });
    const camera = new PerspectiveCamera();
    camera.position.set(0, 5, 13);
    const buffers = new BubbleInstanceBuffers();
    buffers.sync(sim.view(), camera);

    camera.position.set(0, 5, -13);
    const reference = new BubbleInstanceBuffers();
    reference.sync(sim.view(), camera);
    buffers.sync(sim.view(), camera);

    expect(bufferVersions(buffers)).toEqual(Array(10).fill(2));
    expect(bucketSnapshot(buffers.near)).toEqual(
      bucketSnapshot(reference.near),
    );
    expect(bucketSnapshot(buffers.far)).toEqual(bucketSnapshot(reference.far));
    expect(buffers.rippleIndexBySlot).toEqual(reference.rippleIndexBySlot);
  });
});
