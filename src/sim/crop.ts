// 作物：区画の物質を消費・生成するモデル。作物ごとの違いは crops.json に寄せる
// 生き物（作物・v2 の魚・硝化菌）は「exchange で区画の物質をやり取りし、適合度で育つ・弱る」形に揃える

import cropsJson from '../data/crops.json';
import facilityJson from '../data/facility.json';
import { ecOf, type Compartment } from './compartment';
import { trapezoid, type Band } from './fitness';

export const FACTORS = ['ec', 'ph', 'water'] as const;

/** 葉の形（描画層 render/seedling.ts の形の名前）。heart＝かいわれ型の子葉、oval＝厚い楕円の子葉、pea＝小葉2段と巻きひげ */
export const LEAF_SHAPES = ['heart', 'oval', 'pea'] as const;
export type LeafShape = (typeof LEAF_SHAPES)[number];
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
  look: { leafShape: LeafShape; stem: string; leaf: string; height: number; leafSize: number; stemWidth: number };
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

/**
 * 照明（LED）の点灯・消灯の時刻（時。hour % 24 で比べる）と、暗期の根の活動（吸水・吸収・pH の変化）の明期に対する割合。
 * 1日の合計は変えない（作物の吸水量 waterLph は1日の平均）。成長は暗期も同じ速さ（日数は昼夜を含めた日数のため）
 */
export const LIGHT = (facilityJson as { light: { on: number; off: number; darkUptakeRatio: number } }).light;
const LIT_HOURS = LIGHT.off - LIGHT.on;
const LIT_MULT = 24 / (LIT_HOURS + (24 - LIT_HOURS) * LIGHT.darkUptakeRatio);

/** その時刻（経過時間 h）に照明が点いているか */
export function isLit(hour: number): boolean {
  const h = ((hour % 24) + 24) % 24;
  return h >= LIGHT.on && h < LIGHT.off;
}

/** その時刻の根の活動の倍率（明期は 1 より大きく、暗期は小さい。1日の平均が 1） */
export function diurnal(hour: number): number {
  return isLit(hour) ? LIT_MULT : LIT_MULT * LIGHT.darkUptakeRatio;
}

/** 1時間分、区画から水と塩類を吸い、pH を動かす。light は昼夜の倍率（diurnal） */
export function exchange(crop: CropState, spec: CropSpec, c: Compartment, light = 1): void {
  const u = spec.uptake, act = (u.activity[0] + u.activity[1] * crop.growth) * light;
  const et = u.waterLph * act, ec = ecOf(c);
  c.water = Math.max(0.05, c.water - et);
  c.solutes.salts = Math.max(0, c.solutes.salts - et * ec * u.saltRatio);
  c.ph += u.phDriftPerH * act;
}

export type Grade = 'S' | 'A' | 'B' | 'C';

/** [品質の下限, 等級, 単価の倍率] */
export const GRADES: readonly (readonly [number, Grade, number])[] = [[0.95, 'S', 1.2], [0.85, 'A', 1], [0.7, 'B', 0.7], [-Infinity, 'C', 0.4]];

/** 品質から等級と単価の倍率 */
export function gradeOf(quality: number): { grade: Grade; mult: number } {
  const [, grade, mult] = GRADES.find(([min]) => quality >= min)!;
  return { grade, mult };
}

/** 収穫したときの品質（律速因子の適合度の時間平均）・等級・収量。hours は播種からの経過時間 */
export function harvestOf(crop: CropState, spec: CropSpec, hours: number): { quality: number; grade: Grade; mult: number; yieldG: number } {
  const quality = hours > 0 ? crop.qualitySum / hours : 0;
  return { quality, ...gradeOf(quality), yieldG: spec.yieldG * Math.sqrt(Math.max(0, crop.health) / 100) * quality };
}

/** 1時間分育つ。m は律速因子の適合度。0.5 未満で健康度が減り、0.9 超で回復する */
export function grow(crop: CropState, spec: CropSpec, m: number): void {
  crop.growth = Math.min(1, crop.growth + m / (spec.days * 24));
  crop.health = m < 0.5 ? crop.health - (0.5 - m) * 3 : m > 0.9 ? Math.min(100, crop.health + 0.3) : crop.health;
  crop.qualitySum += m;
}
