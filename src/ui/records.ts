// 自己ベスト（このブラウザだけ。共有ランキングは作らない）。課題の自己ベストは tasks.ts（hydro-sim.tasks）、
// ここは自由に遊んだときの記録：栽培は作物ごとの最高品質・最高利益、自動制御（v1.1）は作物ごとの無人の回の品質・資材費・自動の操作回数、
// 症状診断は最高の正答数、経営は最高の月の利益と評判

import { gradeOf, type Result } from '../sim';
import { readStore, writeStore } from './store';

const KEY = 'hydro-sim.best';

export interface Bests {
  /** 作物ごと。quality は収穫したときの最高の品質、profit は最高の利益（別々の回でもよい）、harvests は収穫した回数 */
  grow: Record<string, { quality: number; profit: number; harvests: number }>;
  /**
   * 自動制御：作物ごとの、ルールだけで（養液に手を入れずに）収穫した回。quality は最高の品質、supplies・ops は等級 S の回のうち
   * 最少の資材費・自動の操作の回数（S を取っていなければ null）、runs は回数
   */
  auto: Record<string, AutoBest>;
  /** 症状診断：最高の正答数（of 問中）と遊んだ回数 */
  quiz: { best: number; of: number; plays: number } | null;
  /** 経営：締めた月の最高の利益（何か月目か）と、評判の最高 */
  farm: { monthProfit: number; month: number; reputation: number } | null;
}

export interface AutoBest { quality: number; supplies: number | null; ops: number | null; runs: number }

export const emptyBests = (): Bests => ({ grow: {}, auto: {}, quiz: null, farm: null });

/** 保存値を読む（壊れていたら空から） */
export function parseBests(raw: string | null): Bests {
  try {
    const v = JSON.parse(raw ?? 'null');
    // v1.0 の保存値には auto がない
    if (v && typeof v.grow === 'object' && v.grow) return { grow: v.grow, auto: v.auto && typeof v.auto === 'object' ? v.auto : {}, quiz: v.quiz ?? null, farm: v.farm ?? null };
  } catch { /* 壊れている */ }
  return emptyBests();
}

/** 収穫を記録する。更新した項目（'quality'・'profit'）を返す。収穫できなかった回は数えない */
export function updateGrow(b: Bests, crop: string, r: Result): ('quality' | 'profit')[] {
  if (r.outcome !== 'harvest') return [];
  const g = b.grow[crop];
  if (!g) { b.grow[crop] = { quality: r.quality, profit: r.profit, harvests: 1 }; return ['quality', 'profit']; }
  g.harvests++;
  const up: ('quality' | 'profit')[] = [];
  if (r.quality > g.quality) { g.quality = r.quality; up.push('quality'); }
  if (r.profit > g.profit) { g.profit = r.profit; up.push('profit'); }
  return up;
}

/**
 * ルールだけで回した収穫を記録する（養液に手を入れた回・自動の操作がない回は数えない）。更新した項目を返す。
 * 資材費と回数は等級 S の回だけ比べる（等級を落としてよければいくらでも減らせるため）
 */
export function updateAuto(b: Bests, crop: string, r: Result, n: { manual: number; auto: number }): ('quality' | 'supplies' | 'ops')[] {
  if (r.outcome !== 'harvest' || n.manual > 0 || n.auto === 0) return [];
  const g = (b.auto[crop] ??= { quality: -1, supplies: null, ops: null, runs: 0 }), up: ('quality' | 'supplies' | 'ops')[] = [];
  g.runs++;
  if (r.quality > g.quality) { g.quality = r.quality; up.push('quality'); }
  if (r.grade === 'S') {
    const cost = r.costs.supplies;
    if (g.supplies === null || cost < g.supplies) { g.supplies = cost; up.push('supplies'); }
    if (g.ops === null || n.auto < g.ops) { g.ops = n.auto; up.push('ops'); }
  }
  return up;
}

/** 症状診断の1周を記録する。最高の正答数を更新したら true */
export function updateQuiz(b: Bests, score: number, of: number): boolean {
  const q = b.quiz;
  if (!q) { b.quiz = { best: score, of, plays: 1 }; return true; }
  q.plays++;
  if (score <= q.best) return false;
  q.best = score;
  q.of = of;
  return true;
}

/** 経営で月を締めたときに記録する。最高の月の利益を更新したら true（評判の最高はいつも更新） */
export function updateFarm(b: Bests, month: number, profit: number, reputation: number): boolean {
  const f = b.farm;
  if (!f) { b.farm = { monthProfit: profit, month, reputation }; return true; }
  f.reputation = Math.max(f.reputation, reputation);
  if (profit <= f.monthProfit) return false;
  f.monthProfit = profit;
  f.month = month;
  return true;
}

export const yen = (v: number) => `${v < 0 ? '−' : ''}¥${Math.round(Math.abs(v)).toLocaleString()}`;
/** 品質を「S（品質 97%）」の形に */
export const qualityText = (q: number) => `${gradeOf(q).grade}（品質 ${(q * 100).toFixed(0)}%）`;

// ---- このブラウザへの保存 ----

let bests: Bests = parseBests(readStore(KEY));

const save = () => writeStore(KEY, JSON.stringify(bests));

export const getBests = (): Readonly<Bests> => bests;

const UP_NAME = { quality: '品質', profit: '利益', supplies: '資材費', ops: '自動の操作の回数' } as const;

/** 自由に遊んだ収穫を記録し、更新したら結果画面に出す一文を返す。n は養液に手を入れた回数と自動の操作の回数 */
export function recordGrow(crop: string, r: Result, n: { manual: number; auto: number }): string {
  const up = updateGrow(bests, crop, r), upAuto = updateAuto(bests, crop, r, n);
  if (!up.length && !upAuto.length) return '';
  save();
  return (up.length ? `<div class="nb">🏆 自己ベスト更新：${up.map(k => UP_NAME[k]).join('・')}</div>` : '')
    + (upAuto.length ? `<div class="nb">⚙ 自動制御の自己ベスト更新：${upAuto.map(k => UP_NAME[k]).join('・')}</div>` : '');
}

export function recordQuiz(score: number, of: number): string {
  const up = updateQuiz(bests, score, of);
  save();
  return up ? '<div class="nb">🏆 自己ベスト更新</div>' : `<small>自己ベスト ${bests.quiz!.best} 問</small>`;
}

export function recordFarm(month: number, profit: number, reputation: number): boolean {
  const up = updateFarm(bests, month, profit, reputation);
  save();
  return up;
}

/** 記録を消す（課題の記録は tasks.ts の clearTasks） */
export function clearBests(): void {
  bests = emptyBests();
  save();
}
