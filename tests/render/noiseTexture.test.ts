import { describe, expect, it } from 'vitest';
import {
  NOISE_TEXTURE_SIZE,
  generateNoiseData,
} from '../../src/render/NoiseTexture';

describe('NoiseTexture.generateNoiseData', () => {
  const size = NOISE_TEXTURE_SIZE;
  const data = generateNoiseData(size);

  it('サイズ: size×size×4 バイトの RGBA8', () => {
    expect(data.length).toBe(size * size * 4);
  });

  it('決定論: 2 回生成して同一', () => {
    const again = generateNoiseData(size);
    expect(again).toEqual(data);
  });

  it('値域: 全チャネル 0..255 かつ各チャネルに十分な分散がある', () => {
    for (let c = 0; c < 4; c++) {
      let min = 255;
      let max = 0;
      let sum = 0;
      const n = size * size;
      for (let i = 0; i < n; i++) {
        const v = data[i * 4 + c];
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
      }
      const mean = sum / n;
      expect(min).toBeGreaterThanOrEqual(0);
      expect(max).toBeLessThanOrEqual(255);
      // 定数チャネルではない(fbm/リッジ/ハッシュとも山谷がある)
      expect(max - min).toBeGreaterThan(64);
      // 平均が極端に偏っていない
      expect(mean).toBeGreaterThan(32);
      expect(mean).toBeLessThan(224);
    }
  });

  it('タイル性: 端の 1px 差分が内部の 1px 差分と同程度(継ぎ目に段差がない)', () => {
    // R チャネル: 右端 → 左端(ラップ)の差分絶対値の平均が、
    // 内部横方向差分の平均の 3 倍以内に収まること
    let seamSum = 0;
    let innerSum = 0;
    let innerCount = 0;
    for (let y = 0; y < size; y++) {
      const rowStart = y * size * 4;
      const left = data[rowStart];
      const right = data[rowStart + (size - 1) * 4];
      seamSum += Math.abs(left - right);
      for (let x = 0; x < size - 1; x++) {
        innerSum += Math.abs(
          data[rowStart + x * 4] - data[rowStart + (x + 1) * 4],
        );
        innerCount++;
      }
    }
    const seamMean = seamSum / size;
    const innerMean = innerSum / innerCount;
    expect(seamMean).toBeLessThan(innerMean * 3 + 1);
  });
});
