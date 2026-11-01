// 作物：区画の物質を消費・生成するモデル。作物ごとの違いは crops.json に寄せる
// 生き物（作物・v2 の魚・硝化菌）は「exchange で区画の物質をやり取りし、適合度で育つ・弱る」形に揃える

import cropsJson from '../data/crops.json';
import { ecOf, type Compartment } from './compartment';
import { trapezoid, type Band } from './fitness';

export const FACTORS = ['ec', 'ph', 'water'] as const;
export type Factor = (typeof FACTORS)[number];

export interface CropSpec {
  name: string;
  /** 作物を選ぶときの一言（育て方の要点） */
  note: string;
  /** 最適条件で収穫できるまでの日数 */
  days: number;
  /** once：1回収穫、repeat：連続収穫（葉物。Phase 3 以降） */
  harvest: 'once' | 'repeat';
  bands: Record<Factor, Band>;
  /** 好適水温（v2 で水温を sim に入れたら使う） */
  waterTempC?: Band;
  uptake: {
    /** 生育度 1 のときの吸水量 L/h（活動度を掛ける） */
    waterLph: number;
    /** 活動度 = activity[0] + activity[1] × 生育度 */
    activity: readonly [number, number];
    /** 吸水に対する塩類の吸収割合（1 未満なら水だけ減って EC が上がる） */
    saltRatio: number;
    /** 根の活動による pH の上昇 /h（活動度を掛ける） */
    phDriftPerH: number;
  };
  /** 最適条件・健康度 100 での収量 g */
  yieldG: number;
  pricePer100g: number;
  /** 見た目（描画層が使う。sim は使わない）。色は '#rrggbb'、大きさは基準（ラディッシュ）に対する倍率 */
  look: { stem: string; leaf: string; height: number; leafSize: number; stemWidth: number };
}

// JSON の配列は TS ではタプルにならないので unknown を経由する。中身は crop.test.ts で検査する
export const CROPS = cropsJson as unknown as Record<string, CropSpec>;

export interface CropState {
  id: string;
  /** 植わっている区画 */
  compartment: string;
  /** 生育度 0〜1（1 で収穫） */
  growth: number;
  /** 健康度 0〜100（0 で枯死） */
  health: number;
  /** 律速因子の適合度の累計（品質＝累計 / 経過時間） */
  qualitySum: number;
}

/** 各要因の今の値 */
export const MEASURE: Record<Factor, (c: Compartment) => number> = {
  ec: ecOf,
  ph: c => c.ph,
  water: c => c.water,
};

export function fitness(spec: CropSpec, c: Compartment): Record<Factor, number> {
  return {
    ec: trapezoid(MEASURE.ec(c), spec.bands.ec),
    ph: trapezoid(MEASURE.ph(c), spec.bands.ph),
    water: trapezoid(MEASURE.water(c), spec.bands.water),
  };
}

/** 1時間分、区画から水と塩類を吸い、pH を動かす */
export function exchange(crop: CropState, spec: CropSpec, c: Compartment): void {
  const u = spec.uptake, act = u.activity[0] + u.activity[1] * crop.growth;
  const et = u.waterLph * act, ec = ecOf(c);
  c.water = Math.max(0.05, c.water - et);
  c.solutes.salts = Math.max(0, c.solutes.salts - et * ec * u.saltRatio);
  c.ph += u.phDriftPerH * act;
}

/** 1時間分育つ。m は律速因子の適合度。0.5 未満で健康度が減り、0.9 超で回復する */
export function grow(crop: CropState, spec: CropSpec, m: number): void {
  crop.growth = Math.min(1, crop.growth + m / (spec.days * 24));
  crop.health = m < 0.5 ? crop.health - (0.5 - m) * 3 : m > 0.9 ? Math.min(100, crop.health + 0.3) : crop.health;
  crop.qualitySum += m;
}
