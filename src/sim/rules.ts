// 自動制御ルール（v1.1。栽培モードだけ）：1行＝「センサの読み 比較 しきい値 → 資材 量」と「動いた後は ◯分待つ」。
// ルールはプレーンなデータ（JSON にできる）で sim に渡す。評価は sim.ts の内側の刻み（control.stepMin 分）ごとで、
// 見るのはセンサの読み（s.sensor）だけ。動いたルールの操作は手の操作と同じコマンドとして実行し、記録に auto を付ける。
// 停電中は制御器も止まる（読みも取れず、ルールも動かない）

import { CROPS, FACTORS, type Factor } from './crop';
import type { Command, DoseSupply } from './commands';
import type { Reading } from './mixing';

export interface Rule {
  /** 有効か（無効の行は評価しない） */
  on: boolean;
  /** 見るセンサの読み */
  sensor: Factor;
  /** 読みがしきい値より小さい（'<'）・大きい（'>'）ときに動く */
  op: '<' | '>';
  threshold: number;
  /** 入れる資材と量（資材の単位：肥料 mL・水 L・pH 剤 回） */
  supply: DoseSupply;
  amount: number;
  /** 動いた後、この分だけ同じ行を評価しない（0 なら次の刻みでまた動ける） */
  waitMin: number;
}

/** 制御器の状態：ルールと、行ごとに次に動ける時刻（経過時間 分） */
export interface Controller {
  rules: Rule[];
  readyAt: number[];
}

/** 行は数本まで（ルールの組み方を学ぶのが目的で、細かい場合分けを書かせないため） */
export const RULE_LIMIT = 6;
/** 資材ごとに1回で入れられる量の上限（入力の打ち間違いで槽を壊さないため。手の1回の数倍） */
export const AMOUNT_LIMIT: Record<DoseSupply, number> = { fertilizer: 50, water: 1, phDown: 5, phUp: 5 };
const SUPPLIES_OK: readonly DoseSupply[] = ['fertilizer', 'water', 'phDown', 'phUp'];

/** ルールを確かめて整える（範囲外の量・待ち時間は丸め、壊れた行・上限を超えた行は捨てる） */
export function cleanRules(rules: readonly Rule[]): Rule[] {
  return rules
    .filter(r => r && FACTORS.includes(r.sensor) && (r.op === '<' || r.op === '>') && SUPPLIES_OK.includes(r.supply)
      && Number.isFinite(r.threshold) && Number.isFinite(r.amount) && r.amount > 0)
    .slice(0, RULE_LIMIT)
    .map(r => ({
      on: !!r.on, sensor: r.sensor, op: r.op, threshold: r.threshold, supply: r.supply,
      amount: Math.min(r.amount, AMOUNT_LIMIT[r.supply]),
      waitMin: Number.isFinite(r.waitMin) ? Math.max(0, Math.min(24 * 60, r.waitMin)) : 0,
    }));
}

export function createController(rules: readonly Rule[] = []): Controller {
  const r = cleanRules(rules);
  return { rules: r, readyAt: r.map(() => 0) };
}

/**
 * 今の刻みで動く行（添字）を返し、動いた行の次に動ける時刻を進める。
 * 行は上から順に独立に評価する（同じ刻みで複数の行が動いてよい）
 */
export function dueRules(ctl: Controller, reading: Reading, minute: number): number[] {
  const out: number[] = [];
  ctl.rules.forEach((r, i) => {
    if (!r.on || minute < ctl.readyAt[i]) return;
    const v = reading[r.sensor];
    if (r.op === '<' ? v < r.threshold : v > r.threshold) {
      out.push(i);
      ctl.readyAt[i] = minute + r.waitMin;
    }
  });
  return out;
}

export const ruleCommand = (r: Rule, target: string): Command => ({ type: 'dose', target, supply: r.supply, amount: r.amount });

/**
 * ひな形：作物の適正帯から作る「適切なルール」。EC・pH は帯の内側 2 割の線（上げる線と下げる線の間が不感帯）、液量は 3 割の線で、
 * 手の1回と同じ量を入れ、60 分待つ（センサの間隔 30 分では入れた分が混ざりきらず、読みに出きらないため）。
 * 「EC が高い → 水」の行は入れない（液量の上側に寄せて液量の外れを招き、ひまわりで等級が下がった。液量の下限の線が薄め役を兼ねる）
 */
export function templateRules(crop: string): Rule[] {
  const b = CROPS[crop].bands, line = (k: Factor, at: number) => b[k][1] + (b[k][2] - b[k][1]) * at;
  const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
  return [
    { on: true, sensor: 'ec', op: '<', threshold: round(line('ec', 0.2)), supply: 'fertilizer', amount: 10, waitMin: 60 },
    { on: true, sensor: 'ph', op: '>', threshold: round(line('ph', 0.8)), supply: 'phDown', amount: 1, waitMin: 60 },
    { on: true, sensor: 'ph', op: '<', threshold: round(line('ph', 0.2)), supply: 'phUp', amount: 1, waitMin: 60 },
    { on: true, sensor: 'water', op: '<', threshold: round(line('water', 0.3)), supply: 'water', amount: 0.2, waitMin: 60 },
  ];
}

/** 不感帯も待ち時間もない ON/OFF（悪い例）：上げる・下げるのしきい値をどちらも帯の真ん中にし、刻みごとに入れる */
export function bangBangRules(crop: string): Rule[] {
  const b = CROPS[crop].bands, mid = (k: Factor) => (b[k][1] + b[k][2]) / 2;
  return [
    { on: true, sensor: 'ec', op: '<', threshold: mid('ec'), supply: 'fertilizer', amount: 10, waitMin: 0 },
    { on: true, sensor: 'ph', op: '>', threshold: mid('ph'), supply: 'phDown', amount: 1, waitMin: 0 },
    { on: true, sensor: 'ph', op: '<', threshold: mid('ph'), supply: 'phUp', amount: 1, waitMin: 0 },
    { on: true, sensor: 'water', op: '<', threshold: mid('water'), supply: 'water', amount: 0.2, waitMin: 0 },
  ];
}
