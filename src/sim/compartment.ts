// 区画（槽）と区画間の流れ。水耕は栽培槽1区画、v2 のアクアポニックスは魚槽→ろ過槽→栽培床の3区画を流れでつなぐ

/** 溶質の種類。v2 で 'tan' | 'no2' | 'no3' などを足す */
export type SoluteId = 'salts';

export interface Compartment {
  id: string;
  /** 容量 L */
  capacity: number;
  /** 液量 L */
  water: number;
  /** 溶質の量。salts は EC×L（EC = salts / water） */
  solutes: Record<SoluteId, number>;
  ph: number;
}

/** 区画間の流れ（ポンプ・落差）。rate は L/h */
export interface Flow {
  from: string;
  to: string;
  rate: number;
}

/** 養液の組成（初期値・全交換で使う） */
export interface Solution {
  water: number;
  ec: number;
  ph: number;
}

export const ecOf = (c: Compartment) => c.solutes.salts / c.water;

export function fill(c: Compartment, s: Solution): void {
  c.water = s.water;
  c.solutes = { salts: s.ec * s.water };
  c.ph = s.ph;
}

export function findCompartment(cs: readonly Compartment[], id: string): Compartment {
  const c = cs.find(c => c.id === id);
  if (!c) throw new Error(`区画 ${id} がありません`);
  return c;
}

/**
 * 1時間分の流れを順に適用する。送り先の空き容量と送り元の液量を超えては運ばない。
 * 溶質は送り元の濃度のまま運び、pH は液量の加重平均で混ぜる（簡略化。v2 で KH（緩衝能）を入れるときに見直す）
 */
export function applyFlows(cs: readonly Compartment[], flows: readonly Flow[]): void {
  for (const f of flows) {
    const a = findCompartment(cs, f.from), b = findCompartment(cs, f.to);
    const v = Math.min(f.rate, a.water, b.capacity - b.water);
    if (v <= 0) continue;
    const r = v / a.water;
    for (const k of Object.keys(a.solutes) as SoluteId[]) {
      const m = a.solutes[k] * r;
      a.solutes[k] -= m;
      b.solutes[k] = (b.solutes[k] ?? 0) + m;
    }
    b.ph = (b.ph * b.water + a.ph * v) / (b.water + v);
    a.water -= v;
    b.water += v;
  }
}
