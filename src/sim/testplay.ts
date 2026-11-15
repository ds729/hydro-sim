// テスト用の操作（自動制御ルールモードと同じく、コマンドだけで sim を動かす）。sim.test・farm.test・scenario.test で共用する。
// 画面からは使わない（index.ts から出さない）

import { applyCommand, bedOf, cropSpec, tick, type SimState } from './sim';
import { CROPS, type Factor } from './crop';
import { ecOf } from './compartment';
import { applyFarmCommand, farmTick, rackValues, BUSINESS, type FarmState } from './farm';
import type { Command } from './commands';

const dose = (supply: 'fertilizer' | 'water' | 'phDown' | 'phUp', amount: number): Command =>
  ({ type: 'dose', target: 'bed', supply, amount });
export const FERT = dose('fertilizer', 10), WATER = dose('water', 0.2), PH_DOWN = dose('phDown', 1), PH_UP = dose('phUp', 1);

/** 帯の内側 ratio 割より中の範囲 */
const inner = (band: readonly number[], ratio = 0.2) => [band[1] + (band[2] - band[1]) * ratio, band[2] - (band[2] - band[1]) * ratio];

/** 栽培：作物の適正帯から作る制御。各要因を適正帯の内側 2 割より中に保つ（どの作物でも同じ規則） */
export function keepInBand(s: SimState) {
  const b = bedOf(s), { ec, ph, water: w } = cropSpec(s).bands;
  const [ecLo, ecHi] = inner(ec), [phLo, phHi] = inner(ph), [wLo, wHi] = inner(w);
  if (b.ph > phHi) applyCommand(s, PH_DOWN);
  if (b.ph < phLo) applyCommand(s, PH_UP);
  if (b.water < wLo || (ecOf(b) > ecHi && b.water < wHi)) applyCommand(s, WATER);
  if (ecOf(b) < ecLo) applyCommand(s, FERT);
}

/** 栽培：止まったポンプをすぐ直す */
export function fixPumps(s: SimState) {
  for (const id of [...s.facility.pumpDown]) applyCommand(s, { type: 'fixPump', target: id });
}

/** 栽培：終わるまで進める。each は毎 tick の前に呼ぶ */
export function runToEnd(s: SimState, each: (s: SimState) => void = () => {}) {
  for (let i = 0; i < 10000 && !s.result; i++) { each(s); tick(s); }
  return s.result!;
}

/** 経営：棚に植わっている作物の適正帯の重なりの、内側 2 割より中に保つ（栽培の keepInBand と同じ規則） */
export function farmKeepInBand(f: FarmState) {
  for (const r of f.racks) {
    const crops = r.slots.filter(t => t && t.crop.health > 0).map(t => CROPS[t!.crop.id]);
    if (!crops.length) continue;
    const v = rackValues(f, r.id);
    const band = (k: Factor) => {
      const lo = Math.max(...crops.map(c => c.bands[k][1])), hi = Math.min(...crops.map(c => c.bands[k][2]));
      return [lo + (hi - lo) * 0.2, hi - (hi - lo) * 0.2];
    };
    const [ecLo, ecHi] = band('ec'), [phLo, phHi] = band('ph'), [wLo, wHi] = band('water');
    const put = (supply: 'fertilizer' | 'water' | 'phDown' | 'phUp', amount: number) =>
      applyFarmCommand(f, { type: 'dose', target: r.id, supply, amount });
    if (v.ph > phHi) put('phDown', 1);
    if (v.ph < phLo) put('phUp', 1);
    if (v.water < wLo || (v.ec > ecHi && v.water < wHi)) put('water', 0.2);
    if (v.ec < ecLo) put('fertilizer', 10);
  }
}

/** 経営：育ち終えたトレイを収穫し、枯れたトレイを片付ける */
export function harvestRipe(f: FarmState) {
  for (const r of f.racks) r.slots.forEach((t, i) => {
    if (!t) return;
    if (t.crop.health <= 0) applyFarmCommand(f, { type: 'clear', rack: r.id, slot: i });
    else if (t.ripeAt !== null) applyFarmCommand(f, { type: 'harvest', rack: r.id, slot: i });
  });
}

/** 経営：hours 時間進める */
export const farmRun = (f: FarmState, hours: number, each: (f: FarmState) => void = () => {}) => {
  for (let i = 0; i < hours; i++) { each(f); farmTick(f); }
};

/**
 * 経営の1か月の回し方：棚を1台足してひまわりを分け（EC の適正帯が低い）、毎朝9時に、今日播けば育つ日数＋2日後が納品日になる
 * 契約に必要なトレイ数を播く。帯に保ち、育ったら収穫し、止まったポンプはすぐ直す
 */
export function farmPlan(): { setup: (f: FarmState) => void; each: (f: FarmState) => void } {
  const rackFor = (crop: string) => (crop === 'sunflower' ? 'rack2' : 'rack1');
  return {
    setup: f => { applyFarmCommand(f, { type: 'buy', item: 'rack' }); },
    each: f => {
      for (const id of [...f.facility.pumpDown]) applyFarmCommand(f, { type: 'fixPump', target: id });
      farmKeepInBand(f);
      harvestRipe(f);
      if (f.hour % 24 !== 9) return;
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
    },
  };
}
