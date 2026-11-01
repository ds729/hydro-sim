// HUD（左上）：EC・pH・液量のゲージ、生育・健康、推移グラフ、栽培日誌

import { cropSpec, dayOf, diagnose, type CropSpec, type Factor, type SimEvent, type SimState } from '../sim';
import { journalHtml } from './journal';

const $ = (id: string) => document.getElementById(id)!;

/** [要因, 表示名, ゲージの下端, 上端] */
const GAUGES: [Factor, string, number, number][] = [['ec', 'EC (mS/cm)', 0, 3], ['ph', 'pH', 4, 8], ['water', '液量 (L)', 0, 3]];

export class Hud {
  /** 日誌の最新の記録（変わったときだけ日誌を描き直す） */
  private lastEvent: SimEvent | undefined;

  constructor(spec: CropSpec, private onAdvice: () => void) {
    this.setCrop(spec);
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
    const { values } = diagnose(s), spec = cropSpec(s), dy = dayOf(s);
    for (const [k, , lo, hi] of GAUGES) {
      $('v' + k).textContent = values[k].toFixed(2);
      $('m' + k).style.left = Math.max(0, Math.min(100, ((values[k] - lo) / (hi - lo)) * 100)) + '%';
    }
    $('day').textContent = `Day ${dy} / ${spec.days}` + (dy > spec.days ? '（超過）' : '');
    $('gb').style.width = s.crop.growth * 100 + '%';
    $('hb').style.width = Math.max(0, s.crop.health) + '%';
    const last = s.log.at(-1);
    if (last !== this.lastEvent) {
      this.lastEvent = last;
      if (last?.kind === 'advice') this.onAdvice();
      $('jl').innerHTML = journalHtml(s.log);
    }
    this.chart(s, spec);
  }

  /** 推移グラフ（緑＝EC、青＝pH） */
  private chart(s: SimState, spec: CropSpec) {
    const c = $('ch') as HTMLCanvasElement, x = c.getContext('2d')!, w = c.width, h = c.height;
    x.clearRect(0, 0, w, h);
    x.strokeStyle = 'rgba(128,128,128,.35)';
    x.strokeRect(0, 0, w, h);
    const line = (k: 'ec' | 'ph', lo: number, hi: number, color: string) => {
      x.strokeStyle = color;
      x.lineWidth = 1.5;
      x.beginPath();
      s.history.forEach((q, j) => {
        const X = (j / (spec.days * 12)) * w, Y = h - ((q[k] - lo) / (hi - lo)) * h;
        if (j) x.lineTo(X, Y); else x.moveTo(X, Y);
      });
      x.stroke();
    };
    line('ec', 0, 3, '#2f9e5b');
    line('ph', 4, 8, '#3b82d6');
  }
}
