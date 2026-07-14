import {
  BufferAttribute,
  BufferGeometry,
  type Color,
  type DataTexture,
  LessEqualDepth,
  Matrix4,
  Mesh,
  ShaderMaterial,
  type Vector3,
} from 'three';
import type { SkyRenderView } from '../contract/RenderView';
import type { FrameInfo, RenderSystem } from './RenderSystem';
import {
  createTimeOfDayState,
  localTimeMinutes,
  sampleTimeOfDay,
} from './TimeOfDay';
import { SKY_FRAGMENT_GLSL, SKY_VERTEX_GLSL } from './shaders/sky';

/**
 * 空と主光源の共有uniformブロック。threeのライトは使わず、値オブジェクトを
 * 全カスタムマテリアルで共有する(Environmentが唯一の所有者)。
 */
export interface SunUniforms {
  readonly uSunDir: { readonly value: Vector3 };
  readonly uSunColor: { readonly value: Color };
  readonly uSkyHorizonCool: { readonly value: Color };
  readonly uSkyHorizonWarm: { readonly value: Color };
  readonly uSkyZenith: { readonly value: Color };
  readonly uSkyBelow: { readonly value: Color };
}

/** WebGLを起動しないrender unit test / 計測スクリプト用の固定共有uniform。 */
export const createStaticSunUniforms = (minutes = 480): SunUniforms => {
  const state = createTimeOfDayState();
  sampleTimeOfDay(minutes, state);
  return {
    uSunDir: { value: state.sunDir },
    uSunColor: { value: state.sunColor },
    uSkyHorizonCool: { value: state.horizonCool },
    uSkyHorizonWarm: { value: state.horizonWarm },
    uSkyZenith: { value: state.zenith },
    uSkyBelow: { value: state.below },
  };
};

/**
 * 時刻連動の解析スカイ背景(far plane の全画面三角形 — design-render §7)。
 *
 * - `scene.background` は使わない(最初に描かれフィルを浪費する)。
 *   depthFunc: LessEqualDepth + depthWrite off で
 *   「何にも覆われていないピクセルだけ」を最後にシェーディングする
 * - 端末のローカル時刻を15秒ごとに読み、朝・昼・夕・夜を連続補間する
 * - `timeMinutes`指定時は時刻を固定し、テスト・性能計測を再現可能にする
 * - 空色と主光源は海・球・雫の反射へ同一参照で伝播する
 */
export class Environment implements RenderSystem {
  public readonly object: Mesh;
  public readonly sunUniforms: SunUniforms;
  public exposure = 1.06;

  private readonly material: ShaderMaterial;
  private readonly geometry: BufferGeometry;
  private readonly timeState = createTimeOfDayState();
  private readonly starVisibility = { value: 0 };
  private lastClockReadMs = 0;

  constructor(
    noiseTexture?: DataTexture,
    private readonly fixedMinutes?: number,
  ) {
    const now = Date.now();
    this.lastClockReadMs = now;
    sampleTimeOfDay(
      fixedMinutes ?? localTimeMinutes(new Date(now)),
      this.timeState,
    );
    this.sunUniforms = {
      uSunDir: { value: this.timeState.sunDir },
      uSunColor: { value: this.timeState.sunColor },
      uSkyHorizonCool: { value: this.timeState.horizonCool },
      uSkyHorizonWarm: { value: this.timeState.horizonWarm },
      uSkyZenith: { value: this.timeState.zenith },
      uSkyBelow: { value: this.timeState.below },
    };
    this.syncScalarState();

    // NDC 全画面三角形(クリップは GPU 任せ — 頂点 3 つでクアッドより速い定番)
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );

    this.material = new ShaderMaterial({
      vertexShader: SKY_VERTEX_GLSL,
      fragmentShader: SKY_FRAGMENT_GLSL,
      uniforms: {
        ...this.sunUniforms,
        uStarVisibility: this.starVisibility,
        uProjInv: { value: new Matrix4() },
        uCamWorld: { value: new Matrix4() },
      },
      depthWrite: false,
      depthTest: true,
      depthFunc: LessEqualDepth,
    });
    if (noiseTexture) {
      // 雲気(バックドロップ専用 — 共有 sky() は軽量核のまま。design-render §7)
      this.material.defines = { SKY_BACKDROP: '' };
      this.material.uniforms.uNoise = { value: noiseTexture };
      this.material.uniforms.uTimeSec = { value: 0 };
    }

    this.object = new Mesh(this.geometry, this.material);
    this.object.renderOrder = 3;
    this.object.frustumCulled = false;
    this.object.matrixAutoUpdate = false;

    // カメラの逆行列は描画直前に同期(リサイズ/ドリフトに常に追従)
    this.object.onBeforeRender = (_renderer, _scene, camera) => {
      const uniforms = this.material.uniforms;
      (uniforms.uProjInv.value as Matrix4).copy(camera.projectionMatrixInverse);
      (uniforms.uCamWorld.value as Matrix4).copy(camera.matrixWorld);
    };
  }

  public update(_view: SkyRenderView, frame: FrameInfo): void {
    if (this.fixedMinutes === undefined) {
      const now = Date.now();
      if (now < this.lastClockReadMs || now - this.lastClockReadMs >= 15_000) {
        this.lastClockReadMs = now;
        sampleTimeOfDay(localTimeMinutes(new Date(now)), this.timeState);
        this.syncScalarState();
      }
    }
    const uTimeSec = this.material.uniforms.uTimeSec;
    if (uTimeSec) uTimeSec.value = frame.timeSec;
  }

  public dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }

  private syncScalarState(): void {
    this.starVisibility.value = this.timeState.starVisibility;
    this.exposure = this.timeState.exposure;
  }
}
