// 結果画面（収穫・枯死・時間切れ）

import { CROPS, type Result } from '../sim';
import { SYMPTOMS } from './symptoms';

/** 品質を下げた原因（品質の低下分が 1% 以上のものを大きい順に3つまで） */
function lossHtml(r: Result): string {
  const top = r.losses.filter(l => l.value >= 0.01).slice(0, 3);
  if (!top.length) return '<div class="ls"><b>品質を下げた原因</b>なし。ずっと適正帯に保てました。</div>';
  return '<div class="ls"><b>品質を下げた原因</b>' + top.map(l => {
    const sy = SYMPTOMS[l.key];
    return `${sy.icon} ${sy.label}（${sy.name}） −${(l.value * 100).toFixed(0)}%`;
  }).join('<br>') + '</div>';
}

const TITLE: Record<Result['outcome'], (r: Result) => [string, string]> = {
  harvest: r => ['収穫できました', `等級 ${r.grade}（品質 ${(r.quality * 100).toFixed(0)}%）`],
  dead: () => ['枯死しました', '健康度が0になりました。'],
  late: () => ['収穫に至りませんでした', '成長が遅れすぎました。'],
};

/** 結果を出す。onRestart には次に育てる作物を渡す（「もう一度」は同じ作物、下の段で別の作物） */
export function showResult(r: Result, crop: string, onRestart: (crop: string) => void): void {
  const box = document.getElementById('res')!, [title, sub] = TITLE[r.outcome](r);
  document.getElementById('rb')!.innerHTML = `<h2>${title}</h2><div>${sub}</div>${lossHtml(r)}<table>`
    + `<tr><td>収量</td><td>${r.yieldG.toFixed(0)} g</td></tr><tr><td>売上</td><td>¥${r.sales.toFixed(0)}</td></tr>`
    + `<tr><td>資材費</td><td>¥${r.cost}</td></tr><tr><td><b>利益</b></td><td><b>¥${r.profit.toFixed(0)}</b></td></tr>`
    + `</table><button data-crop="${crop}" style="width:100%">もう一度育てる</button>`
    + `<h3>別の作物で</h3><div class="g">${Object.entries(CROPS).filter(([id]) => id !== crop)
      .map(([id, c]) => `<button data-crop="${id}">${shortName(c.name)}</button>`).join('')}</div>`;
  box.style.display = 'flex';
  for (const b of box.querySelectorAll<HTMLButtonElement>('button[data-crop]')) {
    b.onclick = () => {
      box.style.display = 'none';
      onRestart(b.dataset.crop!);
    };
  }
}

/** ボタン用の短い名前（括弧の補足を外す） */
export const shortName = (name: string) => name.replace(/（.*）/, '');
