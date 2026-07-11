import {
  BufferAttribute,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { SkyRenderView } from '../../contract/RenderView';
import {
  BUBBLE_CAPACITY,
  BUBBLE_STATE,
  SPLASH_VIEW_CAPACITY,
} from '../../contract/WorldSpec';
import type { SunUniforms } from '../Environment';
import type { FrameInfo, QualityTier, RenderSystem } from '../RenderSystem';
import type { SplatScheduler } from '../ocean/SplatScheduler';
import { SPRAY_FRAGMENT_GLSL, SPRAY_VERTEX_GLSL } from '../shaders/spray';
import {
  crownCount,
  hashSeed,
  membraneCount,
  mulberry32,
  packKindSize,
  solveLandingTime,
} from './ballistics';

/** リングバッファ容量(§6 — モバイル縮小は Phase 4。裁定 A33/A35 でクラウン増量 +
 * 球体増量に合わせて余裕を確保)。 */
export const SPRAY_CAPACITY = 4096;
/** 最大寿命 [step](life ≤ 1.7s — 可視ウィンドウの打ち切りに使用)。 */
const MAX_LIFE_STEPS = 1.7 * 60 + 10;
/** 「未スポーン」を示す spawnStepF(age が巨大 → kill)。 */
const NEVER_SPAWNED = -1e6;
/**
 * ティア → spray 上限(発生数の予算比率。Phase 4 AdaptiveQuality の追加ノブ)。
 * A52 最終: エフェクト(世界の空気)は解像度より優先度が高いため tier1 まで
 * 完全温存(1.0)、削減は tier2 以降のみ。
 */
const BUDGET_BY_TIER: readonly number[] = [1.0, 1.0, 0.8, 0.6, 0.4];

const TWO_PI = 2 * Math.PI;
const DEG = Math.PI / 180;

/**
 * スプレー/しぶき(design-render §6)。
 *
 * ステートレス弾道の instanced quad リングバッファ。イベント監視:
 * - 球の着水(SplashEventView): クラウンリング 40〜80 個 + 中央コラム。
 *   落着点 2〜3 箇所にマイクロスプラットを予約(閉形式 — spawn 時に確定)
 * - 球のポップ(statePacked が Splashing へ遷移): 膜片 20〜40 個(虹彩 tint)
 */
export class SpraySystem implements RenderSystem {
  public readonly object: Mesh;

  private readonly geometry: InstancedBufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly spawnData = new Float32Array(SPRAY_CAPACITY * 4);
  private readonly velData = new Float32Array(SPRAY_CAPACITY * 4);
  private readonly spawnAttr: InstancedBufferAttribute;
  private readonly velAttr: InstancedBufferAttribute;
  private readonly scheduler: SplatScheduler;
  private readonly lastState = new Int32Array(BUBBLE_CAPACITY).fill(
    BUBBLE_STATE.Dead,
  );

  private cursor = 0;
  private lastViewStep = -1;
  private activeUntilStepF = -1;
  private wroteThisFrame = false;
  private sprayBudget = 1.0;

  constructor(sun: SunUniforms, scheduler: SplatScheduler) {
    this.scheduler = scheduler;

    for (let i = 0; i < SPRAY_CAPACITY; i++) {
      this.spawnData[i * 4 + 3] = NEVER_SPAWNED;
    }

    this.geometry = new InstancedBufferGeometry();
    this.geometry.setAttribute(
      'position',
      new BufferAttribute(
        new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]),
        3,
      ),
    );
    this.geometry.setIndex(
      new BufferAttribute(new Uint16Array([0, 1, 2, 2, 1, 3]), 1),
    );
    this.spawnAttr = new InstancedBufferAttribute(this.spawnData, 4);
    this.spawnAttr.setUsage(DynamicDrawUsage);
    this.velAttr = new InstancedBufferAttribute(this.velData, 4);
    this.velAttr.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('aSpawn', this.spawnAttr);
    this.geometry.setAttribute('aVel', this.velAttr);
    this.geometry.instanceCount = SPRAY_CAPACITY;

    this.material = new ShaderMaterial({
      vertexShader: SPRAY_VERTEX_GLSL,
      fragmentShader: SPRAY_FRAGMENT_GLSL,
      uniforms: {
        uSunColor: sun.uSunColor,
        uStepF: { value: 0 },
        uCamRight: { value: new Vector3(1, 0, 0) },
        uCamUp: { value: new Vector3(0, 1, 0) },
      },
      // 裁定 A36: 加算 → 通常アルファブレンド(暗い海を背景にしても「発光体」に
      // 見えず、フォームの粒が物として散る)
      blending: NormalBlending,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });

    this.object = new Mesh(this.geometry, this.material);
    this.object.renderOrder = 9; // 半透明群の最後(§1.3)
    this.object.frustumCulled = false;
    this.object.matrixAutoUpdate = false;
    this.object.visible = false;
  }

  public update(view: SkyRenderView, frame: FrameInfo): void {
    const uniforms = this.material.uniforms;
    uniforms.uStepF.value = frame.stepF;
    const e = frame.camera.matrixWorld.elements;
    (uniforms.uCamRight.value as Vector3).set(e[0], e[1], e[2]);
    (uniforms.uCamUp.value as Vector3).set(e[4], e[5], e[6]);

    this.wroteThisFrame = false;
    // step が進んだフレームだけイベントを読む(0-step フレームの二重発火防止)
    if (view.step !== this.lastViewStep) {
      this.ingestSplashes(view);
      this.ingestPops(view);
      this.lastViewStep = view.step;
    }
    if (this.wroteThisFrame) {
      // spawn はイベント時のみ(~数回/20s)なので全レンジ一括で十分
      this.spawnAttr.clearUpdateRanges();
      this.spawnAttr.addUpdateRange(0, SPRAY_CAPACITY * 4);
      this.spawnAttr.needsUpdate = true;
      this.velAttr.clearUpdateRanges();
      this.velAttr.addUpdateRange(0, SPRAY_CAPACITY * 4);
      this.velAttr.needsUpdate = true;
    }

    this.object.visible = frame.stepF < this.activeUntilStepF;
  }

  public applyTier(tier: QualityTier): void {
    this.sprayBudget = BUDGET_BY_TIER[tier];
  }

  public dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }

  /** 球の着水 → クラウンリング + 中央コラム + 落着マイクロスプラット予約。 */
  private ingestSplashes(view: SkyRenderView): void {
    const splashes = view.splashes;
    const n = Math.min(splashes.count, SPLASH_VIEW_CAPACITY);
    for (let ev = 0; ev < n; ev++) {
      const o = ev * 4;
      const x = splashes.data[o];
      const z = splashes.data[o + 1];
      const radius = splashes.data[o + 2];
      const strength = splashes.data[o + 3];
      const rng = mulberry32(
        hashSeed(view.step, ev, Math.round(x * 1024) + Math.round(z * 61)),
      );

      // クラウンリング(上向き 55〜75°、速度 2.2〜4.2 u/s — §6)。
      // spray 上限ノブ(§9.3 拡張): ティアで発生数を間引く
      const count = Math.round(crownCount(strength) * this.sprayBudget);
      for (let i = 0; i < count; i++) {
        const az = rng() * TWO_PI;
        const elev = (55 + rng() * 20) * DEG;
        const speed = (2.2 + rng() * 2.0) * (0.6 + 0.4 * strength);
        const ringR = radius * (0.55 + rng() * 0.45);
        const cosE = Math.cos(elev);
        this.emit(
          view.step,
          x + Math.cos(az) * ringR,
          0.04 + rng() * 0.06,
          z + Math.sin(az) * ringR,
          Math.cos(az) * speed * cosE,
          speed * Math.sin(elev),
          Math.sin(az) * speed * cosE,
          0,
          0.25 + rng() * 0.6,
        );
      }
      // 中央コラム数個(ほぼ真上、裁定 A33 でやや増量)
      const columnCount = Math.max(1, Math.round(7 * this.sprayBudget));
      for (let i = 0; i < columnCount; i++) {
        const az = rng() * TWO_PI;
        const v = 2.8 + rng() * 1.6;
        this.emit(
          view.step,
          x + (rng() - 0.5) * 0.2 * radius,
          0.05,
          z + (rng() - 0.5) * 0.2 * radius,
          Math.cos(az) * 0.3,
          v,
          Math.sin(az) * 0.3,
          0,
          0.5 + rng() * 0.5,
        );
      }
      // 落着点へのマイクロスプラット 3 個(弾道は閉形式 — spawn 時に確定)
      for (let i = 0; i < 3; i++) {
        const az = rng() * TWO_PI;
        const elev = (55 + rng() * 20) * DEG;
        const speed = (2.2 + rng() * 2.0) * (0.6 + 0.4 * strength);
        const ringR = radius * (0.55 + rng() * 0.45);
        const p0y = 0.04 + rng() * 0.06;
        const vy = speed * Math.sin(elev);
        const vxz = speed * Math.cos(elev);
        const t = solveLandingTime(p0y, vy);
        this.scheduler.addMicroSplat(
          view.step + Math.round(t * 60),
          x + Math.cos(az) * (ringR + vxz * t),
          z + Math.sin(az) * (ringR + vxz * t),
          0.04 + 0.06 * strength,
        );
      }
    }
  }

  /** 球のポップ(Splashing 遷移)→ 膜片バースト(虹彩 tint)。 */
  private ingestPops(view: SkyRenderView): void {
    const bubbles = view.bubbles;
    const count = Math.min(bubbles.count, BUBBLE_CAPACITY);
    for (let slot = 0; slot < count; slot++) {
      const o = slot * 8;
      const state = Math.floor(bubbles.data[o + 7]);
      if (
        state === BUBBLE_STATE.Splashing &&
        this.lastState[slot] !== BUBBLE_STATE.Splashing
      ) {
        const cx = bubbles.data[o];
        const cy = bubbles.data[o + 1];
        const cz = bubbles.data[o + 2];
        const r = bubbles.data[o + 3];
        const rng = mulberry32(hashSeed(view.step, slot + 16, 977));
        const n = Math.round(membraneCount(r / 1.7) * this.sprayBudget);
        for (let i = 0; i < n; i++) {
          // 球面上のランダム点(上半球バイアス)から接線 + 外向き
          const az = rng() * TWO_PI;
          const cosT = rng() * 1.2 - 0.2;
          const sinT = Math.sqrt(Math.max(1 - cosT * cosT, 0));
          const nx = sinT * Math.cos(az);
          const ny = cosT;
          const nz = sinT * Math.sin(az);
          const out = 0.8 + rng() * 1.6;
          const tAz = az + Math.PI / 2;
          const tv = 0.6 + rng() * 1.2;
          this.emit(
            view.step,
            cx + nx * r,
            Math.max(cy + ny * r, 0.02),
            cz + nz * r,
            nx * out + Math.cos(tAz) * tv,
            ny * out + 0.6 + rng() * 0.6,
            nz * out + Math.sin(tAz) * tv,
            1,
            0.4 + rng() * 0.6,
          );
        }
      }
      this.lastState[slot] = state;
    }
  }

  private emit(
    step: number,
    px: number,
    py: number,
    pz: number,
    vx: number,
    vy: number,
    vz: number,
    kind: 0 | 1,
    size01: number,
  ): void {
    const o = this.cursor * 4;
    this.spawnData[o] = px;
    this.spawnData[o + 1] = py;
    this.spawnData[o + 2] = pz;
    this.spawnData[o + 3] = step;
    this.velData[o] = vx;
    this.velData[o + 1] = vy;
    this.velData[o + 2] = vz;
    this.velData[o + 3] = packKindSize(kind, size01);
    this.cursor = (this.cursor + 1) % SPRAY_CAPACITY;
    this.wroteThisFrame = true;
    this.activeUntilStepF = Math.max(
      this.activeUntilStepF,
      step + MAX_LIFE_STEPS,
    );
  }
}
