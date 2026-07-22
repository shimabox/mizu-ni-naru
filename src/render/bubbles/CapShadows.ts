import type { Vector4 } from 'three';
import type { SkyRenderView } from '../../contract/RenderView';
import {
  BUBBLE_CAPACITY,
  BUBBLE_STATE,
  DROPLET_VIEW_CAPACITY,
} from '../../contract/WorldSpec';
import { WATER_VISUAL_RATIO } from '../shaders/innerWater';

const STRIDE = 8;
const V4 = 4;

/**
 * 球内水面キャップの接触影(コンタクトシャドウ、裁定 A76)。
 *
 * 落下中の雫が水面に落とす影のブロブを CPU 側で収集し、
 * innerCap フラグメントへ uniform 配列として渡す。
 * A76 改訂(2026-07-22 ユーザー指示): 影を落とすのは**雫のみ**。文字原子
 * (H/O/H₂)は物理的な「物」ではなく記号として漂う主役(文字が主役の裁定)
 * であり、影を持たせると物体に見えてしまうため対象から外した。InnerRipple(§4b、A32/A74)
 * と同じ「カメラ近傍のみを uniform 配列で追跡し、vSlot(rippleIndex)で
 * シェーダ側と照合する」パターンを踏襲する。近傍選抜・上位 K 保持は
 * OceanSystem.packBubbles(§2.5/A30)と同じ流儀 — 挿入ソート・
 * モジュールレベルのスクラッチ TypedArray で定常状態アロケーションゼロ。
 */

/**
 * 影を追跡するカメラ最近傍球数(A76)。InnerRipple の RIPPLE_NEAR_COUNT
 * (現在 24)ほど広くは要らない — 接触影は「近づいたときのリアリティ」が
 * 目的なので、距離フェード圏(CAP_SHADOW_FADE_FAR)内の球を覆えれば足りる。
 * 初版の 4 は「同距離の隣球で影が出たり出なかったりする」ムラとして視認
 * された(ユーザー指摘 2026-07-21)ため 8 に拡大 — 1 球あたりのコストは
 * uniform 数十個と軽いループのみで、8 でもフェード圏内の球数を実質カバーする。
 */
export const CAP_SHADOW_BUBBLES = 8;

/**
 * 球ごとの遮蔽物(雫)上限(A76)。1 球に数十体降ることもあるが、
 * 「うっすら」要件(body *= 1 - 0.30*shade)なので低い・大きい候補の重み
 * 上位数体で影の見た目はほぼ収束する。8 体は打ち切りアーティファクトが
 * 出ない範囲で最小のコスト。
 */
export const CAP_SHADOWS_PER_BUBBLE = 8;

/**
 * カメラ距離フェードの開始/終了[u](A76)。LOD_NEAR_DISTANCE(15u —
 * BubbleInstanceBuffers.ts)とほぼ揃え、ジオメトリが far LOD に切り替わる
 * 手前で影も自然に消えるようにする(切り替わり境界での見た目の同時発生を
 * 避ける)。
 */
export const CAP_SHADOW_FADE_NEAR = 10;
export const CAP_SHADOW_FADE_FAR = 16;
const CAP_SHADOW_FADE_FAR_SQ = CAP_SHADOW_FADE_FAR * CAP_SHADOW_FADE_FAR;

/** キャップ描画条件(innerCap.ts の smoothstep(0.0, 0.03, vFill))と一致させる。 */
const MIN_FILL01 = 0.03;
/** 水面からの浮き上がり判定の床(浮動小数誤差・水面ジオメトリの揺れ吸収)。 */
const MIN_HEIGHT_ABOVE_WATER = 0.01;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
};

// --- 近傍球選抜スクラッチ(OceanSystem.packBubbles と同じ挿入ソート流儀) ---
const candSlot = new Int32Array(BUBBLE_CAPACITY);
const candD2 = new Float64Array(BUBBLE_CAPACITY);

// --- 選抜された ≤CAP_SHADOW_BUBBLES 球の補間済みパラメータ ---
const selCenterX = new Float64Array(CAP_SHADOW_BUBBLES);
const selCenterY = new Float64Array(CAP_SHADOW_BUBBLES);
const selCenterZ = new Float64Array(CAP_SHADOW_BUBBLES);
const selRv = new Float64Array(CAP_SHADOW_BUBBLES);
const selWaterY = new Float64Array(CAP_SHADOW_BUBBLES);
const selFade = new Float64Array(CAP_SHADOW_BUBBLES);
/** rippleIndexBySlot[slot](-1 = 対象外 = 出力から除外)。selectedCount 未満の
 *  範囲にのみ意味を持つ値が入り、それ以外は毎回 -1 に初期化する。 */
const selRippleIndex = new Int32Array(CAP_SHADOW_BUBBLES);

// --- 球ごとの遮蔽物上位 CAP_SHADOWS_PER_BUBBLE 保持(重み降順の固定長挿入) ---
const occW = new Float64Array(CAP_SHADOW_BUBBLES * CAP_SHADOWS_PER_BUBBLE);
const occLocalX = new Float64Array(CAP_SHADOW_BUBBLES * CAP_SHADOWS_PER_BUBBLE);
const occLocalZ = new Float64Array(CAP_SHADOW_BUBBLES * CAP_SHADOWS_PER_BUBBLE);
const occHeight = new Float64Array(CAP_SHADOW_BUBBLES * CAP_SHADOWS_PER_BUBBLE);
const occRadius = new Float64Array(CAP_SHADOW_BUBBLES * CAP_SHADOWS_PER_BUBBLE);
const occCount = new Int32Array(CAP_SHADOW_BUBBLES);

/** 球 j の遮蔽物候補を重み降順の固定長(CAP_SHADOWS_PER_BUBBLE)挿入で取り込む。 */
const ingestOccluder = (
  j: number,
  localX: number,
  localZ: number,
  height: number,
  radius: number,
  weight: number,
): void => {
  const base = j * CAP_SHADOWS_PER_BUBBLE;
  const count = occCount[j];
  let idx: number;
  if (count < CAP_SHADOWS_PER_BUBBLE) {
    idx = count;
    occCount[j] = count + 1;
  } else if (weight > occW[base + CAP_SHADOWS_PER_BUBBLE - 1]) {
    idx = CAP_SHADOWS_PER_BUBBLE - 1;
  } else {
    return; // 既存の最小重みより弱い候補は捨てる
  }
  while (idx > 0 && occW[base + idx - 1] < weight) {
    occW[base + idx] = occW[base + idx - 1];
    occLocalX[base + idx] = occLocalX[base + idx - 1];
    occLocalZ[base + idx] = occLocalZ[base + idx - 1];
    occHeight[base + idx] = occHeight[base + idx - 1];
    occRadius[base + idx] = occRadius[base + idx - 1];
    idx--;
  }
  occW[base + idx] = weight;
  occLocalX[base + idx] = localX;
  occLocalZ[base + idx] = localZ;
  occHeight[base + idx] = height;
  occRadius[base + idx] = radius;
};

/**
 * 雫(stride4 [x,y,z,r] ワールド座標)を 1 パス走査し、
 * 選抜済み球(module scratch の sel*)それぞれに対して「球内(3D 距離² <
 * Rv²)かつ水面上(h > MIN_HEIGHT_ABOVE_WATER)」の候補を ingestOccluder へ渡す。
 * rippleIndex が -1(=シェーダが vSlot 照合できない)の球はスキップ — 収集の
 * 意味がないため。
 *
 * 半径は雫のポップイン(droplet.ts: 半径 0→1 を 10 step、smoothstep(0, 10,
 * stepF - spawnStep))を掛けた見た目半径を使う — 生の r のままだと、まだ
 * 不可視のスポーン直後の雫が ~0.17s 先行してフルサイズの影を落とす
 * (A76 レビュー指摘の修正)。popIn=0(スポーンと同 stepF)は候補ごと除外。
 */
const scanOccluders = (
  posr: Float32Array,
  prevPosr: Float32Array,
  aux: Float32Array,
  count: number,
  capacity: number,
  alpha: number,
  stepF: number,
): void => {
  const n = Math.min(count, capacity);
  for (let i = 0; i < n; i++) {
    const o = i * V4;
    // aux = [phase, swayAmp, spawnStep, seed](スポーン時のみ書き込み — lerp 不要)
    const popIn = smoothstep(0, 10, stepF - aux[o + 2]);
    if (popIn <= 0) continue;
    const x = lerp(prevPosr[o], posr[o], alpha);
    const y = lerp(prevPosr[o + 1], posr[o + 1], alpha);
    const z = lerp(prevPosr[o + 2], posr[o + 2], alpha);
    const r = lerp(prevPosr[o + 3], posr[o + 3], alpha) * popIn;
    for (let j = 0; j < CAP_SHADOW_BUBBLES; j++) {
      if (selRippleIndex[j] < 0) continue;
      const dx = x - selCenterX[j];
      const dy = y - selCenterY[j];
      const dz = z - selCenterZ[j];
      const rv = selRv[j];
      if (dx * dx + dy * dy + dz * dz >= rv * rv) continue;
      const h = y - selWaterY[j];
      if (h <= MIN_HEIGHT_ABOVE_WATER) continue;
      const weight = r / (r + h);
      ingestOccluder(j, dx, dz, h, r, weight);
    }
  }
};

/**
 * 球内水面キャップの接触影を収集し、outShadows/outMeta へ書き込む(A76)。
 * 純ロジック(テスト対象)。定常状態アロケーションゼロ — 呼び出し側は
 * outShadows(長さ CAP_SHADOW_BUBBLES*CAP_SHADOWS_PER_BUBBLE)・outMeta
 * (長さ CAP_SHADOW_BUBBLES)の Vector4 配列を一度だけ確保して毎フレーム渡す。
 *
 * outShadows[j*CAP_SHADOWS_PER_BUBBLE+k] = [localX, localZ, heightAboveWater, r]
 * outMeta[j] = [rippleIndex(-1=空), count, fade, 0]
 */
export const collectCapShadows = (
  view: SkyRenderView,
  alpha: number,
  camX: number,
  camY: number,
  camZ: number,
  rippleIndexBySlot: Int32Array,
  outShadows: Vector4[],
  outMeta: Vector4[],
): void => {
  const bubbles = view.bubbles;
  const count = Math.min(bubbles.count, BUBBLE_CAPACITY);

  // 1. 候補選抜: 生存中の水あり(state < Splashing)・fill01>MIN_FILL01
  //    (キャップ描画条件と一致)・カメラ距離 < CAP_SHADOW_FADE_FAR。
  let candidates = 0;
  for (let slot = 0; slot < count; slot++) {
    const o = slot * STRIDE;
    const state = Math.floor(bubbles.data[o + 7]); // curr のみ(A25: statePacked は lerp 禁止)
    if (state >= BUBBLE_STATE.Splashing) continue;
    const fill01 = lerp(bubbles.prevData[o + 5], bubbles.data[o + 5], alpha);
    if (fill01 <= MIN_FILL01) continue;
    const cx = lerp(bubbles.prevData[o], bubbles.data[o], alpha);
    const cy = lerp(bubbles.prevData[o + 1], bubbles.data[o + 1], alpha);
    const cz = lerp(bubbles.prevData[o + 2], bubbles.data[o + 2], alpha);
    const dx = cx - camX;
    const dy = cy - camY;
    const dz = cz - camZ;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= CAP_SHADOW_FADE_FAR_SQ) continue;
    candSlot[candidates] = slot;
    candD2[candidates] = d2;
    candidates++;
  }
  // 挿入ソート(近い順)— 候補数は多くても BUBBLE_CAPACITY 程度で全ソートで十分安い
  for (let i = 1; i < candidates; i++) {
    const slot = candSlot[i];
    const d2 = candD2[i];
    let j = i - 1;
    while (j >= 0 && candD2[j] > d2) {
      candSlot[j + 1] = candSlot[j];
      candD2[j + 1] = candD2[j];
      j--;
    }
    candSlot[j + 1] = slot;
    candD2[j + 1] = d2;
  }
  const selectedCount = Math.min(candidates, CAP_SHADOW_BUBBLES);

  // 2. 選抜球ごとに Spawning の grow(BUBBLE_STATE_TRANSFORM_GLSL と同式)を
  //    CPU で再現し、Rv・水面平面 Y・fade を求める。stretchY(張り)は無視 —
  //    影はうっすらなので近似で十分(縁の伸びまで再現する価値が薄い)。
  for (let j = 0; j < CAP_SHADOW_BUBBLES; j++) {
    occCount[j] = 0;
    if (j >= selectedCount) {
      selRippleIndex[j] = -1;
      continue;
    }
    const slot = candSlot[j];
    const o = slot * STRIDE;
    const cy = lerp(bubbles.prevData[o + 1], bubbles.data[o + 1], alpha);
    const R = lerp(bubbles.prevData[o + 3], bubbles.data[o + 3], alpha);
    const wl = lerp(bubbles.prevData[o + 4], bubbles.data[o + 4], alpha);
    const statePacked = bubbles.data[o + 7]; // curr のみ
    const state = Math.floor(statePacked);
    const prog = statePacked - state;
    const p2 = prog * prog * (3 - 2 * prog);
    const grow = state === BUBBLE_STATE.Spawning ? 0.6 + 0.4 * p2 : 1;

    const camDist = Math.sqrt(candD2[j]);
    const fade =
      1 - smoothstep(CAP_SHADOW_FADE_NEAR, CAP_SHADOW_FADE_FAR, camDist);
    if (fade <= 0) {
      selRippleIndex[j] = -1;
      continue;
    }

    // rippleIndex が -1 の球はシェーダが vSlot 照合できないため除外
    // (その球自身の cap フラグメントも vSlot<0 で影ループごとスキップされる —
    // InnerWaterSystem.ingestRipples / innerCap.ts と対称)
    const rippleIndex = rippleIndexBySlot[slot];
    selRippleIndex[j] = rippleIndex;
    if (rippleIndex < 0) continue;

    selCenterX[j] = lerp(bubbles.prevData[o], bubbles.data[o], alpha);
    selCenterY[j] = cy;
    selCenterZ[j] = lerp(bubbles.prevData[o + 2], bubbles.data[o + 2], alpha);
    selRv[j] = R * WATER_VISUAL_RATIO * grow;
    selWaterY[j] = cy + wl * grow;
    selFade[j] = fade;
  }

  // 3. 遮蔽物(雫のみ — A76 改訂: 文字原子は記号なので影を落とさない)を
  //    1 パス走査し、球ごとに重み上位を保持。stepF は droplet.ts の uStepF と
  //    同じ導出(view.step + alpha)— ポップインの位相を描画と一致させる。
  scanOccluders(
    view.droplets.posr,
    view.droplets.prevPosr,
    view.droplets.aux,
    view.droplets.count,
    DROPLET_VIEW_CAPACITY,
    alpha,
    view.step + alpha,
  );

  // 4. 書き込み。
  for (let j = 0; j < CAP_SHADOW_BUBBLES; j++) {
    const rIdx = selRippleIndex[j];
    const base = j * CAP_SHADOWS_PER_BUBBLE;
    if (rIdx < 0) {
      outMeta[j].set(-1, 0, 0, 0);
      for (let k = 0; k < CAP_SHADOWS_PER_BUBBLE; k++) {
        outShadows[base + k].set(0, 0, 0, 0);
      }
      continue;
    }
    const cnt = occCount[j];
    outMeta[j].set(rIdx, cnt, selFade[j], 0);
    for (let k = 0; k < CAP_SHADOWS_PER_BUBBLE; k++) {
      const v = outShadows[base + k];
      if (k < cnt) {
        v.set(
          occLocalX[base + k],
          occLocalZ[base + k],
          occHeight[base + k],
          occRadius[base + k],
        );
      } else {
        v.set(0, 0, 0, 0);
      }
    }
  }
};
