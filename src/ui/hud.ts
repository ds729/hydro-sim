// HUD（左上）：EC・pH・液量のゲージ、生育・健康、推移グラフ、栽培日誌

import { LIGHT, TRACE_HOURS, cropSpec, dayOf, isLit, mixing, powered, valuesOf, type CropSpec, type DoseSupply, type Factor, type SimEvent, type SimState } from '../sim';
import { journalHtml } from './journal';
import { autoHtml } from './rules';

const $ = (id: string) => document.getElementById(id)!;

/** [要因, 表示名, ゲージの下端, 上端] */
const GAUGES: [Factor, string, number, number][] = [['ec', 'EC (mS/cm)', 0, 3], ['ph', 'pH', 4, 8], ['water', '液量 (L)', 0, 3]];
/** 推移グラフの縦軸（下端・上端）と線の色 */
const SCALE: Record<Factor, [number, number, string]> = { ec: [0, 3, '#2f9e5b'], ph: [4, 8, '#3b82d6'], water: [0, 3, '#d98a1a'] };
/** 操作の印の色（動かす値の線の色） */
const DOSE_COLOR: Record<DoseSupply, string> = { fertilizer: '#2f9e5b', water: '#d98a1a', phDown: '#3b82d6', phUp: '#3b82d6' };

export class Hud {
  /** 日誌の最新の記録（変わったときだけ日誌を描き直す） */
  private lastEvent: SimEvent | undefined;
  /** 推移グラフの期間：all＝植えてから全期間（2時間ごとの本当の値）、day＝直近24時間（30分ごとのセンサの読み） */
  private view: 'all' | 'day' = 'all';

  constructor(spec: CropSpec, private onAdvice: (e: Extract<SimEvent, { kind: 'advice' }>) => void) {
    this.setCrop(spec);
    for (const b of document.querySelectorAll<HTMLButtonElement>('#chv button')) b.onclick = () => this.setView(b.dataset.v as 'all' | 'day');
  }

  setView(v: 'all' | 'day'): void {
    this.view = v;
    for (const b of document.querySelectorAll<HTMLButtonElement>('#chv button')) b.classList.toggle('on', b.dataset.v === v);
  }

  /** 作物の名前とゲージ（適正帯の色）を作り直す。作物を変えて始め直すときにも呼ぶ */
  setCrop(spec: CropSpec): void {
    this.lastEvent = undefined;
    $('cn').textContent = spec.name;
    $('gs').innerHTML = GAUGES.map(([k, label]) =>
      `<div class="row"><b>${label}</b><span id="v${k}"></span><div class="tr" id="t${k}"><div class="mk" id="m${k}"></div></div></div>`).join('');
    // ゲージの背景：赤（0）・黄（適合度が下がる帯）・緑（適正帯）
    for (const [k, , lo, hi] of GAUGES) {
      const b = spec.bands[k], p = (x: number) => (((x - lo) / (hi - lo)) * 100).toFixed(1);
      $('t' + k).style.background = `linear-gradient(90deg,#d6454588 0 ${p(b[0])}%,#e0a10088 ${p(b[0])}% ${p(b[1])}%,#2f9e5b ${p(b[1])}% ${p(b[2])}%,#e0a10088 ${p(b[2])}% ${p(b[3])}%,#d6454588 ${p(b[3])}%)`;
    }
  }

  update(s: SimState): void {
    // ゲージはセンサの読み。入れた資材がまだ混ざっていなければ、混ざったときの見込みを「→」で添える。
    // 停電中はセンサ（制御器）も止まり、停電の前の読みのまま（薄く出す）
    const values = valuesOf(s, 'sensor'), ahead = mixing(s) ? valuesOf(s, 'settled') : null, spec = cropSpec(s), dy = dayOf(s);
    const stale = !powered(s.facility);
    for (const [k, , lo, hi] of GAUGES) {
      const v = values[k].toFixed(2), a = ahead?.[k].toFixed(2), el = $('v' + k);
      el.innerHTML = a && a !== v ? `${v}<small class="ah">→${a}</small>` : v;
      el.classList.toggle('stale', stale);
      el.title = stale ? '停電中：センサが止まり、停電の前の読みのまま' : a && a !== v ? '入れた資材が混ざりきると右の値になる見込み（混ざるまで30分〜1時間ほど）' : 'センサの読み（30分ごと）';
      $('m' + k).style.left = Math.max(0, Math.min(100, ((values[k] - lo) / (hi - lo)) * 100)) + '%';
    }
    const lit = isLit(s.hour), on = powered(s.facility);
    $('day').textContent = `Day ${dy} / ${spec.days}` + (dy > spec.days ? '（超過）' : '') + `・${s.hour % 24}時 ${!on ? '⚡' : lit ? '💡' : '🌙'}`;
    $('day').title = !on ? '停電中：照明とポンプが止まっている' : lit ? `照明 点灯中（${LIGHT.on}〜${LIGHT.off}時）` : `照明 消灯中（${LIGHT.off}〜${LIGHT.on}時）。夜は吸水が少ない`;
    $('gb').style.width = s.crop.growth * 100 + '%';
    $('hb').style.width = Math.max(0, s.crop.health) + '%';
    const last = s.log.at(-1);
    if (last !== this.lastEvent) {
      this.lastEvent = last;
      if (last?.kind === 'advice') this.onAdvice(last);
      // 開いている「なぜ？」は描き直しても開いたままにする
      const jl = $('jl'), open = new Set([...jl.querySelectorAll<HTMLDetailsElement>('details[open]')].map(d => d.dataset.k));
      jl.innerHTML = journalHtml(s.log, spec);
      for (const d of jl.querySelectorAll<HTMLDetailsElement>('details')) d.open = open.has(d.dataset.k);
    }
    const au = $('au'), ah = autoHtml(s);
    if (au.dataset.h !== ah) { au.dataset.h = ah; au.innerHTML = ah; }
    this.chart(s, spec);
  }

  /**
   * 推移グラフ（緑＝EC、青＝pH、橙＝液量。灰の帯＝照明の消灯）。破線＝自動制御ルールのしきい値、
   * 下の印＝自動の操作・上の印＝手の操作（資材が動かす値の色）。全期間は 2時間ごとの本当の値、直近24時間は 30分ごとのセンサの読み
   */
  private chart(s: SimState, spec: CropSpec) {
    const c = $('ch') as HTMLCanvasElement, x = c.getContext('2d')!, w = c.width, h = c.height;
    const day = this.view === 'day', to = s.hour * 60, from = day ? to - TRACE_HOURS * 60 : 0, span = day ? TRACE_HOURS * 60 : spec.days * 1440;
    const mx = (minute: number) => ((minute - from) / span) * w, my = (k: Factor, v: number) => h - ((v - SCALE[k][0]) / (SCALE[k][1] - SCALE[k][0])) * h;
    x.clearRect(0, 0, w, h);
    x.fillStyle = 'rgba(110,120,150,.16)';
    for (let d = Math.floor(from / 1440) - 1; d * 1440 < from + span; d++) {
      const a = Math.max(from, (d * 24 + LIGHT.off) * 60), b = Math.min(from + span, ((d + 1) * 24 + LIGHT.on) * 60);
      if (b > a) x.fillRect(mx(a), 0, mx(b) - mx(a), h);
    }
    x.strokeStyle = 'rgba(128,128,128,.35)';
    x.lineWidth = 1;
    x.strokeRect(0, 0, w, h);
    // しきい値（有効な行だけ）
    x.setLineDash([3, 3]);
    for (const r of s.control.rules) {
      if (!r.on) continue;
      x.strokeStyle = SCALE[r.sensor][2];
      const Y = Math.round(my(r.sensor, r.threshold)) + 0.5;
      x.beginPath(); x.moveTo(0, Y); x.lineTo(w, Y); x.stroke();
    }
    x.setLineDash([]);
    x.lineWidth = 1.5;
    for (const k of ['ec', 'ph', 'water'] as const) {
      x.strokeStyle = SCALE[k][2];
      x.beginPath();
      if (day) {
        // センサの読みは次に取り直すまで同じ値（階段）
        s.trace.forEach((q, j) => {
          const X = mx(q.minute), Y = my(k, q[k]);
          if (j) x.lineTo(X, my(k, s.trace[j - 1][k])); else x.moveTo(X, Y);
          x.lineTo(X, Y);
        });
        const lastQ = s.trace.at(-1);
        if (lastQ) x.lineTo(mx(to), my(k, lastQ[k]));
      } else {
        s.history.forEach((q, j) => {
          const X = mx((j + 1) * 120), Y = my(k, q[k]);
          if (j) x.lineTo(X, Y); else x.moveTo(X, Y);
        });
      }
      x.stroke();
    }
    // 操作の印（同じ画素の列は1本にまとめる）
    const seen = new Set<string>();
    for (let i = s.log.length - 1; i >= 0; i--) {
      const e = s.log[i];
      if (e.hour * 60 < from - 60) break;
      if (e.kind !== 'command' || e.command.type !== 'dose') continue;
      const X = Math.round(mx(e.minute ?? e.hour * 60)), key = `${X}${e.auto ? 'a' : 'm'}${e.command.supply}`;
      if (X < 0 || seen.has(key)) continue;
      seen.add(key);
      x.fillStyle = DOSE_COLOR[e.command.supply];
      x.fillRect(X, e.auto ? h - 5 : 0, 1.5, 5);
    }
  }
}
