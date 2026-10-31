import { expect, test } from 'vitest';
import { applyFlows, ecOf, type Compartment, type Flow } from './compartment';

const comp = (id: string, water: number, ec: number, ph: number, capacity = 10): Compartment =>
  ({ id, capacity, water, solutes: { salts: ec * water }, ph });

test('循環させると水と塩類の総量は保たれ、濃度がそろう', () => {
  const cs = [comp('fish', 6, 0.4, 7.2), comp('filter', 2, 1.0, 7.0), comp('bed', 3, 2.0, 6.5)];
  const flows: Flow[] = [{ from: 'fish', to: 'filter', rate: 1 }, { from: 'filter', to: 'bed', rate: 1 }, { from: 'bed', to: 'fish', rate: 1 }];
  const total = () => [cs.reduce((a, c) => a + c.water, 0), cs.reduce((a, c) => a + c.solutes.salts, 0)];
  const [w0, s0] = total();
  for (let i = 0; i < 500; i++) applyFlows(cs, flows);
  const [w1, s1] = total();
  expect(w1).toBeCloseTo(w0, 9);
  expect(s1).toBeCloseTo(s0, 9);
  for (const c of cs) expect(ecOf(c)).toBeCloseTo(s0 / w0, 6);
});

test('送り先の空き容量と送り元の液量を超えて運ばない', () => {
  const a = comp('a', 0.5, 1, 7), b = comp('b', 2.8, 1, 6, 3);
  applyFlows([a, b], [{ from: 'a', to: 'b', rate: 1 }]);
  expect(a.water).toBeCloseTo(0.3);
  expect(b.water).toBe(3);
  applyFlows([a, b], [{ from: 'b', to: 'a', rate: 5 }]);
  expect(a.water).toBeCloseTo(3.3);
  expect(b.water).toBe(0);
});
