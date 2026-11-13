import { describe, expect, test } from 'vitest';
import {
  BUSINESS, CROPS, applyFarmCommand, canBuy, createFarm, createSim, farmTick, rackValues, reserved, tick, totals, trayEstimate,
  type Factor, type FarmState, type Ledger,
} from './index';

const R = 'rack1';

/** 棚に植わっている作物の適正帯の重なりの、内側 2 割より中に保つ（栽培モードの keepInBand と同じ規則） */
function keepInBand(f: FarmState) {
  for (const r of f.racks) {
    const crops = r.slots.filter(t => t && t.crop.health > 0).map(t => CROPS[t!.crop.id]);
    if (!crops.length) continue;
    const v = rackValues(f, r.id);
    const band = (k: Factor) => {
      const lo = Math.max(...crops.map(c => c.bands[k][1])), hi = Math.min(...crops.map(c => c.bands[k][2]));
      return [lo + (hi - lo) * 0.2, hi - (hi - lo) * 0.2];
    };
    const [ecLo, ecHi] = band('ec'), [phLo, phHi] = band('ph'), [wLo, wHi] = band('water');
    const dose = (supply: 'fertilizer' | 'water' | 'phDown' | 'phUp', amount: number) =>
      applyFarmCommand(f, { type: 'dose', target: r.id, supply, amount });
    if (v.ph > phHi) dose('phDown', 1);
    if (v.ph < phLo) dose('phUp', 1);
    if (v.water < wLo || (v.ec > ecHi && v.water < wHi)) dose('water', 0.2);
    if (v.ec < ecLo) dose('fertilizer', 10);
  }
}

/** 育ち終えたトレイを収穫し、枯れたトレイを片付ける */
function harvestRipe(f: FarmState) {
  for (const r of f.racks) r.slots.forEach((t, i) => {
    if (!t) return;
    if (t.crop.health <= 0) applyFarmCommand(f, { type: 'clear', rack: r.id, slot: i });
    else if (t.ripeAt !== null) applyFarmCommand(f, { type: 'harvest', rack: r.id, slot: i });
  });
}

const run = (f: FarmState, hours: number, each: (f: FarmState) => void = () => {}) => {
  for (let i = 0; i < hours; i++) { each(f); farmTick(f); }
};

/** 現金 ＝ 元手 ＋ 売上 − 費用（減価償却を除く） − 設備の購入 */
function cashCheck(f: FarmState) {
  const all: Ledger[] = [...f.months, f.ledger];
  const rev = all.reduce((a, l) => a + totals(l).revenue, 0);
  const cost = all.reduce((a, l) => a + totals(l).cost - l.cost.depreciation, 0);
  const capex = all.reduce((a, l) => a + l.capex, 0);
  return BUSINESS.startCash + rev - cost - capex;
}

describe('経営モード（Phase 4）', () => {
  test('始めは元手と棚1台（空のトレイ）', () => {
    const f = createFarm();
    expect(f.cash).toBe(BUSINESS.startCash);
    expect(f.racks).toHaveLength(1);
    expect(f.racks[0].slots).toHaveLength(BUSINESS.slotsPerRack);
    expect(f.racks[0].slots.every(t => t === null)).toBe(true);
  });

  test('同じ作物で埋めた棚は、栽培モードのトレイ1枚と同じ速さで育つ', () => {
    const f = createFarm();
    for (let i = 0; i < BUSINESS.slotsPerRack; i++) applyFarmCommand(f, { type: 'sow', rack: R, slot: i, crop: 'radish' });
    // 無操作どうしで比べる（養液の動きが同じなら、育ち方も同じ）
    const s = createSim({ crop: 'radish' });
    for (let h = 0; h < 72; h++) { farmTick(f); tick(s); }
    const t = f.racks[0].slots[0]!;
    expect(t.crop.growth).toBeCloseTo(s.crop.growth, 9);
    expect(t.crop.health).toBeCloseTo(s.crop.health, 9);
    expect(rackValues(f, R).ec).toBeCloseTo(s.compartments[0].solutes.salts / s.compartments[0].water, 9);
  });

  test('播種で種子と培地の費用、収穫で在庫、卸で売上', () => {
    // ブロッコリー：収穫する Day 11 にはホテルの納品（Day 15）がまだ遠く、取り置きが出ない。取り置きは次のテスト
    const f = createFarm(), cb = BUSINESS.crops.broccoli;
    applyFarmCommand(f, { type: 'sow', rack: R, slot: 0, crop: 'broccoli' });
    expect(f.ledger.cost.seed).toBeCloseTo(cb.seedG * cb.seedYenPerG);
    expect(f.ledger.cost.medium).toBe(BUSINESS.mediumYenPerTray);
    expect(applyFarmCommand(f, { type: 'sow', rack: R, slot: 0, crop: 'broccoli' })).toBe(false);
    expect(applyFarmCommand(f, { type: 'harvest', rack: R, slot: 0 })).toBe(false);
    run(f, CROPS.broccoli.days * 24 * 1.05, keepInBand);
    expect(f.racks[0].slots[0]!.ripeAt).not.toBeNull();
    expect(applyFarmCommand(f, { type: 'harvest', rack: R, slot: 0 })).toBe(true);
    expect(f.stock).toHaveLength(1);
    expect(f.stock[0].grade).toBe('S');
    expect(f.stock[0].grams).toBeCloseTo(cb.trayYieldG, 0);
    const before = f.cash, g = f.stock[0].grams;
    expect(reserved(f).broccoli).toBeUndefined();
    expect(applyFarmCommand(f, { type: 'wholesale' })).toBe(true);
    expect(f.stock).toHaveLength(0);
    expect(f.ledger.revenue.wholesale).toBeCloseTo((g / 100) * cb.retailPer100g * BUSINESS.channels.wholesale.priceMult * 1.2, 6);
    expect(f.cash).toBeCloseTo(before + f.ledger.revenue.wholesale - (g / 100) * BUSINESS.channels.wholesale.packYenPer100g, 6);
  });

  test('卸に出しても明日・あさっての納品の取り置きは残り、作物を選んで出せる', () => {
    const f = createFarm();
    applyFarmCommand(f, { type: 'sow', rack: R, slot: 0, crop: 'radish' });
    applyFarmCommand(f, { type: 'sow', rack: R, slot: 1, crop: 'radish' });
    applyFarmCommand(f, { type: 'sow', rack: R, slot: 2, crop: 'broccoli' });
    // ビストロ（ラディッシュ、Day 11 から週1）の納品の前日まで回して収穫する
    run(f, 24 * 9 + 9, keepInBand);
    harvestRipe(f);
    const stockOf = (crop: string) => f.stock.filter(l => l.crop === crop).reduce((a, l) => a + l.grams, 0);
    const keep = reserved(f).radish;
    expect(keep).toBe(BUSINESS.contracts.find(c => c.id === 'bistro')!.grams);
    expect(stockOf('radish')).toBeGreaterThan(keep);
    // ラディッシュだけ出す：取り置きの分だけ残り、ブロッコリーには手を付けない
    const broccoli = stockOf('broccoli');
    expect(applyFarmCommand(f, { type: 'wholesale', crop: 'radish' })).toBe(true);
    expect(stockOf('radish')).toBeCloseTo(keep, 6);
    expect(stockOf('broccoli')).toBeCloseTo(broccoli, 6);
    // 取り置きしか残っていなければ何も出せない
    expect(applyFarmCommand(f, { type: 'wholesale', crop: 'radish' })).toBe(false);
  });

  test('契約の単価：豆苗も若芽としてフレンチに納めればマイクロハーブ並みの値段になる', () => {
    const french = BUSINESS.contracts.find(c => c.id === 'french')!;
    expect(french.crop).toBe('pea');
    const retail = BUSINESS.crops.pea.retailPer100g * BUSINESS.channels.restaurant.priceMult;
    expect(french.pricePer100g).toBeGreaterThan(retail * 10);
  });

  test('1トレイの見込み：豆苗は量販（卸・直売）だと赤字、若芽としてフレンチに納めれば黒字', () => {
    const pea = trayEstimate('pea'), by = (k: string) => pea.outlets.find(o => (o.contract ?? o.kind) === k)!;
    expect(pea.cost.total).toBeCloseTo(pea.cost.seed + pea.cost.medium + pea.cost.power);
    expect(by('wholesale').profit).toBeLessThan(0);
    expect(by('direct').profit).toBeLessThan(0);
    expect(by('french').profit).toBeGreaterThan(0);
    // アブラナ科・ひまわりはどの販路でも黒字
    for (const c of ['radish', 'broccoli', 'sunflower']) for (const o of trayEstimate(c).outlets) expect(o.profit).toBeGreaterThan(0);
    // 省エネ LED で電気代が下がる
    expect(trayEstimate('pea', BUSINESS, { led: 1 }).cost.power).toBeLessThan(pea.cost.power);
    // 直売は日持ちの間に売れる分だけ（残りは卸）。冷蔵庫で日持ちが延びると直売で売れる量が増える
    const dr = (eq = {}) => trayEstimate('radish', BUSINESS, eq).outlets.find(o => o.kind === 'direct')!;
    expect(dr().grams).toBe(BUSINESS.directDemandGPerDay * BUSINESS.crops.radish.shelfDays);
    expect(dr({ fridge: 1 }).grams).toBeGreaterThan(dr().grams);
    expect(dr({ fridge: 1 }).net).toBeGreaterThan(dr().net);
  });

  test('日持ちを過ぎた在庫は廃棄になり、冷蔵庫で延びる', () => {
    const expireDay = (fridge: boolean) => {
      const f = createFarm();
      if (fridge) applyFarmCommand(f, { type: 'buy', item: 'fridge' });
      applyFarmCommand(f, { type: 'sow', rack: R, slot: 0, crop: 'pea' });
      applyFarmCommand(f, { type: 'sow', rack: R, slot: 1, crop: 'pea' });
      run(f, 24 * 30, f => { keepInBand(f); harvestRipe(f); });
      const ex = f.log.find(e => e.kind === 'expired'), hv = f.log.find(e => e.kind === 'harvest');
      expect(f.ledger.wasteG + f.months.reduce((a, l) => a + l.wasteG, 0)).toBeGreaterThan(0);
      return (ex!.hour - hv!.hour) / 24;
    };
    // 豆苗は契約がなく直売の需要は 1日 100g。2トレイ分は売り切れず、残りが期限で捨てられる
    const d0 = expireDay(false), d1 = expireDay(true);
    expect(d0).toBeLessThanOrEqual(BUSINESS.crops.pea.shelfDays + 1);
    expect(d1).toBeGreaterThan(d0);
  });

  test('収穫しないでおくと価値が落ち、やがて育ちすぎで廃棄', () => {
    const f = createFarm(), cb = BUSINESS.crops.sunflower;
    applyFarmCommand(f, { type: 'sow', rack: R, slot: 0, crop: 'sunflower' });
    run(f, 24 * 40, keepInBand);
    const dead = f.log.find(e => e.kind === 'dead');
    expect(dead && dead.kind === 'dead' && dead.reason).toBe('overgrown');
    const ripe = f.racks[0].slots[0]!.ripeAt!;
    expect((dead!.hour - ripe) / 24).toBeCloseTo(cb.windowDays + BUSINESS.overgrowDiscardDays, 0);
    expect(applyFarmCommand(f, { type: 'harvest', rack: R, slot: 0 })).toBe(false);
    expect(applyFarmCommand(f, { type: 'clear', rack: R, slot: 0 })).toBe(true);
  });

  test('納品できない週が続くと契約が切れる', () => {
    const f = createFarm();
    run(f, 24 * 28);
    const lost = f.log.filter(e => e.kind === 'contractLost').map(e => e.kind === 'contractLost' && e.contract);
    expect(lost.sort()).toEqual(['bistro', 'cafe', 'french', 'hotel']);
    expect(Object.values(f.contracts).every(c => c.lost)).toBe(true);
  });

  test('30日で月を締め、家賃・電気代・減価償却を計上する', () => {
    const f = createFarm();
    applyFarmCommand(f, { type: 'buy', item: 'led' });
    run(f, 24 * BUSINESS.monthDays);
    expect(f.months).toHaveLength(1);
    const m = f.months[0], led = BUSINESS.equipment.led;
    expect(m.cost.rent).toBeCloseTo(BUSINESS.rentPerMonth);
    expect(m.cost.power).toBeCloseTo(BUSINESS.powerYenPerRackDay * BUSINESS.ledPowerMult * BUSINESS.monthDays);
    expect(m.cost.depreciation).toBeCloseTo(led.price / led.lifeMonths);
    expect(m.capex).toBe(led.price);
    expect(f.ledger.month).toBe(2);
    expect(f.log.some(e => e.kind === 'month')).toBe(true);
    expect(f.cash).toBeCloseTo(cashCheck(f), 6);
  });

  test('設備：お金が足りなければ買えない。棚の増設で区画が増える', () => {
    const f = createFarm();
    expect(applyFarmCommand(f, { type: 'buy', item: 'rack' })).toBe(true);
    expect(f.racks).toHaveLength(2);
    expect(f.compartments).toHaveLength(2);
    expect(applyFarmCommand(f, { type: 'buy', item: 'rack' })).toBe(true);
    expect(canBuy(f, 'rack')).toBe(false); // 上限 3 台
    f.cash = 1000;
    expect(applyFarmCommand(f, { type: 'buy', item: 'fridge' })).toBe(false);
    expect(f.equipment.fridge).toBe(0);
  });

  test('自動給水があれば、無操作でも液量不足にならない', () => {
    const lowWater = (auto: boolean) => {
      const f = createFarm();
      if (auto) applyFarmCommand(f, { type: 'buy', item: 'autoWater' });
      for (let i = 0; i < 8; i++) applyFarmCommand(f, { type: 'sow', rack: R, slot: i, crop: 'sunflower' });
      let min = Infinity;
      run(f, 24 * 8, f => { min = Math.min(min, rackValues(f, R).water); });
      return min;
    };
    expect(lowWater(true)).toBeGreaterThan(CROPS.sunflower.bands.water[1]);
    expect(lowWater(false)).toBeLessThan(CROPS.sunflower.bands.water[1]);
  });

  test('連続測定センサがなければ、計器の読みは朝と測ったときだけ変わる', () => {
    const f = createFarm();
    for (let i = 0; i < 8; i++) applyFarmCommand(f, { type: 'sow', rack: R, slot: i, crop: 'radish' });
    run(f, BUSINESS.measureHour + 1);
    const at = f.readAt, r = { ...f.readings[R] };
    run(f, 5);
    expect(f.readAt).toBe(at);
    expect(f.readings[R]).toEqual(r);
    applyFarmCommand(f, { type: 'measure' });
    expect(f.readings[R].water).toBeLessThan(r.water);
    applyFarmCommand(f, { type: 'buy', item: 'probe' });
    farmTick(f);
    expect(f.readAt).toBe(f.hour);
  });

  test('1か月回せる：納品日から逆算して播けば、契約を守って黒字の月次損益が出る', () => {
    const f = createFarm();
    // ひまわり・豆苗（EC の適正が 1.2 まで）は棚を分ける。アブラナ科（1.0 から）と同じ養液だと重なりが狭く、遅れて納品に間に合わない
    applyFarmCommand(f, { type: 'buy', item: 'rack' });
    const rackFor = (crop: string) => (crop === 'sunflower' || crop === 'pea' ? 'rack2' : R);
    run(f, 24 * BUSINESS.monthDays, f => {
      keepInBand(f);
      harvestRipe(f);
      if (f.hour % 24 !== 9) return;
      // 播種計画：今日播いて、育つ日数＋2日後が納品日になる契約に、必要なトレイ数を播く
      const today = Math.floor(f.hour / 24) + 1;
      for (const c of BUSINESS.contracts) {
        const D = today + CROPS[c.crop].days + 2;
        if ((D - 1) % 7 !== c.weekday || D < c.startDay) continue;
        const n = Math.ceil(c.grams / BUSINESS.crops[c.crop].trayYieldG);
        for (let j = 0; j < n; j++) {
          const r = rackFor(c.crop), i = f.racks.find(x => x.id === r)!.slots.indexOf(null);
          if (i >= 0) applyFarmCommand(f, { type: 'sow', rack: r, slot: i, crop: c.crop });
        }
      }
    });
    const m = f.months[0], t = totals(m);
    expect(Object.values(f.contracts).every(c => !c.lost && c.misses === 0)).toBe(true);
    expect(t.profit).toBeGreaterThan(0);
    expect(m.capex).toBe(BUSINESS.equipment.rack.price);
    expect(m.cost.depreciation).toBeCloseTo(BUSINESS.equipment.rack.price / BUSINESS.equipment.rack.lifeMonths);
    expect(m.wasteG).toBeLessThan(m.harvestG * 0.2);
    expect(m.revenue.restaurant).toBeGreaterThan(0);
    expect(m.harvestG).toBeGreaterThan(0);
    expect(t.profit).toBeCloseTo(t.revenue - t.cost, 6);
    expect(f.cash).toBeCloseTo(cashCheck(f), 6);
  });
});
