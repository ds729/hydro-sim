import { describe, expect, it } from 'vitest';
import type { Result } from '../sim';
import { emptyBests, parseBests, updateAuto, updateFarm, updateGrow, updateQuiz } from './records';

const result = (quality: number, profit: number, outcome: Result['outcome'] = 'harvest') => ({ outcome, quality, profit }) as Result;
/** 自動制御の回の結果（等級は品質から） */
const autoResult = (quality: number, supplies: number, outcome: Result['outcome'] = 'harvest') =>
  ({ outcome, quality, grade: quality >= 0.9 ? 'S' : 'B', costs: { supplies } }) as Result;

describe('自己ベスト', () => {
  it('栽培：作物ごとに最高の品質と利益を別々に残し、収穫できなかった回は数えない', () => {
    const b = emptyBests();
    expect(updateGrow(b, 'radish', result(0.9, 5000))).toEqual(['quality', 'profit']);
    expect(updateGrow(b, 'radish', result(0.97, 4000))).toEqual(['quality']);
    expect(updateGrow(b, 'radish', result(0.8, 6000))).toEqual(['profit']);
    expect(updateGrow(b, 'radish', result(0, -100, 'dead'))).toEqual([]);
    expect(b.grow.radish).toEqual({ quality: 0.97, profit: 6000, harvests: 3 });
    expect(b.grow.pea).toBeUndefined();
  });

  it('自動制御：ルールだけで収穫した回の品質と、S の回の最少の資材費・回数。手を入れた回・ルールのない回は数えない', () => {
    const b = emptyBests();
    expect(updateAuto(b, 'radish', autoResult(0.8, 20), { manual: 0, auto: 5 })).toEqual(['quality']);
    expect(b.auto.radish).toEqual({ quality: 0.8, supplies: null, ops: null, runs: 1 });
    expect(updateAuto(b, 'radish', autoResult(1, 80), { manual: 0, auto: 8 })).toEqual(['quality', 'supplies', 'ops']);
    expect(updateAuto(b, 'radish', autoResult(1, 60), { manual: 0, auto: 9 })).toEqual(['supplies']);
    expect(updateAuto(b, 'radish', autoResult(1, 10), { manual: 1, auto: 2 })).toEqual([]);
    expect(updateAuto(b, 'radish', autoResult(1, 10), { manual: 0, auto: 0 })).toEqual([]);
    expect(updateAuto(b, 'radish', autoResult(0, 0, 'dead'), { manual: 0, auto: 3 })).toEqual([]);
    expect(b.auto.radish).toEqual({ quality: 1, supplies: 60, ops: 8, runs: 3 });
  });

  it('症状診断：最高の正答数と回数', () => {
    const b = emptyBests();
    expect(updateQuiz(b, 3, 5)).toBe(true);
    expect(updateQuiz(b, 2, 5)).toBe(false);
    expect(updateQuiz(b, 5, 5)).toBe(true);
    expect(b.quiz).toEqual({ best: 5, of: 5, plays: 3 });
  });

  it('経営：最高の月の利益（赤字の月も記録）と評判の最高', () => {
    const b = emptyBests();
    expect(updateFarm(b, 1, -2000, 3)).toBe(true);
    expect(updateFarm(b, 2, 15000, 10)).toBe(true);
    expect(updateFarm(b, 3, 9000, 6)).toBe(false);
    expect(b.farm).toEqual({ monthProfit: 15000, month: 2, reputation: 10 });
  });

  it('壊れた保存値は空から', () => {
    expect(parseBests('{')).toEqual(emptyBests());
    expect(parseBests(null)).toEqual(emptyBests());
    // v1.0 の保存値（auto なし）も読める
    const old = parseBests('{"grow":{"radish":{"quality":1,"profit":1,"harvests":1}}}');
    expect(old.grow.radish.harvests).toBe(1);
    expect(old.auto).toEqual({});
  });
});
