// 自己ベスト（このブラウザだけ。共有ランキングは作らない）。課題の自己ベストは tasks.ts（hydro-sim.tasks）、
// ここは自由に遊んだときの記録：栽培は作物ごとの最高品質・最高利益、症状診断は最高の正答数、経営は最高の月の利益と評判

import { gradeOf, type Result } from '../sim';
import { readStore, writeStore } from './store';

const KEY = 'hydro-sim.best';

export interface Bests {
  /** 作物ごと。quality は収穫したときの最高の品質、profit は最高の利益（別々の回でもよい）、harvests は収穫した回数 */
  grow: Record<string, { quality: number; profit: number; harvests: number }>;
  /** 症状診断：最高の正答数（of 問中）と遊んだ回数 */
  quiz: { best: number; of: number; plays: number } | null;
  /** 経営：締めた月の最高の利益（何か月目か）と、評判の最高 */
  farm: { monthProfit: number; month: number; reputation: number } | null;
}

export const emptyBests = (): Bests => ({ grow: {}, quiz: null, farm: null });

/** 保存値を読む（壊れていたら空から） */
export function parseBests(raw: string | null): Bests {
  try {
    const v = JSON.parse(raw ?? 'null');
    if (v && typeof v.grow === 'object' && v.grow) return { grow: v.grow, quiz: v.quiz ?? null, farm: v.farm ?? null };
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

/** 自由に遊んだ収穫を記録し、更新したら結果画面に出す一文を返す */
export function recordGrow(crop: string, r: Result): string {
  const up = updateGrow(bests, crop, r);
  if (!up.length) return '';
  save();
  return `<div class="nb">🏆 自己ベスト更新：${up.map(k => (k === 'quality' ? '品質' : '利益')).join('・')}</div>`;
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
