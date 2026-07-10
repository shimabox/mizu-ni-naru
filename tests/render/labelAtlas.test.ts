import { describe, expect, it } from 'vitest';
import { KIND_INDEX } from '../../src/contract/WorldSpec';
import {
  LABEL_ATLAS_HEIGHT,
  LABEL_ATLAS_WIDTH,
  LABEL_CELL_COUNT,
  LABEL_CELL_SIZE,
  labelCellRect,
} from '../../src/render/atoms/LabelAtlas';

describe('LabelAtlas のセル座標(design-render §5)', () => {
  it('アトラス構成: 1024×256・256² セル ×4', () => {
    expect(LABEL_ATLAS_WIDTH).toBe(1024);
    expect(LABEL_ATLAS_HEIGHT).toBe(256);
    expect(LABEL_CELL_SIZE).toBe(256);
    expect(LABEL_CELL_COUNT).toBe(4);
  });

  it('セル順 = KIND_INDEX(H=0, O=1, H2=2)で位置と UV が整合する', () => {
    for (const kind of Object.values(KIND_INDEX)) {
      const cell = labelCellRect(kind);
      expect(cell.x).toBe(kind * 256);
      expect(cell.y).toBe(0);
      expect(cell.size).toBe(256);
      expect(cell.u0).toBeCloseTo(kind * 0.25, 10);
      expect(cell.u1).toBeCloseTo((kind + 1) * 0.25, 10);
      expect(cell.v0).toBe(0);
      expect(cell.v1).toBe(1);
    }
  });

  it('シェーダのセル選択式 (kind + corner.x) * 0.25 と一致する', () => {
    for (const kind of [0, 1, 2, 3]) {
      const cell = labelCellRect(kind);
      // corner.x = 0(左端)/ 1(右端)
      expect((kind + 0) * 0.25).toBeCloseTo(cell.u0, 10);
      expect((kind + 1) * 0.25).toBeCloseTo(cell.u1, 10);
    }
  });

  it('範囲外 kindIndex は例外', () => {
    expect(() => labelCellRect(-1)).toThrow(RangeError);
    expect(() => labelCellRect(4)).toThrow(RangeError);
    expect(() => labelCellRect(1.5)).toThrow(RangeError);
  });
});
