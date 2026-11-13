// 経営モード（Phase 4）：棚（栽培槽を共有するトレイの列）・播種・収穫・在庫・販売・月次損益・設備。
// 栽培の物理（区画・作物の吸収と成長）は栽培モードと同じ関数を使う。数値は business.json に寄せる（相場・見積もりで置き換えられるように）

import businessJson from '../data/business.json';
import { execute, type Command } from './commands';
import { fill, findCompartment, type Compartment, type Solution } from './compartment';
import { CROPS, FACTORS, MEASURE, exchange, fitness, gradeOf, grow, harvestOf, type CropState, type Factor, type Grade } from './crop';
import { limiting } from './fitness';

// ---- データ（business.json） ----

export interface CropBusiness {
  /** 1トレイあたりの播種量 g */
  seedG: number;
  /** 種子の単価 円/g */
  seedYenPerG: number;
  /** 最適条件・健康度 100 での1トレイの収量 g（crops.json の yieldG は栽培モードの比。経営ではこちらを使う） */
  trayYieldG: number;
  /** 小売（直売）の単価 円/100g（等級 A）。販路の倍率を掛けて使う */
  retailPer100g: number;
  /** 業務用冷蔵庫がないときの日持ち（日）。業務用冷蔵庫（4℃前後）で fridgeShelfMult 倍 */
  shelfDays: number;
  /** 収穫の適期（生育度 1 になってから品質が落ち始めるまでの日数） */
  windowDays: number;
}

export interface Channel {
  name: string;
  /** 小売単価に対する倍率 */
  priceMult: number;
  /** 包装費 円/100g */
  packYenPer100g: number;
}

export interface Contract {
  id: string;
  name: string;
  crop: string;
  /** 1回の納品量 g */
  grams: number;
  /** 納品する曜日（0〜6。Day 1 が 0） */
  weekday: number;
  /** 最初の納品を受ける日（これより前の納品日は数えない。育てる時間の猶予） */
  startDay: number;
  /** 欠品がこの回数に達したら契約が切れる */
  maxMisses: number;
  /** 契約で決めた単価 円/100g（省略時は小売単価×飲食店の倍率）。同じ作物でも「何として売るか」で値段が変わる */
  pricePer100g?: number;
  /** 契約の説明（画面用） */
  note?: string;
}

export interface Equipment {
  name: string;
  price: number;
  /** 減価償却の月数（定額） */
  lifeMonths: number;
  /** 説明（何が楽になるか） */
  note: string;
}

export type EquipmentId = 'rack' | 'autoWater' | 'autoPh' | 'probe' | 'fridge' | 'led';

export interface Business {
  startCash: number;
  /** 1か月の日数（月次損益の締め） */
  monthDays: number;
  /** 家賃 円/月（日割りで計上） */
  rentPerMonth: number;
  /** 棚1台の電気代 円/日（LED・ポンプ） */
  powerYenPerRackDay: number;
  /** 省エネ LED にしたときの電気代の倍率 */
  ledPowerMult: number;
  /** 培地 円/トレイ */
  mediumYenPerTray: number;
  /** 棚1台のトレイ数・最大の棚数 */
  slotsPerRack: number;
  maxRacks: number;
  /** 棚1台の養液（トレイ1枚分の組成。棚全体ではトレイ数倍） */
  solution: Solution;
  /** 業務用冷蔵庫（4℃前後）にしたときの日持ちの倍率 */
  fridgeShelfMult: number;
  /** 適期を過ぎてからの1日あたりの価値の低下、この日数を過ぎたら売れない（廃棄） */
  overgrowLossPerDay: number;
  overgrowDiscardDays: number;
  /** ペン型の計器で毎朝測る時刻（時）。連続測定センサがあれば毎時読める */
  measureHour: number;
  /** 作業時間 分（1トレイの播種、1トレイの収穫・包装、1回の測定）。損益には入れず、時給の目安に使う */
  laborMin: { sow: number; harvest: number; measure: number };
  /** 直売の1日の需要 g（作物によらず合計。古い在庫から売れる） */
  directDemandGPerDay: number;
  channels: Record<'wholesale' | 'restaurant' | 'direct', Channel>;
  contracts: Contract[];
  equipment: Record<EquipmentId, Equipment>;
  crops: Record<string, CropBusiness>;
}

export const BUSINESS = businessJson as unknown as Business;

// ---- 状態 ----

export interface Tray {
  crop: CropState;
  sownAt: number;
  /** 生育度 1 になった時刻（まだなら null） */
  ripeAt: number | null;
}

export interface Rack {
  /** 区画の id（栽培槽） */
  id: string;
  slots: (Tray | null)[];
}

/** 在庫（収穫した1トレイ分） */
export interface Lot {
  crop: string;
  grams: number;
  grade: Grade;
  /** 等級と収穫の遅れによる単価の倍率 */
  mult: number;
  harvestedAt: number;
  expiresAt: number;
}

/** 損益の科目。売上は販路別、費用は内容別 */
export type RevenueKey = 'wholesale' | 'restaurant' | 'direct';
export type CostKey = 'seed' | 'medium' | 'nutrient' | 'pack' | 'power' | 'rent' | 'depreciation';

export interface Ledger {
  /** 何か月目か（1 始まり） */
  month: number;
  revenue: Record<RevenueKey, number>;
  cost: Record<CostKey, number>;
  /** 設備の購入（現金は出るが費用は減価償却で月割り） */
  capex: number;
  /** 廃棄した量 g と、売っていれば得られた金額（卸値） */
  wasteG: number;
  wasteYen: number;
  harvestG: number;
  soldG: number;
  /** 作業時間 分 */
  laborMin: number;
}

export type FarmCommand =
  | Command
  | { type: 'sow'; rack: string; slot: number; crop: string }
  | { type: 'harvest'; rack: string; slot: number }
  /** 枯れた・育ちすぎたトレイを片付ける */
  | { type: 'clear'; rack: string; slot: number }
  /** ペン型の計器で今の値を測る */
  | { type: 'measure' }
  /** 在庫を卸に出す（crop を指定するとその作物だけ）。明日・あさっての納品の取り置きは残す */
  | { type: 'wholesale'; crop?: string }
  | { type: 'buy'; item: EquipmentId };

export type FarmEvent =
  | { hour: number; kind: 'command'; command: FarmCommand; auto?: boolean }
  | { hour: number; kind: 'harvest'; rack: string; slot: number; crop: string; grams: number; grade: Grade }
  | { hour: number; kind: 'dead'; rack: string; slot: number; crop: string; reason: 'health' | 'overgrown' }
  | { hour: number; kind: 'delivery'; contract: string; grams: number; short: number; yen: number }
  | { hour: number; kind: 'contractLost'; contract: string }
  | { hour: number; kind: 'direct'; grams: number; yen: number }
  | { hour: number; kind: 'expired'; crop: string; grams: number }
  | { hour: number; kind: 'month'; ledger: Ledger };

export interface FarmState {
  hour: number;
  rng: number;
  cash: number;
  compartments: Compartment[];
  racks: Rack[];
  stock: Lot[];
  equipment: Record<EquipmentId, number>;
  /** 買った設備と買った月（減価償却に使う） */
  assets: { item: EquipmentId; month: number }[];
  /** 契約ごとの欠品回数（契約が切れたら lost） */
  contracts: Record<string, { misses: number; lost: boolean }>;
  /** 今月の損益（締めると months に移る） */
  ledger: Ledger;
  months: Ledger[];
  /** 計器の読み（棚ごと）と測った時刻。連続測定センサがなければ朝と測ったときだけ更新する */
  readings: Record<string, Record<Factor, number>>;
  readAt: number;
  log: FarmEvent[];
}

const RACK_PREFIX = 'rack';
/** 取り置きの日数（何日先の納品まで直売に回さないか） */
const RESERVE_DAYS = 2;

function newLedger(month: number): Ledger {
  return {
    month,
    revenue: { wholesale: 0, restaurant: 0, direct: 0 },
    cost: { seed: 0, medium: 0, nutrient: 0, pack: 0, power: 0, rent: 0, depreciation: 0 },
    capex: 0, wasteG: 0, wasteYen: 0, harvestG: 0, soldG: 0, laborMin: 0,
  };
}

/** 棚全体の養液（トレイ数倍） */
function rackSolution(b: Business): Solution {
  return { ...b.solution, water: b.solution.water * b.slotsPerRack };
}

function addRack(f: FarmState, b: Business): void {
  const id = `${RACK_PREFIX}${f.racks.length + 1}`, sol = rackSolution(b);
  const c: Compartment = { id, capacity: 3 * b.slotsPerRack, water: 0, solutes: { salts: 0 }, ph: 7 };
  fill(c, sol);
  f.compartments.push(c);
  f.racks.push({ id, slots: Array(b.slotsPerRack).fill(null) });
  f.readings[id] = { ec: 0, ph: 0, water: 0 };
}

export function createFarm(opts: { seed?: number; business?: Business } = {}): FarmState {
  const b = opts.business ?? BUSINESS;
  const f: FarmState = {
    hour: 0, rng: (opts.seed ?? 1) >>> 0, cash: b.startCash, compartments: [], racks: [], stock: [],
    equipment: { rack: 0, autoWater: 0, autoPh: 0, probe: 0, fridge: 0, led: 0 }, assets: [],
    contracts: Object.fromEntries(b.contracts.map(c => [c.id, { misses: 0, lost: false }])),
    ledger: newLedger(1), months: [], readings: {}, readAt: 0, log: [],
  };
  addRack(f, b);
  read(f, b);
  return f;
}

export const rackOf = (f: FarmState, id: string) => {
  const r = f.racks.find(r => r.id === id);
  if (!r) throw new Error(`棚 ${id} がありません`);
  return r;
};
export const farmDay = (f: FarmState) => Math.floor(f.hour / 24) + 1;

/**
 * 棚の栽培槽をトレイ1枚分に割った見かけの区画（液量・塩類を 1/トレイ数）。
 * 作物の帯（液量 L）は栽培モードのトレイ1枚分なので、この見かけの区画で適合度と吸収を計算する
 */
function share(c: Compartment, n: number): Compartment {
  return { id: c.id, capacity: c.capacity / n, water: c.water / n, solutes: { salts: c.solutes.salts / n }, ph: c.ph };
}

/** 棚の1トレイ分の見かけの値（EC・pH・液量） */
export function rackValues(f: FarmState, rackId: string, b: Business = BUSINESS): Record<Factor, number> {
  const c = share(findCompartment(f.compartments, rackId), b.slotsPerRack);
  return { ec: MEASURE.ec(c), ph: MEASURE.ph(c), water: MEASURE.water(c) };
}

/** トレイの適合度と律速因子 */
export function trayFitness(f: FarmState, rackId: string, t: Tray, b: Business = BUSINESS) {
  const c = share(findCompartment(f.compartments, rackId), b.slotsPerRack), fit = fitness(CROPS[t.crop.id], c);
  return { fitness: fit, worst: limiting(FACTORS, fit) };
}

/** 計器の読みを今の値にする */
function read(f: FarmState, b: Business): void {
  for (const r of f.racks) f.readings[r.id] = rackValues(f, r.id, b);
  f.readAt = f.hour;
}

/** 収穫の遅れによる価値の倍率（適期内は 1） */
export function freshness(t: Tray, hour: number, b: Business = BUSINESS): number {
  if (t.ripeAt === null) return 1;
  const over = (hour - t.ripeAt) / 24 - b.crops[t.crop.id].windowDays;
  return over <= 0 ? 1 : Math.max(0, 1 - b.overgrowLossPerDay * over);
}

const unitPrice = (b: Business, crop: string, ch: keyof Business['channels'], contract?: Contract) =>
  contract?.pricePer100g ?? b.crops[crop].retailPer100g * b.channels[ch].priceMult;

// ---- 進行 ----

/** 1時間進める */
export function farmTick(f: FarmState, b: Business = BUSINESS): void {
  for (const r of f.racks) {
    const bed = findCompartment(f.compartments, r.id), n = b.slotsPerRack;
    let dWater = 0, dSalts = 0, dPh = 0;
    for (let i = 0; i < r.slots.length; i++) {
      const t = r.slots[i];
      if (!t || t.crop.health <= 0) continue;
      const spec = CROPS[t.crop.id], c = share(bed, n), before = { w: c.water, s: c.solutes.salts, ph: c.ph };
      const lim = limiting(FACTORS, fitness(spec, c));
      exchange(t.crop, spec, c);
      dWater += c.water - before.w;
      dSalts += c.solutes.salts - before.s;
      dPh += (c.ph - before.ph) / n;
      if (t.ripeAt === null) {
        grow(t.crop, spec, lim.value);
        if (t.crop.growth >= 1) t.ripeAt = f.hour + 1;
      } else {
        // 育ち終えた後も健康度は変わる（品質の累計は止める）
        const q = t.crop.qualitySum;
        grow(t.crop, spec, lim.value);
        t.crop.qualitySum = q;
      }
      if (t.crop.health <= 0) kill(f, r, i, 'health');
      else if (t.ripeAt !== null && (f.hour + 1 - t.ripeAt) / 24 > b.crops[t.crop.id].windowDays + b.overgrowDiscardDays) kill(f, r, i, 'overgrown');
    }
    bed.water = Math.max(0.05 * n, bed.water + dWater);
    bed.solutes.salts = Math.max(0, bed.solutes.salts + dSalts);
    bed.ph += dPh;
  }
  f.hour++;
  automate(f, b);
  if (f.equipment.probe || f.hour % 24 === b.measureHour) read(f, b);
  if (f.hour % 24 === 0) daily(f, b);
}

/** 枯れたトレイは片付けるまで場所をふさぐ（作物の状態は残し、health ≤ 0 で枯死を表す） */
function kill(f: FarmState, r: Rack, slot: number, reason: 'health' | 'overgrown') {
  const t = r.slots[slot]!;
  t.crop.health = 0;
  f.log.push({ hour: f.hour + 1, kind: 'dead', rack: r.id, slot, crop: t.crop.id, reason });
}

/** 設備による自動の操作（自動給水・pH 自動調整）。操作はコマンドとして実行し、記録に auto を付ける */
function automate(f: FarmState, b: Business): void {
  for (const r of f.racks) {
    if (!r.slots.some(t => t && t.crop.health > 0)) continue;
    const v = rackValues(f, r.id, b), crops = r.slots.filter((t): t is Tray => !!t).map(t => CROPS[t.crop.id]);
    // 目標は植わっている作物の適正帯の重なりの中央（重ならなければ平均）
    const mid = (k: Factor) => {
      const lo = Math.max(...crops.map(c => c.bands[k][1])), hi = Math.min(...crops.map(c => c.bands[k][2]));
      return lo <= hi ? [lo, hi] : [(lo + hi) / 2, (lo + hi) / 2];
    };
    if (f.equipment.autoWater) {
      const [lo, hi] = mid('water');
      if (v.water < lo + (hi - lo) * 0.3) run(f, b, { type: 'dose', target: r.id, supply: 'water', amount: 0.2 }, true);
    }
    if (f.equipment.autoPh) {
      const [lo, hi] = mid('ph');
      if (v.ph > hi - (hi - lo) * 0.2) run(f, b, { type: 'dose', target: r.id, supply: 'phDown', amount: 1 }, true);
      else if (v.ph < lo + (hi - lo) * 0.2) run(f, b, { type: 'dose', target: r.id, supply: 'phUp', amount: 1 }, true);
    }
  }
}

/** 1日の締め：家賃・電気代、在庫の期限切れ、契約の納品、直売、月の締め */
function daily(f: FarmState, b: Business): void {
  const L = f.ledger, rent = b.rentPerMonth / b.monthDays;
  const power = f.racks.length * b.powerYenPerRackDay * (f.equipment.led ? b.ledPowerMult : 1);
  spend(f, 'rent', rent);
  spend(f, 'power', power);
  // 期限切れ
  f.stock = f.stock.filter(l => {
    if (l.expiresAt > f.hour) return true;
    L.wasteG += l.grams;
    L.wasteYen += (l.grams / 100) * unitPrice(b, l.crop, 'wholesale') * l.mult;
    f.log.push({ hour: f.hour, kind: 'expired', crop: l.crop, grams: l.grams });
    return false;
  });
  // 今日（これから始まる日）の納品。Day 1 の曜日が 0
  const weekday = (farmDay(f) - 1) % 7;
  for (const c of b.contracts) {
    const st = f.contracts[c.id];
    if (st.lost || c.weekday !== weekday || farmDay(f) < c.startDay) continue;
    const { grams, yen } = take(f, b, c.crop, c.grams, 'restaurant', {}, c);
    const short = c.grams - grams;
    f.log.push({ hour: f.hour, kind: 'delivery', contract: c.id, grams, short, yen });
    // 1 割までの不足は許してもらえる
    if (short > c.grams * 0.1 && ++st.misses >= c.maxMisses) {
      st.lost = true;
      f.log.push({ hour: f.hour, kind: 'contractLost', contract: c.id });
    }
  }
  // 直売：1日の需要まで、作物によらず古い在庫から売れる。契約の納品分（取り置き）には手を付けない
  const d = take(f, b, null, b.directDemandGPerDay, 'direct', reserved(f, b));
  if (d.grams > 0) f.log.push({ hour: f.hour, kind: 'direct', grams: d.grams, yen: d.yen });
  if (f.hour % (24 * b.monthDays) === 0) closeMonth(f, b);
}

/** 取り置き：明日・あさっての納品に要る量（作物ごと、続いている契約だけ）。それより先の分まで取っておくと日持ちが切れる */
export function reserved(f: FarmState, b: Business = BUSINESS): Record<string, number> {
  const out: Record<string, number> = {}, today = farmDay(f);
  for (const c of b.contracts) {
    if (f.contracts[c.id].lost) continue;
    // 次の納品日（今日の納品はもう済んでいる）
    let D = Math.max(today + 1, c.startDay);
    while ((D - 1) % 7 !== c.weekday) D++;
    if (D - today <= RESERVE_DAYS) out[c.crop] = (out[c.crop] ?? 0) + c.grams;
  }
  return out;
}

/**
 * 在庫から作物を古い順に grams まで出して売る（crop が null なら作物を問わない）。
 * keep の分（作物ごとの取り置き）は新しい在庫から残す。売れた量と売上を返す
 */
function take(f: FarmState, b: Business, crop: string | null, grams: number, ch: RevenueKey, keep: Record<string, number> = {}, contract?: Contract): { grams: number; yen: number } {
  let need = grams, sold = 0, yen = 0;
  const avail: Record<string, number> = {};
  for (const l of f.stock) avail[l.crop] = (avail[l.crop] ?? 0) + l.grams;
  for (const k in avail) avail[k] = Math.max(0, avail[k] - (keep[k] ?? 0));
  for (const l of f.stock) {
    if (need <= 0) break;
    if ((crop !== null && l.crop !== crop) || l.grams <= 0 || avail[l.crop] <= 0) continue;
    const g = Math.min(need, l.grams, avail[l.crop]);
    avail[l.crop] -= g;
    l.grams -= g;
    need -= g;
    sold += g;
    yen += sell(f, b, l, g, ch, contract);
  }
  f.stock = f.stock.filter(l => l.grams > 1e-6);
  return { grams: sold, yen };
}

function sell(f: FarmState, b: Business, l: Lot, g: number, ch: RevenueKey, contract?: Contract): number {
  const yen = (g / 100) * unitPrice(b, l.crop, ch, contract) * l.mult;
  f.ledger.revenue[ch] += yen;
  f.ledger.soldG += g;
  f.cash += yen;
  spend(f, 'pack', (g / 100) * b.channels[ch].packYenPer100g);
  return yen;
}

function spend(f: FarmState, k: CostKey, yen: number) {
  f.ledger.cost[k] += yen;
  if (k !== 'depreciation') f.cash -= yen;
}

/** 月の締め：減価償却を計上して損益を確定し、次の月を始める */
function closeMonth(f: FarmState, b: Business): void {
  // 買った月から lifeMonths か月、定額で月割り（買った月も丸1か月分。簡略化）
  for (const a of f.assets) {
    const e = b.equipment[a.item];
    if (f.ledger.month - a.month < e.lifeMonths) spend(f, 'depreciation', e.price / e.lifeMonths);
  }
  f.log.push({ hour: f.hour, kind: 'month', ledger: f.ledger });
  f.months.push(f.ledger);
  f.ledger = newLedger(f.ledger.month + 1);
}

// ---- 操作 ----

/** 損益の合計 */
export function totals(l: Ledger): { revenue: number; cost: number; profit: number } {
  const revenue = Object.values(l.revenue).reduce((a, x) => a + x, 0), cost = Object.values(l.cost).reduce((a, x) => a + x, 0);
  return { revenue, cost, profit: revenue - cost };
}

/** 設備を買えるか（お金・上限） */
export function canBuy(f: FarmState, item: EquipmentId, b: Business = BUSINESS): boolean {
  const max = item === 'rack' ? b.maxRacks - 1 : 1;
  return f.equipment[item] < max && f.cash >= b.equipment[item].price;
}

/** コマンドを実行する。できなければ false（記録しない） */
export function applyFarmCommand(f: FarmState, cmd: FarmCommand, b: Business = BUSINESS): boolean {
  return run(f, b, cmd, false);
}

function run(f: FarmState, b: Business, cmd: FarmCommand, auto: boolean): boolean {
  if (!perform(f, b, cmd)) return false;
  f.log.push(auto ? { hour: f.hour, kind: 'command', command: cmd, auto } : { hour: f.hour, kind: 'command', command: cmd });
  return true;
}

function perform(f: FarmState, b: Business, cmd: FarmCommand): boolean {
  switch (cmd.type) {
    case 'dose': case 'replaceSolution': {
      // 量はトレイ1枚分。トレイ1枚分の見かけの区画に入れ、液量・塩類はトレイ数倍して棚に戻す（pH はそのまま）。費用もトレイ数倍
      rackOf(f, cmd.target);
      const bed = findCompartment(f.compartments, cmd.target), n = b.slotsPerRack, v = share(bed, n);
      const yen = execute([v], cmd, b.solution) * n;
      bed.water = v.water * n;
      bed.solutes.salts = v.solutes.salts * n;
      bed.ph = v.ph;
      spend(f, 'nutrient', yen);
      return true;
    }
    case 'sow': {
      const r = rackOf(f, cmd.rack), cb = b.crops[cmd.crop];
      if (!CROPS[cmd.crop] || !cb) throw new Error(`作物 ${cmd.crop} がありません`);
      if (r.slots[cmd.slot] !== null) return false;
      r.slots[cmd.slot] = { crop: { id: cmd.crop, compartment: r.id, growth: 0, health: 100, qualitySum: 0 }, sownAt: f.hour, ripeAt: null };
      spend(f, 'seed', cb.seedG * cb.seedYenPerG);
      f.ledger.laborMin += b.laborMin.sow;
      spend(f, 'medium', b.mediumYenPerTray);
      return true;
    }
    case 'harvest': {
      const r = rackOf(f, cmd.rack), t = r.slots[cmd.slot];
      if (!t || t.ripeAt === null || t.crop.health <= 0) return false;
      const spec = CROPS[t.crop.id], cb = b.crops[t.crop.id];
      const h = harvestOf(t.crop, spec, t.ripeAt - t.sownAt);
      const grams = cb.trayYieldG * (h.yieldG / spec.yieldG), fresh = freshness(t, f.hour, b);
      const shelf = cb.shelfDays * (f.equipment.fridge ? b.fridgeShelfMult : 1);
      f.stock.push({ crop: t.crop.id, grams, grade: h.grade, mult: gradeOf(h.quality).mult * fresh, harvestedAt: f.hour, expiresAt: f.hour + shelf * 24 });
      f.ledger.harvestG += grams;
      f.ledger.laborMin += b.laborMin.harvest;
      r.slots[cmd.slot] = null;
      f.log.push({ hour: f.hour, kind: 'harvest', rack: r.id, slot: cmd.slot, crop: t.crop.id, grams, grade: h.grade });
      return true;
    }
    case 'clear': {
      const r = rackOf(f, cmd.rack);
      if (!r.slots[cmd.slot]) return false;
      r.slots[cmd.slot] = null;
      return true;
    }
    case 'measure': {
      read(f, b);
      f.ledger.laborMin += b.laborMin.measure;
      return true;
    }
    case 'wholesale': {
      const { grams } = take(f, b, cmd.crop ?? null, Infinity, 'wholesale', reserved(f, b));
      return grams > 0;
    }
    case 'buy': {
      if (!canBuy(f, cmd.item, b)) return false;
      f.cash -= b.equipment[cmd.item].price;
      f.ledger.capex += b.equipment[cmd.item].price;
      f.equipment[cmd.item]++;
      f.assets.push({ item: cmd.item, month: f.ledger.month });
      if (cmd.item === 'rack') addRack(f, b);
      return true;
    }
  }
}
