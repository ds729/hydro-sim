// 栽培日誌：sim のイベントを文章にする（sim 側は文言を持たない）

import { CROPS, HYDROPONIC, SUPPLIES, type Command, type CropSpec, type DoseSupply, type Factor, type SimEvent } from '../sim';
import { symptomOf } from './symptoms';

const DOSE: Record<DoseSupply, (amount: number) => string> = {
  fertilizer: a => `肥料を${a}mL追加（ECが上がります）`,
  water: a => `水を${a}L追加（ECが薄まり、液量が増えます）`,
  phDown: () => 'pHダウン剤を投入',
  phUp: () => 'pHアップ剤を投入',
};

function commandText(c: Command): string {
  if (c.type === 'dose') return DOSE[c.supply](c.amount);
  const s = HYDROPONIC.compartments.find(d => d.id === c.target)!.initial;
  return `養液を全交換（EC${s.ec.toFixed(1)}・pH${s.ph.toFixed(1)}・${s.water.toFixed(1)}Lに戻りました）`;
}

/** 時刻の表示（Day 1 06:00） */
const timeText = (hour: number) => `Day ${Math.floor(hour / 24) + 1} ${String(hour % 24).padStart(2, '0')}:00`;

/** 観察メモの値の表示（単位つき） */
const VALUE: Record<Factor, [string, string]> = { ec: ['EC', ''], ph: ['pH', ''], water: ['液量', 'L'] };

type Advice = Extract<SimEvent, { kind: 'advice' }>;

/** 観察メモ（なぜ？ログ）：症状・値と適正帯 → 原因 → 結果 → 対処。「なぜ？」を開くと仕組みを出す */
function adviceHtml(e: Advice, spec: CropSpec): string {
  const sy = symptomOf(e), [label, unit] = VALUE[e.factor], b = spec.bands[e.factor];
  const cause = e.driver
    ? `${timeText(e.driverHour!)}に入れた${SUPPLIES[e.driver].name}が効きすぎた。`
    : sy.natural;
  const fit = Math.round(e.fit * 100);
  return `<b>${sy.icon} ${sy.label}（${sy.name}）</b> ${label} ${e.value.toFixed(2)}${unit}<small class="jb">適正 ${b[1].toFixed(1)}〜${b[2].toFixed(1)}${unit}</small>`
    + `<div class="jw"><i>原因</i>${cause}</div>`
    + `<div class="jw"><i>結果</i>${sy.look}${fit < 1 ? '成長が止まる。' : `成長は ${fit}% 以下の速さに落ちる。`}${e.fit < 0.5 ? '健康度も下がっていく。' : ''}</div>`
    + `<div class="jw"><i>対処</i>${sy.fix}</div>`
    + `<details data-k="${e.hour}${e.factor}"><summary>なぜ？</summary>${sy.why}</details>`;
}

/** 観察メモ以外の記録の文章 */
export function eventText(e: Exclude<SimEvent, Advice>): string {
  switch (e.kind) {
    case 'start': return `${CROPS[e.crop].name}の栽培開始。EC・pH・液量を適正帯（緑）に保とう。${CROPS[e.crop].note}`;
    case 'command': return commandText(e.command);
    case 'morning':
      return `朝の記録：EC ${e.ec.toFixed(1)}、pH ${e.ph.toFixed(1)}、液量 ${e.water.toFixed(1)}L、生育 ${Math.round(e.growth * 100)}%`;
  }
}

/** 日誌の表示クラスとアイコン（観察メモ 🔍・定点記録 📝・操作 ✏️）。観察メモの本文は症状のアイコンを使う */
export const eventStyle = (e: SimEvent): [string, string] =>
  e.kind === 'advice' ? ['o', '🔍'] : e.kind === 'morning' ? ['d', '📝'] : ['a', '✏️'];

/** 日誌に出す件数（新しい順） */
export const JOURNAL_SIZE = 12;

export function journalHtml(log: readonly SimEvent[], spec: CropSpec): string {
  return log.slice(-JOURNAL_SIZE).reverse().map(e => {
    const [cls, icon] = eventStyle(e);
    const body = e.kind === 'advice' ? adviceHtml(e, spec) : `${icon} ${eventText(e)}`;
    return `<div class="jn ${cls}"><small style="margin:0">${timeText(e.hour)}</small>${body}</div>`;
  }).join('');
}
