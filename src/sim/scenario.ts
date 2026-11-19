// 課題（Phase 6）：課題のデータ（scenarios.json）から栽培・症状診断・経営の状態を作り、達成条件を sim の状態で判定する。
// sim は文言を持たない（課題の題・説明・ヒントは json にあり、画面が出す）

import scenariosJson from '../data/scenarios.json';
import { fill, type Solution } from './compartment';
import { CROPS, GRADES, type Grade } from './crop';
import type { ScheduledEvent } from './facility';
import { createFarm, totals, type FarmState } from './farm';
import { createQuiz, quizScore, type Quiz } from './quiz';
import { bedOf, createSim, HYDROPONIC, resampleSensors, type SimState } from './sim';

/** 達成条件（書いたものをすべて満たす）。栽培は収穫が前提 */
export interface ScenarioGoal {
  /** 栽培：この等級以上で収穫する */
  grade?: Grade;
  /** 栽培：養液・調整剤の費用の上限 円 */
  maxSupplies?: number;
  /** 栽培・経営：利益の下限 円（経営は days 日間の合計） */
  minProfit?: number;
  /** 症状診断：正答数の下限 */
  minScore?: number;
  /** 経営：この日数を回し終えたら判定する（必須） */
  days?: number;
  /** 経営：欠品の回数（全契約の合計）の上限 */
  maxMisses?: number;
  /** 経営：評判の下限 */
  minReputation?: number;
}

export interface Scenario {
  id: string;
  /** 画面用の題・説明・ヒント（sim は使わない） */
  title: string;
  brief: string;
  hint: string;
  mode: 'grow' | 'quiz' | 'farm';
  /** 栽培の作物 */
  crop?: string;
  /** 乱数のシード（症状診断の出題・抽選のイベント）。省くと startScenario に渡したシード */
  seed?: number;
  /** 停電・ポンプの停止を抽選で起こす */
  events?: boolean;
  /** 決まった時刻に起こすイベント */
  schedule?: ScheduledEvent[];
  /** 栽培：始めの養液（省いた値は通常の初期値）。全交換で戻るのは通常の初期値 */
  initial?: Partial<Solution>;
  /** 案内つき（初回の1周） */
  guide?: boolean;
  goal: ScenarioGoal;
}

/** 課題の一覧（並び順が画面の順） */
export const SCENARIOS = scenariosJson as unknown as Scenario[];

export const scenarioById = (id: string): Scenario => {
  const sc = SCENARIOS.find(s => s.id === id);
  if (!sc) throw new Error(`課題 ${id} がありません`);
  return sc;
};

/** 課題の進行中の状態（モードごとの sim の状態をそのまま持つ） */
export type ScenarioRun =
  | { scenario: string; mode: 'grow'; sim: SimState }
  | { scenario: string; mode: 'quiz'; quiz: Quiz }
  | { scenario: string; mode: 'farm'; farm: FarmState };

/** 課題を始める。seed は課題にシードがないときに使う（画面は毎回変える） */
export function startScenario(id: string, seed = 1): ScenarioRun {
  const sc = scenarioById(id), s = sc.seed ?? seed;
  switch (sc.mode) {
    case 'grow': {
      const sim = createSim({ crop: sc.crop, seed: s, events: sc.events, schedule: sc.schedule });
      if (sc.initial) {
        fill(bedOf(sim), { ...HYDROPONIC.compartments[0].initial, ...sc.initial });
        resampleSensors(sim);
      }
      return { scenario: id, mode: 'grow', sim };
    }
    case 'quiz':
      return { scenario: id, mode: 'quiz', quiz: createQuiz(s) };
    case 'farm':
      return { scenario: id, mode: 'farm', farm: createFarm({ seed: s, events: sc.events, schedule: sc.schedule }) };
  }
}

/** 条件ごとの判定。value は今の値（まだ決まらなければ null） */
export interface GoalCheck {
  key: keyof ScenarioGoal | 'harvest';
  target: number | string | true;
  value: number | string | boolean | null;
  ok: boolean;
}

export interface Verdict {
  /** running：まだ決まらない、cleared：達成、failed：未達（終わった、または取り返せない） */
  status: 'running' | 'cleared' | 'failed';
  checks: GoalCheck[];
  /** 自己ベストに使う値（大きいほど良い）。栽培は品質、症状診断は正答数、経営は利益 */
  score: number | null;
}

const gradeRank = (g: Grade) => GRADES.findIndex(([, x]) => x === g);

/** 課題の達成を判定する（状態は変えない） */
export function judgeScenario(run: ScenarioRun): Verdict {
  const g = scenarioById(run.scenario).goal, checks: GoalCheck[] = [];
  const add = (key: GoalCheck['key'], target: GoalCheck['target'], value: GoalCheck['value'], ok: boolean) => checks.push({ key, target, value, ok });
  const verdict = (done: boolean, score: number | null, lost = false): Verdict => {
    const ok = checks.every(c => c.ok);
    return { status: done ? (ok ? 'cleared' : 'failed') : lost ? 'failed' : 'running', checks, score };
  };

  if (run.mode === 'grow') {
    const r = run.sim.result, harvested = r?.outcome === 'harvest';
    add('harvest', true, r ? harvested : null, harvested);
    if (g.grade) add('grade', g.grade, r && harvested ? r.grade : null, !!r && harvested && gradeRank(r.grade) <= gradeRank(g.grade));
    // 資材費は途中でも分かる。上限を超えたら取り返せない
    if (g.maxSupplies !== undefined) add('maxSupplies', g.maxSupplies, run.sim.cost, run.sim.cost <= g.maxSupplies);
    if (g.minProfit !== undefined) add('minProfit', g.minProfit, r ? r.profit : null, !!r && r.profit >= g.minProfit);
    const over = g.maxSupplies !== undefined && run.sim.cost > g.maxSupplies;
    return verdict(!!r, r && harvested ? r.quality : null, over);
  }

  if (run.mode === 'quiz') {
    const z = run.quiz, done = z.answers.every(a => a), score = quizScore(z);
    const wrong = z.answers.filter(a => a).length - score;
    if (g.minScore !== undefined) add('minScore', g.minScore, score, score >= g.minScore);
    // 間違えた数が多く、残りを全部当てても届かない
    const lost = g.minScore !== undefined && z.questions.length - wrong < g.minScore;
    return verdict(done, done ? score : null, lost);
  }

  const f = run.farm, days = g.days ?? 30, done = f.hour >= days * 24;
  const misses = Object.values(f.contracts).reduce((a, c) => a + c.misses, 0);
  const profit = [...f.months, f.ledger].reduce((a, l) => a + totals(l).profit, 0);
  add('days', days, Math.min(days, Math.floor(f.hour / 24)), done);
  if (g.maxMisses !== undefined) add('maxMisses', g.maxMisses, misses, misses <= g.maxMisses);
  if (g.minProfit !== undefined) add('minProfit', g.minProfit, profit, profit >= g.minProfit);
  if (g.minReputation !== undefined) add('minReputation', g.minReputation, f.reputation, f.reputation >= g.minReputation);
  const lost = g.maxMisses !== undefined && misses > g.maxMisses;
  return verdict(done, done ? profit : null, lost);
}

/** データの検査（テストと起動時の確認用）：作物があり、モードに合った条件だけがある */
export function validateScenario(sc: Scenario): string[] {
  const errs: string[] = [], g = sc.goal;
  const only = (keys: (keyof ScenarioGoal)[]) => {
    for (const k of Object.keys(g) as (keyof ScenarioGoal)[]) if (!keys.includes(k)) errs.push(`${sc.id}：${sc.mode} に ${k} は使えない`);
  };
  if (sc.mode === 'grow') {
    if (!sc.crop || !CROPS[sc.crop]) errs.push(`${sc.id}：作物 ${sc.crop} がない`);
    only(['grade', 'maxSupplies', 'minProfit']);
  } else if (sc.mode === 'quiz') {
    if (g.minScore === undefined) errs.push(`${sc.id}：minScore がない`);
    only(['minScore']);
  } else {
    if (g.days === undefined) errs.push(`${sc.id}：days がない`);
    only(['days', 'maxMisses', 'minProfit', 'minReputation']);
  }
  return errs;
}
