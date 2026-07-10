import { describe, expect, it } from 'vitest';
import { patchOutputShader } from '../../src/render/PostPipeline';

/** three ^0.185 OutputShader の構造を模した最小フラグメント。 */
const FRAGMENT = `
		precision highp float;

		uniform sampler2D tDiffuse;

		varying vec2 vUv;

		void main() {

			gl_FragColor = texture2D( tDiffuse, vUv );

			// tone mapping

			gl_FragColor.rgb = ACESFilmicToneMapping( gl_FragColor.rgb );

			// color space

			gl_FragColor = sRGBTransferOETF( gl_FragColor );

		}`;

describe('patchOutputShader', () => {
  it('ビネットをトーンマップ後・色空間変換前に注入する', () => {
    const patched = patchOutputShader(FRAGMENT);
    expect(patched).not.toBeNull();
    const src = patched as string;

    // 追加 uniform が宣言される
    expect(src).toContain('uniform float uVignetteStrength;');
    expect(src).toContain('uniform float uVignetteStart;');

    // 順序: tDiffuse フェッチ → トーンマップ → ビネット → 色空間
    const fetch = src.indexOf('texture2D( tDiffuse, vUv )');
    const tone = src.indexOf('ACESFilmicToneMapping');
    const vignette = src.indexOf('uVignetteStrength * smoothstep');
    const colorSpace = src.indexOf('sRGBTransferOETF');
    expect(fetch).toBeGreaterThanOrEqual(0);
    expect(tone).toBeGreaterThan(fetch);
    expect(vignette).toBeGreaterThan(tone);
    expect(colorSpace).toBeGreaterThan(vignette);
  });

  it('画面パスに bloom サンプラを注入しない(ANGLE Metal 黒フレーム回避)', () => {
    // bloom はシーン内の BloomApplyMesh で加算する設計(PostPipeline 冒頭
    // ドキュメント)。OutputPass が tDiffuse 以外の FBO 産物をサンプルする
    // 構成に戻すと Chrome/macOS で黒フレームが再発する。
    const src = patchOutputShader(FRAGMENT) as string;
    expect(src).not.toContain('uBloomTexture');
  });

  it('マーカー欠落時(three 更新等)は null を返す', () => {
    expect(patchOutputShader('void main() {}')).toBeNull();
    expect(
      patchOutputShader(FRAGMENT.replace('// color space', '')),
    ).toBeNull();
    expect(
      patchOutputShader(FRAGMENT.replace('varying vec2 vUv;', '')),
    ).toBeNull();
  });
});
