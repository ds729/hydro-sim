// 栽培日誌：sim のイベントを文章にする（sim 側は文言を持たない）

import { CROPS, HYDROPONIC, SUPPLIES, type Command, type CropSpec, type DoseSupply, type Factor, type SimEvent } from '../sim';
import { SYMPTOMS, symptomOf } from './symptoms';
import { doseText, isAuto, minuteText } from './rules';

const DOSE: Record<DoseSupply, (amount: number) => string> = {
  fertilizer: a => `肥料を${a}mL追加（ECが上がります）`,
  water: a => `水を${a}L追加（ECが薄まり、液量が増えます）`,
  phDown: () => 'pHダウン剤を投入',
  phUp: () => 'pHアップ剤を投入',
};

function commandText(c: Command): string {
  if (c.type === 'dose') return DOSE[c.supply](c.amount);
  if (c.type === 'fixPump') return 'ポンプを直した（吸い込み口の詰まりを掃除して動かし直した）';
  const s = HYDROPONIC.compartments.find(d => d.id === c.target)!.initial;
  return `養液を全交換（EC${s.ec.toFixed(1)}・pH${s.ph.toFixed(1)}・${s.water.toFixed(1)}Lに戻りました）`;
}

/** 時刻の表示（Day 1 06:00） */
const timeText = (hour: number) => `Day ${Math.floor(hour / 24) + 1} ${String(hour % 24).padStart(2, '0')}:00`;

/** 観察メモの値の表示（単位つき） */
const VALUE: Record<Factor, [string, string]> = { ec: ['EC', ''], ph: ['pH', ''], water: ['液量', 'L'] };

type Advice = Extract<SimEvent, { kind: 'advice' }>;
type Hypoxia = Extract<SimEvent, { kind: 'hypoxia' }>;

/** 観察メモ（根の酸欠）：溶存酸素 → 原因 → 結果 → 対処 */
function hypoxiaHtml(e: Hypoxia): string {
  const sy = SYMPTOMS['o2.low'];
  const cause = e.pump ? 'ポンプは回っているが、止まっていた間に減った酸素がまだ戻っていない。' : sy.natural;
  return `<b>${sy.icon} ${sy.label}（${sy.name}）</b> 溶存酸素 ${Math.round(e.o2 * 100)}%<small class="jb">飽和に対して</small>`
    + `<div class="jw"><i>原因</i>${cause}</div>`
    + `<div class="jw"><i>結果</i>${sy.look}${e.fit < 0.5 ? '健康度も下がっていく。' : ''}</div>`
    + `<div class="jw"><i>対処</i>${e.pump ? '数時間で戻る。ポンプを止めたままにしない。' : sy.fix}</div>`
    + `<details data-k="${e.hour}o2"><summary>なぜ？</summary>${sy.why}</details>`;
}

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
export function eventText(e: Exclude<SimEvent, Advice | Hypoxia>): string {
  switch (e.kind) {
    case 'start': return `${CROPS[e.crop].name}の栽培開始。EC・pH・液量を適正帯（緑）に保とう。${CROPS[e.crop].note}`;
    case 'command': return commandText(e.command);
    case 'morning':
      return `朝の記録：EC ${e.ec.toFixed(1)}、pH ${e.ph.toFixed(1)}、液量 ${e.water.toFixed(1)}L、生育 ${Math.round(e.growth * 100)}%`;
    case 'outage': return `停電（${e.hours}時間ほど）。照明とポンプが止まった。照明が点く時間帯は育たない`;
    case 'powerBack': return '電気が戻った。照明とポンプが動き出した';
    case 'pumpStop': return 'ポンプが止まった（吸い込み口の詰まり）。養液が循環せず、酸素が減っていく。早めに直す';
  }
}

/** 日誌の表示クラスとアイコン（観察メモ 🔍・定点記録 📝・操作 ✏️）。観察メモの本文は症状のアイコンを使う */
export const eventStyle = (e: SimEvent): [string, string] =>
  e.kind === 'advice' || e.kind === 'hypoxia' ? ['o', '🔍'] : e.kind === 'morning' ? ['d', '📝']
    : e.kind === 'outage' ? ['o', '⚡'] : e.kind === 'pumpStop' ? ['o', '🛑'] : e.kind === 'powerBack' ? ['a', '💡']
      : e.kind === 'command' && e.command.type === 'fixPump' ? ['a', '🔧'] : ['a', '✏️'];

/** 日誌に出す件数（新しい順） */
export const JOURNAL_SIZE = 12;

export function journalHtml(log: readonly SimEvent[], spec: CropSpec): string {
  const out: string[] = [];
  for (let i = log.length - 1; i >= 0 && out.length < JOURNAL_SIZE; i--) {
    const e = log[i];
    // 続けて起きた自動の操作は1件にまとめる（悪い設定では数千回になり、観察メモが押し出されるため）
    if (isAuto(e)) {
      let j = i;
      while (j > 0 && isAuto(log[j - 1])) j--;
      out.push(autoHtml(log.slice(j, i + 1) as Extract<SimEvent, { kind: 'command' }>[]));
      i = j;
      continue;
    }
    const [cls, icon] = eventStyle(e);
    const body = e.kind === 'advice' ? adviceHtml(e, spec) : e.kind === 'hypoxia' ? hypoxiaHtml(e) : `${icon} ${eventText(e)}`;
    out.push(`<div class="jn ${cls}"><small style="margin:0">${timeText(e.hour)}</small>${body}</div>`);
  }
  return out.join('');
}

/** 自動制御ルールの操作（続けて起きた分をまとめる）：時刻・回数・資材ごとの合計・動いた行 */
function autoHtml(es: Extract<SimEvent, { kind: 'command' }>[]): string {
  const first = es[0], last = es.at(-1)!, rows = [...new Set(es.map(e => e.rule! + 1))].sort((a, b) => a - b);
  // 同じ日なら終わりの時刻だけ（Day 2 06:05〜14:25）
  const a = minuteText(first.minute!), b = minuteText(last.minute!), sameDay = a.split(' ')[1] === b.split(' ')[1];
  const time = es.length > 1 ? `${a}〜${sameDay ? b.split(' ')[2] : b}` : a;
  if (es.length === 1) return `<div class="jn u"><small style="margin:0">${time}</small>⚙ 自動（行${rows[0]}）：${commandText(first.command)}</div>`;
  const sum = new Map<DoseSupply, [number, number]>();
  for (const e of es) if (e.command.type === 'dose') {
    const v = sum.get(e.command.supply) ?? [0, 0];
    sum.set(e.command.supply, [v[0] + e.command.amount, v[1] + 1]);
  }
  const parts = [...sum].map(([k, [a, n]]) => (SUPPLIES[k].unit === '回' ? `${SUPPLIES[k].name} ${n}回` : `${doseText(k, a)}（${n}回）`));
  return `<div class="jn u"><small style="margin:0">${time}</small>⚙ 自動の操作 ×${es.length}（行${rows.join('・')}）：${parts.join('、')}</div>`;
}
