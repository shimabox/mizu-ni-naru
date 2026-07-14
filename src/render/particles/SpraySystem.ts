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
import { bubbleVisualSeed } from '../bubbles/BubbleInstanceBuffers';
import type { SplatScheduler } from '../ocean/SplatScheduler';
import { SPRAY_FRAGMENT_GLSL, SPRAY_VERTEX_GLSL } from '../shaders/spray';
import {
  bubbleWaterColor,
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

/**
 * リングが初回飽和するまでは、書き込み済みprefixだけを描く。
 * suffixはNEVER_SPAWNEDをvertex shaderでkillしていた領域なので省略しても同値。
 */
export const initializedSprayInstanceCount = (emittedCount: number): number =>
  Math.min(emittedCount, SPRAY_CAPACITY);
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
 * A57: 着水位置とその瞬間 Splashing 状態の球のアンカー位置(ax, az)の
 * 突き合わせマージン(u、二乗距離で比較)。同一 step の書き込みなので通常は
 * ほぼ厳密一致するが、タイミングのズレ等のフォールバック用に余裕を持たせる。
 */
const SPLASH_MATCH_DIST = 0.5;
const SPLASH_MATCH_DIST_SQ = SPLASH_MATCH_DIST * SPLASH_MATCH_DIST;

/**
 * フォールバック色(着水位置に一致する球が特定できない場合のデフォルト、
 * kind 0 のみ)。旧 foamTop(#d4ecf2 系、白 8 : 水色 2 目安 — 裁定 A37)を
 * そのまま踏襲。膜片(kind 1、球ポップ)は A59 でポップした球自身の水色
 * ハッシュに切り替えたため、このフォールバックは使わない(ポップ元の
 * スロット/半径は常に既知なため — ingestPops 参照)。
 *
 * 裁定 A61 の実測メモ: このフォールバックの発火率をヘッドレス sim で計測
 * (seed 7・96 球・8 分相当、実ゲームプレイの高さ帯拡大後 = A56 環境)した
 * ところ 0/305(0%)— Falling→Splashing 遷移は同一 step 内で完結するため、
 * resolveSplashTint は常に厳密一致(d²=0)する。再発した「白っぽい/水色が
 * 混在」の実際の原因はここではなく shaders/spray.ts の film ミックス比率
 * だった(同ファイルの裁定 A61 コメント参照)。
 */
const FALLBACK_TINT: readonly [number, number, number] = [0.831, 0.925, 0.949];

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
  private readonly tintData = new Float32Array(SPRAY_CAPACITY * 3);
  private readonly spawnAttr: InstancedBufferAttribute;
  private readonly velAttr: InstancedBufferAttribute;
  private readonly tintAttr: InstancedBufferAttribute;
  private readonly scheduler: SplatScheduler;
  /** ハッシュ計算のスクラッチ出力(spawn 時のみ使用・割り当てなし)。 */
  private readonly tintScratch: [number, number, number] = [0, 0, 0];
  private readonly lastState = new Int32Array(BUBBLE_CAPACITY).fill(
    BUBBLE_STATE.Dead,
  );

  private cursor = 0;
  private emittedCount = 0;
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
    this.tintAttr = new InstancedBufferAttribute(this.tintData, 3);
    this.tintAttr.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('aSpawn', this.spawnAttr);
    this.geometry.setAttribute('aVel', this.velAttr);
    this.geometry.setAttribute('aTint', this.tintAttr);
    this.geometry.instanceCount = 0;

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
      // emitごとではなくイベントbatchの最後に1回だけdraw範囲を更新する。
      this.geometry.instanceCount = this.emittedCount;
      // spawn はイベント時のみ(~数回/20s)なので全レンジ一括で十分
      this.spawnAttr.clearUpdateRanges();
      this.spawnAttr.addUpdateRange(0, SPRAY_CAPACITY * 4);
      this.spawnAttr.needsUpdate = true;
      this.velAttr.clearUpdateRanges();
      this.velAttr.addUpdateRange(0, SPRAY_CAPACITY * 4);
      this.velAttr.needsUpdate = true;
      this.tintAttr.clearUpdateRanges();
      this.tintAttr.addUpdateRange(0, SPRAY_CAPACITY * 3);
      this.tintAttr.needsUpdate = true;
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

      // A57: 着水位置と同フレームの Splashing 球のアンカー位置を突き合わせ、
      // その球の水色ハッシュ(glass.ts と同一計算)をしぶきの色として完全採用。
      // 一致する球が見つからない場合は従来の淡い水色にフォールバック(要件5)。
      const [tr, tg, tb] = this.resolveSplashTint(view, x, z);

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
          tr,
          tg,
          tb,
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
          tr,
          tg,
          tb,
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

  /**
   * A57: 着水位置(x, z)に最も近い Splashing 状態の球を探し、その球の水色
   * (glass.ts WATER_TINT_GLSL と同一計算)を返す。マージン外・候補なしの
   * 場合は FALLBACK_TINT(従来の淡い水色)を返す。
   */
  private resolveSplashTint(
    view: SkyRenderView,
    x: number,
    z: number,
  ): readonly [number, number, number] {
    const bubbles = view.bubbles;
    const count = Math.min(bubbles.count, BUBBLE_CAPACITY);
    let bestSlot = -1;
    let bestD2 = SPLASH_MATCH_DIST_SQ;
    for (let slot = 0; slot < count; slot++) {
      const o = slot * 8;
      if (Math.floor(bubbles.data[o + 7]) !== BUBBLE_STATE.Splashing) continue;
      const dx = bubbles.data[o] - x;
      const dz = bubbles.data[o + 2] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestSlot = slot;
      }
    }
    if (bestSlot < 0) return FALLBACK_TINT;
    const r = bubbles.data[bestSlot * 8 + 3];
    const seed = bubbleVisualSeed(bestSlot, r);
    bubbleWaterColor(seed, this.tintScratch);
    return this.tintScratch;
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
        // A59: 膜片(kind 1)もポップした球自身の水色ハッシュ(A57 と同一計算)を
        // aTint として焼き込む。虹彩ロジック自体(spray.ts の film 合成)は
        // 不変 — ベース色だけを旧 FALLBACK_TINT(白っぽい旧 foamTop)から
        // 差し替える(水滴 kind 0 と同じ家族の色に統一)。
        const membraneSeed = bubbleVisualSeed(slot, r);
        bubbleWaterColor(membraneSeed, this.tintScratch);
        const [mr, mg, mb] = this.tintScratch;
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
            // A59: ポップした球自身の水色(fragment 側 film 合成のベース色)
            mr,
            mg,
            mb,
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
    tr: number,
    tg: number,
    tb: number,
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
    const t = this.cursor * 3;
    this.tintData[t] = tr;
    this.tintData[t + 1] = tg;
    this.tintData[t + 2] = tb;
    this.emittedCount = initializedSprayInstanceCount(this.emittedCount + 1);
    this.cursor = (this.cursor + 1) % SPRAY_CAPACITY;
    this.wroteThisFrame = true;
    this.activeUntilStepF = Math.max(
      this.activeUntilStepF,
      step + MAX_LIFE_STEPS,
    );
  }
}
