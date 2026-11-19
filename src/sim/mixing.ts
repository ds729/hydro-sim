// 制御の遅れ（v1.1。栽培モードだけ）：混合の遅れとセンサの更新間隔。
// 入れた資材は養液タンクに入り、ポンプの循環で栽培槽に混ざるまで「混ざっていない分」に置く。作物が受けるのは混ざった分だけ。
// センサは栽培槽の混ざった分を決まった間隔でしか読まない。画面のゲージ・モニタ・自動制御のルールはこの読みを見る

import { addEffect, type DoseEffect } from './commands';
import { ecOf, type Compartment } from './compartment';
import { FACILITY, type FacilitySpec } from './facility';
import type { Factor } from './crop';

export const CONTROL = FACILITY.control;

/** 混ざっていない分がこれ未満になったら 0 にする（状態を見やすく保つ） */
const EPS = 1e-6;

export const noEffect = (): DoseEffect => ({ salts: 0, water: 0, ph: 0 });
export const isMixed = (u: DoseEffect) => u.salts === 0 && u.water === 0 && u.ph === 0;

/**
 * 混ざっていない分のうち minutes 分で混ざる割合を区画に移す。ポンプが回っていれば時定数 mixTauMin、
 * 止まっていれば mixTauStoppedMin（水面と温度差だけでゆっくり混ざる）
 */
export function mix(c: Compartment, u: DoseEffect, minutes: number, running: boolean, spec: FacilitySpec['control'] = CONTROL): void {
  if (isMixed(u)) return;
  const r = 1 - Math.exp(-minutes / (running ? spec.mixTauMin : spec.mixTauStoppedMin));
  addEffect(c, { salts: u.salts * r, water: u.water * r, ph: u.ph * r });
  for (const k of ['salts', 'water', 'ph'] as const) {
    u[k] *= 1 - r;
    if (Math.abs(u[k]) < EPS) u[k] = 0;
  }
}

/** 混ざっていない分を残らず区画に移す（見込みの値・テスト用） */
export function mixAll(c: Compartment, u: DoseEffect): void {
  addEffect(c, u);
  Object.assign(u, noEffect());
}

/** センサの読み。minute はその読みを取った時刻（経過時間 分） */
export interface Reading extends Record<Factor, number> { minute: number }

export const readSensors = (c: Compartment, minute: number): Reading => ({ ec: ecOf(c), ph: c.ph, water: c.water, minute });
