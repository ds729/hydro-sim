// 自動制御ルールの画面（v1.1。栽培モードだけ）：☰ の「⚙ 自動制御」の窓（行の追加・編集・有効/無効・ひな形）と、HUD の自動運転中の表示。
// ルールはこのブラウザに保存し、始め直しても同じルールで回す（作物を変えたらひな形を入れ直すかは遊ぶ人が決める）

import {
  AMOUNT_LIMIT, CROPS, RULE_LIMIT, SUPPLIES, bangBangRules, cleanRules, powered, templateRules,
  type DoseSupply, type Factor, type Rule, type SimEvent, type SimState,
} from '../sim';
import { readStore, writeStore } from './store';

const KEY = 'hydro-sim.rules';
const $ = (id: string) => document.getElementById(id)!;

/** 保存するルール：on は自動運転の入・切（切っても行は残す） */
export interface RuleSet { on: boolean; rules: Rule[] }

export function loadRuleSet(): RuleSet {
  try {
    const v = JSON.parse(readStore(KEY) ?? 'null');
    if (v && Array.isArray(v.rules)) return { on: !!v.on, rules: cleanRules(v.rules) };
  } catch { /* 保存値が壊れている・ストレージが使えない */ }
  return { on: false, rules: [] };
}

const saveRuleSet = (r: RuleSet) => writeStore(KEY, JSON.stringify(r));

/** sim に渡すルール（切なら行なし） */
export const activeRules = (r: RuleSet): Rule[] => (r.on ? r.rules : []);

export const SENSOR: Record<Factor, [string, string]> = { ec: ['EC', ''], ph: ['pH', ''], water: ['液量', 'L'] };
const SUPPLY_NAME: Record<DoseSupply, string> = { fertilizer: '肥料', water: '水', phDown: 'pHダウン剤', phUp: 'pHアップ剤' };
const STEP: Record<Factor, number> = { ec: 0.05, ph: 0.05, water: 0.05 };
const AMOUNT_STEP: Record<DoseSupply, number> = { fertilizer: 5, water: 0.1, phDown: 1, phUp: 1 };

/** 経過時間（分）の表示（Day 3 14:25） */
export const minuteText = (m: number) => `Day ${Math.floor(m / 1440) + 1} ${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** 資材と量の表示（肥料 10mL・pHダウン剤 1回） */
export const doseText = (supply: DoseSupply, amount: number) => `${SUPPLY_NAME[supply]} ${+amount.toFixed(2)}${SUPPLIES[supply].unit}`;

/** 行の条件の表示（EC < 1.04 → 肥料 10mL・60分待つ） */
export const ruleText = (r: Rule) =>
  `${SENSOR[r.sensor][0]} ${r.op} ${r.threshold}${SENSOR[r.sensor][1]} → ${doseText(r.supply, r.amount)}${r.waitMin ? `・${r.waitMin}分待つ` : ''}`;

type AutoCommand = Extract<SimEvent, { kind: 'command' }> & { auto: true };
export const isAuto = (e: SimEvent): e is AutoCommand => e.kind === 'command' && !!e.auto;

/** 自動の操作の回数と最後の操作（記録を後ろから数える） */
function autoStats(log: readonly SimEvent[]): { n: number; last: AutoCommand | null } {
  let n = 0, last: AutoCommand | null = null;
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (isAuto(e)) { n++; last ??= e; }
  }
  return { n, last };
}

/** HUD の自動運転の表示（ルールがなければ空）。押すと窓を開く（data-ru） */
export function autoHtml(s: SimState): string {
  const rows = s.control.rules.filter(r => r.on).length;
  if (!rows) return '';
  const { n, last } = autoStats(s.log), off = !powered(s.facility);
  const lastText = last && last.command.type === 'dose'
    ? `<small>直近 ${minuteText(last.minute!)} 行${last.rule! + 1}：${doseText(last.command.supply, last.command.amount)}</small>` : '<small>まだ動いていない</small>';
  return `<button data-ru title="自動制御のルールを開く">⚙ ${off ? '停電で停止中' : '自動運転中'}</button>`
    + `<span>${rows}行・自動の操作 ${n}回</span>${off ? '<small>停電中は制御器（センサ・ルール）も止まる</small>' : lastText}`;
}

export interface RulePanelHost {
  /** 今の栽培の状態（作物の適正帯と自動の操作の回数を出す） */
  sim(): SimState;
  /** 課題中は使えない（課題の条件を崩さないため） */
  locked(): boolean;
  /** ルールが変わった（sim に入れ直す） */
  apply(rules: Rule[]): void;
}

/** ☰ の「⚙ 自動制御」の窓 */
export class RulePanel {
  set: RuleSet = loadRuleSet();

  constructor(private host: RulePanelHost) {
    const box = $('ru');
    box.onclick = e => { if (e.target === box) this.close(); };
    $('rup').addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-ra]');
      if (b) this.action(b.dataset.ra!, b.closest<HTMLElement>('[data-i]')?.dataset.i);
    });
    $('rup').addEventListener('change', e => this.edit(e.target as HTMLInputElement | HTMLSelectElement));
  }

  open(): void {
    $('ru').style.display = 'flex';
    this.render();
  }

  close(): void { $('ru').style.display = 'none'; }

  get isOpen() { return $('ru').style.display === 'flex'; }

  /** 開いている間に呼ぶ：自動の操作の回数と行ごとの最近の動きを書き換える（入力中の欄は作り直さない） */
  refresh(): void {
    if (!this.isOpen || this.host.locked()) return;
    const s = this.host.sim(), last = new Map<number, AutoCommand>(), count = new Map<number, number>();
    for (const e of s.log) if (isAuto(e)) { last.set(e.rule!, e); count.set(e.rule!, (count.get(e.rule!) ?? 0) + 1); }
    const sum = $('rus');
    const html = `今回の栽培：自動の操作 ${[...count.values()].reduce((a, b) => a + b, 0)}回・資材費 ¥${Math.round(s.cost).toLocaleString()}`;
    if (sum.textContent !== html) sum.textContent = html;
    this.set.rules.forEach((_, i) => {
      const el = document.getElementById('rua' + i), e = last.get(i);
      // sim の行の並びは保存したルールと同じ（切のときは sim に行がない）
      const t = !this.set.on ? '' : e ? `最近 ${minuteText(e.minute!)}・${count.get(i)}回` : 'まだ動いていない';
      if (el && el.textContent !== t) el.textContent = t;
    });
  }

  private render(): void {
    const p = $('rup'), head = '<div class="zh"><h2>⚙ 自動制御</h2><button data-ra="close" aria-label="閉じる">✕</button></div>';
    if (this.host.locked()) {
      p.innerHTML = head + '<div class="zl"><p>課題の途中は自動制御を使えません（課題は手の操作で達成する条件です）。課題をやめると、保存したルールで続きから回ります。</p></div>';
      return;
    }
    const s = this.host.sim(), crop = CROPS[s.crop.id], { on, rules } = this.set;
    const band = (k: Factor) => `${crop.bands[k][1].toFixed(1)}〜${crop.bands[k][2].toFixed(1)}${SENSOR[k][1]}`;
    p.innerHTML = head + '<div class="zl">'
      + `<div class="rsw"><b>自動運転</b><div class="g"><button data-ra="on" class="${on ? 'on' : ''}">入</button><button data-ra="off" class="${on ? '' : 'on'}">切</button></div></div>`
      + `<small class="rn">センサの読み（30分ごとに更新）を5分ごとに見て、条件に合った行の資材を入れます。入れた資材が混ざって読みに出るまで30分〜1時間かかるので、`
      + `<b>待ち時間</b>がないと入れすぎます。上げる線と下げる線の間をあける（<b>不感帯</b>）と、行ったり来たりしません。</small>`
      + `<small class="rn">${crop.name}の適正帯：EC ${band('ec')}・pH ${band('ph')}・液量 ${band('water')}</small>`
      + rules.map((r, i) => this.rowHtml(r, i)).join('')
      + (rules.length ? '' : '<p class="rn">行がありません。「ひな形」で今の作物に合う4行を入れるか、「＋ 行を足す」で作ります。</p>')
      + `<div class="g3 rb"><button data-ra="add"${rules.length >= RULE_LIMIT ? ' disabled' : ''}>＋ 行を足す</button>`
      + '<button data-ra="template" title="今の作物の適正帯から作る4行（不感帯あり・60分待つ）">ひな形</button>'
      + '<button data-ra="bad" title="上げる線と下げる線が同じで、待ち時間もない ON/OFF">悪い例</button></div>'
      + `<small class="rn">ひな形：適正帯の内側 2 割の線で上げ下げし、60 分待つ。悪い例：線が帯の真ん中で待ち時間なし（入れすぎて行き過ぎ、pH が上下に振れ続ける）。行は ${RULE_LIMIT} 本まで、上から順に別々に動きます。</small>`
      + `<small class="rn" id="rus"></small>`
      + '<small class="rn">壁のモニタと推移グラフの「直近24時間」（PC）で、センサの読み・しきい値（破線）・自動の操作の印を見られます。</small>'
      + '</div>';
    this.refresh();
  }

  private rowHtml(r: Rule, i: number): string {
    const opt = <T extends string>(list: [T, string][], v: T) => list.map(([k, l]) => `<option value="${k}"${k === v ? ' selected' : ''}>${l}</option>`).join('');
    const sensors = opt((Object.keys(SENSOR) as Factor[]).map(k => [k, SENSOR[k][0]]), r.sensor);
    const supplies = opt((Object.keys(SUPPLY_NAME) as DoseSupply[]).map(k => [k, SUPPLY_NAME[k]]), r.supply);
    return `<div class="rr${r.on ? '' : ' off'}" data-i="${i}">`
      + `<div class="rl"><label><input type="checkbox" data-f="on"${r.on ? ' checked' : ''}>行${i + 1}</label>もし`
      + `<select data-f="sensor" aria-label="センサ">${sensors}</select>`
      + `<select data-f="op" aria-label="比較">${opt([['<', '＜'], ['>', '＞']], r.op)}</select>`
      + `<input type="number" data-f="threshold" value="${r.threshold}" step="${STEP[r.sensor]}" aria-label="しきい値"><span data-u="s">${SENSOR[r.sensor][1]}</span>なら`
      + `<button data-ra="del" aria-label="行${i + 1}を消す" title="この行を消す">✕</button></div>`
      + `<div class="rl"><select data-f="supply" aria-label="資材">${supplies}</select>`
      + `<input type="number" data-f="amount" value="${r.amount}" min="0" max="${AMOUNT_LIMIT[r.supply]}" step="${AMOUNT_STEP[r.supply]}" aria-label="量"><span data-u="a">${SUPPLIES[r.supply].unit}</span>入れ、`
      + `<span class="rw"><input type="number" data-f="waitMin" value="${r.waitMin}" min="0" max="1440" step="10" aria-label="待ち時間">分待つ</span></div>`
      + `<small id="rua${i}"></small></div>`;
  }

  /** ルールを整えて保存し、sim に入れ直す */
  private commit(rerender: boolean): void {
    this.set.rules = cleanRules(this.set.rules);
    saveRuleSet(this.set);
    this.host.apply(activeRules(this.set));
    if (rerender) this.render(); else this.refresh();
  }

  private action(a: string, idx?: string): void {
    const crop = this.host.sim().crop.id, rules = this.set.rules;
    if (a === 'close') { this.close(); return; }
    if (a === 'on' || a === 'off') this.set.on = a === 'on';
    else if (a === 'add' && rules.length < RULE_LIMIT) {
      // 新しい行はひな形の1行目（EC が低ければ肥料）から。待ち時間は 60 分
      rules.push({ ...templateRules(crop)[0] });
      this.set.on = true;
    } else if (a === 'del' && idx !== undefined) rules.splice(+idx, 1);
    else if (a === 'template' || a === 'bad') {
      if (rules.length && !confirm(`今の${rules.length}行を消して、${a === 'template' ? 'ひな形' : '悪い例'}に入れ替えますか？`)) return;
      this.set.rules = a === 'template' ? templateRules(crop) : bangBangRules(crop).map(r => ({ ...r, threshold: +r.threshold.toFixed(2) }));
      this.set.on = true;
    } else return;
    this.commit(true);
  }

  /** 欄の変更。数が正しくなければ元の値に戻す。行の作り直しはしない（Tab で次の欄に移ったところを消さないため） */
  private edit(el: HTMLInputElement | HTMLSelectElement): void {
    const f = el.dataset.f as keyof Rule | undefined, row = el.closest<HTMLElement>('[data-i]');
    if (!f || !row) return;
    const i = +row.dataset.i!, r = this.set.rules[i];
    if (!r) return;
    if (f === 'on') { r.on = (el as HTMLInputElement).checked; row.classList.toggle('off', !r.on); }
    else if (f === 'sensor') { r.sensor = el.value as Factor; row.querySelector('[data-u="s"]')!.textContent = SENSOR[r.sensor][1]; }
    else if (f === 'op') r.op = el.value as Rule['op'];
    else if (f === 'supply') {
      r.supply = el.value as DoseSupply;
      r.amount = Math.min(r.amount, AMOUNT_LIMIT[r.supply]);
      row.querySelector('[data-u="a"]')!.textContent = SUPPLIES[r.supply].unit;
      const a = row.querySelector<HTMLInputElement>('[data-f="amount"]')!;
      Object.assign(a, { max: String(AMOUNT_LIMIT[r.supply]), step: String(AMOUNT_STEP[r.supply]), value: String(r.amount) });
    } else {
      const v = parseFloat(el.value), ok = Number.isFinite(v) && (f === 'threshold' || (f === 'waitMin' ? v >= 0 : v > 0));
      if (!ok) { el.value = String(r[f]); return; }
      r[f] = f === 'amount' ? Math.min(v, AMOUNT_LIMIT[r.supply]) : f === 'waitMin' ? Math.min(1440, Math.round(v)) : v;
      el.value = String(r[f]);
    }
    this.commit(false);
  }
}
