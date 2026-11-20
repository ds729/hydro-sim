import { describe, expect, test } from 'vitest';
import {
  autoCount, bangBangRules, cleanRules, CONTROL, createController, createSim, CROPS, dueRules, resampleSensors, setRules, templateRules, tick, TRACE_HOURS,
  type Rule, type SimState,
} from './index';
import { fixPumps, runToEnd } from './testplay';

const phDown: Rule = { on: true, sensor: 'ph', op: '>', threshold: 6.3, supply: 'phDown', amount: 1, waitMin: 60 };
const reading = (ph: number) => ({ ec: 1.2, ph, water: 2, minute: 0 });

/** 栽培槽の pH の最小・最大を見ながら終わるまで進める（ルールだけで動かす。人は each で） */
function runWatch(s: SimState, each: (s: SimState) => void = () => {}) {
  let lo = Infinity, hi = -Infinity;
  const r = runToEnd(s, x => { each(x); const ph = x.compartments[0].ph; lo = Math.min(lo, ph); hi = Math.max(hi, ph); });
  return { r, lo, hi, auto: autoCount(s) };
}
const crops = Object.keys(CROPS);

describe('自動制御ルール（v1.1 区切り2）', () => {
  test('行の評価：しきい値を越えたら動き、待ち時間の間は動かない。無効の行は動かない', () => {
    const c = createController([phDown, { ...phDown, on: false }]);
    expect(dueRules(c, reading(6.2), 0)).toEqual([]);
    expect(dueRules(c, reading(6.4), 5)).toEqual([0]);
    expect(dueRules(c, reading(6.4), 30)).toEqual([]);
    expect(dueRules(c, reading(6.4), 65)).toEqual([0]);
  });

  test('ルールを整える：壊れた行は捨て、量・待ち時間は範囲に丸め、行は上限まで', () => {
    const bad = [{ ...phDown, sensor: 'o2' }, { ...phDown, amount: 0 }, { ...phDown, threshold: NaN }] as unknown as Rule[];
    expect(cleanRules(bad)).toEqual([]);
    expect(cleanRules([{ ...phDown, amount: 99, waitMin: -5 }])[0]).toMatchObject({ amount: 5, waitMin: 0 });
    expect(cleanRules(Array(10).fill(phDown))).toHaveLength(6);
  });

  test('動いた操作は手の操作と同じコマンドで、記録に auto・行・刻みの時刻が付く。状態は JSON にできる', () => {
    const s = createSim({ rules: [{ ...phDown, threshold: 5.9 }] });
    tick(s);
    const e = s.log.filter(x => x.kind === 'command');
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ auto: true, rule: 0, command: { type: 'dose', supply: 'phDown', amount: 1 } });
    const minute = (e[0] as { minute: number }).minute;
    expect(minute % CONTROL.stepMin).toBe(0);
    expect(minute).toBeLessThanOrEqual(60);
    expect(s.cost).toBe(20);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    setRules(s, []);
    expect(s.control).toEqual({ rules: [], readyAt: [] });
  });

  test('ひな形のルールだけで（人は何もしない）4作物とも S で収穫でき、操作は 20 回まで・資材費は 150 円まで', () => {
    for (const crop of crops) {
      const { r, auto } = runWatch(createSim({ crop, rules: templateRules(crop) }));
      expect(r.outcome, crop).toBe('harvest');
      expect(r.grade, crop).toBe('S');
      expect(auto, crop).toBeLessThanOrEqual(20);
      expect(r.costs.supplies, crop).toBeLessThanOrEqual(150);
    }
  });

  test('待ち時間なし：センサの読みが変わるまで入れ続けて行き過ぎ、上げ下げを繰り返して（ハンチング）等級が落ちる', () => {
    for (const crop of crops) {
      const { r, lo, hi, auto } = runWatch(createSim({ crop, rules: templateRules(crop).map(x => ({ ...x, waitMin: 0 })) }));
      const band = CROPS[crop].bands.ph;
      expect(r.grade, crop).not.toBe('S');
      expect(lo, crop).toBeLessThan(band[1]);
      expect(hi, crop).toBeGreaterThan(band[2]);
      expect(auto, crop).toBeGreaterThan(500);
    }
  });

  test('不感帯なし：待ち時間があっても上げ下げを繰り返し、品質は保てても資材費が何十倍にもなる', () => {
    for (const crop of crops) {
      const ok = runWatch(createSim({ crop, rules: templateRules(crop) }));
      const flat = runWatch(createSim({ crop, rules: bangBangRules(crop).map(x => ({ ...x, waitMin: 60 })) }));
      expect(flat.r.outcome, crop).toBe('harvest');
      expect(flat.auto, crop).toBeGreaterThan(ok.auto * 10);
      expect(flat.r.costs.supplies, crop).toBeGreaterThan(ok.r.costs.supplies * 10);
    }
  });

  test('不感帯も待ち時間もない ON/OFF は、行き過ぎとハンチングで C まで落ちるか枯れる', () => {
    for (const crop of crops) {
      const { r } = runWatch(createSim({ crop, rules: bangBangRules(crop) }));
      expect(r.outcome === 'dead' || r.grade === 'C' || r.grade === 'B', crop).toBe(true);
      expect(r.quality, crop).toBeLessThan(0.8);
    }
  });

  test('停電中は制御器が止まる（読みは取れず、ルールも動かない）。停電があっても無人で S', () => {
    const schedule = [{ hour: 60, kind: 'outage' as const, hours: 8 }, { hour: 150, kind: 'outage' as const, hours: 6 }];
    for (const crop of crops) {
      const s = createSim({ crop, rules: templateRules(crop), schedule });
      const frozen: number[] = [];
      const { r } = runWatch(s, x => { if (x.hour === 64) frozen.push(x.sensor.minute); });
      expect(frozen[0], crop).toBe(60 * 60);
      const during = s.log.filter(e => e.kind === 'command' && e.auto && ((e.hour >= 60 && e.hour < 68) || (e.hour >= 150 && e.hour < 156)));
      expect(during, crop).toEqual([]);
      expect(r.grade, crop).toBe('S');
    }
  });

  test('停電・ポンプの停止が抽選で起きても、止まったポンプを人が直せば、ルールで S を保てる', () => {
    for (const crop of crops) for (const seed of [1, 2, 3]) {
      const s = createSim({ crop, seed, events: true, rules: templateRules(crop) });
      const { r } = runWatch(s, fixPumps);
      expect(s.log.some(e => e.kind === 'pumpStop' || e.kind === 'outage'), `${crop} ${seed}`).toBe(true);
      expect(r.grade, `${crop} ${seed}`).toBe('S');
    }
  });
});

describe('センサの読みの推移（trace）', () => {
  test('直近24時間だけ残し、2時間ごとの記録では見えないハンチングが見える', () => {
    const s = createSim({ crop: 'radish', rules: bangBangRules('radish') });
    for (let h = 0; h < 72; h++) tick(s);
    expect(s.trace.length).toBeGreaterThan(40);
    expect(s.trace.length).toBeLessThanOrEqual(49);
    expect(s.trace[0].minute).toBeGreaterThanOrEqual(s.hour * 60 - TRACE_HOURS * 60);
    const range = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    // 悪い例は pH が 2時間の周期で上下する：30分ごとの読みでは振れ幅が大きく、2時間ごとの記録では同じ位相ばかり拾って小さく見える
    expect(range(s.trace.map(r => r.ph))).toBeGreaterThan(0.8);
    expect(range(s.history.slice(-12).map(r => r.ph))).toBeLessThan(0.3);
  });

  test('センサを取り直すと推移はその1点から', () => {
    const s = createSim({ crop: 'radish' });
    for (let h = 0; h < 5; h++) tick(s);
    resampleSensors(s);
    expect(s.trace).toHaveLength(1);
  });
});
