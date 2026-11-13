// 経営モードの画面：HUD の位置に棚（計器の読み・トレイ8枚・選んだトレイの操作）、☰ の中に現金・在庫・契約・記録、
// 帳簿（設備・月次損益・1トレイの見込み）は図鑑と同じ重ねた窓に出す。文言はここで作り、sim はイベントと数値だけを出す

import {
  BUSINESS, CROPS, applyFarmCommand, canBuy, createSim, farmDay, freshness, rackValues, reserved, totals, trayEstimate,
  type Band, type EquipmentId, type Factor, type FarmCommand, type FarmEvent, type FarmState, type Ledger, type SimState, type Tray,
} from '../sim';
import { shortName } from './result';

const $ = (id: string) => document.getElementById(id)!;
const B = BUSINESS;
/** Day 1 を月曜とする（契約の曜日 0〜6 ＝ 月〜日） */
const WD = '月火水木金土日';
const yen = (x: number) => '¥' + Math.round(x).toLocaleString('ja-JP');
const signed = (x: number) => (x < 0 ? '−' : '+') + yen(Math.abs(x));
const cropName = (id: string) => shortName(CROPS[id].name);
const when = (hour: number) => `D${Math.floor(hour / 24) + 1} ${hour % 24}時`;
/** 中身が変わったときだけ書き換える（毎回書き換えると、押している最中のボタンが作り直されてクリックが効かない） */
function setHtml(el: HTMLElement, html: string) {
  if (el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; }
}

/** [要因, 表示名, ゲージの下端, 上端, 小数桁]。HUD（栽培モード）と同じ目盛り */
const GAUGES: [Factor, string, number, number, number][] = [['ec', 'EC', 0, 3, 2], ['ph', 'pH', 4, 8, 2], ['water', '液量 L', 0, 3, 2]];
const EQUIP_ORDER: EquipmentId[] = ['rack', 'autoWater', 'probe', 'autoPh', 'fridge', 'led'];
type BookTab = 'equip' | 'pl' | 'est';

/** 棚に植わっている（枯れていない）作物の適正帯の重なり。重ならなければ緑の幅 0 */
function rackBand(f: FarmState, rack: number, k: Factor): Band | null {
  const specs = f.racks[rack].slots.filter((t): t is Tray => !!t && t.crop.health > 0).map(t => CROPS[t.crop.id].bands[k]);
  if (!specs.length) return null;
  const a = Math.max(...specs.map(b => b[0])), b = Math.max(...specs.map(b => b[1])), c = Math.min(...specs.map(b => b[2])), d = Math.min(...specs.map(b => b[3]));
  return b <= c ? [a, b, c, d] : [a, (b + c) / 2, (b + c) / 2, d];
}

/** トレイの状態 */
type TrayKind = 'empty' | 'grow' | 'ripe' | 'dead';
const kindOf = (t: Tray | null): TrayKind => (!t ? 'empty' : t.crop.health <= 0 ? 'dead' : t.ripeAt !== null ? 'ripe' : 'grow');
/** 見た目で分かる元気さ（健康度そのものは見えないので言葉にする） */
const vigor = (h: number) => (h >= 80 ? '元気' : h >= 50 ? '少し弱っている' : 'かなり弱っている');

export class FarmPanel {
  /** 選んでいる棚（番号）とトレイ */
  rack = 0;
  slot = 0;
  /** 描画用の見かけの栽培槽（選んだトレイ。区切り3 で棚の 3D にするまでのつなぎ） */
  private view: SimState | null = null;
  private trayBtns: HTMLButtonElement[] = [];
  private bookTab: BookTab | null = null;
  private seenLog = 0;

  constructor(private f: FarmState, private onMonth: () => void) {
    $('fms').onclick = () => this.send({ type: 'measure' });
    $('fbk').onclick = () => this.openBook('pl');
    $('bk').onclick = e => { if (e.target === $('bk')) this.closeBook(); };
    // 在庫・契約・トレイの操作は書き換わる中身なので、押したボタンは data 属性で見分ける
    for (const id of ['fda', 'fst', 'frk', 'bp']) $(id).addEventListener('click', e => this.onClick(e));
    this.seenLog = f.log.length;
  }

  get state(): FarmState { return this.f; }
  /** 始め直す（確認用の口から） */
  reset(f: FarmState): void {
    this.f = f;
    this.rack = this.slot = 0;
    this.seenLog = f.log.length;
    this.trayBtns = [];
    $('ftr').innerHTML = '';
  }

  send(c: FarmCommand): boolean {
    return applyFarmCommand(this.f, c);
  }

  /** 道具バーの操作（養液）を選んでいる棚に向ける */
  rackId(): string { return this.f.racks[this.rack].id; }

  private onClick(e: Event) {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b || b.disabled) return;
    const d = b.dataset, f = this.f, r = f.racks[this.rack];
    if (d.rk) { this.rack = +d.rk; this.slot = 0; this.trayBtns = []; $('ftr').innerHTML = ''; }
    else if (d.sow) {
      const all = ($('fsa') as HTMLInputElement | null)?.checked;
      const slots = all ? r.slots.map((t, i) => (t ? -1 : i)).filter(i => i >= 0) : [this.slot];
      for (const i of slots) this.send({ type: 'sow', rack: r.id, slot: i, crop: d.sow });
    } else if (d.act === 'harvest' || d.act === 'clear') {
      const want: TrayKind = d.act === 'harvest' ? 'ripe' : 'dead';
      const slots = d.all ? r.slots.map((t, i) => (kindOf(t) === want ? i : -1)).filter(i => i >= 0) : [this.slot];
      for (const i of slots) this.send({ type: d.act, rack: r.id, slot: i });
    } else if (d.ws) this.send({ type: 'wholesale', crop: d.ws });
    else if (d.buy) {
      const e = B.equipment[d.buy as EquipmentId];
      if (confirm(`${e.name}を ${yen(e.price)} で買いますか？`)) this.send({ type: 'buy', item: d.buy as EquipmentId });
    } else if (d.tab) this.openBook(d.tab as BookTab);
    else if (d.close) this.closeBook();
    this.update();
  }

  /** 画面を今の状態に合わせる（毎フレームではなく、変わったときと 0.1 秒ごと） */
  update(): void {
    const f = this.f;
    if (this.rack >= f.racks.length) this.rack = 0;
    const d = farmDay(f), h = f.hour % 24;
    $('fd').textContent = `Day ${d}（${WD[(d - 1) % 7]}）${h}時`;
    $('fmo').textContent = `${f.ledger.month}か月目・現金`;
    $('fcash').textContent = yen(f.cash);
    this.racks();
    this.gauges();
    this.trays();
    this.detail();
    this.side();
    if (this.bookTab) this.book();
    // 月の締め：時間を止めて損益を見せる
    for (const e of f.log.slice(this.seenLog)) if (e.kind === 'month') { this.onMonth(); this.openBook('pl'); }
    this.seenLog = f.log.length;
    this.view = this.traySim();
  }

  /** 描画する栽培槽 */
  get sim(): SimState | null { return this.view; }
  /** 連続測定センサがなければ制御盤のランプとモニタを伏せる */
  get blind(): 'noProbe' | false { return this.f.equipment.probe ? false : 'noProbe'; }

  private racks() {
    const n = this.f.racks.length;
    setHtml($('frk'), n < 2 ? '' : this.f.racks.map((_, i) => `<button data-rk="${i}" class="${i === this.rack ? 'on' : ''}">棚${i + 1}</button>`).join(''));
  }

  private gauges() {
    const f = this.f, v = f.readings[this.rackId()];
    setHtml($('fg'), GAUGES.map(([k, label, lo, hi, dg]) => {
      const band = rackBand(f, this.rack, k), p = (x: number) => (((x - lo) / (hi - lo)) * 100).toFixed(1);
      const bg = band ? `linear-gradient(90deg,#d6454588 0 ${p(band[0])}%,#e0a10088 ${p(band[0])}% ${p(band[1])}%,#2f9e5b ${p(band[1])}% ${p(band[2])}%,#e0a10088 ${p(band[2])}% ${p(band[3])}%,#d6454588 ${p(band[3])}%)` : 'var(--bt)';
      const x = Math.max(0, Math.min(100, ((v[k] - lo) / (hi - lo)) * 100));
      return `<div class="row"><b>${label}</b><span>${v[k].toFixed(dg)}</span><div class="tr" style="background:${bg}"><div class="mk" style="left:${x}%"></div></div></div>`;
    }).join(''));
    const ago = f.hour - f.readAt;
    $('fat').textContent = f.equipment.probe ? '連続測定センサ（毎時）' : `計器：${when(f.readAt)}${ago ? `（${ago}時間前）` : ''}`;
    ($('fms') as HTMLButtonElement).style.display = f.equipment.probe ? 'none' : '';
  }

  private trays() {
    const f = this.f, r = f.racks[this.rack], box = $('ftr');
    if (this.trayBtns.length !== r.slots.length) {
      box.innerHTML = '';
      this.trayBtns = r.slots.map((_, i) => {
        const b = document.createElement('button');
        b.onclick = () => { this.slot = i; this.update(); };
        box.appendChild(b);
        return b;
      });
    }
    r.slots.forEach((t, i) => {
      const k = kindOf(t), b = this.trayBtns[i];
      let html = `<i>${i + 1}</i>`;
      if (!t) html += '<span>＋ 空き</span>';
      else {
        const name = cropName(t.crop.id);
        if (k === 'dead') html += `<span>${name}</span><em>枯れ</em>`;
        else if (k === 'ripe') { const fr = freshness(t, f.hour); html += `<span>${name}</span><em>${fr < 1 ? `育ちすぎ −${Math.round((1 - fr) * 100)}%` : '収穫できる'}</em>`; }
        else html += `<span>${name}</span><u><s style="width:${(t.crop.growth * 100).toFixed(0)}%"></s></u>`;
      }
      setHtml(b, html);
      b.className = `ft ${k}${t && k === 'grow' && t.crop.health < 50 ? ' weak' : ''}${i === this.slot ? ' sel' : ''}`;
    });
  }

  private detail() {
    const f = this.f, r = f.racks[this.rack], t = r.slots[this.slot], k = kindOf(t), where = `棚${this.rack + 1}・トレイ${this.slot + 1}`;
    const count = (w: TrayKind) => r.slots.filter(x => kindOf(x) === w).length;
    let info = '', act = '';
    if (!t) {
      info = `<b>${where}</b>：空き。播く作物を選ぶ（種と培地の費用。下は1トレイの見込み利益の最大）`;
      act = '<div class="g">' + Object.keys(B.crops).map(id => {
        const e = trayEstimate(id, B, f.equipment), best = Math.max(...e.outlets.map(o => o.profit));
        return `<button data-sow="${id}" title="${CROPS[id].note}">${cropName(id)}<small>${yen(e.cost.seed + e.cost.medium)} → 最大${signed(best)}</small></button>`;
      }).join('') + `</div><label class="fa"><input type="checkbox" id="fsa">空きトレイ（${count('empty')}枚）全部に播く</label>`;
    } else {
      const name = cropName(t.crop.id), sown = (f.hour - t.sownAt) / 24;
      if (k === 'grow') {
        const eta = farmDay({ ...f, hour: t.sownAt + CROPS[t.crop.id].days * 24 });
        info = `<b>${where}</b>：${name}　播いて ${sown.toFixed(1)}日・生育 ${Math.round(t.crop.growth * 100)}%・${vigor(t.crop.health)}<br><small>順調なら Day ${eta} に育ち終わる</small>`;
      } else if (k === 'ripe') {
        const left = t.ripeAt! / 24 + B.crops[t.crop.id].windowDays - f.hour / 24, fr = freshness(t, f.hour);
        info = `<b>${where}</b>：${name}　収穫できる（${vigor(t.crop.health)}）<br><small>${fr < 1 ? `適期を過ぎて価値 −${Math.round((1 - fr) * 100)}%。あと ${(left + B.overgrowDiscardDays).toFixed(1)}日で売れなくなる` : `適期はあと ${left.toFixed(1)}日`}</small>`;
        act = `<div class="g"><button data-act="harvest" class="on">🧺 収穫</button><button data-act="harvest" data-all="1">収穫できる ${count('ripe')}枚を全部</button></div>`;
      } else {
        info = `<b>${where}</b>：${name}　枯れた・売れない。片付けると播ける`;
        act = `<div class="g"><button data-act="clear">🧹 片付け</button><button data-act="clear" data-all="1">枯れた ${count('dead')}枚を全部</button></div>`;
      }
    }
    setHtml($('fdi'), info);
    setHtml($('fda'), act);
  }

  private side() {
    const f = this.f, L = totals(f.ledger);
    setHtml($('fsum'), `<table><tr><td>今月の売上</td><td>${yen(L.revenue)}</td></tr><tr><td>費用</td><td>${yen(L.cost)}</td></tr>`
      + `<tr><td><b>利益</b></td><td><b>${signed(L.profit)}</b></td></tr></table><small>減価償却は月末に計上</small>`);
    // 在庫：作物ごとの量・一番早い期限・取り置き
    const keep = reserved(f), by: Record<string, { g: number; exp: number }> = {};
    for (const l of f.stock) {
      const s = (by[l.crop] ??= { g: 0, exp: Infinity });
      s.g += l.grams;
      s.exp = Math.min(s.exp, l.expiresAt);
    }
    const stock = Object.entries(by).map(([id, s]) => {
      const kp = Math.min(s.g, keep[id] ?? 0), free = s.g - kp;
      return `<div class="fs"><b>${cropName(id)}</b> ${s.g.toFixed(0)}g<small>期限 ${when(s.exp)}${kp ? `・取り置き ${kp.toFixed(0)}g` : ''}</small>`
        + (free > 0.5 ? `<button data-ws="${id}">卸に出す ${free.toFixed(0)}g</button>` : '') + '</div>';
    }).join('');
    setHtml($('fst'), stock || '<small>なし（直売は毎日 古い在庫から売れる）</small>');
    // 契約：次の納品日・欠品
    const today = farmDay(f);
    setHtml($('fct'), B.contracts.map(c => {
      const st = f.contracts[c.id];
      let next = Math.max(today + 1, c.startDay);
      while ((next - 1) % 7 !== c.weekday) next++;
      const status = st.lost ? '<em class="ng">契約切れ</em>' : `次 Day ${next}（あと${next - today}日）`;
      return `<div class="fs${st.lost ? ' lost' : ''}" title="${c.note ?? ''}"><b>${c.name}</b> ${cropName(c.crop)} ${c.grams}g・毎週${WD[c.weekday]}`
        + `<small>${c.pricePer100g ? `${yen(c.pricePer100g)}/100g・` : ''}${status}・欠品 ${st.misses}/${c.maxMisses}</small></div>`;
    }).join(''));
    setHtml($('flg'), logHtml(f.log));
  }

  // ---- 帳簿 ----

  openBook(tab: BookTab): void {
    this.bookTab = tab;
    $('bk').style.display = 'flex';
    this.book();
  }

  closeBook(): void {
    this.bookTab = null;
    $('bk').style.display = 'none';
  }

  private book() {
    const tab = this.bookTab!, T: [BookTab, string][] = [['pl', '月次損益'], ['est', '見込み'], ['equip', '設備']];
    const body = tab === 'pl' ? plHtml(this.f) : tab === 'est' ? estHtml(this.f) : equipHtml(this.f);
    setHtml($('bp'), `<div class="zh"><h2>帳簿</h2><button data-close="1" aria-label="閉じる">✕</button></div>`
      + `<div class="g3">${T.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div>`
      + `<div class="zl">${body}</div><small class="zn">※数値は仮置きの簡略モデルです（根拠は公開前に裏取りする）。</small>`);
  }

  /** 選んだトレイ（空きなら棚の別のトレイ）を栽培モードの栽培槽の形にする。値は計器の読みではなく実際の値（見た目は本物） */
  private traySim(): SimState | null {
    const f = this.f, r = f.racks[this.rack];
    const t = r.slots[this.slot] ?? r.slots.find(x => x) ?? null;
    const s = createSim({ crop: t?.crop.id ?? 'radish' }), bed = s.compartments[0], v = rackValues(f, r.id);
    bed.water = v.water;
    bed.solutes.salts = v.ec * v.water;
    bed.ph = v.ph;
    if (t) {
      Object.assign(s.crop, { growth: t.crop.growth, health: t.crop.health });
      s.hour = f.hour - t.sownAt;
    } else s.crop.growth = 0;
    return s;
  }
}

/** 経営の記録（新しい順）。養液の操作と測定は多いので出さない。同じ時刻の同じ記録はまとめる */
function logHtml(log: FarmEvent[]): string {
  const rows: { hour: number; text: string; n: number; cls?: string }[] = [];
  const spot = (rack: string, slot: number) => `棚${rack.replace(/\D/g, '')}-${slot + 1}`;
  for (const e of log) {
    let text = '', cls: string | undefined;
    switch (e.kind) {
      case 'command': {
        const c = e.command;
        if (c.type === 'sow') text = `🌱 ${cropName(c.crop)}を播いた`;
        else if (c.type === 'clear') text = '🧹 枯れたトレイを片付けた';
        else if (c.type === 'wholesale') text = `📦 ${c.crop ? cropName(c.crop) : '在庫'}を卸に出した`;
        else if (c.type === 'buy') { text = `🛒 ${B.equipment[c.item].name}を買った（${yen(B.equipment[c.item].price)}）`; cls = 'o'; }
        break;
      }
      case 'harvest': text = `🧺 ${cropName(e.crop)}を収穫（等級 ${e.grade}）`; break;
      case 'delivery': {
        const c = B.contracts.find(x => x.id === e.contract)!;
        if (e.short > c.grams * 0.1) { text = `⚠️ ${c.name}に欠品（${e.grams.toFixed(0)}/${c.grams}g）`; cls = 'ng'; }
        else text = `🚚 ${c.name}に納品 ${e.grams.toFixed(0)}g ${yen(e.yen)}`;
        break;
      }
      case 'contractLost': text = `❌ ${B.contracts.find(x => x.id === e.contract)!.name}との契約が切れた`; cls = 'ng'; break;
      case 'direct': text = `🏪 直売 ${e.grams.toFixed(0)}g ${yen(e.yen)}`; break;
      case 'expired': text = `🗑 ${cropName(e.crop)} ${e.grams.toFixed(0)}g が日持ち切れで廃棄`; cls = 'ng'; break;
      case 'dead': text = `🥀 ${spot(e.rack, e.slot)} ${cropName(e.crop)}が${e.reason === 'health' ? '枯れた' : '育ちすぎて売れなくなった'}`; cls = 'ng'; break;
      case 'month': text = `📅 ${e.ledger.month}か月目を締めた：利益 ${signed(totals(e.ledger).profit)}`; cls = 'o'; break;
    }
    if (!text) continue;
    const last = rows.at(-1);
    if (last && last.hour === e.hour && last.text === text) last.n++;
    else rows.push({ hour: e.hour, text, n: 1, cls });
  }
  if (!rows.length) return '<small>空きトレイを押して種を播こう。契約の納品日（☰ の契約）から逆算して播くのがコツ。</small>';
  return rows.slice(-40).reverse().map(r => `<div class="jn${r.cls ? ' ' + r.cls : ''}"><small>${when(r.hour)}</small> ${r.text}${r.n > 1 ? ` ×${r.n}` : ''}</div>`).join('');
}

/** 月次損益（締めた月と今月の途中） */
function plHtml(f: FarmState): string {
  const cols: [string, Ledger][] = [...f.months.slice(-2).map(l => [`${l.month}か月目`, l] as [string, Ledger]), [`${f.ledger.month}か月目（途中）`, f.ledger]];
  const row = (label: string, fn: (l: Ledger) => string, cls = '') => `<tr class="${cls}"><td>${label}</td>${cols.map(([, l]) => `<td>${fn(l)}</td>`).join('')}</tr>`;
  const y = (fn: (l: Ledger) => number) => (l: Ledger) => yen(fn(l));
  const labor = (l: Ledger) => l.laborMin / 60;
  return `<table class="pl"><tr><th></th>${cols.map(([h]) => `<th>${h}</th>`).join('')}</tr>`
    + row('卸', y(l => l.revenue.wholesale)) + row('飲食店（契約）', y(l => l.revenue.restaurant)) + row('直売', y(l => l.revenue.direct))
    + row('売上 計', y(l => totals(l).revenue), 'sum')
    + row('種', y(l => l.cost.seed)) + row('培地', y(l => l.cost.medium)) + row('養液・調整剤', y(l => l.cost.nutrient)) + row('包装', y(l => l.cost.pack))
    + row('電気代', y(l => l.cost.power)) + row('家賃', y(l => l.cost.rent)) + row('減価償却', y(l => l.cost.depreciation))
    + row('費用 計', y(l => totals(l).cost), 'sum')
    + row('利益', l => signed(totals(l).profit), 'sum big')
    + row('設備の購入（現金）', y(l => l.capex))
    + row('収穫', l => `${(l.harvestG / 1000).toFixed(2)}kg`) + row('販売', l => `${(l.soldG / 1000).toFixed(2)}kg`)
    + row('廃棄', l => `${(l.wasteG / 1000).toFixed(2)}kg`) + row('廃棄の損（卸値）', y(l => l.wasteYen))
    + row('作業時間', l => `${labor(l).toFixed(1)}h`) + row('時給の目安', l => (labor(l) > 0 ? signed(totals(l).profit / labor(l)) : '—'))
    + `</table><small>現金 ${yen(f.cash)}（元手 ${yen(B.startCash)}）。設備は買った月に現金が出て、費用は減価償却で月割り。作業時間は損益に入れず、時給の目安＝利益÷作業時間。</small>`;
}

/** 作物ごとの1トレイの損益見込み */
function estHtml(f: FarmState): string {
  return Object.keys(B.crops).map(id => {
    const e = trayEstimate(id, B, f.equipment), c = e.cost;
    const rows = e.outlets.map(o => {
      const ct = o.contract ? B.contracts.find(x => x.id === o.contract)! : null;
      const rest = e.yieldG > o.grams ? '＋残りを卸' : '';
      const label = ct ? `${ct.name}（契約 ${o.grams}g${rest}）` : o.kind === 'wholesale' ? '卸（全量）' : `直売（${o.grams.toFixed(0)}g${rest}）`;
      return `<tr><td>${label}</td><td>${yen(o.net)}</td><td class="${o.profit < 0 ? 'ng' : 'ok'}">${signed(o.profit)}</td></tr>`;
    }).join('');
    return `<div class="ze"><b>${cropName(id)}</b>　${e.days}日・${e.yieldG}g<br><small>費用 ${yen(c.total)}（種 ${yen(c.seed)}・培地 ${yen(c.medium)}・電気代 ${yen(c.power)}）</small>`
      + `<table class="es"><tr><th>販路</th><th>手取り</th><th>利益</th></tr>${rows}</table></div>`;
  }).join('') + `<small>等級 A・健康に育った1トレイの見込み。手取り＝売上−包装費。直売は1日 ${B.directDemandGPerDay}g しか売れないので、日持ちの間に売れる分（ほかの在庫と取り合う）。家賃・養液・作業時間は含まない。電気代は棚1台の分をトレイ8枚で割った日割り。</small>`;
}

function equipHtml(f: FarmState): string {
  return EQUIP_ORDER.map(k => {
    const e = B.equipment[k], have = f.equipment[k], max = k === 'rack' ? B.maxRacks - 1 : 1;
    const label = have >= max ? '✓ 導入済み' : f.cash < e.price ? 'お金が足りない' : `買う ${yen(e.price)}`;
    return `<div class="ze"><b>${e.name}</b><em class="zb">${yen(e.price)}${k === 'rack' ? `（棚 ${f.racks.length}/${B.maxRacks}台）` : ''}</em>`
      + `<p>${e.note}</p><small>減価償却 ${e.lifeMonths}か月（月 ${yen(e.price / e.lifeMonths)}）</small>`
      + `<button data-buy="${k}" ${canBuy(f, k) ? '' : 'disabled'} style="width:100%;margin-top:4px">${label}</button></div>`;
  }).join('');
}
