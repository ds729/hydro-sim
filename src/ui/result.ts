// 結果画面（収穫・枯死・時間切れ）

import { CROPS, type Result } from '../sim';

const TITLE: Record<Result['outcome'], (r: Result) => [string, string]> = {
  harvest: r => ['収穫できました', `等級 ${r.grade}（品質 ${(r.quality * 100).toFixed(0)}%）`],
  dead: () => ['枯死しました', '健康度が0になりました。'],
  late: () => ['収穫に至りませんでした', '成長が遅れすぎました。'],
};

/** 結果を出す。onRestart には次に育てる作物を渡す（「もう一度」は同じ作物、下の段で別の作物） */
export function showResult(r: Result, crop: string, onRestart: (crop: string) => void): void {
  const box = document.getElementById('res')!, [title, sub] = TITLE[r.outcome](r);
  document.getElementById('rb')!.innerHTML = `<h2>${title}</h2><div>${sub}</div><table>`
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
