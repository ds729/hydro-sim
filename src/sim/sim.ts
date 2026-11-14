// シミュレーション本体。固定タイムステップ（1 tick ＝ 1時間）、状態はプレーンなデータ（複製・保存・比較できる）

import { execute, SUPPLIES, type Command, type DoseSupply } from './commands';
import { applyFlows, ecOf, fill, findCompartment, type Compartment, type Flow, type Solution } from './compartment';
import { CROPS, FACTORS, MEASURE, diurnal, exchange, isLit, fitness, grow, harvestOf, type CropState, type Factor, type Grade } from './crop';
import { limiting, side } from './fitness';
import { aerate, createFacility, endHour, fixPump, o2Fitness, powered, pumpRunning, rollEvents, watchHypoxia, type FacilityEvent, type FacilityState } from './facility';

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
  /**
   * 観察メモ：要因が適正帯から外れ続けた。fit はその要因の適合度（律速なら成長の速さ）。
   * driver は外れた向きに動かした操作（最後に適正だった時刻より後。null なら作物の吸収など自然な変化）、driverHour はその時刻
   */
  | {
    hour: number; kind: 'advice'; factor: Factor; side: 'low' | 'high'; value: number;
    fit: number; driver: DoseSupply | null; driverHour: number | null;
  }
  /** 設備：停電・電気の復旧・ポンプの停止・根の酸欠の観察メモ（facility.ts） */
  | ({ hour: number } & FacilityEvent);

export interface Result {
  outcome: 'harvest' | 'dead' | 'late';
  /** 品質：律速因子の適合度の時間平均 */
  quality: number;
  grade: Grade;
  yieldG: number;
  sales: number;
  cost: number;
  profit: number;
  /** 品質を下げた原因：`${要因}.${low|high}` ごとの品質の低下分（合計 ＝ 1 − 品質）。大きい順 */
  losses: { key: string; value: number }[];
}

export interface SimState {
  setup: Setup;
  /** 経過時間（tick 数） */
  hour: number;
  /** 乱数の状態（rng.ts の nextRandom で進める） */
  rng: number;
  compartments: Compartment[];
  flows: Flow[];
  /** 電気・ポンプ（停電・ポンプの停止。区画ごとにポンプが1台） */
  facility: FacilityState;
  crop: CropState;
  /** 資材費の累計 円 */
  cost: number;
  /** 2時間ごとの記録（グラフ用） */
  history: { ec: number; ph: number; water: number }[];
  log: SimEvent[];
  /** 観察メモの判定：適合度 0.7 未満が続いた時間、最後にメモを出した時刻、最後に適正（適合度 0.9 以上）だった時刻 */
  watch: Record<Factor, { low: number; last: number | null; okAt: number }>;
  /** 律速因子ごとの (1 − 適合度) の累計。キーは `${要因}.${low|high}`（品質を下げた原因の内訳） */
  loss: Record<string, number>;
  result: Result | null;
}

/** 適合度 0.7 未満がこの時間続いたら観察メモを出す。同じ要因は 24 時間あける */
const WATCH_LOW = 0.7, WATCH_HOURS = 3, WATCH_INTERVAL = 24;
/** この適合度以上なら「適正」とみなす（観察メモの原因は、最後に適正だった時刻より後の操作から探す） */
const WATCH_OK = 0.9;

/** events：停電・ポンプの停止を起こす（既定は起こさない） */
export function createSim(opts: { crop?: string; seed?: number; setup?: Setup; events?: boolean } = {}): SimState {
  const setup = opts.setup ?? HYDROPONIC;
  const compartments = setup.compartments.map(d => {
    const c: Compartment = { id: d.id, capacity: d.capacity, water: 0, solutes: { salts: 0 }, ph: 7, o2: 1 };
    fill(c, d.initial);
    return c;
  });
  const id = opts.crop ?? 'radish';
  if (!CROPS[id]) throw new Error(`作物 ${id} がありません`);
  return {
    setup, hour: 0, rng: (opts.seed ?? 1) >>> 0, compartments, flows: setup.flows.map(f => ({ ...f })),
    facility: createFacility(opts.events ?? false),
    crop: { id, compartment: setup.bed, growth: 0, health: 100, qualitySum: 0 },
    cost: 0, history: [], log: [{ hour: 0, kind: 'start', crop: id }],
    watch: { ec: { low: 0, last: null, okAt: 0 }, ph: { low: 0, last: null, okAt: 0 }, water: { low: 0, last: null, okAt: 0 } },
    loss: {},
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
  const spec = cropSpec(s), bed = bedOf(s), fx = s.facility;
  for (const e of rollEvents(fx, s, s.compartments.map(c => c.id))) s.log.push({ hour: s.hour, ...e });
  const power = powered(fx);
  for (const c of s.compartments) aerate(c, pumpRunning(fx, c.id));
  applyFlows(s.compartments, s.flows);
  exchange(s.crop, spec, bed, diurnal(s.hour, power));
  // 律速：EC・pH・液量のうち最も悪いものと、溶存酸素
  const f = fitness(spec, bed), lim = limiting(FACTORS, f), o2 = o2Fitness(bed), m = Math.min(lim.value, o2);
  // 停電で照明が消えた明期は育たない（夜の停電は照明には響かない）
  grow(s.crop, spec, m, !power && isLit(s.hour) ? 0 : 1);
  if (m < 1) {
    const k = o2 < lim.value ? 'o2.low' : `${lim.key}.${side(MEASURE[lim.key](bed), spec.bands[lim.key])}`;
    s.loss[k] = (s.loss[k] ?? 0) + 1 - m;
  }
  s.hour++;
  if (s.hour % 24 === 0) {
    s.log.push({ hour: s.hour, kind: 'morning', ec: ecOf(bed), ph: bed.ph, water: bed.water, growth: s.crop.growth });
  }
  for (const k of FACTORS) {
    const w = s.watch[k];
    w.low = f[k] < WATCH_LOW ? w.low + 1 : 0;
    if (f[k] >= WATCH_OK) w.okAt = s.hour;
    if (w.low >= WATCH_HOURS && s.hour - (w.last ?? -99) >= WATCH_INTERVAL) {
      w.last = s.hour;
      const v = MEASURE[k](bed), sd = side(v, spec.bands[k]), d = driverOf(s, k, sd);
      s.log.push({ hour: s.hour, kind: 'advice', factor: k, side: sd, value: v, fit: f[k], driver: d?.supply ?? null, driverHour: d?.hour ?? null });
    }
  }
  const hx = watchHypoxia(fx, bed, s.hour, pumpRunning(fx, bed.id));
  if (hx) s.log.push({ hour: s.hour, ...hx });
  for (const e of endHour(fx)) s.log.push({ hour: s.hour, ...e });
  if (s.hour % 2 === 0) s.history.push({ ec: ecOf(bed), ph: bed.ph, water: bed.water });
  if (s.crop.health <= 0) finish(s, 'dead');
  else if (s.crop.growth >= 1) finish(s, 'harvest');
  else if (s.hour > spec.days * 48) finish(s, 'late');
}

/** コマンドを実行する。終わった後は受け付けず false を返す */
export function applyCommand(s: SimState, cmd: Command): boolean {
  if (s.result) return false;
  const d = s.setup.compartments.find(c => c.id === cmd.target);
  if (!d) throw new Error(`区画 ${cmd.target} がありません`);
  if (cmd.type === 'fixPump') {
    if (!fixPump(s.facility, cmd.target)) return false;
  } else s.cost += execute(s.compartments, cmd, d.initial);
  s.log.push({ hour: s.hour, kind: 'command', command: cmd });
  return true;
}

function finish(s: SimState, outcome: Result['outcome']): void {
  const spec = cropSpec(s), h = harvestOf(s.crop, spec, s.hour), q = h.quality, grade = h.grade;
  const yieldG = outcome === 'harvest' ? h.yieldG : 0;
  const sales = (yieldG / 100) * spec.pricePer100g * h.mult;
  const losses = Object.entries(s.loss).map(([key, v]) => ({ key, value: v / s.hour })).sort((a, b) => b.value - a.value);
  s.result = { outcome, quality: q, grade, yieldG, sales, cost: s.cost, profit: sales - s.cost, losses };
}

/** 資材が要因を動かす向き（+1 上げる、−1 下げる、0 動かさない）。EC は塩類で上がり、水で薄まる */
function pushOf(supply: DoseSupply, k: Factor): number {
  const e = SUPPLIES[supply].perUnit;
  if (k === 'ec') return Math.sign(e.salts ?? 0) || -Math.sign(e.water ?? 0);
  return Math.sign((k === 'ph' ? e.ph : e.water) ?? 0);
}

/**
 * 要因を外れた向きに動かした直近の操作（なければ null ＝ 作物の吸収など自然な変化）。
 * さかのぼるのは、その要因が最後に適正だった時刻（その時刻の操作は含む）か、最後の全交換まで
 */
function driverOf(s: SimState, k: Factor, sd: 'low' | 'high'): { supply: DoseSupply; hour: number } | null {
  const want = sd === 'high' ? 1 : -1, from = s.watch[k].okAt;
  for (let i = s.log.length - 1; i >= 0; i--) {
    const e = s.log[i];
    if (e.hour < from || (e.kind === 'command' && e.command.type === 'replaceSolution')) break;
    if (e.kind === 'command' && e.command.type === 'dose' && pushOf(e.command.supply, k) === want) return { supply: e.command.supply, hour: e.hour };
  }
  return null;
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
