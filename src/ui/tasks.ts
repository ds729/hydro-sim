// 課題の画面：☰ の「課題」一覧、課題中の目標（HUD の上）、達成の判定の表示。中身は scenarios.json と sim の judgeScenario から作る。
// 達成の記録はこのブラウザに保存する（自己ベストの表示は区切り5）

import { CROPS, SCENARIOS, type GoalCheck, type Scenario, type Verdict } from '../sim';
import { shortName } from './result';

const KEY = 'hydro-sim.tasks';
const $ = (id: string) => document.getElementById(id)!;

export interface TaskRecord {
  cleared: boolean;
  /** 達成したときの最高の score（栽培は品質、診断は正答数、経営は利益） */
  best: number | null;
}

function load(): Record<string, TaskRecord> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (v && typeof v === 'object') return v;
  } catch { /* 保存値が壊れている・ストレージが使えない */ }
  return {};
}

const records = load();

export const taskRecord = (id: string): TaskRecord | undefined => records[id];
/** 記録が1つもない（初めて開いた）か */
export const noRecords = () => Object.keys(records).length === 0;

/** 終わった課題を記録する（達成したら達成の印と最高の score） */
export function recordTask(id: string, v: Verdict): void {
  const r = (records[id] ??= { cleared: false, best: null });
  if (v.status === 'cleared') {
    r.cleared = true;
    if (v.score !== null && (r.best === null || v.score > r.best)) r.best = v.score;
  }
  try { localStorage.setItem(KEY, JSON.stringify(records)); } catch { /* 保存できなくても今回は効く */ }
}

const MODE: Record<Scenario['mode'], string> = { grow: '🌱 栽培', quiz: '🔍 症状診断', farm: '📒 経営' };
const yen = (v: number) => `${v < 0 ? '−' : ''}¥${Math.round(Math.abs(v)).toLocaleString()}`;

/** 条件の文と今の値 */
function checkText(c: GoalCheck): [string, string] {
  const v = c.value;
  switch (c.key) {
    case 'harvest': return ['収穫する', v === null ? '育成中' : v ? '収穫' : '収穫できず'];
    case 'grade': return [`等級 ${c.target} 以上`, v === null ? '—' : `${v}`];
    case 'maxSupplies': return [`養液・調整剤 ¥${c.target} 以内`, yen(v as number)];
    case 'minProfit': return [`利益 ${yen(c.target as number)} 以上`, v === null ? '—' : yen(v as number)];
    case 'minScore': return [`${c.target} 問正解`, `${v} 問`];
    case 'days': return [`${c.target} 日回す`, `${v} 日`];
    case 'maxMisses': return [`欠品 ${c.target} 回以内`, `${v} 回`];
    case 'minReputation': return [`評判 ${c.target} 以上`, `${v}`];
  }
}

/** 条件の一覧。進行中で未達成の条件は「・」、決まったら ✓ / ✗ */
export function checksHtml(v: Verdict): string {
  return '<ul class="tc">' + v.checks.map(c => {
    const [t, val] = checkText(c), mark = c.ok ? '✓' : v.status === 'running' && !(c.key === 'maxSupplies' || c.key === 'maxMisses') ? '・' : '✗';
    return `<li class="${mark === '✓' ? 'ok' : mark === '✗' ? 'ng' : ''}"><i>${mark}</i>${t}<span>${val}</span></li>`;
  }).join('') + '</ul>';
}

const STATUS: Record<Verdict['status'], string> = { running: '', cleared: '<b class="ok">達成！</b>', failed: '<b class="ng">未達</b>' };

/** 課題中の目標（HUD の上、#tg）。やめる・もう一度・一覧・終えるのボタンは data-ta で main が受ける */
export function goalHtml(sc: Scenario, v: Verdict): string {
  if (v.status === 'running') return `<div class="th"><b>🎯 ${sc.title}</b><span><button data-ta="quit">やめる</button></span></div>${checksHtml(v)}`;
  return `<div class="th"><b>🎯 ${sc.title}</b>${STATUS[v.status]}</div>${checksHtml(v)}`
    + '<div class="g3 tb"><button data-ta="retry">もう一度</button><button data-ta="list">一覧</button><button data-ta="quit" title="課題を終えて、元の続きに戻る">終える</button></div>';
}

/** 結果の判定（結果画面・課題の終わりの窓）。ボタンは data-ta */
export function verdictHtml(sc: Scenario, v: Verdict): string {
  const head = v.status === 'cleared' ? '🎉 課題 達成！' : '課題 未達';
  return `<div class="tv ${v.status === 'cleared' ? 'ok' : 'ng'}"><b>${head}</b><small>${sc.title}</small>${checksHtml(v)}`
    + (v.status === 'cleared' ? '' : `<small>💡 ${sc.hint}</small>`)
    + '<div class="g"><button data-ta="retry">もう一度挑戦</button><button data-ta="list">課題の一覧</button></div>'
    + '<button data-ta="quit" style="width:100%;margin-top:4px">課題を終える（元の続きに戻る）</button></div>';
}

/** 課題の終わりの窓（症状診断・経営。栽培は結果画面に入れる） */
export function showVerdict(sc: Scenario, v: Verdict, onAction: (a: string) => void): void {
  const box = $('res');
  $('rb').innerHTML = `${verdictHtml(sc, v)}<button data-ta="close" style="width:100%">閉じる（結果を見る）</button>`;
  box.style.display = 'flex';
  bindActions($('rb'), a => { box.style.display = 'none'; if (a !== 'close') onAction(a); });
}

/** data-ta のボタンに動作をつなぐ */
export function bindActions(root: HTMLElement, onAction: (a: string) => void): void {
  for (const b of root.querySelectorAll<HTMLButtonElement>('button[data-ta]')) b.onclick = () => onAction(b.dataset.ta!);
}

/** 課題の一覧を開く。onStart に課題の id を渡す */
export function openTasks(onStart: (id: string) => void, current: string | null): void {
  const box = $('ts'), done = SCENARIOS.filter(s => records[s.id]?.cleared).length;
  $('tsp').innerHTML = `<div class="zh"><h2>課題 ${done}/${SCENARIOS.length}</h2><button id="tsc" aria-label="閉じる">✕</button></div><div class="zl">`
    + SCENARIOS.map((sc, i) => {
      const r = records[sc.id], crop = sc.crop ? `・${shortName(CROPS[sc.crop].name)}` : '';
      return `<div class="ze${r?.cleared ? '' : ' un'}"><b>${i + 1}. ${sc.title}</b>${r?.cleared ? '<em class="zb">✓ 達成</em>' : ''}`
        + `<small>${MODE[sc.mode]}${crop}${sc.guide ? '・案内つき' : ''}</small><p>${sc.brief}</p>`
        + `<button data-id="${sc.id}">${sc.id === current ? 'はじめから' : '挑戦する'}</button></div>`;
    }).join('') + '</div><small class="zn">課題の途中で別のモード・作物に変えると、課題をやめて元の続きに戻ります。</small>';
  box.style.display = 'flex';
  const close = () => { box.style.display = 'none'; };
  for (const b of $('tsp').querySelectorAll<HTMLButtonElement>('button[data-id]')) b.onclick = () => { close(); onStart(b.dataset.id!); };
  $('tsc').onclick = close;
  box.onclick = e => { if (e.target === box) close(); };
}
