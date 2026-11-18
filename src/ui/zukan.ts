// 図鑑：作物・症状・資材と費用・設備・イベント・記録。中身は crops.json・symptoms.json・supplies.json・business.json・facility.json と、
// 説明文と数値の出典の状態を持つ zukan.json から作る。見たかどうかと自己ベストはこのブラウザに保存する

import zukanJson from '../data/zukan.json';
import { BUSINESS, CROPS, FACILITY, SCENARIOS, SUPPLIES, type EquipmentId, type Factor, type SupplyId } from '../sim';
import { clearBests, getBests, qualityText, yen } from './records';
import { shortName } from './result';
import { readStore, writeStore } from './store';
import { SYMPTOMS } from './symptoms';
import { bestText, clearTasks, MODE, taskRecord } from './tasks';

/** 出典の状態：確認済み・推定・未確認（一般的な目安）・ゲーム都合 */
export type SourceStatus = 'checked' | 'estimate' | 'unverified' | 'game';
export interface SourceNote { s: SourceStatus; refs?: string[]; note?: string }
interface Value extends SourceNote { label: string; value: string }
interface Entry { id: string; icon: string; name?: string; note: string; fix?: string; values: Value[] }
type CropKey = 'days' | 'ec' | 'ph' | 'water' | 'yield' | 'price' | 'seed';

export interface ZukanData {
  status: Record<SourceStatus, { label: string; desc: string }>;
  refs: Record<string, string>;
  crops: Record<string, Record<CropKey, SourceNote>>;
  symptoms: Record<string, SourceNote>;
  supplies: (Entry & { id: SupplyId })[];
  costs: Value[];
  equipment: Entry[];
  equipmentBusiness: Record<EquipmentId, { icon: string; price: SourceStatus; effect: SourceStatus }>;
  events: Entry[];
}
export const ZUKAN = zukanJson as unknown as ZukanData;

const KEY = 'hydro-sim.seen';
export type Tab = 'crops' | 'symptoms' | 'supplies' | 'equipment' | 'events' | 'records';
/** 見た記録を残すタブ（設備は経営モードで買ったもの、イベントは起きたもの） */
type SeenTab = Exclude<Tab, 'records'>;
const SEEN_TABS: SeenTab[] = ['crops', 'symptoms', 'supplies', 'equipment', 'events'];
const TABS: [Tab, string][] = [['crops', '作物'], ['symptoms', '症状'], ['supplies', '資材・費用'], ['equipment', '設備'], ['events', 'イベント'], ['records', '🏆 記録']];
const $ = (id: string) => document.getElementById(id)!;

/** 帯の表示 [要因, 表示名, 単位] */
const BANDS: [Factor, string, string][] = [['ec', 'EC', ''], ['ph', 'pH', ''], ['water', '液量', 'L']];

function load(): Record<SeenTab, string[]> {
  const out = Object.fromEntries(SEEN_TABS.map(t => [t, [] as string[]])) as Record<SeenTab, string[]>;
  try {
    const v = JSON.parse(readStore(KEY) ?? 'null');
    // 前の版の保存値（作物・症状だけ）も読む
    for (const t of SEEN_TABS) if (Array.isArray(v?.[t])) out[t] = v[t];
  } catch { /* 保存値が壊れている・ストレージが使えない */ }
  return out;
}

const seen = load();

/** 見たことを記録する（作物は育て始めたとき、症状は観察メモ・診断の答え合わせ、資材は使ったとき、設備は買ったとき、イベントは起きたとき） */
export function markSeen(tab: SeenTab, id: string): void {
  if (seen[tab].includes(id)) return;
  seen[tab].push(id);
  writeStore(KEY, JSON.stringify(seen));
}

/** 記録（sim の log）の新しい分から、図鑑に載せるもの（資材・設備・イベント）を拾う */
export function markSeenFromLog(entries: readonly { kind: string; [k: string]: unknown }[]): void {
  for (const e of entries) {
    const c = e.command as { type: string; supply?: string; item?: string } | undefined;
    if (e.kind === 'command' && c) {
      if (c.type === 'dose' && c.supply) markSeen('supplies', c.supply);
      else if (c.type === 'replaceSolution') markSeen('supplies', 'solution');
      else if (c.type === 'buy' && c.item) markSeen('equipment', c.item);
    } else if (e.kind === 'outage' || e.kind === 'pumpStop' || e.kind === 'offer') markSeen('events', e.kind);
    else if ((e.kind === 'delivery' && e.cause) || e.kind === 'contractLost') markSeen('events', 'miss');
    else if (e.kind === 'hypoxia') markSeen('symptoms', 'o2.low');
  }
}

// ---- 出典の状態 ----

/** 出典の番号の表示（R は経営の数値の調査） */
const refLabel = (r: string) => (r === 'R' ? '[調査]' : `[${r}]`);
/** 今描いているタブで使った出典（タブの下に一覧を出す） */
const used = new Set<string>();

/** 出典の状態の小さな札と出典の番号 */
function chip(n: SourceNote): string {
  for (const r of n.refs ?? []) used.add(r);
  return `<i class="sx ${n.s}" title="${ZUKAN.status[n.s].desc}">${ZUKAN.status[n.s].label}</i>${(n.refs ?? []).map(refLabel).join('')}`;
}

/** 「名前 値 [状態]」の1行 */
const valueLine = (label: string, value: string, n: SourceNote) => `<span class="zv">${label} ${value} ${chip(n)}${n.note ? `<small>（${n.note}）</small>` : ''}</span>`;

/** 値の文字列の {名前} を、データから作った値に置き換える（数値を2か所に持たない） */
export function fill(text: string, id?: string): string {
  const L = FACILITY.light, ch = BUSINESS.channels;
  const vars: Record<string, string> = {
    price: id && id in SUPPLIES ? `${SUPPLIES[id as SupplyId].pricePerUnit}円/${SUPPLIES[id as SupplyId].unit}` : '',
    medium: `1トレイ ${BUSINESS.mediumYenPerTray}円`,
    power: `棚1台（8トレイ）1日 ${BUSINESS.powerYenPerRackDay}円`,
    packDirect: `100g あたり ${ch.direct.packYenPer100g}円`,
    packOther: `100g あたり ${ch.restaurant.packYenPer100g}円・${ch.wholesale.packYenPer100g}円`,
    rent: `月 ${BUSINESS.rentPerMonth.toLocaleString()}円`,
    channels: `飲食店 ${ch.restaurant.priceMult}・卸 ${ch.wholesale.priceMult}`,
    lightHours: `${L.on}時〜${L.off}時（${L.off - L.on}時間）`,
    darkRatio: `昼の ${L.darkUptakeRatio} 倍`,
    outage: `平均 ${FACILITY.outage.meanIntervalDays}日に1回・${FACILITY.outage.hours[0]}〜${FACILITY.outage.hours[1]}時間`,
    pump: `ポンプ1台あたり平均 ${FACILITY.pump.meanIntervalDays}日に1回`,
  };
  return text.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
}

const values = (e: { id?: string; values: Value[] }) => e.values.map(v => valueLine(v.label, fill(v.value, e.id), v)).join('');
const badge = (on: boolean, text: string) => (on && text ? `<em class="zb">✓ ${text}</em>` : '');
const entry = (on: boolean, head: string, mark: string, body: string) => `<div class="ze${on ? '' : ' un'}"><b>${head}</b>${badge(on, mark)}${body}</div>`;

// ---- タブの中身 ----

function cropHtml(): string {
  return Object.entries(CROPS).map(([id, c]) => {
    const z = ZUKAN.crops[id], b = BUSINESS.crops[id];
    const bands = BANDS.map(([k, label, unit]) => valueLine(`${label} 適正`, `${c.bands[k][1].toFixed(1)}〜${c.bands[k][2].toFixed(1)}${unit}`, z[k === 'water' ? 'water' : k])).join('');
    return entry(seen.crops.includes(id), `<i class="zs" style="background:${c.look.leaf};border-color:${c.look.stem}"></i>${shortName(c.name)}`, '育てた',
      `<p>${c.note}</p><div class="zvs">${valueLine('収穫まで', `${c.days}日`, z.days)}${bands}`
      + valueLine('1トレイの収量', `${c.yieldG}g`, z.yield) + valueLine('直売の単価', `${c.pricePer100g.toLocaleString()}円/100g`, z.price)
      + valueLine('種', `${b.seedG}g・${Math.round(b.seedG * b.seedYenPerG)}円/トレイ`, z.seed) + '</div>');
  }).join('');
}

function symptomHtml(): string {
  return Object.entries(SYMPTOMS).map(([id, s]) => entry(seen.symptoms.includes(id), `${s.icon} ${s.name}（${s.label}）`, '見た',
    `<p>👀 ${s.look}</p><p>🌱 よくある原因：${s.natural}</p><p>❓ ${s.why} ${chip(ZUKAN.symptoms[id])}</p>`
    + `<p>🛠 ${s.fix}${s.tools.length ? `<br><small>使う資材：${s.tools.map(t => SUPPLIES[t].name).join('・')}</small>` : ''}</p>`)).join('');
}

function supplyHtml(): string {
  return ZUKAN.supplies.map(e => entry(seen.supplies.includes(e.id), `${e.icon} ${SUPPLIES[e.id].name}`, '使った',
    `<p>${e.note}</p><div class="zvs">${values(e)}</div>`)).join('')
    + `<div class="ze"><b>💴 費用（1トレイ・経営モード）</b><p>栽培モードの結果画面と経営モードの損益で同じ値を使う。</p><div class="zvs">`
    + ZUKAN.costs.map(v => valueLine(v.label, fill(v.value), v)).join('') + '</div></div>';
}

function equipmentHtml(): string {
  const basic = ZUKAN.equipment.map(e => entry(true, `${e.icon} ${e.name}`, '', `<p>${e.note}</p>${e.values.length ? `<div class="zvs">${values(e)}</div>` : ''}`)).join('');
  const biz = (Object.entries(BUSINESS.equipment) as [EquipmentId, (typeof BUSINESS.equipment)[EquipmentId]][]).map(([id, q]) => {
    const z = ZUKAN.equipmentBusiness[id];
    return entry(seen.equipment.includes(id), `${z.icon} ${q.name}`, '買った', `<p>${q.note}</p><div class="zvs">`
      + valueLine('価格', `${q.price.toLocaleString()}円（${q.lifeMonths}か月で償却）`, { s: z.price, refs: z.price === 'game' ? [] : ['R'] })
      + valueLine('効き目の数値', '', { s: z.effect }) + '</div>');
  }).join('');
  return `<h3>栽培の設備</h3>${basic}<h3>経営モードで買える設備</h3>${biz}`;
}

function eventHtml(): string {
  return ZUKAN.events.map(e => entry(e.id === 'night' || seen.events.includes(e.id), `${e.icon} ${e.name}`, e.id === 'night' ? '' : '起きた',
    `<p>${e.note}</p><p>🛠 ${e.fix}</p><div class="zvs">${values(e)}</div>`)).join('');
}

function recordHtml(): string {
  const b = getBests(), done = SCENARIOS.filter(s => taskRecord(s.id)?.cleared).length;
  const tasks = SCENARIOS.map((sc, i) => {
    const r = taskRecord(sc.id), best = r?.best !== null && r?.best !== undefined ? bestText(sc.id, r.best) : r?.cleared ? '達成' : '—';
    return `<tr class="${r?.cleared ? '' : 'un'}"><td>${i + 1}. ${sc.title}<small>${MODE[sc.mode]}</small></td><td>${r?.cleared ? '✓ ' : ''}${best}</td></tr>`;
  }).join('');
  const grow = Object.entries(CROPS).map(([id, c]) => {
    const g = b.grow[id];
    return `<tr class="${g ? '' : 'un'}"><td>${shortName(c.name)}${g ? `<small>収穫 ${g.harvests}回</small>` : ''}</td>`
      + `<td>${g ? `${qualityText(g.quality)}<br>利益 ${yen(g.profit)}` : '—'}</td></tr>`;
  }).join('');
  const q = b.quiz, f = b.farm;
  return `<h3>🎯 課題 ${done}/${SCENARIOS.length}</h3><table class="zr">${tasks}</table>`
    + `<h3>🌱 栽培（自由に遊んだとき）</h3><table class="zr">${grow}</table>`
    + `<h3>🔍 症状診断・📒 経営（自由に遊んだとき）</h3><table class="zr">`
    + `<tr class="${q ? '' : 'un'}"><td>診断の最高の正答数${q ? `<small>${q.plays}周</small>` : ''}</td><td>${q ? `${q.best}/${q.of} 問` : '—'}</td></tr>`
    + `<tr class="${f ? '' : 'un'}"><td>最高の月の利益${f ? `<small>${f.month}か月目</small>` : ''}</td><td>${f ? yen(f.monthProfit) : '—'}</td></tr>`
    + `<tr class="${f ? '' : 'un'}"><td>評判の最高</td><td>${f ? f.reputation : '—'}</td></tr></table>`
    + '<p><small>記録はこのブラウザにだけ残ります（ほかの人とは比べません）。</small></p><button id="zclr" style="width:100%">記録を消す</button>';
}

const BODY: Record<Tab, () => string> = { crops: cropHtml, symptoms: symptomHtml, supplies: supplyHtml, equipment: equipmentHtml, events: eventHtml, records: recordHtml };
/** タブの見出しの「見た数/全部」 */
const TOTAL: Record<SeenTab, () => number> = {
  crops: () => Object.keys(CROPS).length, symptoms: () => Object.keys(SYMPTOMS).length, supplies: () => ZUKAN.supplies.length,
  equipment: () => Object.keys(BUSINESS.equipment).length, events: () => ZUKAN.events.length - 1,
};
const count = (t: Tab) => (t === 'records' ? '' : ` <small>${seen[t].filter(id => t !== 'events' || id !== 'night').length}/${TOTAL[t]()}</small>`);

/** 札の意味と、このタブで使った出典の一覧 */
function legend(): string {
  const refs = [...used].sort((a, b) => (a === 'R' ? 1 : b === 'R' ? -1 : +a - +b));
  return '<div class="zlg"><b>数値の札</b>' + (Object.keys(ZUKAN.status) as SourceStatus[]).map(k => `<br>${chip({ s: k })} ${ZUKAN.status[k].desc}`).join('')
    + (refs.length ? '<br><b>出典</b>' + refs.map(r => `<br>${refLabel(r)} ${ZUKAN.refs[r]}`).join('') : '') + '</div>';
}

/** 図鑑を開く */
export function openZukan(tab: Tab = 'crops'): void {
  const box = $('zk');
  $('zp').innerHTML = `<div class="zh"><h2>図鑑</h2><button id="zc" aria-label="閉じる">✕</button></div>`
    + `<div class="g3 zt">${TABS.map(([t, label]) => `<button data-t="${t}" class="${t === tab ? 'on' : ''}">${label}${count(t)}</button>`).join('')}</div>`
    + `<div class="zl">${(used.clear(), BODY[tab]())}${tab === 'records' ? '' : legend()}</div>`
    + '<small class="zn">※簡略化したモデルです。数値の確かさは札（確認済み・推定・未確認・ゲーム都合）で示しています。</small>';
  box.style.display = 'flex';
  for (const b of $('zp').querySelectorAll<HTMLButtonElement>('button[data-t]')) b.onclick = () => openZukan(b.dataset.t as Tab);
  $('zc').onclick = () => { box.style.display = 'none'; };
  box.onclick = e => { if (e.target === box) box.style.display = 'none'; };
  const clr = document.getElementById('zclr');
  if (clr) clr.onclick = () => {
    if (!confirm('課題の達成と自己ベストを消しますか？（図鑑の「見た」は残ります）')) return;
    clearTasks();
    clearBests();
    openZukan('records');
  };
}
