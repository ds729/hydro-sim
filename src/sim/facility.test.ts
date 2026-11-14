import { describe, expect, test } from 'vitest';
import {
  FACILITY, applyCommand, applyFarmCommand, bedOf, createFarm, createSim, farmTick, o2Fitness, startOutage, stopPump, tick,
  type FarmState, type SimState,
} from './index';

const run = (s: SimState, hours: number) => { for (let i = 0; i < hours; i++) tick(s); };
const runFarm = (f: FarmState, hours: number) => { for (let i = 0; i < hours; i++) farmTick(f); };
/** 設備のイベントの記録 */
type Logged = { kind: string; hour: number; hours?: number };
const events = (log: readonly Logged[], kind: string): Logged[] => log.filter(e => e.kind === kind);

describe('設備（Phase 5）：停電・ポンプの停止・溶存酸素', () => {
  test('イベントなし（既定）では乱数を引かず、ポンプは回り続けて酸素は適正のまま', () => {
    const s = createSim({ seed: 7 }), rng = s.rng;
    run(s, 24 * 5);
    expect(s.rng).toBe(rng);
    expect(o2Fitness(bedOf(s))).toBe(1);
    expect(s.log.some(e => ['outage', 'pumpStop', 'hypoxia'].includes(e.kind))).toBe(false);
  });

  test('ポンプが止まると酸素が減り、根の酸欠の観察メモが出て健康度が落ちる。直すと戻る', () => {
    const s = createSim(), ref = createSim();
    run(s, 24);
    run(ref, 24);
    stopPump(s.facility, 'bed');
    // 一晩（8時間）なら酸欠にならない
    run(s, 8);
    run(ref, 8);
    expect(o2Fitness(bedOf(s))).toBe(1);
    run(s, 40);
    run(ref, 40);
    const hx = events(s.log, 'hypoxia');
    expect(hx.length).toBeGreaterThan(0);
    expect(hx[0]).toMatchObject({ target: 'bed', pump: false });
    expect(s.crop.health).toBeLessThan(ref.crop.health - 5);
    expect(s.crop.growth).toBeLessThan(ref.crop.growth);
    expect(s.loss['o2.low']).toBeGreaterThan(0);
    // 直す（記録に残る）。止まっていないポンプは直せない
    expect(applyCommand(s, { type: 'fixPump', target: 'bed' })).toBe(true);
    expect(applyCommand(s, { type: 'fixPump', target: 'bed' })).toBe(false);
    expect(s.log.at(-1)).toMatchObject({ kind: 'command', command: { type: 'fixPump' } });
    run(s, 4);
    expect(o2Fitness(bedOf(s))).toBe(1);
  });

  test('明期の停電は成長が止まり、夜の停電は照明に響かない。時間が来ると電気が戻る', () => {
    const lag = (startHour: number, hours: number) => {
      const s = createSim(), ref = createSim();
      run(s, startHour);
      run(ref, startHour);
      startOutage(s.facility, hours);
      run(s, hours + 2);
      run(ref, hours + 2);
      expect(events(s.log, 'powerBack').map(e => e.hour)).toEqual([startHour + hours]);
      return ref.crop.growth - s.crop.growth;
    };
    // Day 2 の 10時から6時間：6時間分の成長が遅れる
    expect(lag(34, 6)).toBeCloseTo((6 * 1) / (8 * 24), 3);
    // Day 3 の 0時から4時間（消灯中）：遅れない（ポンプも4時間なら酸欠にならない）
    expect(lag(48, 4)).toBeCloseTo(0, 6);
  });

  test('停電中は吸水が減る（照明が消えて蒸散が落ちる）', () => {
    const s = createSim(), ref = createSim();
    run(s, 34);
    run(ref, 34);
    startOutage(s.facility, 6);
    const w0 = bedOf(s).water;
    run(s, 6);
    run(ref, 6);
    expect(w0 - bedOf(s).water).toBeLessThan((w0 - bedOf(ref).water) * 0.3);
  });

  test('イベントあり：同じシードなら同じ時刻に起き、頻度はおおむね facility.json の間隔どおり', () => {
    const go = (seed: number) => {
      const f = createFarm({ seed, events: true });
      runFarm(f, 24 * 120);
      return f.log.filter(e => ['outage', 'pumpStop', 'powerBack'].includes(e.kind));
    };
    const a = go(3), b = go(3), c = go(4);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    const outages = events(a, 'outage').length, stops = events(a, 'pumpStop').length;
    expect(outages).toBeGreaterThanOrEqual(120 / FACILITY.outage.meanIntervalDays / 3);
    expect(outages).toBeLessThanOrEqual((120 / FACILITY.outage.meanIntervalDays) * 2);
    // 直さないので、ポンプは1回止まったらそのまま
    expect(stops).toBe(1);
    for (const e of events(a, 'outage')) {
      const h = e.hours!;
      expect(h).toBeGreaterThanOrEqual(FACILITY.outage.hours[0]);
      expect(h).toBeLessThanOrEqual(FACILITY.outage.hours[1]);
    }
  });

  test('経営：非常用電源があれば停電中もポンプが回る。予備ポンプは止まったら自動で切り替える', () => {
    const o2After = (ups: boolean) => {
      const f = createFarm();
      if (ups) applyFarmCommand(f, { type: 'buy', item: 'ups' });
      for (let i = 0; i < 8; i++) applyFarmCommand(f, { type: 'sow', rack: 'rack1', slot: i, crop: 'radish' });
      runFarm(f, 48);
      startOutage(f.facility, 8);
      runFarm(f, 8);
      return f.compartments[0].o2;
    };
    expect(o2After(true)).toBeGreaterThan(0.8);
    expect(o2After(false)).toBeLessThan(0.75);

    const f = createFarm();
    expect(applyFarmCommand(f, { type: 'fixPump', target: 'rack1' })).toBe(false);
    applyFarmCommand(f, { type: 'buy', item: 'sparePump' });
    stopPump(f.facility, 'rack1');
    const labor = f.ledger.laborMin;
    farmTick(f);
    expect(f.facility.pumpDown).toEqual([]);
    expect(f.log.at(-1)).toMatchObject({ kind: 'command', command: { type: 'fixPump', target: 'rack1' }, auto: true });
    expect(f.ledger.laborMin).toBe(labor + 15);
  });

  test('経営：ポンプを止めたままにすると、棚の苗が根の酸欠で枯れる', () => {
    const f = createFarm();
    for (let i = 0; i < 8; i++) applyFarmCommand(f, { type: 'sow', rack: 'rack1', slot: i, crop: 'sunflower' });
    runFarm(f, 24);
    stopPump(f.facility, 'rack1');
    runFarm(f, 24 * 6);
    expect(events(f.log, 'hypoxia').length).toBeGreaterThan(0);
    const dead = f.log.filter(e => e.kind === 'dead');
    expect(dead.length).toBe(8);
    expect(dead.every(e => e.kind === 'dead' && e.reason === 'hypoxia')).toBe(true);
  });
});
