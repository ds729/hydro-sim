// 症状診断モード：1つの要因だけが適正帯を外れた栽培槽を作り、見た目から原因を当てる。文言は持たない（ui 側が symptoms.json から作る）

import { CROPS, FACTORS, type Factor } from './crop';
import { bedOf, createSim, type SimState } from './sim';
import { mulberry32 } from './rng';

export interface Cause { factor: Factor; side: 'low' | 'high' }

/** 出題する原因（液量過多は見た目の差が小さいので出さない） */
export const QUIZ_CAUSES: readonly Cause[] = [
  { factor: 'ec', side: 'low' }, { factor: 'ec', side: 'high' },
  { factor: 'ph', side: 'low' }, { factor: 'ph', side: 'high' },
  { factor: 'water', side: 'low' },
];

export const causeKey = (c: Cause) => `${c.factor}.${c.side}`;

export interface Question {
  crop: string;
  cause: Cause;
  /** 外れた要因の適合度（小さいほど症状が強い） */
  fit: number;
  growth: number;
  health: number;
}

export interface Quiz {
  questions: Question[];
  /** 各問の答え（未回答は null） */
  answers: (Cause | null)[];
  /** 今の問題の番号 */
  index: number;
}

/** 1周の問題を作る。原因は QUIZ_CAUSES を1回ずつ並べ替え、作物はランダム */
export function createQuiz(seed = 1): Quiz {
  const rand = mulberry32(seed);
  const causes = [...QUIZ_CAUSES];
  for (let i = causes.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [causes[i], causes[j]] = [causes[j], causes[i]];
  }
  const crops = Object.keys(CROPS);
  const questions = causes.map(cause => ({
    crop: crops[Math.floor(rand() * crops.length)], cause,
    fit: 0.1 + rand() * 0.25, growth: 0.55 + rand() * 0.35, health: 55 + rand() * 30,
  }));
  return { questions, answers: questions.map(() => null), index: 0 };
}

/** 問題の栽培槽：外れた要因以外は適正帯の中央、外れた要因は適合度 fit になる値 */
export function questionSim(q: Question): SimState {
  const s = createSim({ crop: q.crop }), bands = CROPS[q.crop].bands, bed = bedOf(s);
  const mid = (k: Factor) => (bands[k][1] + bands[k][2]) / 2;
  const v = Object.fromEntries(FACTORS.map(k => [k, mid(k)])) as Record<Factor, number>;
  const [a, , , d] = bands[q.cause.factor], [, b, c] = bands[q.cause.factor];
  v[q.cause.factor] = q.cause.side === 'low' ? a + q.fit * (b - a) : d - q.fit * (d - c);
  bed.water = v.water;
  bed.solutes.salts = v.ec * v.water;
  bed.ph = v.ph;
  Object.assign(s.crop, { growth: q.growth, health: q.health });
  return s;
}

/** 今の問題に答える。正解なら true。答え済みなら何もせず null */
export function answerQuiz(z: Quiz, c: Cause): boolean | null {
  if (z.index >= z.questions.length || z.answers[z.index]) return null;
  z.answers[z.index] = c;
  return causeKey(c) === causeKey(z.questions[z.index].cause);
}

/** 次の問題へ進める。全問終わったら false */
export function nextQuestion(z: Quiz): boolean {
  if (z.answers[z.index]) z.index++;
  return z.index < z.questions.length;
}

export const quizScore = (z: Quiz) =>
  z.answers.filter((a, i) => a && causeKey(a) === causeKey(z.questions[i].cause)).length;
