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
export type DoseSupply = Exclude<keyof typeof SUPPLIES, 'solution'>;

export type Command =
  /** 資材を区画に入れる（amount は資材の単位で） */
  | { type: 'dose'; target: string; supply: DoseSupply; amount: number }
  /** 養液を初期組成に入れ替える */
  | { type: 'replaceSolution'; target: string };

const PH_MIN = 3, PH_MAX = 9;

/** 区画を変え、かかった費用を返す */
export function execute(cs: readonly Compartment[], cmd: Command, initial: Solution): number {
  const c = findCompartment(cs, cmd.target);
  if (cmd.type === 'replaceSolution') {
    fill(c, initial);
    return SUPPLIES.solution.pricePerUnit;
  }
  const sp = SUPPLIES[cmd.supply], e = sp.perUnit;
  if (e.salts) c.solutes.salts += e.salts * cmd.amount;
  if (e.water) c.water = Math.min(c.capacity, c.water + e.water * cmd.amount);
  if (e.ph) c.ph = Math.min(PH_MAX, Math.max(PH_MIN, c.ph + e.ph * cmd.amount));
  return sp.pricePerUnit * cmd.amount;
}
