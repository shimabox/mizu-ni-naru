import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Vector3,
  Vector4,
} from 'three';
import type { SkyRenderView } from '../../contract/RenderView';
import { BUBBLE_STATE, RIPPLE_VIEW_CAPACITY } from '../../contract/WorldSpec';
import type { SunUniforms } from '../Environment';
import type { FrameInfo, QualityTier, RenderSystem } from '../RenderSystem';
import {
  createBillboardQuadGeometry,
  writeCameraBasis,
} from '../atoms/billboard';
import { bubbleVisualSeed } from '../bubbles/BubbleInstanceBuffers';
import {
  INNER_SPLASH_FRAGMENT_GLSL,
  INNER_SPLASH_MAX_STRETCH,
  INNER_SPLASH_SHELL_RATIO,
  INNER_SPLASH_TRACKED_BUBBLES,
  INNER_SPLASH_VERTEX_GLSL,
} from '../shaders/innerSplash';
import { bubbleWaterColor, hashSeed, mulberry32 } from './ballistics';

const V4 = 4;
const V3 = 3;
const TWO_PI = 2 * Math.PI;
/** 雫着水InnerRippleの契約帯。原子反射0.15 / 溶解0.3とは重ならない。 */
export const INNER_SPLASH_MIN_STRENGTH = 0.6;
export const INNER_SPLASH_MAX_STRENGTH = 1.0;
/** 同時発火時は新しい粒を優先して古い粒を上書きする固定リング容量。 */
export const INNER_SPLASH_CAPACITY = 256;
const MAX_LIFE_STEPS = Math.ceil(1.05 * 60) + 2;
/** A52の優先順位に合わせ、tier2まではエフェクトを完全温存する。 */
const BUDGET_BY_TIER: readonly number[] = [1.0, 1.0, 1.0, 0.7, 0.5];

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);

/** strengthの分離契約だけで、simを変更せず雫着水を識別する。 */
export const isDropletInnerImpact = (strength: number): boolean =>
  strength >= INNER_SPLASH_MIN_STRENGTH &&
  strength <= INNER_SPLASH_MAX_STRENGTH + 1e-4;

/** 小さな雫で7粒、大きな雫で12粒。品質予算は発生数だけへ掛ける。 */
export const innerSplashParticleCount = (
  strength: number,
  budget = 1,
): number => {
  if (budget <= 0) return 0;
  const t = clamp01(
    (strength - INNER_SPLASH_MIN_STRENGTH) /
      (INNER_SPLASH_MAX_STRENGTH - INNER_SPLASH_MIN_STRENGTH),
  );
  return Math.max(1, Math.round((7 + 5 * t) * Math.min(budget, 1)));
};

/** shaderと同じ「粒子半径を含む内殻境界」判定。 */
export const isInnerSplashInsideShell = (
  localX: number,
  localY: number,
  localZ: number,
  bubbleR: number,
  particleRadius: number,
): boolean =>
  Math.hypot(localX, localY, localZ) +
    particleRadius * INNER_SPLASH_MAX_STRETCH <=
  INNER_SPLASH_SHELL_RATIO * bubbleR + 1e-9;

/**
 * 球内の雫着水しぶき。
 *
 * `InnerRippleView`の雫strength帯だけを読み、render専用hashから短命な
 * billboardを生成する。simのRNGやイベント列は消費しない。位置は球ローカルで
 * 保持し、現在の球中心へ追従する。drawは粒子が生きている間だけ1回追加される。
 */
export class InnerSplashSystem implements RenderSystem {
  public readonly object: Mesh;

  private readonly geometry: InstancedBufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly spawnData = new Float32Array(INNER_SPLASH_CAPACITY * V4);
  private readonly velocityData = new Float32Array(INNER_SPLASH_CAPACITY * V4);
  private readonly bubbleData = new Float32Array(INNER_SPLASH_CAPACITY * V4);
  private readonly tintData = new Float32Array(INNER_SPLASH_CAPACITY * V3);
  private readonly spawnAttr: InstancedBufferAttribute;
  private readonly velocityAttr: InstancedBufferAttribute;
  private readonly bubbleAttr: InstancedBufferAttribute;
  private readonly tintAttr: InstancedBufferAttribute;
  private readonly bubbleFrame: Vector4[] = [];
  private readonly tintScratch = new Float32Array(3);

  private cursor = 0;
  private emittedCount = 0;
  private lastViewStep = -1;
  private activeUntilStepF = -1;
  private sprayBudget = 1;
  private batchStart = 0;
  private writesThisFrame = 0;

  constructor(sun: SunUniforms) {
    for (let i = 0; i < INNER_SPLASH_TRACKED_BUBBLES; i++) {
      this.bubbleFrame.push(new Vector4(0, 0, 0, BUBBLE_STATE.Dead));
    }

    const quad = createBillboardQuadGeometry();
    this.geometry = new InstancedBufferGeometry();
    this.geometry.setIndex(quad.getIndex());
    this.geometry.setAttribute('position', quad.getAttribute('position'));
    this.geometry.instanceCount = 0;

    this.spawnAttr = dynamicAttribute(this.spawnData, V4);
    this.velocityAttr = dynamicAttribute(this.velocityData, V4);
    this.bubbleAttr = dynamicAttribute(this.bubbleData, V4);
    this.tintAttr = dynamicAttribute(this.tintData, V3);
    this.geometry.setAttribute('aSpawn', this.spawnAttr);
    this.geometry.setAttribute('aVelocity', this.velocityAttr);
    this.geometry.setAttribute('aBubble', this.bubbleAttr);
    this.geometry.setAttribute('aTint', this.tintAttr);

    this.material = new ShaderMaterial({
      vertexShader: INNER_SPLASH_VERTEX_GLSL,
      fragmentShader: INNER_SPLASH_FRAGMENT_GLSL,
      uniforms: {
        uSunColor: sun.uSunColor,
        uStepF: { value: 0 },
        uCamRight: { value: new Vector3(1, 0, 0) },
        uCamUp: { value: new Vector3(0, 1, 0) },
        uBubbleFrame: { value: this.bubbleFrame },
      },
      blending: NormalBlending,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });

    this.object = new Mesh(this.geometry, this.material);
    // InnerWater cap(5.5)の後、Glass back/front(6〜7.5)の前。
    this.object.renderOrder = 5.75;
    this.object.frustumCulled = false;
    this.object.matrixAutoUpdate = false;
    this.object.visible = false;
  }

  public update(view: SkyRenderView, frame: FrameInfo): void {
    const uniforms = this.material.uniforms;
    uniforms.uStepF.value = frame.stepF;
    this.batchStart = this.cursor;
    this.writesThisFrame = 0;

    if (view.step !== this.lastViewStep) {
      this.ingestImpacts(view);
      this.lastViewStep = view.step;
    }
    if (this.writesThisFrame > 0) {
      this.geometry.instanceCount = this.emittedCount;
      this.uploadWrittenRanges();
    }

    this.object.visible = frame.stepF < this.activeUntilStepF;
    if (!this.object.visible) return;
    this.updateBubbleFrame(view, frame.alpha);
    writeCameraBasis(
      frame.camera,
      uniforms.uCamRight.value as Vector3,
      uniforms.uCamUp.value as Vector3,
    );
  }

  public applyTier(tier: QualityTier): void {
    this.sprayBudget = BUDGET_BY_TIER[tier];
  }

  public dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }

  private ingestImpacts(view: SkyRenderView): void {
    const ripples = view.ripples;
    const count = Math.min(ripples.count, RIPPLE_VIEW_CAPACITY);
    const bubbles = view.bubbles;
    for (let eventIndex = 0; eventIndex < count; eventIndex++) {
      const o = eventIndex * V4;
      const slot = Math.round(ripples.data[o]);
      const localX = ripples.data[o + 1];
      const localZ = ripples.data[o + 2];
      const strength = ripples.data[o + 3];
      if (
        !isDropletInnerImpact(strength) ||
        slot < 0 ||
        slot >= INNER_SPLASH_TRACKED_BUBBLES ||
        slot >= bubbles.count
      ) {
        continue;
      }

      const bo = slot * 8;
      const state = Math.floor(bubbles.data[bo + 7]);
      if (state >= BUBBLE_STATE.Splashing) continue;
      const bubbleR = bubbles.data[bo + 3];
      const waterY = bubbles.data[bo + 4];
      const visualSeed = bubbleVisualSeed(slot, bubbleR);
      bubbleWaterColor(visualSeed, this.tintScratch);
      const eventSeed = hashSeed(
        view.step,
        slot * 257 + eventIndex,
        Math.round((localX * 997 + localZ * 61) * 1024),
      );
      const rng = mulberry32(eventSeed);
      const particleCount = innerSplashParticleCount(
        strength,
        this.sprayBudget,
      );
      const impact01 = clamp01(
        (strength - INNER_SPLASH_MIN_STRENGTH) /
          (INNER_SPLASH_MAX_STRENGTH - INNER_SPLASH_MIN_STRENGTH),
      );
      const impactRadius = bubbleR * 0.095 * Math.max(impact01, 0.5);

      for (let i = 0; i < particleCount; i++) {
        const az = ((i + rng() * 0.35) / particleCount) * TWO_PI;
        const particleRadius = bubbleR * (0.02 + rng() * 0.015);
        const margin = particleRadius * INNER_SPLASH_MAX_STRETCH;
        const localY = waterY + margin;
        const jitter = impactRadius * (0.04 + rng() * 0.12);
        let px = localX + Math.cos(az) * jitter;
        let pz = localZ + Math.sin(az) * jitter;
        const maxCenterRadius = Math.max(
          INNER_SPLASH_SHELL_RATIO * bubbleR - margin,
          0,
        );
        const maxHorizontal = Math.sqrt(
          Math.max(maxCenterRadius * maxCenterRadius - localY * localY, 0),
        );
        const horizontal = Math.hypot(px, pz);
        if (horizontal > maxHorizontal && horizontal > 0) {
          const scale = maxHorizontal / horizontal;
          px *= scale;
          pz *= scale;
        }

        const speedScale = 0.8 + 0.2 * impact01;
        const horizontalSpeed = (0.28 + rng() * 0.22) * speedScale;
        const verticalSpeed = (0.8 + rng() * 0.4) * speedScale;
        this.emit(
          view.step,
          slot,
          bubbleR,
          px,
          localY,
          pz,
          Math.cos(az) * horizontalSpeed,
          verticalSpeed,
          Math.sin(az) * horizontalSpeed,
          0.7 + rng() * 0.3,
          particleRadius / bubbleR,
          rng(),
          this.tintScratch[0],
          this.tintScratch[1],
          this.tintScratch[2],
        );
      }
    }
  }

  private emit(
    step: number,
    slot: number,
    bubbleR: number,
    px: number,
    py: number,
    pz: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    sizeRatio: number,
    seed: number,
    tintR: number,
    tintG: number,
    tintB: number,
  ): void {
    const o = this.cursor * V4;
    this.spawnData[o] = px;
    this.spawnData[o + 1] = py;
    this.spawnData[o + 2] = pz;
    this.spawnData[o + 3] = step;
    this.velocityData[o] = vx;
    this.velocityData[o + 1] = vy;
    this.velocityData[o + 2] = vz;
    this.velocityData[o + 3] = life;
    this.bubbleData[o] = slot;
    this.bubbleData[o + 1] = bubbleR;
    this.bubbleData[o + 2] = sizeRatio;
    this.bubbleData[o + 3] = seed;
    const t = this.cursor * V3;
    this.tintData[t] = tintR;
    this.tintData[t + 1] = tintG;
    this.tintData[t + 2] = tintB;

    this.cursor = (this.cursor + 1) % INNER_SPLASH_CAPACITY;
    this.writesThisFrame++;
    this.emittedCount = Math.min(this.emittedCount + 1, INNER_SPLASH_CAPACITY);
    this.activeUntilStepF = Math.max(
      this.activeUntilStepF,
      step + MAX_LIFE_STEPS,
    );
  }

  private uploadWrittenRanges(): void {
    const ranges = writtenRanges(
      this.batchStart,
      this.writesThisFrame,
      INNER_SPLASH_CAPACITY,
    );
    for (const [attribute, itemSize] of [
      [this.spawnAttr, V4],
      [this.velocityAttr, V4],
      [this.bubbleAttr, V4],
      [this.tintAttr, V3],
    ] as const) {
      attribute.clearUpdateRanges();
      for (const range of ranges) {
        attribute.addUpdateRange(
          range.start * itemSize,
          range.count * itemSize,
        );
      }
      attribute.needsUpdate = true;
    }
  }

  private updateBubbleFrame(view: SkyRenderView, alpha: number): void {
    const bubbles = view.bubbles;
    const count = Math.min(bubbles.count, INNER_SPLASH_TRACKED_BUBBLES);
    for (let slot = 0; slot < count; slot++) {
      const o = slot * 8;
      const prev = bubbles.prevData;
      const curr = bubbles.data;
      this.bubbleFrame[slot].set(
        prev[o] + (curr[o] - prev[o]) * alpha,
        prev[o + 1] + (curr[o + 1] - prev[o + 1]) * alpha,
        prev[o + 2] + (curr[o + 2] - prev[o + 2]) * alpha,
        curr[o + 7],
      );
    }
    for (let slot = count; slot < INNER_SPLASH_TRACKED_BUBBLES; slot++) {
      this.bubbleFrame[slot].set(0, 0, 0, BUBBLE_STATE.Dead);
    }
  }
}

interface WrittenRange {
  readonly start: number;
  readonly count: number;
}

/** 連続リング書き込みを1〜2個の部分upload範囲へ変換する。 */
export const writtenRanges = (
  start: number,
  writes: number,
  capacity: number,
): readonly WrittenRange[] => {
  if (writes <= 0 || capacity <= 0) return [];
  if (writes >= capacity) return [{ start: 0, count: capacity }];
  const firstCount = Math.min(writes, capacity - start);
  if (firstCount === writes) return [{ start, count: writes }];
  return [
    { start, count: firstCount },
    { start: 0, count: writes - firstCount },
  ];
};

const dynamicAttribute = (
  array: Float32Array,
  itemSize: number,
): InstancedBufferAttribute => {
  const attribute = new InstancedBufferAttribute(array, itemSize);
  attribute.setUsage(DynamicDrawUsage);
  return attribute;
};
