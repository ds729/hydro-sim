import { expect, test } from 'vitest';
import { CROPS, FACTORS } from './crop';
import { limiting, side, trapezoid } from './fitness';

test('crops.json：各要因の帯は4つの昇順の数', () => {
  for (const [id, c] of Object.entries(CROPS)) {
    for (const k of FACTORS) {
      const b = c.bands[k];
      expect(b, `${id}.${k}`).toHaveLength(4);
      expect([...b].sort((x, y) => x - y), `${id}.${k}`).toEqual([...b]);
    }
    expect(c.days).toBeGreaterThan(0);
    expect(c.uptake.activity).toHaveLength(2);
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
