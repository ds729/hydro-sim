import { describe, expect, test } from 'vitest';
import { applyCommand, bedOf, createSim, CROPS, cropSpec, diagnose, ecOf, mulberry32, tick, type Command, type SimState } from './index';

const fert: Command = { type: 'dose', target: 'bed', supply: 'fertilizer', amount: 10 };
const water: Command = { type: 'dose', target: 'bed', supply: 'water', amount: 0.2 };
const phDown: Command = { type: 'dose', target: 'bed', supply: 'phDown', amount: 1 };
const phUp: Command = { type: 'dose', target: 'bed', supply: 'phUp', amount: 1 };

/** 終わるまで進める。each は毎 tick の前に呼ぶ */
function runToEnd(s: SimState, each: (s: SimState) => void = () => {}) {
  for (let i = 0; i < 10000 && !s.result; i++) { each(s); tick(s); }
  return s.result!;
}

/** 適正帯の中ほどに保つ簡単な制御（自動制御ルールモードと同じくコマンドだけで操作する） */
function keepOptimal(s: SimState) {
  const b = bedOf(s);
  if (b.ph > 6.3) applyCommand(s, phDown);
  if (b.water < 1.6 || (ecOf(b) > 1.4 && b.water < 2)) applyCommand(s, water);
  if (ecOf(b) < 1.0) applyCommand(s, fert);
}

/** 作物の適正帯から作る制御：各要因を適正帯の内側 2 割より中に保つ（どの作物でも同じ規則） */
function keepInBand(s: SimState) {
  const b = bedOf(s), { ec, ph, water: w } = cropSpec(s).bands;
  const inner = (band: readonly number[]) => [band[1] + (band[2] - band[1]) * 0.2, band[2] - (band[2] - band[1]) * 0.2];
  const [ecLo, ecHi] = inner(ec), [phLo, phHi] = inner(ph), [wLo, wHi] = inner(w);
  if (b.ph > phHi) applyCommand(s, phDown);
  if (b.ph < phLo) applyCommand(s, phUp);
  if (b.water < wLo || (ecOf(b) > ecHi && b.water < wHi)) applyCommand(s, water);
  if (ecOf(b) < ecLo) applyCommand(s, fert);
}

describe('作物（Phase 3）', () => {
  test.each(Object.keys(CROPS))('%s：適正帯に保てば規定日数±5%で S 収穫', id => {
    const s = createSim({ crop: id }), hours = cropSpec(s).days * 24;
    let minFit = 1;
    const r = runToEnd(s, s => { keepInBand(s); minFit = Math.min(minFit, diagnose(s).worst.value); });
    expect(minFit).toBe(1);
    expect(r.outcome).toBe('harvest');
    expect(s.hour).toBeGreaterThanOrEqual(hours * 0.95);
    expect(s.hour).toBeLessThanOrEqual(hours * 1.05);
    expect(r.grade).toBe('S');
  });

  test.each(Object.keys(CROPS))('%s：無操作では収穫できない', id => {
    expect(runToEnd(createSim({ crop: id })).outcome).not.toBe('harvest');
  });

  test('ない作物はエラー', () => {
    expect(() => createSim({ crop: 'tomato' })).toThrow();
  });
});

describe('roadmap Phase 1 の完了条件', () => {
  test('最適条件なら規定日数±5%で収穫できる', () => {
    const s = createSim(), hours = cropSpec(s).days * 24;
    let minFit = 1;
    const r = runToEnd(s, s => { keepOptimal(s); minFit = Math.min(minFit, diagnose(s).worst.value); });
    expect(minFit).toBe(1);
    expect(r.outcome).toBe('harvest');
    expect(s.hour).toBeGreaterThanOrEqual(hours * 0.95);
    expect(s.hour).toBeLessThanOrEqual(hours * 1.05);
    expect(r.grade).toBe('S');
  });

  test('無操作だと EC が単調に上がり、v0.4.1 と同じく Day 11 に枯死する', () => {
    const s = createSim();
    let prev = ecOf(bedOf(s));
    const r = runToEnd(s, s => {
      const ec = ecOf(bedOf(s));
      expect(ec).toBeGreaterThanOrEqual(prev);
      prev = ec;
    });
    expect(ecOf(bedOf(s))).toBeGreaterThan(prev - 1e-12);
    expect(r.outcome).toBe('dead');
    expect(s.hour).toBe(263);
  });

  test('pH 9 まで上げると枯死する', () => {
    const s = createSim();
    for (let i = 0; i < 10; i++) applyCommand(s, phUp);
    expect(bedOf(s).ph).toBe(9);
    expect(runToEnd(s).outcome).toBe('dead');
  });

  // v0.4.1 では 103 時間（Day 5）・540 円。2026-11-02 の裏取りで EC の適正帯を広げたので延びた
  test('6時間ごとに肥料を入れると EC 過多で Day 5 に枯死する', () => {
    const s = createSim();
    const r = runToEnd(s, s => { if (s.hour % 6 === 0) applyCommand(s, fert); });
    expect(r.outcome).toBe('dead');
    expect(s.hour).toBe(117);
    expect(r.cost).toBe(600);
    expect(r.profit).toBe(-600);
  });
});

describe('コマンド', () => {
  test('資材の効果と費用', () => {
    const s = createSim(), b = bedOf(s);
    applyCommand(s, fert);
    expect(ecOf(b)).toBeCloseTo(1.35);
    applyCommand(s, water);
    expect(b.water).toBeCloseTo(2.2);
    expect(s.cost).toBe(30);
    expect(s.log.at(-1)).toEqual({ hour: 0, kind: 'command', command: water });
  });

  test('液量は容量、pH は 3〜9 で頭打ち', () => {
    const s = createSim(), b = bedOf(s);
    for (let i = 0; i < 20; i++) { applyCommand(s, water); applyCommand(s, phDown); }
    expect(b.water).toBe(3);
    expect(b.ph).toBe(3);
  });

  test('全交換で初期組成に戻る', () => {
    const s = createSim(), b = bedOf(s);
    for (let i = 0; i < 50; i++) tick(s);
    applyCommand(s, fert);
    applyCommand(s, { type: 'replaceSolution', target: 'bed' });
    expect([b.water, ecOf(b), b.ph]).toEqual([2, 1.2, 6]);
    expect(s.cost).toBe(130);
  });

  test('終わった後は受け付けない', () => {
    const s = createSim();
    runToEnd(s);
    const cost = s.cost, n = s.log.length;
    expect(applyCommand(s, fert)).toBe(false);
    expect([s.cost, s.log.length]).toEqual([cost, n]);
  });
});

describe('記録', () => {
  test('毎朝の定点記録と、外れ続けた要因の観察メモが出る', () => {
    const s = createSim();
    for (let i = 0; i < 10; i++) applyCommand(s, phUp);
    for (let i = 0; i < 24; i++) tick(s);
    expect(s.log.filter(e => e.kind === 'morning').map(e => e.hour)).toEqual([24]);
    const advice = s.log.filter(e => e.kind === 'advice');
    expect(advice).toHaveLength(1);
    expect(advice[0]).toMatchObject({ hour: 3, factor: 'ph', side: 'high' });
    expect(s.history).toHaveLength(12);
  });

  test('観察メモの原因：直近の操作が外れた向きに動かしていればその資材、なければ自然な変化（null）', () => {
    const s = createSim();
    for (let i = 0; i < 10; i++) applyCommand(s, phUp);
    for (let i = 0; i < 4; i++) tick(s);
    expect(s.log.find(e => e.kind === 'advice')).toMatchObject({ factor: 'ph', side: 'high', driver: 'phUp', driverHour: 0 });

    // 適正なうちに入れた操作は原因にしない（pHアップで適正帯の中で上げ、その後の自然な上昇で外れる）
    const t = createSim();
    applyCommand(t, phUp);
    for (let i = 0; i < 200 && !t.log.some(e => e.kind === 'advice'); i++) tick(t);
    const a = t.log.find(e => e.kind === 'advice')!;
    expect(a).toMatchObject({ factor: 'ph', side: 'high', driver: null });
    expect(a.hour).toBeGreaterThan(24);

    // 外れたままなら、24 時間後のメモも同じ操作を原因にする
    const v = createSim();
    for (let i = 0; i < 8; i++) applyCommand(v, fert);
    for (let i = 0; i < 30; i++) tick(v);
    expect(v.log.filter(e => e.kind === 'advice' && e.factor === 'ec').map(e => e.kind === 'advice' && [e.hour, e.driver]))
      .toEqual([[3, 'fertilizer'], [27, 'fertilizer']]);

    // 全交換より前の操作は原因にしない
    const u = createSim();
    for (let i = 0; i < 10; i++) applyCommand(u, phUp);
    applyCommand(u, { type: 'replaceSolution', target: 'bed' });
    for (let i = 0; i < 200 && !u.log.some(e => e.kind === 'advice'); i++) tick(u);
    expect(u.log.find(e => e.kind === 'advice')).toMatchObject({ driver: null });
  });

  test('観察メモに適合度が付き、結果に品質を下げた原因の内訳（合計 ＝ 1 − 品質）が出る', () => {
    const s = createSim();
    const r = runToEnd(s, s => { if (s.hour % 6 === 0) applyCommand(s, fert); });
    const adv = s.log.find(e => e.kind === 'advice');
    expect(adv).toMatchObject({ factor: 'ec', side: 'high', driver: 'fertilizer' });
    if (adv?.kind === 'advice') expect(adv.fit).toBeLessThan(0.7);
    expect(r.losses[0].key).toBe('ec.high');
    expect(r.losses.reduce((a, l) => a + l.value, 0)).toBeCloseTo(1 - r.quality, 10);
    for (let i = 1; i < r.losses.length; i++) expect(r.losses[i].value).toBeLessThanOrEqual(r.losses[i - 1].value);
  });

  test('同じシードと操作なら同じ経過になる（状態はプレーンなデータ）', () => {
    const play = (seed: number) => {
      const s = createSim({ seed }), r = mulberry32(seed), cmds = [fert, water, phDown, phUp];
      runToEnd(s, s => { if (r() < 0.1) applyCommand(s, cmds[Math.floor(r() * cmds.length)]); });
      return JSON.stringify(s);
    };
    expect(play(7)).toBe(play(7));
    expect(play(7)).not.toBe(play(8));
    expect(structuredClone(createSim())).toEqual(createSim());
  });
});
