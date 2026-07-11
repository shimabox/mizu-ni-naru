import { describe, expect, it } from 'vitest';
import { parseUrlParams } from '../../src/app/urlParams';
import { BUBBLE_CAPACITY } from '../../src/contract/WorldSpec';

describe('parseUrlParams', () => {
  it('省略時は既定値(全て undefined / measure=false)', () => {
    const p = parseUrlParams('');
    expect(p.seed).toBeUndefined();
    expect(p.measure).toBe(false);
    expect(p.q).toBeUndefined();
    expect(p.dpr).toBeUndefined();
    expect(p.sim).toBeUndefined();
    expect(p.slots).toBeUndefined();
  });

  it('正常値をパースする', () => {
    const p = parseUrlParams('?seed=7&m=1&q=2&dpr=1.5&sim=stub&slots=5');
    expect(p.seed).toBe(7);
    expect(p.measure).toBe(true);
    expect(p.q).toBe(2);
    expect(p.dpr).toBe(1.5);
    expect(p.sim).toBe('stub');
    expect(p.slots).toBe(5);
  });

  it('不正値は undefined に落とす(数値ガード)', () => {
    const p = parseUrlParams('?seed=abc&m=2&q=9&dpr=-1&sim=real&slots=0');
    expect(p.seed).toBeUndefined();
    expect(p.measure).toBe(false);
    expect(p.q).toBeUndefined();
    expect(p.dpr).toBeUndefined();
    expect(p.sim).toBeUndefined();
    expect(p.slots).toBeUndefined();
  });

  it('非整数の seed / q / slots は拒否する', () => {
    const p = parseUrlParams('?seed=1.5&q=1.2&slots=3.7');
    expect(p.seed).toBeUndefined();
    expect(p.q).toBeUndefined();
    expect(p.slots).toBeUndefined();
  });

  it('slots は 1..BUBBLE_CAPACITY に制限する', () => {
    expect(parseUrlParams(`?slots=${BUBBLE_CAPACITY}`).slots).toBe(
      BUBBLE_CAPACITY,
    );
    expect(
      parseUrlParams(`?slots=${BUBBLE_CAPACITY + 1}`).slots,
    ).toBeUndefined();
    expect(parseUrlParams('?slots=1').slots).toBe(1);
  });
});
