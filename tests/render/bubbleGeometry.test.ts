import { describe, expect, it } from 'vitest';
import {
  FOREGROUND_BUBBLE_DETAIL,
  createForegroundBubbleGeometry,
} from '../../src/render/bubbles/BubbleGeometry';

describe('foreground bubble geometry', () => {
  it('GlassとInnerWaterで共有するdetail 6の980三角形を生成する', () => {
    const geometry = createForegroundBubbleGeometry();

    expect(FOREGROUND_BUBBLE_DETAIL).toBe(6);
    expect(geometry.getIndex()).toBeNull();
    expect(geometry.getAttribute('position').count / 3).toBe(980);

    geometry.dispose();
  });
});
