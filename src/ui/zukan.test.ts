import { describe, expect, it } from 'vitest';
import { BUSINESS, CROPS, SUPPLIES } from '../sim';
import { SYMPTOMS } from './symptoms';
import { fill, ZUKAN, type SourceNote } from './zukan';

/** 図鑑に出す数値の札をすべて集める */
function notes(): [string, SourceNote][] {
  const out: [string, SourceNote][] = [];
  for (const [id, c] of Object.entries(ZUKAN.crops)) for (const [k, n] of Object.entries(c)) out.push([`crops.${id}.${k}`, n]);
  for (const [id, n] of Object.entries(ZUKAN.symptoms)) out.push([`symptoms.${id}`, n]);
  for (const e of [...ZUKAN.supplies, ...ZUKAN.equipment, ...ZUKAN.events]) for (const v of e.values) out.push([`${e.id}.${v.label}`, v]);
  for (const v of ZUKAN.costs) out.push([`costs.${v.label}`, v]);
  return out;
}

describe('図鑑のデータ（zukan.json）', () => {
  it('作物・症状・資材・設備にもれなく出典の状態がある', () => {
    expect(Object.keys(ZUKAN.crops).sort()).toEqual(Object.keys(CROPS).sort());
    for (const c of Object.values(ZUKAN.crops)) expect(Object.keys(c).sort()).toEqual(['days', 'ec', 'ph', 'price', 'seed', 'water', 'yield']);
    expect(Object.keys(ZUKAN.symptoms).sort()).toEqual(Object.keys(SYMPTOMS).sort());
    expect(ZUKAN.supplies.map(s => s.id).sort()).toEqual(Object.keys(SUPPLIES).sort());
    expect(Object.keys(ZUKAN.equipmentBusiness).sort()).toEqual(Object.keys(BUSINESS.equipment).sort());
  });

  it('状態は4つのどれかで、出典の番号は一覧にある。確認済み・推定には出典がある', () => {
    for (const [where, n] of notes()) {
      expect(ZUKAN.status, where).toHaveProperty(n.s);
      for (const r of n.refs ?? []) expect(ZUKAN.refs, `${where} の [${r}]`).toHaveProperty(r);
      if (n.s === 'checked' || n.s === 'estimate') expect(n.refs?.length, `${where} に出典がない`).toBeGreaterThan(0);
    }
  });

  it('値の {名前} はすべてデータから埋まる', () => {
    for (const e of [...ZUKAN.supplies, ...ZUKAN.equipment, ...ZUKAN.events]) for (const v of e.values) {
      const t = fill(v.value, e.id);
      expect(t, `${e.id}.${v.label}`).not.toMatch(/\{|\}/);
      if (v.value.includes('{')) expect(t.length, `${e.id}.${v.label}`).toBeGreaterThan(0);
    }
    for (const v of ZUKAN.costs) expect(fill(v.value)).not.toMatch(/\{|\}|^$/);
    expect(fill('{price}', 'fertilizer')).toBe('0.1円/mL');
  });
});
