// 図鑑の土台（作物・症状）。中身は crops.json と symptoms.json から作る。見たかどうかはこのブラウザに保存する

import { CROPS, SUPPLIES, type Factor } from '../sim';
import { shortName } from './result';
import { SYMPTOMS } from './symptoms';

const KEY = 'hydro-sim.seen';
type Tab = 'crops' | 'symptoms';
const $ = (id: string) => document.getElementById(id)!;

/** 帯の表示 [要因, 表示名, 単位] */
const BANDS: [Factor, string, string][] = [['ec', 'EC', ''], ['ph', 'pH', ''], ['water', '液量', 'L']];

function load(): Record<Tab, string[]> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (Array.isArray(v?.crops) && Array.isArray(v?.symptoms)) return v;
  } catch { /* 保存値が壊れている・ストレージが使えない */ }
  return { crops: [], symptoms: [] };
}

const seen = load();

/** 見たことを記録する（作物は育て始めたとき、症状は観察メモ・診断の答え合わせで出たとき） */
export function markSeen(tab: Tab, id: string): void {
  if (seen[tab].includes(id)) return;
  seen[tab].push(id);
  try { localStorage.setItem(KEY, JSON.stringify(seen)); } catch { /* 保存できなくても今回は効く */ }
}

function cropHtml(): string {
  return Object.entries(CROPS).map(([id, c]) => {
    const bands = BANDS.map(([k, label, unit]) => `${label} ${c.bands[k][1].toFixed(1)}〜${c.bands[k][2].toFixed(1)}${unit}`).join('・');
    return `<div class="ze${seen.crops.includes(id) ? '' : ' un'}">`
      + `<b><i class="zs" style="background:${c.look.leaf};border-color:${c.look.stem}"></i>${shortName(c.name)}</b>${badge(seen.crops.includes(id), '育てた')}`
      + `<p>${c.note}</p><small>収穫 ${c.days}日・適正 ${bands}<br>収量 ${c.yieldG}g・単価 ${c.pricePer100g}円/100g</small></div>`;
  }).join('');
}

function symptomHtml(): string {
  return Object.entries(SYMPTOMS).map(([id, s]) =>
    `<div class="ze${seen.symptoms.includes(id) ? '' : ' un'}"><b>${s.icon} ${s.name}（${s.label}）</b>${badge(seen.symptoms.includes(id), '見た')}`
    + `<p>👀 ${s.look}</p><p>🌱 よくある原因：${s.natural}</p><p>❓ ${s.why}</p>`
    + `<p>🛠 ${s.fix}<br><small>使う資材：${s.tools.map(t => SUPPLIES[t].name).join('・')}</small></p></div>`).join('');
}

const badge = (on: boolean, text: string) => (on ? `<em class="zb">✓ ${text}</em>` : '');

/** 図鑑を開く */
export function openZukan(tab: Tab = 'crops'): void {
  const box = $('zk'), n = (t: Tab) => `${seen[t].length}/${Object.keys(t === 'crops' ? CROPS : SYMPTOMS).length}`;
  $('zp').innerHTML = `<div class="zh"><h2>図鑑</h2><button id="zc" aria-label="閉じる">✕</button></div>`
    + `<div class="g"><button data-t="crops" class="${tab === 'crops' ? 'on' : ''}">作物 ${n('crops')}</button>`
    + `<button data-t="symptoms" class="${tab === 'symptoms' ? 'on' : ''}">症状 ${n('symptoms')}</button></div>`
    + `<div class="zl">${tab === 'crops' ? cropHtml() : symptomHtml()}</div>`
    + '<small class="zn">※数値と説明は仮置きの簡略モデルです。</small>';
  box.style.display = 'flex';
  for (const b of $('zp').querySelectorAll<HTMLButtonElement>('button[data-t]')) b.onclick = () => openZukan(b.dataset.t as Tab);
  $('zc').onclick = () => { box.style.display = 'none'; };
  box.onclick = e => { if (e.target === box) box.style.display = 'none'; };
}
