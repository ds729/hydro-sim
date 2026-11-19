// 操作はすべてコマンドとして sim に渡す。画面の道具バーも、v1.1 の自動制御ルールも同じ口を使う

import suppliesJson from '../data/supplies.json';
import { fill, findCompartment, type Compartment, type SoluteId, type Solution } from './compartment';

export interface Supply {
  name: string;
  unit: string;
  pricePerUnit: number;
  /** 1単位あたりの効果（溶質の増分、液量 L、pH の変化） */
  perUnit: Partial<Record<SoluteId | 'water' | 'ph', number>>;
}

export const SUPPLIES = suppliesJson as Record<'fertilizer' | 'water' | 'phDown' | 'phUp' | 'solution', Supply>;
export type SupplyId = keyof typeof SUPPLIES;
export type DoseSupply = Exclude<SupplyId, 'solution'>;

export type Command =
  /** 資材を区画に入れる（amount は資材の単位で） */
  | { type: 'dose'; target: string; supply: DoseSupply; amount: number }
  /** 養液を初期組成に入れ替える */
  | { type: 'replaceSolution'; target: string }
  /** 止まったポンプを直す（掃除して動かし直す）。区画は変えず、sim が設備の状態（facility.ts）で扱う */
  | { type: 'fixPump'; target: string };

export const PH_MIN = 3, PH_MAX = 9;

/** 資材を入れたときに区画へ加わる分（塩類 EC×L・液量 L・pH の変化）。すぐ効かせるか、混ざっていない分に置くかは呼び出し側 */
export interface DoseEffect { salts: number; water: number; ph: number }

export function doseEffect(cmd: Extract<Command, { type: 'dose' }>): DoseEffect {
  const e = SUPPLIES[cmd.supply].perUnit;
  return { salts: (e.salts ?? 0) * cmd.amount, water: (e.water ?? 0) * cmd.amount, ph: (e.ph ?? 0) * cmd.amount };
}

/** 加わる分を区画に足す（液量は容量、pH は 3〜9 で頭打ち） */
export function addEffect(c: Compartment, d: DoseEffect): void {
  c.solutes.salts += d.salts;
  if (d.water) c.water = Math.min(c.capacity, c.water + d.water);
  if (d.ph) c.ph = Math.min(PH_MAX, Math.max(PH_MIN, c.ph + d.ph));
}

/** 区画を変え、かかった費用を返す（資材はすぐ混ざる。経営モードはこれ。栽培モードは sim.ts が遅れて混ぜる） */
export function execute(cs: readonly Compartment[], cmd: Command, initial: Solution): number {
  const c = findCompartment(cs, cmd.target);
  if (cmd.type === 'fixPump') return 0;
  if (cmd.type === 'replaceSolution') {
    fill(c, initial);
    return SUPPLIES.solution.pricePerUnit;
  }
  addEffect(c, doseEffect(cmd));
  return SUPPLIES[cmd.supply].pricePerUnit * cmd.amount;
}
