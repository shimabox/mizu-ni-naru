import {
  BufferAttribute,
  BufferGeometry,
  Color,
  type DataTexture,
  FrontSide,
  Group,
  IcosahedronGeometry,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  Vector4,
} from 'three';
import type { SkyRenderView } from '../../contract/RenderView';
import {
  BUBBLE_CAPACITY,
  BUBBLE_STATE,
  RIPPLE_VIEW_CAPACITY,
} from '../../contract/WorldSpec';
import type { SunUniforms } from '../Environment';
import type { FrameInfo, RenderSystem } from '../RenderSystem';
import {
  INNER_CAP_FRAGMENT_GLSL,
  INNER_CAP_VERTEX_GLSL,
} from '../shaders/innerCap';
import {
  INNER_WATER_FRAGMENT_GLSL,
  INNER_WATER_VERTEX_GLSL,
} from '../shaders/innerWater';
import type { BubbleInstanceBuffers } from './BubbleInstanceBuffers';

/** 球ごとの InnerRipple リングバッファ本数(§4b)。 */
const RIPPLES_PER_BUBBLE = 6;
/** 「発火していない」を示す誕生 stepF(age が巨大 → 減衰で消滅)。 */
const RIPPLE_DEAD_BIRTH = -1e6;

/** キャップの単位円盤グリッド(24 リング × 48 セグメント — §4b)。 */
const CAP_RINGS = 24;
const CAP_SEGMENTS = 48;

const createCapDiskGeometry = (): BufferGeometry => {
  const vertexCount = 1 + CAP_RINGS * CAP_SEGMENTS;
  const positions = new Float32Array(vertexCount * 3);
  let p = 3;
  for (let k = 0; k < CAP_RINGS; k++) {
    const r = (k + 1) / CAP_RINGS;
    for (let s = 0; s < CAP_SEGMENTS; s++) {
      const theta = (2 * Math.PI * s) / CAP_SEGMENTS;
      positions[p] = r * Math.cos(theta);
      positions[p + 1] = 0;
      positions[p + 2] = r * Math.sin(theta);
      p += 3;
    }
  }
  const triCount = CAP_SEGMENTS + (CAP_RINGS - 1) * CAP_SEGMENTS * 2;
  const indices = new Uint16Array(triCount * 3);
  let i = 0;
  const ringStart = (k: number): number => 1 + k * CAP_SEGMENTS;
  for (let s = 0; s < CAP_SEGMENTS; s++) {
    const s1 = (s + 1) % CAP_SEGMENTS;
    indices[i++] = 0;
    indices[i++] = ringStart(0) + s1;
    indices[i++] = ringStart(0) + s;
  }
  for (let k = 0; k < CAP_RINGS - 1; k++) {
    const inner = ringStart(k);
    const outer = ringStart(k + 1);
    for (let s = 0; s < CAP_SEGMENTS; s++) {
      const s1 = (s + 1) % CAP_SEGMENTS;
      indices[i++] = inner + s;
      indices[i++] = inner + s1;
      indices[i++] = outer + s;
      indices[i++] = inner + s1;
      indices[i++] = outer + s1;
      indices[i++] = outer + s;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return geometry;
};

/**
 * 球内の水(design-render §4)— 体積 1 draw + 水面キャップ 1 draw。
 *
 * per-instance 属性は BubbleGlassSystem と同一の BubbleInstanceBuffers を共有。
 * InnerRippleView のイベントはレンダー側リングバッファ(球ごと 6 本、
 * 古い順上書き)に保持し、uniform `uInnerRipples[48]` で解析リング波として
 * キャップの法線に注入する(A7/A8)。
 */
export class InnerWaterSystem implements RenderSystem {
  public readonly object: Group;

  private readonly volumeGeometry: InstancedBufferGeometry;
  private readonly capGeometry: InstancedBufferGeometry;
  private readonly volumeMaterial: ShaderMaterial;
  private readonly capMaterial: ShaderMaterial;
  private readonly buffers: BubbleInstanceBuffers;

  private readonly rippleUniform: Vector4[];
  private readonly rippleCursor = new Int32Array(BUBBLE_CAPACITY);
  private readonly lastState = new Int32Array(BUBBLE_CAPACITY).fill(
    BUBBLE_STATE.Dead,
  );

  constructor(
    sun: SunUniforms,
    buffers: BubbleInstanceBuffers,
    noiseTexture: DataTexture,
  ) {
    this.buffers = buffers;

    this.rippleUniform = [];
    for (let i = 0; i < BUBBLE_CAPACITY * RIPPLES_PER_BUBBLE; i++) {
      this.rippleUniform.push(new Vector4(0, 0, RIPPLE_DEAD_BIRTH, 0));
    }

    const sssColor = new Color(0x2fc0a8);

    const volumeBase = new IcosahedronGeometry(1, 3);
    this.volumeGeometry = this.makeInstanced(
      volumeBase.getIndex(),
      volumeBase.getAttribute('position') as BufferAttribute,
      buffers,
    );
    this.volumeMaterial = new ShaderMaterial({
      vertexShader: INNER_WATER_VERTEX_GLSL,
      fragmentShader: INNER_WATER_FRAGMENT_GLSL,
      uniforms: {
        uAlpha: { value: 0 },
        uTimeSec: { value: 0 },
        uNoise: { value: noiseTexture },
        uSssColor: { value: sssColor },
      },
      transparent: true,
      depthTest: true,
      depthWrite: true, // §1.3 — A25 不変条件でソート不要に閉じる
      side: FrontSide,
    });

    const capBase = createCapDiskGeometry();
    this.capGeometry = this.makeInstanced(
      capBase.getIndex(),
      capBase.getAttribute('position') as BufferAttribute,
      buffers,
    );
    this.capMaterial = new ShaderMaterial({
      vertexShader: INNER_CAP_VERTEX_GLSL,
      fragmentShader: INNER_CAP_FRAGMENT_GLSL,
      uniforms: {
        uSunDir: sun.uSunDir,
        uSunColor: sun.uSunColor,
        uAlpha: { value: 0 },
        uTimeSec: { value: 0 },
        uStepF: { value: 0 },
        uSssColor: { value: sssColor },
        uInnerRipples: { value: this.rippleUniform },
      },
      transparent: true,
      depthTest: true,
      depthWrite: true,
      side: FrontSide,
    });

    this.object = new Group();
    this.object.matrixAutoUpdate = false;
    const volumeMesh = new Mesh(this.volumeGeometry, this.volumeMaterial);
    volumeMesh.renderOrder = 4;
    const capMesh = new Mesh(this.capGeometry, this.capMaterial);
    capMesh.renderOrder = 5;
    for (const mesh of [volumeMesh, capMesh]) {
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      this.object.add(mesh);
    }
  }

  public update(view: SkyRenderView, frame: FrameInfo): void {
    this.volumeGeometry.instanceCount = this.buffers.count;
    this.capGeometry.instanceCount = this.buffers.count;

    this.volumeMaterial.uniforms.uAlpha.value = frame.alpha;
    this.volumeMaterial.uniforms.uTimeSec.value = frame.timeSec;
    this.capMaterial.uniforms.uAlpha.value = frame.alpha;
    this.capMaterial.uniforms.uTimeSec.value = frame.timeSec;
    this.capMaterial.uniforms.uStepF.value = frame.stepF;

    this.ingestRipples(view);
  }

  public dispose(): void {
    this.volumeGeometry.dispose();
    this.capGeometry.dispose();
    this.volumeMaterial.dispose();
    this.capMaterial.dispose();
  }

  private makeInstanced(
    index: BufferAttribute | null,
    position: BufferAttribute,
    buffers: BubbleInstanceBuffers,
  ): InstancedBufferGeometry {
    const geometry = new InstancedBufferGeometry();
    geometry.setIndex(index);
    geometry.setAttribute('position', position);
    geometry.setAttribute('aCurrA', buffers.currA);
    geometry.setAttribute('aCurrB', buffers.currB);
    geometry.setAttribute('aPrevA', buffers.prevA);
    geometry.setAttribute('aPrevB', buffers.prevB);
    geometry.setAttribute('aMisc', buffers.misc);
    geometry.instanceCount = 0;
    return geometry;
  }

  /** InnerRippleView → 球ごとのリングバッファ(古い順上書き)+ 再誕生でクリア。 */
  private ingestRipples(view: SkyRenderView): void {
    const bubbles = view.bubbles;
    const count = Math.min(bubbles.count, BUBBLE_CAPACITY);
    for (let slot = 0; slot < count; slot++) {
      const state = Math.floor(bubbles.data[slot * 8 + 7]);
      if (
        state === BUBBLE_STATE.Spawning &&
        this.lastState[slot] !== BUBBLE_STATE.Spawning
      ) {
        // スロット再利用(世代交代)— 前世代の波紋を消す
        const base = slot * RIPPLES_PER_BUBBLE;
        for (let k = 0; k < RIPPLES_PER_BUBBLE; k++) {
          this.rippleUniform[base + k].set(0, 0, RIPPLE_DEAD_BIRTH, 0);
        }
        this.rippleCursor[slot] = 0;
      }
      this.lastState[slot] = state;
    }

    const ripples = view.ripples;
    const n = Math.min(ripples.count, RIPPLE_VIEW_CAPACITY);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const slot = ripples.data[o];
      if (slot < 0 || slot >= BUBBLE_CAPACITY) continue;
      const cursor = this.rippleCursor[slot];
      this.rippleUniform[slot * RIPPLES_PER_BUBBLE + cursor].set(
        ripples.data[o + 1], // localX(球ローカル世界単位 — A8)
        ripples.data[o + 2], // localZ
        view.step,
        ripples.data[o + 3], // strength
      );
      this.rippleCursor[slot] = (cursor + 1) % RIPPLES_PER_BUBBLE;
    }
  }
}
