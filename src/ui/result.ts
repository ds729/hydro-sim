// 結果画面（収穫・枯死・時間切れ）

import type { Result } from '../sim';

const TITLE: Record<Result['outcome'], (r: Result) => [string, string]> = {
  harvest: r => ['収穫できました', `等級 ${r.grade}（品質 ${(r.quality * 100).toFixed(0)}%）`],
  dead: () => ['枯死しました', '健康度が0になりました。'],
  late: () => ['収穫に至りませんでした', '成長が遅れすぎました。'],
};

export function showResult(r: Result, onRestart: () => void): void {
  const box = document.getElementById('res')!, [title, sub] = TITLE[r.outcome](r);
  document.getElementById('rb')!.innerHTML = `<h2>${title}</h2><div>${sub}</div><table>`
    + `<tr><td>収量</td><td>${r.yieldG.toFixed(0)} g</td></tr><tr><td>売上</td><td>¥${r.sales.toFixed(0)}</td></tr>`
    + `<tr><td>資材費</td><td>¥${r.cost}</td></tr><tr><td><b>利益</b></td><td><b>¥${r.profit.toFixed(0)}</b></td></tr>`
    + `</table><button id="rs" style="width:100%">もう一度育てる</button>`;
  box.style.display = 'flex';
  document.getElementById('rs')!.onclick = () => {
    box.style.display = 'none';
    onRestart();
  };
}
