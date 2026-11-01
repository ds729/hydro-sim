// シミュレーション本体。固定タイムステップ（1 tick ＝ 1時間）、状態はプレーンなデータ（複製・保存・比較できる）

import { execute, type Command } from './commands';
import { applyFlows, ecOf, fill, findCompartment, type Compartment, type Flow, type Solution } from './compartment';
import { CROPS, FACTORS, MEASURE, exchange, fitness, grow, type CropState, type Factor } from './crop';
import { limiting, side } from './fitness';

/** 設備の構成。水耕は栽培槽1区画で流れなし */
export interface Setup {
  compartments: { id: string; name: string; capacity: number; initial: Solution }[];
  flows: Flow[];
  /** 作物を植える区画 */
  bed: string;
}

export const HYDROPONIC: Setup = {
  compartments: [{ id: 'bed', name: '栽培槽', capacity: 3, initial: { water: 2, ec: 1.2, ph: 6 } }],
  flows: [],
  bed: 'bed',
};

export type SimEvent =
  | { hour: number; kind: 'start'; crop: string }
  | { hour: number; kind: 'command'; command: Command }
  /** 毎朝（24時間ごと）の定点記録 */
  | { hour: number; kind: 'morning'; ec: number; ph: number; water: number; growth: number }
  /** 観察メモ：要因が適正帯から外れ続けたときの原因と対処 */
  | { hour: number; kind: 'advice'; factor: Factor; side: 'low' | 'high'; value: number };

export type Grade = 'S' | 'A' | 'B' | 'C';

export interface Result {
  outcome: 'harvest' | 'dead' | 'late';
  /** 品質：律速因子の適合度の時間平均 */
  quality: number;
  grade: Grade;
  yieldG: number;
  sales: number;
  cost: number;
  profit: number;
}

export interface SimState {
  setup: Setup;
  /** 経過時間（tick 数） */
  hour: number;
  /** 乱数の状態（rng.ts の nextRandom で進める） */
  rng: number;
  compartments: Compartment[];
  flows: Flow[];
  crop: CropState;
  /** 資材費の累計 円 */
  cost: number;
  /** 2時間ごとの記録（グラフ用） */
  history: { ec: number; ph: number }[];
  log: SimEvent[];
  /** 観察メモの判定：適合度 0.7 未満が続いた時間と、最後にメモを出した時刻 */
  watch: Record<Factor, { low: number; last: number | null }>;
  result: Result | null;
}

/** 適合度 0.7 未満がこの時間続いたら観察メモを出す。同じ要因は 24 時間あける */
const WATCH_LOW = 0.7, WATCH_HOURS = 3, WATCH_INTERVAL = 24;

const GRADES: [number, Grade, number][] = [[0.95, 'S', 1.2], [0.85, 'A', 1], [0.7, 'B', 0.7], [-Infinity, 'C', 0.4]];

export function createSim(opts: { crop?: string; seed?: number; setup?: Setup } = {}): SimState {
  const setup = opts.setup ?? HYDROPONIC;
  const compartments = setup.compartments.map(d => {
    const c: Compartment = { id: d.id, capacity: d.capacity, water: 0, solutes: { salts: 0 }, ph: 7 };
    fill(c, d.initial);
    return c;
  });
  const id = opts.crop ?? 'radish';
  if (!CROPS[id]) throw new Error(`作物 ${id} がありません`);
  return {
    setup, hour: 0, rng: (opts.seed ?? 1) >>> 0, compartments, flows: setup.flows.map(f => ({ ...f })),
    crop: { id, compartment: setup.bed, growth: 0, health: 100, qualitySum: 0 },
    cost: 0, history: [], log: [{ hour: 0, kind: 'start', crop: id }],
    watch: { ec: { low: 0, last: null }, ph: { low: 0, last: null }, water: { low: 0, last: null } },
    result: null,
  };
}

export const bedOf = (s: SimState) => findCompartment(s.compartments, s.crop.compartment);
export const cropSpec = (s: SimState) => CROPS[s.crop.id];
/** 1 始まりの日数（Day 1 ＝ 0〜23時） */
export const dayOf = (s: SimState) => Math.floor(s.hour / 24) + 1;

/** 1時間進める。終わっていたら何もしない */
export function tick(s: SimState): void {
  if (s.result) return;
  const spec = cropSpec(s), bed = bedOf(s);
  applyFlows(s.compartments, s.flows);
  exchange(s.crop, spec, bed);
  const f = fitness(spec, bed);
  grow(s.crop, spec, limiting(FACTORS, f).value);
  s.hour++;
  if (s.hour % 24 === 0) {
    s.log.push({ hour: s.hour, kind: 'morning', ec: ecOf(bed), ph: bed.ph, water: bed.water, growth: s.crop.growth });
  }
  for (const k of FACTORS) {
    const w = s.watch[k];
    w.low = f[k] < WATCH_LOW ? w.low + 1 : 0;
    if (w.low >= WATCH_HOURS && s.hour - (w.last ?? -99) >= WATCH_INTERVAL) {
      w.last = s.hour;
      const v = MEASURE[k](bed);
      s.log.push({ hour: s.hour, kind: 'advice', factor: k, side: side(v, spec.bands[k]), value: v });
    }
  }
  if (s.hour % 2 === 0) s.history.push({ ec: ecOf(bed), ph: bed.ph });
  if (s.crop.health <= 0) finish(s, 'dead');
  else if (s.crop.growth >= 1) finish(s, 'harvest');
  else if (s.hour > spec.days * 48) finish(s, 'late');
}

/** コマンドを実行する。終わった後は受け付けず false を返す */
export function applyCommand(s: SimState, cmd: Command): boolean {
  if (s.result) return false;
  const d = s.setup.compartments.find(c => c.id === cmd.target);
  if (!d) throw new Error(`区画 ${cmd.target} がありません`);
  s.cost += execute(s.compartments, cmd, d.initial);
  s.log.push({ hour: s.hour, kind: 'command', command: cmd });
  return true;
}

function finish(s: SimState, outcome: Result['outcome']): void {
  const spec = cropSpec(s), q = s.crop.qualitySum / s.hour;
  const [, grade, mult] = GRADES.find(([min]) => q >= min)!;
  const yieldG = outcome === 'harvest' ? spec.yieldG * Math.sqrt(Math.max(0, s.crop.health) / 100) * q : 0;
  const sales = (yieldG / 100) * spec.pricePer100g * mult;
  s.result = { outcome, quality: q, grade, yieldG, sales, cost: s.cost, profit: sales - s.cost };
}

export interface Diagnosis {
  values: Record<Factor, number>;
  fitness: Record<Factor, number>;
  /** 律速因子（最も悪い要因）とその向き。見た目の症状はこれで決まる */
  worst: { key: Factor; value: number; side: 'low' | 'high' };
}

export function diagnose(s: SimState): Diagnosis {
  const spec = cropSpec(s), bed = bedOf(s), f = fitness(spec, bed);
  const values = { ec: MEASURE.ec(bed), ph: MEASURE.ph(bed), water: MEASURE.water(bed) };
  const w = limiting(FACTORS, f);
  return { values, fitness: f, worst: { ...w, side: side(values[w.key], spec.bands[w.key]) } };
}
