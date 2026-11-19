import { describe, expect, test } from 'vitest';
import { applyCommand, bedOf, CONTROL, createSim, ecOf, mixing, stopPump, tick, valuesOf, type Command } from './index';

const fert: Command = { type: 'dose', target: 'bed', supply: 'fertilizer', amount: 10 };
const phDown: Command = { type: 'dose', target: 'bed', supply: 'phDown', amount: 1 };

describe('制御の遅れ（v1.1 区切り1）', () => {
  test('入れた資材はすぐには効かない：費用はすぐかかり、栽培槽とセンサの読みは変わらず、見込みだけが変わる', () => {
    const s = createSim(), b = bedOf(s);
    applyCommand(s, fert);
    expect(s.cost).toBeCloseTo(1);
    expect(ecOf(b)).toBeCloseTo(1.2);
    expect(s.sensor.ec).toBeCloseTo(1.2);
    expect(valuesOf(s, 'settled').ec).toBeCloseTo(1.35);
    expect(mixing(s)).toBe(true);
  });

  test('混ざる速さ：ポンプが回っていれば1時間で 1 − e^(−60/τ) が混ざり、数時間で混ざりきる', () => {
    const s = createSim(), t = createSim();
    applyCommand(s, phDown);
    applyCommand(t, phDown);
    tick(s);
    tick(t);
    // 作物の pH の上昇は s と t で同じなので、差は混ざった分だけ（資材なしの sim と比べる）
    const ref = createSim();
    tick(ref);
    const done = (bedOf(ref).ph - bedOf(s).ph) / 0.3;
    expect(done).toBeCloseTo(1 - Math.exp(-60 / CONTROL.mixTauMin), 2);
    for (let i = 0; i < 6; i++) tick(s);
    expect(mixing(s)).toBe(false);
  });

  test('ポンプが止まると混ざるのが遅い（水面からゆっくり）', () => {
    const run = createSim(), stop = createSim(), ref = createSim();
    stopPump(stop.facility, 'bed');
    stopPump(ref.facility, 'bed');
    applyCommand(run, phDown);
    applyCommand(stop, phDown);
    tick(run);
    tick(stop);
    tick(ref);
    const done = (bedOf(ref).ph - bedOf(stop).ph) / 0.3;
    expect(done).toBeCloseTo(1 - Math.exp(-60 / CONTROL.mixTauStoppedMin), 2);
    expect(done).toBeLessThan(0.5);
    expect(bedOf(run).ph).toBeLessThan(bedOf(stop).ph);
  });

  test('センサの読みは決まった間隔でしか変わらない：取った時刻は間隔の倍数で、1時間の終わりの読みは栽培槽の値', () => {
    const s = createSim();
    expect(60 % CONTROL.stepMin).toBe(0);
    expect(CONTROL.sensorIntervalMin % CONTROL.stepMin).toBe(0);
    for (let i = 0; i < 5; i++) {
      applyCommand(s, fert);
      tick(s);
      expect(s.sensor.minute).toBe(s.hour * 60);
      expect(s.sensor.minute % CONTROL.sensorIntervalMin).toBe(0);
      expect(s.sensor.ec).toBeCloseTo(ecOf(bedOf(s)), 10);
    }
  });

  test('全交換はすぐ入れ替わり、混ざっていない資材も捨てる（センサは次の読みまで前の値）', () => {
    const s = createSim();
    for (let i = 0; i < 30; i++) tick(s);
    const before = s.sensor.ec;
    for (let i = 0; i < 5; i++) applyCommand(s, fert);
    applyCommand(s, { type: 'replaceSolution', target: 'bed' });
    expect(mixing(s)).toBe(false);
    expect(ecOf(bedOf(s))).toBeCloseTo(1.2);
    expect(s.sensor.ec).toBe(before);
    tick(s);
    expect(s.sensor.ec).toBeCloseTo(ecOf(bedOf(s)), 10);
  });

  test('状態はプレーンなデータのまま（混ざっていない分とセンサの読みも JSON にできる）', () => {
    const s = createSim();
    applyCommand(s, fert);
    tick(s);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});
