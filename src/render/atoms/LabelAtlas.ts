import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter } from 'three';

/**
 * 自前グリフアトラス(design-render §5)。
 *
 * 1024×256 canvas に 256² セル ×4(H / O / H₂ / 予備)。**セル順 = KIND_INDEX**。
 * H₂ の下付きは「小フォント + ベースライン下げ」の 2 フォントトリック。
 * troika(1 Text = 1 draw)は不採用 — 全ラベルを 1 draw で描くため。
 *
 * チャネル設計(文字が主役 — 発光球なしでも全背景で判読するため):
 * - G = 文字本体の被覆(シェーダで per-atom 色に着色)
 * - R = 縁取り(ストローク)の被覆 — 明るい空でも文字が沈まない暗色エッジ
 * - A = 両者の合計被覆(αブレンドのアルファ)
 * ストローク(#f00)→ フィル(#0f0)の順に描くと重なり部はフィルが上書きし、
 * R はエッジ専用・G は本体専用にきれいに分離する。
 */
export const LABEL_ATLAS_WIDTH = 1024;
export const LABEL_ATLAS_HEIGHT = 256;
export const LABEL_CELL_SIZE = 256;
export const LABEL_CELL_COUNT = 4;

export interface LabelCell {
  /** セル左上(px、canvas 座標)。 */
  readonly x: number;
  readonly y: number;
  readonly size: number;
  /** UV 矩形(左下原点 — CanvasTexture flipY 済みの GL 座標)。 */
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

/** セル座標の計算(純ロジック — テスト対象)。kindIndex = KIND_INDEX 準拠。 */
export const labelCellRect = (kindIndex: number): LabelCell => {
  if (
    !Number.isInteger(kindIndex) ||
    kindIndex < 0 ||
    kindIndex >= LABEL_CELL_COUNT
  ) {
    throw new RangeError(`kindIndex out of range: ${kindIndex}`);
  }
  const x = kindIndex * LABEL_CELL_SIZE;
  return {
    x,
    y: 0,
    size: LABEL_CELL_SIZE,
    u0: x / LABEL_ATLAS_WIDTH,
    v0: 0,
    u1: (x + LABEL_CELL_SIZE) / LABEL_ATLAS_WIDTH,
    v1: 1,
  };
};

/** セル内に描く文字仕様(セル順 = KIND_INDEX: H, O, H₂, 予備)。 */
const GLYPHS: readonly { main: string; sub?: string }[] = [
  { main: 'H' },
  { main: 'O' },
  { main: 'H', sub: '2' },
];

const MAIN_FONT = 'bold 150px "Helvetica Neue", Arial, sans-serif';
const SUB_FONT = 'bold 90px "Helvetica Neue", Arial, sans-serif';
/** 下付きのベースライン下げ(px)。 */
const SUB_BASELINE_DROP = 48;
/** 縁取り幅(px — 片側 ≈ lineWidth/2。150px フォント比で細めのエッジ)。 */
const STROKE_WIDTH = 18;

/** グリフの各パーツ(主文字/下付き)を stroke → fill の 2 パスで描く。 */
const drawGlyphPasses = (
  ctx: CanvasRenderingContext2D,
  draw: (pass: 'stroke' | 'fill') => void,
): void => {
  ctx.lineWidth = STROKE_WIDTH;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#ff0000'; // R = 縁取りチャネル
  draw('stroke');
  ctx.fillStyle = '#00ff00'; // G = 本体チャネル(重なりは fill が上書き)
  draw('fill');
};

/** アトラス canvas の焼き込み(DOM 必須 — 起動時 1 回)。 */
export const createLabelAtlasCanvas = (): HTMLCanvasElement => {
  const canvas = document.createElement('canvas');
  canvas.width = LABEL_ATLAS_WIDTH;
  canvas.height = LABEL_ATLAS_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');

  ctx.clearRect(0, 0, LABEL_ATLAS_WIDTH, LABEL_ATLAS_HEIGHT);
  ctx.textBaseline = 'middle';

  GLYPHS.forEach((glyph, kindIndex) => {
    const cell = labelCellRect(kindIndex);
    const cx = cell.x + cell.size / 2;
    const cy = cell.y + cell.size / 2;
    if (!glyph.sub) {
      ctx.textAlign = 'center';
      drawGlyphPasses(ctx, (pass) => {
        ctx.font = MAIN_FONT;
        if (pass === 'stroke') ctx.strokeText(glyph.main, cx, cy);
        else ctx.fillText(glyph.main, cx, cy);
      });
      return;
    }
    // 2 フォントトリック: 主文字 + 小フォントの下付き(ベースライン下げ)
    ctx.font = MAIN_FONT;
    const mainW = ctx.measureText(glyph.main).width;
    ctx.font = SUB_FONT;
    const subW = ctx.measureText(glyph.sub).width;
    const total = mainW + subW * 0.9;
    const startX = cx - total / 2;
    ctx.textAlign = 'left';
    const sub = glyph.sub;
    drawGlyphPasses(ctx, (pass) => {
      ctx.font = MAIN_FONT;
      if (pass === 'stroke') ctx.strokeText(glyph.main, startX, cy);
      else ctx.fillText(glyph.main, startX, cy);
      ctx.font = SUB_FONT;
      if (pass === 'stroke')
        ctx.strokeText(sub, startX + mainW, cy + SUB_BASELINE_DROP);
      else ctx.fillText(sub, startX + mainW, cy + SUB_BASELINE_DROP);
    });
  });

  return canvas;
};

export const createLabelAtlasTexture = (): CanvasTexture => {
  const texture = new CanvasTexture(createLabelAtlasCanvas());
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
};
