import { expect, test } from 'vitest';
import { FACTORS, SUPPLIES } from '../sim';
import { SYMPTOMS } from './symptoms';

test('symptoms.json：全要因の低・高と根の酸欠があり、文言と資材がそろう', () => {
  expect(Object.keys(SYMPTOMS).sort()).toEqual([...FACTORS.flatMap(k => [`${k}.low`, `${k}.high`]), 'o2.low'].sort());
  for (const [k, s] of Object.entries(SYMPTOMS)) {
    for (const f of ['name', 'label', 'icon', 'look', 'natural', 'why', 'fix'] as const) expect(s[f], `${k}.${f}`).toBeTruthy();
    // 根の酸欠の対処はポンプを直すことで、資材は使わない
    if (k !== 'o2.low') expect(s.tools.length, k).toBeGreaterThan(0);
    for (const t of s.tools) expect(SUPPLIES[t], `${k} ${t}`).toBeDefined();
  }
});
