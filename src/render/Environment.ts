import {
  BufferAttribute,
  BufferGeometry,
  Color,
  LessEqualDepth,
  Matrix4,
  Mesh,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { SkyRenderView } from '../contract/RenderView';
import type { FrameInfo, RenderSystem } from './RenderSystem';
import { SKY_FRAGMENT_GLSL, SKY_VERTEX_GLSL } from './shaders/sky';

/**
 * 太陽 uniform の共有ブロック(design-render §1.1)。
 * three のライトシステムは使わず、この 2 つの uniform を全カスタムマテリアルで
 * 共有する(値オブジェクトは同一参照 — Environment が唯一の所有者)。
 */
export interface SunUniforms {
  readonly uSunDir: { readonly value: Vector3 };
  readonly uSunColor: { readonly value: Color };
}

/**
 * 朝の解析スカイ背景(far plane の全画面三角形 — design-render §7)。
 *
 * - `scene.background` は使わない(最初に描かれフィルを浪費する)。
 *   depthFunc: LessEqualDepth + depthWrite off で
 *   「何にも覆われていないピクセルだけ」を最後にシェーディングする
 * - 太陽は不動(スクリーンセーバーの「時刻」は変えない)。uSunDir / uSunColor
 *   はコンストラクタで確定し、全システムのマテリアルへ同一参照を配る
 */
export class Environment implements RenderSystem {
  public readonly object: Mesh;
  public readonly sunUniforms: SunUniforms;

  private readonly material: ShaderMaterial;
  private readonly geometry: BufferGeometry;

  constructor() {
    this.sunUniforms = {
      // 仰角 14°(y = sin14° ≈ 0.242)。方位は構図固定
      uSunDir: { value: new Vector3(0.485, 0.242, -0.841).normalize() },
      // #ffd19a 系(Color は sRGB hex を linear 作業空間へ自動変換する)
      uSunColor: { value: new Color(0xffd19a) },
    };

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
        uSunDir: this.sunUniforms.uSunDir,
        uSunColor: this.sunUniforms.uSunColor,
        uProjInv: { value: new Matrix4() },
        uCamWorld: { value: new Matrix4() },
      },
      depthWrite: false,
      depthTest: true,
      depthFunc: LessEqualDepth,
    });

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

  public update(_view: SkyRenderView, _frame: FrameInfo): void {
    // 太陽は不動・行列は onBeforeRender で同期 — フレーム更新なし
  }

  public dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
