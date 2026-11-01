// 栽培日誌：sim のイベントを文章にする（sim 側は文言を持たない）

import { CROPS, HYDROPONIC, type Command, type DoseSupply, type Factor, type SimEvent } from '../sim';

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

/** 観察メモ（原因と対処）。[低い側, 高い側] */
const ADVICE: Record<Factor, [(v: string) => string, (v: string) => string]> = {
  ec: [
    v => `EC ${v}：肥料濃度が低く、養分不足で成長が遅れています。肥料を追加しましょう。`,
    v => `EC ${v}：濃度が高すぎます。濃度障害で吸水が妨げられます。水を足して薄めるか、養液を交換しましょう。`,
  ],
  ph: [
    v => `pH ${v}：酸性すぎて根が傷みます。pHアップで調整を。`,
    v => `pH ${v}：高すぎて鉄などの微量要素が吸収しにくくなります。pHダウンで調整を。`,
  ],
  water: [
    v => `液量 ${v}L：少なすぎます。養液が濃縮しやすく根も乾きます。水を足しましょう。`,
    v => `液量 ${v}L：多すぎて根の酸素が不足し、根腐れの恐れがあります。`,
  ],
};

export function eventText(e: SimEvent): string {
  switch (e.kind) {
    case 'start': return `${CROPS[e.crop].name}の栽培開始。EC・pH・液量を適正帯（緑）に保とう。${CROPS[e.crop].note}`;
    case 'command': return commandText(e.command);
    case 'morning':
      return `朝の記録：EC ${e.ec.toFixed(1)}、pH ${e.ph.toFixed(1)}、液量 ${e.water.toFixed(1)}L、生育 ${Math.round(e.growth * 100)}%`;
    case 'advice': return ADVICE[e.factor][e.side === 'low' ? 0 : 1](e.value.toFixed(1));
  }
}

/** 日誌の表示クラスとアイコン（観察メモ 🔍・定点記録 📝・操作 ✏️） */
export const eventStyle = (e: SimEvent): [string, string] =>
  e.kind === 'advice' ? ['o', '🔍'] : e.kind === 'morning' ? ['d', '📝'] : ['a', '✏️'];

/** 日誌に出す件数（新しい順） */
export const JOURNAL_SIZE = 12;

export function journalHtml(log: readonly SimEvent[]): string {
  return log.slice(-JOURNAL_SIZE).reverse().map(e => {
    const [cls, icon] = eventStyle(e);
    const t = `Day ${Math.floor(e.hour / 24) + 1} ${String(e.hour % 24).padStart(2, '0')}:00`;
    return `<div class="jn ${cls}"><small style="margin:0">${t}</small>${icon} ${eventText(e)}</div>`;
  }).join('');
}
