// 道具バー（下）。ボタンはコマンドを sim に渡すだけ。値段は supplies.json から出す

import { SUPPLIES, type Command } from '../sim';

interface Tool { key: string; icon: string; label: string; title: string; command: Command }

const BED = 'bed';
export const TOOLS: Tool[] = [
  { key: '1', icon: '🧪', label: '肥料', title: '肥料を10mL追加（ECが上がる）', command: { type: 'dose', target: BED, supply: 'fertilizer', amount: 10 } },
  { key: '2', icon: '💧', label: '水', title: '水を0.2L追加（ECが下がり、液量が増える）', command: { type: 'dose', target: BED, supply: 'water', amount: 0.2 } },
  { key: '3', icon: '🔽', label: 'pHダウン', title: 'pHを0.3下げる', command: { type: 'dose', target: BED, supply: 'phDown', amount: 1 } },
  { key: '4', icon: '🔼', label: 'pHアップ', title: 'pHを0.3上げる', command: { type: 'dose', target: BED, supply: 'phUp', amount: 1 } },
  { key: '5', icon: '♻️', label: '全交換', title: '養液を初期状態に入れ替える', command: { type: 'replaceSolution', target: BED } },
];

const price = (c: Command) =>
  c.type === 'dose' ? SUPPLIES[c.supply].pricePerUnit * c.amount : SUPPLIES.solution.pricePerUnit;

/**
 * 道具バーを作り、クリックとキー 1〜5 でコマンドを送る。
 * 返す関数で値段の表示を n 倍にする（経営モードは棚＝トレイ8枚分に効くので 8 倍）
 */
export function mountTools(bar: HTMLElement, send: (c: Command) => void): (n: number) => void {
  const prices: [HTMLElement, number][] = [];
  for (const t of TOOLS) {
    const b = document.createElement('button'), p = price(t.command);
    b.className = 'tl';
    b.dataset.k = t.key;
    b.title = `${t.title}（キー${t.key}）`;
    b.innerHTML = `<b>${t.icon}</b><span>${t.label}</span><em>${p ? '¥' + p : '無料'}</em>`;
    b.onclick = () => {
      send(t.command);
      // 押した感触（縮んで戻る）
      b.classList.remove('tap');
      void b.offsetWidth;
      b.classList.add('tap');
    };
    bar.appendChild(b);
    prices.push([b.querySelector('em')!, p]);
  }
  addEventListener('keydown', e => (bar.querySelector(`[data-k="${e.key}"]`) as HTMLButtonElement | null)?.click());
  return n => { for (const [em, p] of prices) em.textContent = p ? '¥' + p * n : '無料'; };
}
