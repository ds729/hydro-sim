import { describe, expect, test } from 'vitest';
import {
  answerQuiz, applyCommand, bedOf, createSim, ecOf, judgeScenario, nextQuestion, QUIZ_CAUSES, SCENARIOS, scenarioById, startScenario,
  tick, validateScenario, type ScenarioRun,
} from './index';
import { farmPlan, farmRun, FERT, fixPumps, keepInBand, PH_DOWN, runToEnd, WATER } from './testplay';

/** 課題の「資材を節約」で使う操作：適正帯の端に来てから戻す（pH ダウンの回数を減らす） */
function keepAtEdge(s: Parameters<typeof keepInBand>[0]) {
  const b = bedOf(s);
  if (b.ph > 6.45) applyCommand(s, PH_DOWN);
  if (b.water < 1.25) applyCommand(s, WATER);
  if (ecOf(b) < 0.85) applyCommand(s, FERT);
}

/** 課題を「帯に保つ操作」で最後まで遊ぶ（栽培は帯に保ってポンプを直す。資材を節約する課題は帯の端で戻す、診断は全問正解、経営は契約から逆算して播く） */
function play(run: ScenarioRun): ScenarioRun {
  const days = scenarioById(run.scenario).goal.days ?? 30;
  if (run.mode === 'grow') {
    const keep = run.scenario === 'thrifty' ? keepAtEdge : keepInBand;
    runToEnd(run.sim, s => { fixPumps(s); keep(s); });
  }
  else if (run.mode === 'quiz') {
    const z = run.quiz;
    do answerQuiz(z, z.questions[z.index].cause); while (nextQuestion(z));
  } else {
    const p = farmPlan();
    p.setup(run.farm);
    farmRun(run.farm, days * 24, p.each);
  }
  return run;
}

/** 何もしない（栽培は終わるまで、経営は期限まで進める。診断は答えない） */
function idle(run: ScenarioRun): ScenarioRun {
  if (run.mode === 'grow') runToEnd(run.sim);
  else if (run.mode === 'farm') farmRun(run.farm, (scenarioById(run.scenario).goal.days ?? 30) * 24);
  return run;
}

const ids = SCENARIOS.map(s => s.id);

describe('課題（Phase 6）', () => {
  test('データ：id が重ならず、8 個前後で、栽培・症状診断・経営とイベントにまたがる。条件はモードに合う', () => {
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(6);
    expect(ids.length).toBeLessThanOrEqual(10);
    for (const m of ['grow', 'quiz', 'farm']) expect(SCENARIOS.some(s => s.mode === m)).toBe(true);
    expect(SCENARIOS.some(s => s.schedule?.length || s.events)).toBe(true);
    // 初回の案内は最初の課題だけ
    expect(SCENARIOS.filter(s => s.guide).map(s => s.id)).toEqual([ids[0]]);
    for (const sc of SCENARIOS) {
      expect(validateScenario(sc)).toEqual([]);
      expect(sc.title && sc.brief && sc.hint).toBeTruthy();
    }
  });

  test.each(ids)('%s：帯に保つ操作で達成できる', id => {
    const v = judgeScenario(play(startScenario(id)));
    expect(v.checks.filter(c => !c.ok)).toEqual([]);
    expect(v.status).toBe('cleared');
    expect(v.score).not.toBeNull();
  });

  test.each(ids)('%s：無操作では達成できない', id => {
    expect(judgeScenario(idle(startScenario(id))).status).not.toBe('cleared');
  });

  test('始めの状態：養液の初期値を課題で変えられ、全交換では通常の初期値に戻る', () => {
    const run = startScenario('thin');
    if (run.mode !== 'grow') throw new Error();
    const b = bedOf(run.sim);
    expect(ecOf(b)).toBeCloseTo(0.3);
    expect(b.ph).toBeCloseTo(6);
    applyCommand(run.sim, { type: 'replaceSolution', target: 'bed' });
    expect(ecOf(b)).toBeCloseTo(1.2);
    expect(judgeScenario(run).status).toBe('running');
  });

  test('ポンプが止まった：予定の時刻にポンプが止まり停電が起き、直さないと根が酸欠で枯れる', () => {
    const run = startScenario('pump');
    if (run.mode !== 'grow') throw new Error();
    runToEnd(run.sim, keepInBand);
    const s = run.sim, sc = scenarioById('pump');
    const at = (k: string) => s.log.filter(e => e.kind === k).map(e => e.hour);
    expect(at('pumpStop')[0]).toBe(sc.schedule![0].hour);
    expect(at('outage')).toContain(sc.schedule![1].hour);
    expect(s.log.some(e => e.kind === 'hypoxia')).toBe(true);
    expect(s.result!.outcome).toBe('dead');
    expect(judgeScenario(run).status).toBe('failed');
  });

  test('予定のイベントは抽選のイベントを使わない栽培でも起き、乱数を引かない', () => {
    const s = createSim({ schedule: [{ hour: 3, kind: 'outage', hours: 2 }] }), rng = s.rng;
    for (let i = 0; i < 6; i++) tick(s);
    expect(s.log.filter(e => e.kind === 'outage')).toEqual([{ hour: 3, kind: 'outage', hours: 2 }]);
    expect(s.log.filter(e => e.kind === 'powerBack').map(e => e.hour)).toEqual([5]);
    expect(s.facility.schedule).toEqual([]);
    expect(s.rng).toBe(rng);
  });

  test('資材を節約：真ん中に合わせ直すと上限を超え、帯の端で戻せば達成できる。超えた時点で未達が決まる', () => {
    const naive = startScenario('thrifty'), edge = startScenario('thrifty');
    if (naive.mode !== 'grow' || edge.mode !== 'grow') throw new Error();
    let failedAt: number | null = null;
    runToEnd(naive.sim, s => {
      keepInBand(s);
      if (failedAt === null && judgeScenario(naive).status === 'failed') failedAt = s.hour;
    });
    expect(naive.sim.result!.grade).toBe('S');
    expect(judgeScenario(naive).status).toBe('failed');
    expect(failedAt).not.toBeNull();
    expect(failedAt!).toBeLessThan(naive.sim.hour);
    runToEnd(edge.sim, keepAtEdge);
    const v = judgeScenario(edge);
    expect(v.status).toBe('cleared');
    expect(edge.sim.cost).toBeLessThanOrEqual(scenarioById('thrifty').goal.maxSupplies!);
  });

  test('症状を見分ける：答えないうちは決まらず、1問でも間違えると未達が決まる', () => {
    const run = startScenario('diagnose', 7);
    if (run.mode !== 'quiz') throw new Error();
    expect(judgeScenario(run).status).toBe('running');
    const z = run.quiz, right = z.questions[0].cause;
    answerQuiz(z, QUIZ_CAUSES.find(c => c.factor !== right.factor || c.side !== right.side)!);
    expect(judgeScenario(run).status).toBe('failed');
  });

  test('トラブル続きの1か月：ポンプを直さないと欠品が出て未達', () => {
    const run = startScenario('trouble');
    if (run.mode !== 'farm') throw new Error();
    const p = farmPlan();
    p.setup(run.farm);
    // 帯に保ち播いて収穫するが、止まったポンプは直さない
    farmRun(run.farm, 30 * 24, f => {
      const down = f.facility.pumpDown;
      f.facility.pumpDown = [];
      p.each(f);
      f.facility.pumpDown = down;
    });
    const v = judgeScenario(run);
    expect(v.status).toBe('failed');
    expect(v.checks.find(c => c.key === 'maxMisses')!.ok).toBe(false);
  });

  test('経営は期限まで決まらない（欠品が上限を超えたら、その時点で未達）', () => {
    const run = startScenario('contract');
    if (run.mode !== 'farm') throw new Error();
    const p = farmPlan();
    p.setup(run.farm);
    farmRun(run.farm, 29 * 24, p.each);
    expect(judgeScenario(run).status).toBe('running');
    const idleRun = startScenario('contract');
    if (idleRun.mode !== 'farm') throw new Error();
    farmRun(idleRun.farm, 15 * 24);
    expect(judgeScenario(idleRun).status).toBe('failed');
  });

  test('ない課題はエラー', () => {
    expect(() => startScenario('nope')).toThrow();
  });
});
