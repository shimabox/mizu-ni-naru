import { describe, expect, it } from 'vitest';
import {
  SPRAY_CAPACITY,
  initializedSprayInstanceCount,
} from '../../src/render/particles/SpraySystem';

describe('initializedSprayInstanceCount', () => {
  it('初回リング飽和までは書き込み済みprefixだけを描く', () => {
    expect(initializedSprayInstanceCount(0)).toBe(0);
    expect(initializedSprayInstanceCount(1)).toBe(1);
    expect(initializedSprayInstanceCount(SPRAY_CAPACITY - 1)).toBe(
      SPRAY_CAPACITY - 1,
    );
  });

  it('リング飽和後は従来どおり全容量を描く', () => {
    expect(initializedSprayInstanceCount(SPRAY_CAPACITY)).toBe(SPRAY_CAPACITY);
    expect(initializedSprayInstanceCount(SPRAY_CAPACITY + 500)).toBe(
      SPRAY_CAPACITY,
    );
  });
});
