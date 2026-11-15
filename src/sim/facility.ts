// 設備（Phase 5）：電気・ポンプ・養液の溶存酸素と、停電・ポンプの停止のイベント。栽培モードと経営モードで共用する。
// 数値は facility.json に寄せる。イベントの乱数は sim の rng（シード）で引くので、同じシードなら同じ日に起きる

import facilityJson from '../data/facility.json';
import type { Compartment } from './compartment';
import { trapezoid, type Band } from './fitness';
import { nextRandom } from './rng';

export interface FacilitySpec {
  /** 照明（LED）の点灯・消灯の時刻（時）と、暗期の根の活動の明期に対する割合（crop.ts の isLit・diurnal） */
  light: { on: number; off: number; darkUptakeRatio: number };
  /**
   * 溶存酸素（飽和度 0〜1）。band は作物共通の適合度の台形。ポンプが回っていれば aeratePerH ×（1 − 飽和度）ずつ戻り、
   * 止まっていても水面から surfacePerH ×（1 − 飽和度）だけ溶け込む。根の呼吸で飽和度が rootPerH × 活動度 /h 下がる（液量によらない。簡略化：
   * 液量で割ると、液量不足のときにポンプが回っていても酸欠になり、液量不足の症状と混ざるため）
   */
  o2: { band: Band; aeratePerH: number; surfacePerH: number; rootPerH: number };
  /** 停電：平均の間隔（日）と長さ（時間、最小〜最大） */
  outage: { meanIntervalDays: number; hours: [number, number] };
  /** ポンプの停止（詰まり）：ポンプ1台あたりの平均の間隔（日）。直すまで止まったまま */
  pump: { meanIntervalDays: number };
}

export const FACILITY = facilityJson as unknown as FacilitySpec;

/** 予定のイベント（課題で決まった時刻に起こす。hour は経過時間）。pumpStop の target を省くと最初のポンプ */
export type ScheduledEvent =
  | { hour: number; kind: 'outage'; hours: number }
  | { hour: number; kind: 'pumpStop'; target?: string };

export interface FacilityState {
  /** 停電・ポンプの停止を抽選で起こすか（栽培モードは既定で起こさない） */
  events: boolean;
  /** 予定のイベント（events によらず起きる。起きたものから消す） */
  schedule: ScheduledEvent[];
  /** 停電の残り時間 h（0 なら通電） */
  outage: number;
  /** 止まっているポンプ（区画の id） */
  pumpDown: string[];
  /** 根の酸欠の観察メモの判定（区画ごと）：適合度 0.7 未満が続いた時間、最後にメモを出した時刻 */
  watch: Record<string, { low: number; last: number | null }>;
}

/** 設備のイベント（sim の記録に hour を付けて入れる） */
export type FacilityEvent =
  /** 停電が始まった（hours は続く時間） */
  | { kind: 'outage'; hours: number }
  | { kind: 'powerBack' }
  /** ポンプが止まった（詰まり） */
  | { kind: 'pumpStop'; target: string }
  /** 観察メモ：根が酸欠（溶存酸素の適合度 0.7 未満が3時間）。pump はそのときポンプが回っていたか */
  | { kind: 'hypoxia'; target: string; o2: number; fit: number; pump: boolean };

export function createFacility(events = false, schedule: readonly ScheduledEvent[] = []): FacilityState {
  return { events, schedule: schedule.map(e => ({ ...e })), outage: 0, pumpDown: [], watch: {} };
}

export const powered = (fs: FacilityState) => fs.outage <= 0;

/** ポンプが回っているか。backup は非常用電源（停電中もポンプは動く） */
export const pumpRunning = (fs: FacilityState, id: string, backup = false) => !fs.pumpDown.includes(id) && (powered(fs) || backup);

/**
 * 1時間の始めに、予定のイベントを起こし、停電・ポンプの停止を抽選する（抽選は events のときだけ。乱数を引くのもそのときだけ）。
 * 停電中は新しい停電を起こさない。起きたことを返す（記録は呼び出し側）
 */
export function rollEvents(fs: FacilityState, now: { rng: number; hour: number }, pumps: readonly string[], spec: FacilitySpec = FACILITY): FacilityEvent[] {
  const out: FacilityEvent[] = [];
  for (const e of fs.schedule.filter(e => e.hour <= now.hour)) {
    out.push(e.kind === 'outage' ? startOutage(fs, e.hours) : stopPump(fs, e.target ?? pumps[0]));
  }
  fs.schedule = fs.schedule.filter(e => e.hour > now.hour);
  if (!fs.events) return out;
  if (fs.outage <= 0 && nextRandom(now) < 1 / (spec.outage.meanIntervalDays * 24)) {
    const [lo, hi] = spec.outage.hours;
    out.push(startOutage(fs, lo + Math.floor(nextRandom(now) * (hi - lo + 1))));
  }
  for (const id of pumps) {
    if (fs.pumpDown.includes(id)) continue;
    if (nextRandom(now) < 1 / (spec.pump.meanIntervalDays * 24)) out.push(stopPump(fs, id));
  }
  return out;
}

/** 停電を起こす（抽選のほか、テスト・確認用の口・シナリオから使う） */
export function startOutage(fs: FacilityState, hours: number): FacilityEvent {
  fs.outage = Math.max(fs.outage, hours);
  return { kind: 'outage', hours };
}

export function stopPump(fs: FacilityState, id: string): FacilityEvent {
  if (!fs.pumpDown.includes(id)) fs.pumpDown.push(id);
  return { kind: 'pumpStop', target: id };
}

/** ポンプを直す（掃除して動かし直す）。止まっていなければ false */
export function fixPump(fs: FacilityState, id: string): boolean {
  const i = fs.pumpDown.indexOf(id);
  if (i < 0) return false;
  fs.pumpDown.splice(i, 1);
  return true;
}

/** 1時間の終わりに停電の残りを減らす。電気が戻ったらイベントを返す */
export function endHour(fs: FacilityState): FacilityEvent[] {
  if (fs.outage <= 0) return [];
  fs.outage--;
  return fs.outage <= 0 ? [{ kind: 'powerBack' }] : [];
}

/** 1時間分、酸素を溶け込ませる（ポンプが回っていればエアレーション、止まっていれば水面からだけ） */
export function aerate(c: Compartment, running: boolean, spec: FacilitySpec = FACILITY): void {
  c.o2 += (1 - c.o2) * (running ? spec.o2.aeratePerH : spec.o2.surfacePerH);
}

/** 根の呼吸で酸素を使う。activity は作物の活動度（昼夜の倍率は掛けない。呼吸は夜も続く） */
export function respire(c: Compartment, activity: number, spec: FacilitySpec = FACILITY): void {
  c.o2 = Math.max(0, c.o2 - spec.o2.rootPerH * activity);
}

export const o2Fitness = (c: Compartment, spec: FacilitySpec = FACILITY) => trapezoid(c.o2, spec.o2.band);

/** 根の酸欠の観察メモ：適合度 0.7 未満が3時間続いたら出す。同じ区画は 24時間あける（症状の観察メモと同じ規則） */
export function watchHypoxia(fs: FacilityState, c: Compartment, hour: number, running: boolean): FacilityEvent | null {
  const w = (fs.watch[c.id] ??= { low: 0, last: null }), fit = o2Fitness(c);
  w.low = fit < 0.7 ? w.low + 1 : 0;
  if (w.low < 3 || hour - (w.last ?? -99) < 24) return null;
  w.last = hour;
  return { kind: 'hypoxia', target: c.id, o2: c.o2, fit, pump: running };
}
