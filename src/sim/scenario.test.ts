import { describe, expect, test } from 'vitest';
import {
  answerQuiz, applyCommand, autoCount, bangBangRules, bedOf, createSim, ecOf, judgeScenario, nextQuestion, QUIZ_CAUSES, SCENARIOS, scenarioById,
  setRules, startScenario, templateRules, tick, validateScenario, type Rule, type ScenarioRun,
} from './index';
import { farmPlan, farmRun, FERT, fixPumps, keepInBand, PH_DOWN, runToEnd, WATER } from './testplay';

/** 課題の「資材を節約」で使う操作：適正帯の端に来てから戻す（pH ダウンの回数を減らす） */
function keepAtEdge(s: Parameters<typeof keepInBand>[0]) {
  const v = s.sensor;
  if (v.ph > 6.45) applyCommand(s, PH_DOWN);
  if (v.water < 1.25) applyCommand(s, WATER);
  if (v.ec < 0.85) applyCommand(s, FERT);
}

/**
 * 自動制御の課題の答えの例：ひな形のルール。「自動で節約」は pHダウンの線を帯の上端の近く（6.45）に上げる
 * （ひな形の線 6.3 では早めに入れて 80 円かかる）
 */
function autoAnswer(id: string): Rule[] {
  const sc = scenarioById(id), rules = templateRules(sc.crop!);
  if (id === 'autoThrifty') rules[1] = { ...rules[1], threshold: 6.45 };
  return rules;
}

/**
 * 課題を「帯に保つ操作」で最後まで遊ぶ（栽培は帯に保ってポンプを直す。資材を節約する課題は帯の端で戻す、自動制御の課題はルールだけで回す、
 * 診断は全問正解、経営は契約から逆算して播く）
 */
function play(run: ScenarioRun): ScenarioRun {
  const sc = scenarioById(run.scenario), days = sc.goal.days ?? 30;
  if (run.mode === 'grow' && sc.rules) {
    setRules(run.sim, autoAnswer(run.scenario));
    runToEnd(run.sim, fixPumps);
  } else if (run.mode === 'grow') {
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
    expect(ids.length).toBeLessThanOrEqual(12);
    // 自動制御の課題（v1.1）は 2〜3 個
    const auto = SCENARIOS.filter(s => s.rules);
    expect(auto.length).toBeGreaterThanOrEqual(2);
    expect(auto.length).toBeLessThanOrEqual(3);
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

describe('自動制御の課題（v1.1）', () => {
  const autoIds = SCENARIOS.filter(s => s.rules).map(s => s.id);
  /** ルールを入れて終わるまで回す（人は何もしない。ポンプは直す） */
  const withRules = (id: string, rules: Rule[]) => {
    const run = startScenario(id);
    if (run.mode !== 'grow') throw new Error();
    setRules(run.sim, rules);
    runToEnd(run.sim, fixPumps);
    return { run, v: judgeScenario(run) };
  };
  const failed = (v: ReturnType<typeof judgeScenario>) => v.checks.filter(c => !c.ok).map(c => c.key);

  test('ルールは自動制御の課題にだけ入る', () => {
    const r = templateRules('radish');
    const a = startScenario('autoThrifty', 1, r), b = startScenario('thrifty', 1, r);
    if (a.mode !== 'grow' || b.mode !== 'grow') throw new Error();
    expect(a.sim.control.rules).toHaveLength(r.length);
    expect(b.sim.control.rules).toEqual([]);
    expect(validateScenario({ ...scenarioById('thrifty'), goal: { maxAuto: 3 } })).not.toEqual([]);
    expect(validateScenario({ ...scenarioById('contract'), rules: true })).not.toEqual([]);
  });

  test.each(autoIds)('%s：手で帯に保っても、養液に手を入れた時点で未達', id => {
    const run = startScenario(id);
    if (run.mode !== 'grow') throw new Error();
    let failedAt: number | null = null;
    runToEnd(run.sim, s => {
      fixPumps(s); keepInBand(s);
      if (failedAt === null && judgeScenario(run).status === 'failed') failedAt = s.hour;
    });
    expect(failedAt).not.toBeNull();
    expect(failed(judgeScenario(run))).toContain('maxManual');
  });

  test('無人で1周：不感帯のない線（待ち時間はあり）だと S でも回数の上限を超え、ひな形なら 30 回以内', () => {
    const flat = withRules('autoFirst', bangBangRules('broccoli').map(r => ({ ...r, waitMin: 60 })));
    expect(flat.run.sim.result!.grade).toBe('S');
    expect(failed(flat.v)).toEqual(['maxAuto']);
    const ok = withRules('autoFirst', templateRules('broccoli'));
    expect(ok.v.status).toBe('cleared');
    // 自己ベストは自動の操作の回数（少ないほど良いので負の値）
    expect(ok.v.score).toBe(-autoCount(ok.run.sim));
  });

  test('自動で節約：ひな形のままでは pH を早めに下げて上限を超え、線を帯の端に寄せると達成', () => {
    const tmpl = withRules('autoThrifty', templateRules('radish'));
    expect(tmpl.run.sim.result!.grade).toBe('S');
    expect(failed(tmpl.v)).toEqual(['maxSupplies']);
    const ok = withRules('autoThrifty', autoAnswer('autoThrifty'));
    expect(ok.v.status).toBe('cleared');
    expect(ok.v.score).toBe(-ok.run.sim.cost);
  });

  test('自動で立て直す：待ち時間なしは入れすぎて行き過ぎ、回数も等級も届かない。待ち時間 30 分（センサの間隔）なら達成', () => {
    const tmpl = templateRules('pea');
    const rush = withRules('autoRecover', tmpl.map(r => ({ ...r, waitMin: 0 })));
    expect(failed(rush.v)).toEqual(expect.arrayContaining(['grade', 'maxAuto']));
    expect(withRules('autoRecover', tmpl.map(r => ({ ...r, waitMin: 30 }))).v.status).toBe('cleared');
    // 停電中は制御器が止まる（予定の2回とも起きる）
    expect(rush.run.sim.log.filter(e => e.kind === 'outage').map(e => e.hour)).toEqual([40, 120]);
  });
});
