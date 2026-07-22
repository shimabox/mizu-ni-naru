import { Vector4 } from 'three';
import { describe, expect, it } from 'vitest';
import type {
  AtomView,
  DropletView,
  SkyRenderView,
} from '../../src/contract/RenderView';
import { BUBBLE_CAPACITY, BUBBLE_STATE } from '../../src/contract/WorldSpec';
import {
  CAP_SHADOWS_PER_BUBBLE,
  CAP_SHADOW_BUBBLES,
  CAP_SHADOW_FADE_FAR,
  CAP_SHADOW_FADE_NEAR,
  collectCapShadows,
} from '../../src/render/bubbles/CapShadows';

const BSTRIDE = 8;
const PSTRIDE = 4;

interface BubbleSpec {
  center: [number, number, number];
  R: number;
  waterLevelYLocal: number;
  fill01: number;
  /** statePacked = stateIndex + progress01(0..0.999)。 */
  statePacked: number;
}

interface PointSpec {
  pos: [number, number, number];
  r: number;
  /** 雫のポップイン検証用。省略時 -1000(= とっくに popIn 完了)。 */
  spawnStep?: number;
}

const makeBubbleData = (
  specs: BubbleSpec[],
): { data: Float32Array; prevData: Float32Array; count: number } => {
  const data = new Float32Array(specs.length * BSTRIDE);
  specs.forEach((s, i) => {
    const o = i * BSTRIDE;
    data[o] = s.center[0];
    data[o + 1] = s.center[1];
    data[o + 2] = s.center[2];
    data[o + 3] = s.R;
    data[o + 4] = s.waterLevelYLocal;
    data[o + 5] = s.fill01;
    data[o + 6] = 0; // wobble(未使用)
    data[o + 7] = s.statePacked;
  });
  return { data, prevData: new Float32Array(data), count: specs.length };
};

const makePointData = (specs: PointSpec[]): Float32Array => {
  const data = new Float32Array(specs.length * PSTRIDE);
  specs.forEach((s, i) => {
    const o = i * PSTRIDE;
    data[o] = s.pos[0];
    data[o + 1] = s.pos[1];
    data[o + 2] = s.pos[2];
    data[o + 3] = s.r;
  });
  return data;
};

const makeAtomView = (specs: PointSpec[]): AtomView => {
  const posr = makePointData(specs);
  return {
    posr,
    prevPosr: new Float32Array(posr),
    colorKind: new Float32Array(specs.length * PSTRIDE),
    aux: new Float32Array(specs.length * PSTRIDE),
    count: specs.length,
    version: 1,
  };
};

const makeDropletView = (specs: PointSpec[]): DropletView => {
  const posr = makePointData(specs);
  // aux = [phase, swayAmp, spawnStep, seed]。spawnStep 省略時は -1000
  // (ポップイン完了済み)— 影半径の等値アサートが popIn の影響を受けない
  const aux = new Float32Array(specs.length * PSTRIDE);
  specs.forEach((s, i) => {
    aux[i * PSTRIDE + 2] = s.spawnStep ?? -1000;
  });
  return {
    posr,
    prevPosr: new Float32Array(posr),
    aux,
    count: specs.length,
    version: 1,
  };
};

const makeView = (
  bubbles: BubbleSpec[],
  atoms: PointSpec[] = [],
  droplets: PointSpec[] = [],
  step = 0,
): SkyRenderView => {
  const bubbleData = makeBubbleData(bubbles);
  return {
    step,
    bubbles: { ...bubbleData, version: 1 },
    atoms: makeAtomView(atoms),
    droplets: makeDropletView(droplets),
    splashes: { data: new Float32Array(0), count: 0 },
    ripples: { data: new Float32Array(0), count: 0 },
  };
};

const makeOutputs = (): { shadows: Vector4[]; meta: Vector4[] } => {
  const shadows: Vector4[] = [];
  for (let i = 0; i < CAP_SHADOW_BUBBLES * CAP_SHADOWS_PER_BUBBLE; i++) {
    shadows.push(new Vector4());
  }
  const meta: Vector4[] = [];
  for (let i = 0; i < CAP_SHADOW_BUBBLES; i++) meta.push(new Vector4());
  return { shadows, meta };
};

/** 既定: rippleIndexBySlot[slot] = slot(全球が近傍追跡対象)。 */
const identityRippleIndex = (n: number): Int32Array => {
  const arr = new Int32Array(BUBBLE_CAPACITY).fill(-1);
  for (let i = 0; i < n; i++) arr[i] = i;
  return arr;
};

const DRIFTING = BUBBLE_STATE.Drifting; // grow=1 の単純なケース

describe('collectCapShadows(A76: 球内水面キャップの接触影)', () => {
  it('最近傍球内・水面上の雫が正しい球ローカル座標・h・r でパックされる(prev/curr lerp含む)', () => {
    const view = makeView(
      [
        {
          center: [0, 0, 0],
          R: 2,
          waterLevelYLocal: 0,
          fill01: 1,
          statePacked: DRIFTING,
        },
      ],
      [],
      [{ pos: [0.3, 0.5, -0.2], r: 0.05 }],
    );
    // prev を curr からずらして alpha 補間が効くことを確認する
    view.bubbles.prevData[0] = -1; // center.x prev = -1(curr=0)
    view.droplets.prevPosr[0] = -0.3; // droplet.x prev = -0.3(curr=0.3)

    const { shadows, meta } = makeOutputs();
    collectCapShadows(
      view,
      0.5,
      0,
      0,
      5,
      identityRippleIndex(1),
      shadows,
      meta,
    );

    // center.x lerp(-1,0,0.5) = -0.5、droplet.x lerp(-0.3,0.3,0.5) = 0 → localX = 0-(-0.5) = 0.5
    expect(meta[0].x).toBe(0); // rippleIndex
    expect(meta[0].y).toBe(1); // count
    expect(meta[0].z).toBeCloseTo(1, 5); // fade(カメラ距離5 < NEAR なので 1)
    expect(shadows[0].x).toBeCloseTo(0.5, 5); // localX
    expect(shadows[0].y).toBeCloseTo(-0.2, 5); // localZ
    expect(shadows[0].z).toBeCloseTo(0.5, 5); // h
    expect(shadows[0].w).toBeCloseTo(0.05, 5); // r
  });

  it('水面下の雫・球外の雫は除外される', () => {
    const view = makeView(
      [
        {
          center: [0, 0, 0],
          R: 2,
          waterLevelYLocal: 0,
          fill01: 1,
          statePacked: DRIFTING,
        },
      ],
      [],
      [
        { pos: [0.2, 0.3, 0.1], r: 0.05 }, // 有効(水面上・球内)
        { pos: [0.1, -0.05, 0.1], r: 0.05 }, // 水面下 → 除外
        { pos: [10, 10, 10], r: 0.05 }, // 球外 → 除外
      ],
    );
    const { shadows, meta } = makeOutputs();
    collectCapShadows(view, 1, 0, 0, 5, identityRippleIndex(1), shadows, meta);

    expect(meta[0].y).toBe(1);
    expect(shadows[0].w).toBeCloseTo(0.05, 5);
    expect(shadows[0].z).toBeCloseTo(0.3, 5); // h
  });

  it('CAP_SHADOW_FADE_FAR より遠い球は除外され、fade は NEAR..FAR で単調減少する', () => {
    const bubble: BubbleSpec = {
      center: [0, 0, 0],
      R: 2,
      waterLevelYLocal: 0,
      fill01: 1,
      statePacked: DRIFTING,
    };
    const fadeAt = (camDist: number): number => {
      const view = makeView([bubble]);
      const { shadows, meta } = makeOutputs();
      collectCapShadows(
        view,
        1,
        0,
        0,
        camDist,
        identityRippleIndex(1),
        shadows,
        meta,
      );
      return meta[0].x < 0 ? 0 : meta[0].z;
    };

    const fNear = fadeAt(CAP_SHADOW_FADE_NEAR);
    const fMid = fadeAt((CAP_SHADOW_FADE_NEAR + CAP_SHADOW_FADE_FAR) / 2);
    const fJustBeforeFar = fadeAt(CAP_SHADOW_FADE_FAR - 0.1);
    expect(fNear).toBeCloseTo(1, 5);
    expect(fNear).toBeGreaterThan(fMid);
    expect(fMid).toBeGreaterThan(fJustBeforeFar);
    expect(fJustBeforeFar).toBeGreaterThan(0);

    // FAR 以遠は候補選抜の時点で除外される
    const view = makeView([bubble]);
    const { shadows, meta } = makeOutputs();
    collectCapShadows(
      view,
      1,
      0,
      0,
      CAP_SHADOW_FADE_FAR,
      identityRippleIndex(1),
      shadows,
      meta,
    );
    expect(meta[0].x).toBe(-1);
  });

  it('9体以上いるとき重み(低い・大きいほど濃い)上位8体が残る', () => {
    const droplets: PointSpec[] = [];
    // r を 0.9→0.1 と減らしながら h=0.1 固定 → weight=r/(r+h) は単調減少
    // (r=0.1 が最小 weight で 9 番目 = 弾かれる想定)
    for (let i = 0; i < 9; i++) {
      const r = 0.9 - i * 0.1;
      droplets.push({ pos: [i * 0.01, 0.1, 0], r });
    }
    const view = makeView(
      [
        {
          center: [0, 0, 0],
          R: 5,
          waterLevelYLocal: 0,
          fill01: 1,
          statePacked: DRIFTING,
        },
      ],
      [],
      droplets,
    );
    const { shadows, meta } = makeOutputs();
    collectCapShadows(view, 1, 0, 0, 5, identityRippleIndex(1), shadows, meta);

    expect(meta[0].y).toBe(CAP_SHADOWS_PER_BUBBLE);
    const keptR = Array.from(
      { length: CAP_SHADOWS_PER_BUBBLE },
      (_, k) => shadows[k].w,
    ).sort((a, b) => a - b);
    // 最小 weight(r=0.1)は弾かれ、r=0.2..0.9 の 8 体が残る
    expect(keptR.some((r) => Math.abs(r - 0.1) < 1e-6)).toBe(false);
    for (let i = 0; i < 8; i++) {
      const r = 0.9 - i * 0.1;
      expect(keptR.some((kr) => Math.abs(kr - r) < 1e-6)).toBe(true);
    }
    // 最高 weight(r=0.9)が先頭(weight 降順)に来ている
    expect(shadows[0].w).toBeCloseTo(0.9, 5);
  });

  it('Splashing/Dead 球・fill01≈0 の球は除外される', () => {
    const view = makeView([
      {
        center: [0, 0, 0],
        R: 2,
        waterLevelYLocal: 0,
        fill01: 1,
        statePacked: DRIFTING,
      }, // 有効
      {
        center: [3, 0, 0],
        R: 2,
        waterLevelYLocal: 0,
        fill01: 1,
        statePacked: BUBBLE_STATE.Splashing,
      },
      {
        center: [-3, 0, 0],
        R: 2,
        waterLevelYLocal: 0,
        fill01: 1,
        statePacked: BUBBLE_STATE.Dead,
      },
      {
        center: [0, 0, 3],
        R: 2,
        waterLevelYLocal: 0,
        fill01: 0.01,
        statePacked: DRIFTING,
      },
    ]);
    const { shadows, meta } = makeOutputs();
    collectCapShadows(view, 1, 0, 0, 5, identityRippleIndex(4), shadows, meta);

    // 有効なのは slot 0 のみ → meta のどこか 1 枠だけが rippleIndex=0 を持つ
    const active = meta.filter((m) => m.x >= 0);
    expect(active.length).toBe(1);
    expect(active[0].x).toBe(0);
  });

  it('原子(文字)は影を落とさない(A76 改訂: 遮蔽物は雫のみ)', () => {
    const view = makeView(
      [
        {
          center: [0, 0, 0],
          R: 2,
          waterLevelYLocal: 0,
          fill01: 1,
          statePacked: DRIFTING,
        },
      ],
      [{ pos: [0.1, 0.2, 0.15], r: 0.08 }], // 球内・水面上の原子 — それでも対象外
      [],
    );
    const { shadows, meta } = makeOutputs();
    collectCapShadows(view, 1, 0, 0, 5, identityRippleIndex(1), shadows, meta);

    expect(meta[0].x).toBe(0); // 球自体は追跡対象
    expect(meta[0].y).toBe(0); // だが影は 0 件
    expect(shadows[0]).toEqual(new Vector4(0, 0, 0, 0));
  });

  it('雫のポップイン中は影半径も縮み、スポーン直後(popIn=0)は影が出ない', () => {
    const bubble: BubbleSpec = {
      center: [0, 0, 0],
      R: 2,
      waterLevelYLocal: 0,
      fill01: 1,
      statePacked: DRIFTING,
    };
    // スポーン直後(stepF == spawnStep)→ popIn=0 → 候補ごと除外
    const fresh = makeView(
      [bubble],
      [],
      [{ pos: [0.1, 0.3, 0], r: 0.05, spawnStep: 5 }],
      5,
    );
    const a = makeOutputs();
    collectCapShadows(
      fresh,
      0,
      0,
      0,
      5,
      identityRippleIndex(1),
      a.shadows,
      a.meta,
    );
    expect(a.meta[0].x).toBe(0);
    expect(a.meta[0].y).toBe(0);

    // ポップイン中間(stepF - spawnStep = 5 / 10)→ 影半径 = r * smoothstep(0,10,5) = r * 0.5
    // (droplet.ts の popIn と同位相 — 見た目半径と影半径が一致する)
    const mid = makeView(
      [bubble],
      [],
      [{ pos: [0.1, 0.3, 0], r: 0.05, spawnStep: 0 }],
      5,
    );
    const b = makeOutputs();
    collectCapShadows(
      mid,
      0,
      0,
      0,
      5,
      identityRippleIndex(1),
      b.shadows,
      b.meta,
    );
    expect(b.meta[0].y).toBe(1);
    expect(b.shadows[0].w).toBeCloseTo(0.05 * 0.5, 5);
  });

  it('rippleIndexBySlot が -1 の球は meta に載らない(影も出さない)', () => {
    const view = makeView(
      [
        {
          center: [0, 0, 0],
          R: 2,
          waterLevelYLocal: 0,
          fill01: 1,
          statePacked: DRIFTING,
        },
      ],
      [],
      [{ pos: [0.2, 0.3, 0.1], r: 0.05 }],
    );
    const rippleIndexBySlot = new Int32Array(BUBBLE_CAPACITY).fill(-1);
    const { shadows, meta } = makeOutputs();
    collectCapShadows(view, 1, 0, 0, 5, rippleIndexBySlot, shadows, meta);

    expect(meta[0]).toEqual(new Vector4(-1, 0, 0, 0));
    for (let k = 0; k < CAP_SHADOWS_PER_BUBBLE; k++) {
      expect(shadows[k]).toEqual(new Vector4(0, 0, 0, 0));
    }
  });
});
