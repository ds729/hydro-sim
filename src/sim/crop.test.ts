import { expect, test } from 'vitest';
import { CROPS, FACTORS, LEAF_SHAPES, LIGHT, diurnal, isLit } from './crop';
import { createSim, tick, bedOf } from './sim';
import { limiting, side, trapezoid } from './fitness';

test('crops.json：各要因の帯は4つの昇順の数、一言と見た目がある', () => {
  for (const [id, c] of Object.entries(CROPS)) {
    for (const k of FACTORS) {
      const b = c.bands[k];
      expect(b, `${id}.${k}`).toHaveLength(4);
      expect([...b].sort((x, y) => x - y), `${id}.${k}`).toEqual([...b]);
    }
    expect(c.days).toBeGreaterThan(0);
    expect(c.uptake.activity).toHaveLength(2);
    expect(c.note, id).toBeTruthy();
    for (const k of ['stem', 'leaf'] as const) expect(c.look[k], `${id}.look.${k}`).toMatch(/^#[0-9a-f]{6}$/);
    expect(LEAF_SHAPES, `${id}.look.leafShape`).toContain(c.look.leafShape);
    for (const k of ['height', 'leafSize', 'stemWidth'] as const) expect(c.look[k], `${id}.look.${k}`).toBeGreaterThan(0);
  }
});

test('台形の適合度', () => {
  const b = [0, 1, 2, 4] as const;
  expect([-1, 0, 0.5, 1, 1.5, 2, 3, 4, 5].map(x => trapezoid(x, b))).toEqual([0, 0, 0.5, 1, 1, 1, 0.5, 0, 0]);
  expect([side(1.4, b), side(1.5, b)]).toEqual(['low', 'high']);
});

test('律速因子は最小の要因、同点なら先の要因', () => {
  expect(limiting(['a', 'b', 'c'], { a: 0.8, b: 0.3, c: 0.3 })).toEqual({ key: 'b', value: 0.3 });
  expect(limiting(['a', 'b'], { a: 1, b: 1 })).toEqual({ key: 'a', value: 1 });
});

test('昼夜：照明は LIGHT.on〜off 時に点き、根の活動は明期に寄るが1日の平均は 1', () => {
  expect(isLit(LIGHT.on - 1)).toBe(false);
  expect(isLit(LIGHT.on)).toBe(true);
  expect(isLit(LIGHT.off - 1)).toBe(true);
  expect(isLit(LIGHT.off + 24 * 3)).toBe(false);
  const day = Array.from({ length: 24 }, (_, h) => diurnal(h));
  expect(day.reduce((a, b) => a + b) / 24).toBeCloseTo(1, 10);
  expect(diurnal(12)).toBeGreaterThan(1);
  expect(diurnal(2)).toBeLessThan(diurnal(12) * 0.5);
});

test('昼夜：液量は明期に減り、暗期はほとんど減らない', () => {
  const s = createSim({ crop: 'radish' });
  const at = (h: number) => { while (s.hour < h) tick(s); return bedOf(s).water; };
  // 2日目の暗期（0〜6時）と明期（12〜18時）の6時間で比べる
  const n0 = at(24), n1 = at(30), d0 = at(36), d1 = at(42);
  expect(d0 - d1).toBeGreaterThan((n0 - n1) * 4);
});
