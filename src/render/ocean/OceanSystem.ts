import { Color, type DataTexture, Mesh, ShaderMaterial, Vector4 } from 'three';
import type { SkyRenderView } from '../../contract/RenderView';
import { BUBBLE_CAPACITY, BUBBLE_STATE } from '../../contract/WorldSpec';
import type { SunUniforms } from '../Environment';
import type { FrameInfo, QualityTier, RenderSystem } from '../RenderSystem';
import { bubbleVisualSeed } from '../bubbles/BubbleInstanceBuffers';
import {
  GERSTNER_WAVES,
  GERSTNER_WAVE_COUNT,
  SWELL_AMP_SUM_VERTEX,
  gerstnerAngularWavenumber,
  gerstnerPhaseRate,
} from '../shaders/gerstner';
import {
  MAX_REFLECT_BUBBLES,
  OCEAN_FRAGMENT_GLSL,
  OCEAN_VERTEX_GLSL,
} from '../shaders/ocean';
import { OceanGeometryCache } from './OceanGeometry';
import type { RippleUniforms } from './RippleField';

const TWO_PI = 2 * Math.PI;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * ティア → グリッド密度(design-render §9.3)。
 * A52 最終: エフェクト(世界の空気)は解像度より優先度が高いため tier2 まで
 * フル密度を温存、削減は tier3 以降のみ。
 */
const GRID_BY_TIER: readonly (readonly [number, number])[] = [
  [144, 192],
  [144, 192],
  [144, 192],
  [120, 160],
  [96, 128],
];

/**
 * ティア → analyticReflections on/off(design-render §9.3)。
 * A52 最終: 海面の映り込みは世界の空気を作る要素として tier3 まで生存させ、
 * off になるのは最終防衛ラインの tier4 のみ。
 */
const ANALYTIC_REFLECTIONS_BY_TIER: readonly boolean[] = [
  true,
  true,
  true,
  true,
  false,
];

/**
 * Ocean v2(design-render §2 — 本作の主役)。
 *
 * Phase 2: (a) Gerstner 8 波 + (c) シェーディング + (f) 放射リンググリッド。
 * (b) リップル / (d) フォーム / (e) 解析反射は Phase 3(シェーダに TODO フック済み)。
 * uPhase は CPU が毎フレーム mod 2π して供給(fp32 位相の経時劣化ゼロ)。
 */
export class OceanSystem implements RenderSystem {
  public readonly object: Mesh;

  /**
   * analyticReflections の 2 変種(§9.3)。#define の有無で needsUpdate
   * 再コンパイルのヒッチを起こさないよう、両方を構築時に事前コンパイルし
   * 同一 uniforms オブジェクトを共有する(three の ShaderMaterial は
   * uniforms を参照代入するのでどちらの material 経由でも同じ値を読む)。
   * applyTier は object.material の参照を差し替えるだけ。
   */
  private readonly materialOn: ShaderMaterial;
  private readonly materialOff: ShaderMaterial;
  private readonly sharedUniforms: Record<string, { value: unknown }>;
  private readonly geometryCache = new OceanGeometryCache();
  private readonly waveB: Vector4[];
  private readonly phaseRates: number[];
  private readonly bubblePosR: Vector4[];
  private readonly bubbleMisc: Vector4[];
  /** 近傍選抜のスクラッチ(候補スロット番号と d² — 定常アロケーションゼロ)。 */
  private readonly candSlot = new Int32Array(BUBBLE_CAPACITY);
  private readonly candD2 = new Float64Array(BUBBLE_CAPACITY);

  constructor(
    sun: SunUniforms,
    noiseTexture: DataTexture,
    ripple: RippleUniforms,
  ) {
    const waveA: Vector4[] = [];
    this.waveB = [];
    this.phaseRates = [];
    for (const wave of GERSTNER_WAVES) {
      const rad = (wave.dirDeg * Math.PI) / 180;
      const w = gerstnerAngularWavenumber(wave.lambda);
      waveA.push(new Vector4(Math.cos(rad), Math.sin(rad), w, wave.amp));
      this.waveB.push(new Vector4(wave.q, 0, 0, 0));
      this.phaseRates.push(gerstnerPhaseRate(wave.lambda));
    }

    this.bubblePosR = [];
    this.bubbleMisc = [];
    for (let i = 0; i < MAX_REFLECT_BUBBLES; i++) {
      this.bubblePosR.push(new Vector4(0, 0, 0, 0));
      this.bubbleMisc.push(new Vector4(0, 0, 0, 0));
    }

    this.sharedUniforms = {
      uSunDir: sun.uSunDir,
      uSunColor: sun.uSunColor,
      uWaveA: { value: waveA },
      uWaveB: { value: this.waveB },
      uSwellGain: { value: 1 },
      uSwellAmpSum: { value: SWELL_AMP_SUM_VERTEX },
      uTimeSec: { value: 0 },
      uNoise: { value: noiseTexture },
      uDeepColor: { value: new Color(0x05253c) },
      uMidColor: { value: new Color(0x0d4d6e) },
      uSssColor: { value: new Color(0x2fc0a8) },
      // A38: #eef7f5 → #e2eef2 — 純白寄りは暗い海上で「光」と誤読される
      // (A37 のしぶきと同じ裁定をフォームにも適用)
      uFoamColor: { value: new Color(0xe2eef2) },
      // リップルフィールド(RippleField と uniform 値オブジェクトを共有 —
      // prerender のピンポン swap がテクスチャ参照を差し替える)
      uRipple: ripple.uRipple,
      uRippleTexelUv: ripple.uRippleTexelUv,
      uRippleTexelWorld: ripple.uRippleTexelWorld,
      uRippleHalfExtent: ripple.uRippleHalfExtent,
      // 解析的球面反射(§2.5)— 補間 + 状態変形済みの球データを毎フレーム供給
      uBubblePosR: { value: this.bubblePosR },
      uBubbleMisc: { value: this.bubbleMisc },
      uBubbleCount: { value: 0 },
    };

    // ANALYTIC_REFLECTIONS の 2 変種を事前コンパイル(§9.3 — needsUpdate 再
    // コンパイルのヒッチ回避)。uniforms オブジェクトは同一参照を共有する。
    this.materialOn = new ShaderMaterial({
      vertexShader: OCEAN_VERTEX_GLSL,
      fragmentShader: OCEAN_FRAGMENT_GLSL,
      uniforms: this.sharedUniforms,
      defines: { RIPPLE_FIELD: '', ANALYTIC_REFLECTIONS: '' },
    });
    this.materialOff = new ShaderMaterial({
      vertexShader: OCEAN_VERTEX_GLSL,
      fragmentShader: OCEAN_FRAGMENT_GLSL,
      uniforms: this.sharedUniforms,
      defines: { RIPPLE_FIELD: '' },
    });

    const [rings, segments] = GRID_BY_TIER[0];
    this.object = new Mesh(
      this.geometryCache.get(rings, segments),
      this.materialOn,
    );
    this.object.renderOrder = 2; // 不透明: 原子/雫の後、スカイの前(§1.3)
    this.object.frustumCulled = false;
    this.object.matrixAutoUpdate = false;
  }

  public update(view: SkyRenderView, frame: FrameInfo): void {
    const t = frame.timeSec;
    const uniforms = this.sharedUniforms as unknown as Record<
      string,
      { value: number }
    >;
    uniforms.uTimeSec.value = t;
    // 呼吸: 凪がわずかに満ち引きする(周期 90s)
    uniforms.uSwellGain.value = 1 + 0.15 * Math.sin((TWO_PI * t) / 90);
    // 位相は CPU で mod 2π(§2.1 — シェーダ内 uTime×φ̇ は不採用)
    for (let i = 0; i < GERSTNER_WAVE_COUNT; i++) {
      this.waveB[i].y = (this.phaseRates[i] * t) % TWO_PI;
    }
    uniforms.uBubbleCount.value = this.packBubbles(view, frame);
  }

  /**
   * 解析反射の球 uniform(§2.5 / A30)。prev/curr 補間 + 状態変形(Spawning の
   * スケールイン / Splashing の膨張・フェード)を CPU で適用し、
   * 見た目半径 R_visual と fade を渡す。Dead は除外。
   * 世界容量128のうちカメラに近い≤8球を毎フレームCPU選抜し、8要素の
   * uniform配列へ詰める(描画コスト維持のためシェーダのループも8固定)。
   */
  private packBubbles(view: SkyRenderView, frame: FrameInfo): number {
    const alpha = frame.alpha;
    const cam = frame.camera.position;
    const bubbles = view.bubbles;
    const count = Math.min(bubbles.count, BUBBLE_CAPACITY);
    // 候補収集(alive のみ)+ カメラ距離²
    let candidates = 0;
    for (let slot = 0; slot < count; slot++) {
      const o = slot * 8;
      const statePacked = bubbles.data[o + 7]; // curr のみ(prev lerp 禁止)
      const state = Math.floor(statePacked);
      if (state === BUBBLE_STATE.Dead) continue;
      const prog = statePacked - state;
      const fade = state === BUBBLE_STATE.Splashing ? 1 - prog : 1;
      if (fade <= 1e-3) continue;
      const dx = lerp(bubbles.prevData[o], bubbles.data[o], alpha) - cam.x;
      const dy =
        lerp(bubbles.prevData[o + 1], bubbles.data[o + 1], alpha) - cam.y;
      const dz =
        lerp(bubbles.prevData[o + 2], bubbles.data[o + 2], alpha) - cam.z;
      this.candSlot[candidates] = slot;
      this.candD2[candidates] = dx * dx + dy * dy + dz * dz;
      candidates++;
    }
    // 近い順の部分選択(挿入ソート — 候補 ≤16 なので全ソートで十分安い)
    for (let i = 1; i < candidates; i++) {
      const slot = this.candSlot[i];
      const d2 = this.candD2[i];
      let j = i - 1;
      while (j >= 0 && this.candD2[j] > d2) {
        this.candSlot[j + 1] = this.candSlot[j];
        this.candD2[j + 1] = this.candD2[j];
        j--;
      }
      this.candSlot[j + 1] = slot;
      this.candD2[j + 1] = d2;
    }
    const selected = Math.min(candidates, MAX_REFLECT_BUBBLES);
    let n = 0;
    for (let k = 0; k < selected; k++) {
      const slot = this.candSlot[k];
      const o = slot * 8;
      const statePacked = bubbles.data[o + 7];
      const state = Math.floor(statePacked);
      const prog = statePacked - state;
      const grow =
        state === BUBBLE_STATE.Spawning
          ? 0.6 + 0.5 * prog - 0.1 * Math.sin(prog * 9)
          : 1;
      const pop = state === BUBBLE_STATE.Splashing ? 1 + 0.25 * prog : 1;
      const fade = state === BUBBLE_STATE.Splashing ? 1 - prog : 1;
      const r = lerp(bubbles.prevData[o + 3], bubbles.data[o + 3], alpha);
      const rVisual = r * grow * pop;
      if (rVisual <= 1e-4) continue;
      this.bubblePosR[n].set(
        lerp(bubbles.prevData[o], bubbles.data[o], alpha),
        lerp(bubbles.prevData[o + 1], bubbles.data[o + 1], alpha),
        lerp(bubbles.prevData[o + 2], bubbles.data[o + 2], alpha),
        rVisual,
      );
      this.bubbleMisc[n].set(
        lerp(bubbles.prevData[o + 4], bubbles.data[o + 4], alpha) /
          Math.max(r, 1e-5),
        bubbles.data[o + 5], // fill01
        bubbleVisualSeed(slot, bubbles.data[o + 3]),
        fade,
      );
      n++;
    }
    return n;
  }

  public applyTier(tier: QualityTier): void {
    const [rings, segments] = GRID_BY_TIER[tier];
    this.object.geometry = this.geometryCache.get(rings, segments);
    this.object.material = ANALYTIC_REFLECTIONS_BY_TIER[tier]
      ? this.materialOn
      : this.materialOff;
  }

  public dispose(): void {
    this.geometryCache.dispose();
    this.materialOn.dispose();
    this.materialOff.dispose();
  }
}
