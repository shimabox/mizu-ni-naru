import { Color, type DataTexture, Mesh, ShaderMaterial, Vector4 } from 'three';
import type { SkyRenderView } from '../../contract/RenderView';
import type { SunUniforms } from '../Environment';
import type { FrameInfo, QualityTier, RenderSystem } from '../RenderSystem';
import {
  GERSTNER_WAVES,
  GERSTNER_WAVE_COUNT,
  SWELL_AMP_SUM_VERTEX,
  gerstnerAngularWavenumber,
  gerstnerPhaseRate,
} from '../shaders/gerstner';
import { OCEAN_FRAGMENT_GLSL, OCEAN_VERTEX_GLSL } from '../shaders/ocean';
import { OceanGeometryCache } from './OceanGeometry';

const TWO_PI = 2 * Math.PI;

/** ティア → グリッド密度(design-render §9.3)。Phase 2 は tier0 固定起動。 */
const GRID_BY_TIER: readonly (readonly [number, number])[] = [
  [144, 192],
  [144, 192],
  [120, 160],
  [96, 128],
  [72, 96],
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

  private readonly material: ShaderMaterial;
  private readonly geometryCache = new OceanGeometryCache();
  private readonly waveB: Vector4[];
  private readonly phaseRates: number[];

  constructor(sun: SunUniforms, noiseTexture: DataTexture) {
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

    this.material = new ShaderMaterial({
      vertexShader: OCEAN_VERTEX_GLSL,
      fragmentShader: OCEAN_FRAGMENT_GLSL,
      uniforms: {
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
        uFoamColor: { value: new Color(0xeef7f5) },
      },
      // Phase 3: ANALYTIC_REFLECTIONS / RIPPLE_FIELD の 2 変種を事前コンパイルし
      // 参照切替(needsUpdate 再コンパイルのヒッチ回避 — §9.3)
      defines: {},
    });

    const [rings, segments] = GRID_BY_TIER[0];
    this.object = new Mesh(
      this.geometryCache.get(rings, segments),
      this.material,
    );
    this.object.renderOrder = 2; // 不透明: 原子/雫の後、スカイの前(§1.3)
    this.object.frustumCulled = false;
    this.object.matrixAutoUpdate = false;
  }

  public update(_view: SkyRenderView, frame: FrameInfo): void {
    const t = frame.timeSec;
    const uniforms = this.material.uniforms;
    uniforms.uTimeSec.value = t;
    // 呼吸: 凪がわずかに満ち引きする(周期 90s)
    uniforms.uSwellGain.value = 1 + 0.15 * Math.sin((TWO_PI * t) / 90);
    // 位相は CPU で mod 2π(§2.1 — シェーダ内 uTime×φ̇ は不採用)
    for (let i = 0; i < GERSTNER_WAVE_COUNT; i++) {
      this.waveB[i].y = (this.phaseRates[i] * t) % TWO_PI;
    }
  }

  public applyTier(tier: QualityTier): void {
    const [rings, segments] = GRID_BY_TIER[tier];
    this.object.geometry = this.geometryCache.get(rings, segments);
  }

  public dispose(): void {
    this.geometryCache.dispose();
    this.material.dispose();
  }
}
