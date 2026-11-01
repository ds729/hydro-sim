// 画質設定（影・解像度）。選んだ値はこのブラウザに保存する（保存できない環境では既定値のまま）

import type { Quality } from '../render/view';

const KEY = 'hydro-sim.quality';
/** 解像度：devicePixelRatio の上限。高＝最大 2（スマホの高精細画面でも 2 で止める） */
const RES: [label: string, dpr: number][] = [['高', 2], ['中', 1], ['低', 0.75]];
const DEFAULT: Quality = { shadows: true, dpr: 2 };

function load(): Quality {
  try {
    const q = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (typeof q?.shadows === 'boolean' && RES.some(([, d]) => d === q.dpr)) return q;
  } catch { /* 保存値が壊れている・ストレージが使えない */ }
  return { ...DEFAULT };
}

/** 画質のボタン（影：あり/なし、解像度：高/中/低）を作り、保存値を apply に渡す */
export function mountQuality(el: HTMLElement, apply: (q: Quality) => void): void {
  const q = load();
  const row = (label: string, items: [string, () => boolean, () => void][]) => {
    const head = document.createElement('span'), box = document.createElement('div');
    head.textContent = label;
    const btns = items.map(([text, on, set]) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.onclick = () => {
        set();
        btns.forEach((x, i) => x.classList.toggle('on', items[i][1]()));
        apply(q);
        try { localStorage.setItem(KEY, JSON.stringify(q)); } catch { /* 保存できなくても今回は効く */ }
      };
      b.classList.toggle('on', on());
      box.appendChild(b);
      return b;
    });
    el.append(head, box);
  };
  row('影', [['あり', () => q.shadows, () => { q.shadows = true; }], ['なし', () => !q.shadows, () => { q.shadows = false; }]]);
  row('解像度', RES.map(([label, d]) => [label, () => q.dpr === d, () => { q.dpr = d; }]));
  apply(q);
}
