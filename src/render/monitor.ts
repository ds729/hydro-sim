// 壁掛けモニタ（CanvasTexture に養液の値とグラフを描く）

import * as THREE from 'three';
import { LIGHT, TRACE_HOURS, cropSpec, dayOf, isLit, type Diagnosis, type Factor, type SimState } from '../sim';

const W = 512, H = 278;
const lamp = (q: number) => (q > 0.9 ? '#5fe09a' : q > 0.5 ? '#f2c230' : '#ff6b6b');

/** センサの表示を伏せる理由（false は伏せない） */
export type Blind = false | 'quiz' | 'noProbe';

export class Monitor {
  readonly texture: THREE.CanvasTexture;
  private ctx: CanvasRenderingContext2D;

  constructor() {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    this.ctx = c.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(c);
    // Canvas の色は sRGB（指定しないとリニアとして扱われ、白っぽく出る）
    this.texture.colorSpace = THREE.SRGBColorSpace;
  }

  /**
   * clock は部屋の時計（経過時間 h。経営モードでは s.hour が播いてからの時間なので別に渡す）。alert は警報の帯（ポンプの停止）。
   * rules は自動制御ルールの行ごとの状態（0＝行なし・1＝無効・2＝有効・3＝動いた直後）。有効な行があれば、グラフを直近24時間のセンサの読みにして、
   * しきい値の破線と自動の操作の印を重ね、下に AUTO のランプを並べる（行き過ぎ・ハンチングを見せる）
   */
  draw(s: SimState, d: Diagnosis, clock = s.hour, alert: string | null = null, rules: readonly number[] = []): void {
    const x = this.ctx, days = cropSpec(s).days, dy = dayOf(s), { values: v, fitness: f } = d;
    x.fillStyle = '#0f2a2e';
    x.fillRect(0, 0, W, H);
    x.font = 'bold 22px sans-serif';
    x.fillStyle = '#8be3c4';
    x.fillText('養液モニタ　Day ' + dy + (dy > days ? '（超過）' : '') + `　${Math.floor(clock) % 24}時`, 16, 32);
    x.font = '16px sans-serif';
    x.fillStyle = isLit(clock) ? '#ffd2ec' : '#7d8aa8';
    x.fillText(isLit(clock) ? '照明 ON' : '照明 OFF', 420, 32);
    const rows: [string, string, number][] = [
      ['EC', v.ec.toFixed(2), f.ec],
      ['pH', v.ph.toFixed(2), f.ph],
      ['液量', v.water.toFixed(2) + ' L', f.water],
    ];
    rows.forEach(([label, val, q], i) => {
      const y = 86 + i * 50;
      x.fillStyle = lamp(q);
      x.beginPath();
      x.arc(26, y - 9, 9, 0, 6.3);
      x.fill();
      x.fillStyle = '#d9efe6';
      x.font = '20px sans-serif';
      x.fillText(label, 46, y);
      x.font = 'bold 30px sans-serif';
      x.fillText(val, 120, y);
    });
    const auto = rules.some(v => v >= 2);
    x.strokeStyle = '#2c5a5e';
    x.lineWidth = 1;
    x.strokeRect(300, 50, 196, 130);
    if (auto) this.dayGraph(s); else {
      const series: ['ec' | 'ph', number, number, string][] = [['ec', 0, 3, '#5fe09a'], ['ph', 4, 8, '#6aa8ff']];
      for (const [k, lo, hi, color] of series) {
        x.strokeStyle = color;
        x.lineWidth = 2;
        x.beginPath();
        s.history.forEach((q, j) => {
          const X = 300 + (j / (days * 12)) * 196, Y = 180 - ((q[k] - lo) / (hi - lo)) * 130;
          if (j) x.lineTo(X, Y); else x.moveTo(X, Y);
        });
        x.stroke();
      }
    }
    if (rules.some(v => v > 0)) {
      x.font = 'bold 14px sans-serif';
      x.fillStyle = auto ? '#8be3c4' : '#7d8aa8';
      x.fillText('AUTO', 300, 206);
      rules.forEach((v, i) => {
        x.fillStyle = ['#26343a', '#55606a', '#2f8a5c', '#ffa62b'][v];
        x.beginPath();
        x.arc(358 + i * 24, 201, 8, 0, 6.3);
        x.fill();
        x.fillStyle = v === 3 ? '#1a1a1a' : '#9fb3ad';
        x.font = '11px sans-serif';
        x.fillText(String(i + 1), 355 + i * 24, 205);
      });
    }
    x.fillStyle = '#d9efe6';
    x.font = '16px sans-serif';
    x.fillText('生育 ' + Math.round(s.crop.growth * 100) + '%　健康 ' + Math.max(0, Math.round(s.crop.health)) + '%', 16, 236);
    x.fillStyle = '#1f4a4e';
    x.fillRect(16, 246, 480, 14);
    x.fillStyle = '#5fe09a';
    x.fillRect(16, 246, 480 * s.crop.growth, 14);
    this.alert(alert);
    this.texture.needsUpdate = true;
  }

  /** 直近24時間のセンサの読み（EC・pH の階段）としきい値・自動の操作の印。枠は (300, 50)〜(496, 180) */
  private dayGraph(s: SimState) {
    const x = this.ctx, to = s.hour * 60, from = to - TRACE_HOURS * 60;
    const mx = (m: number) => 300 + ((m - from) / (TRACE_HOURS * 60)) * 196;
    const scale: Partial<Record<Factor, [number, number, string]>> = { ec: [0, 3, '#5fe09a'], ph: [4, 8, '#6aa8ff'] };
    const my = (k: Factor, v: number) => { const [lo, hi] = scale[k]!; return Math.max(50, Math.min(180, 180 - ((v - lo) / (hi - lo)) * 130)); };
    // 夜（照明 消灯）の帯
    x.fillStyle = 'rgba(120,140,190,.12)';
    for (let d = Math.floor(from / 1440) - 1; d * 1440 < to; d++) {
      const a = Math.max(from, (d * 24 + LIGHT.off) * 60), b = Math.min(to, ((d + 1) * 24 + LIGHT.on) * 60);
      if (b > a) x.fillRect(mx(a), 50, mx(b) - mx(a), 130);
    }
    x.setLineDash([5, 4]);
    x.lineWidth = 1.5;
    for (const r of s.control.rules) {
      const sc = scale[r.sensor];
      if (!r.on || !sc) continue;
      x.strokeStyle = sc[2];
      x.beginPath(); x.moveTo(300, my(r.sensor, r.threshold)); x.lineTo(496, my(r.sensor, r.threshold)); x.stroke();
    }
    x.setLineDash([]);
    x.lineWidth = 2;
    for (const k of ['ec', 'ph'] as const) {
      x.strokeStyle = scale[k]![2];
      x.beginPath();
      s.trace.forEach((q, j) => {
        if (j) x.lineTo(mx(q.minute), my(k, s.trace[j - 1][k])); else x.moveTo(mx(q.minute), my(k, q[k]));
        x.lineTo(mx(q.minute), my(k, q[k]));
      });
      const last = s.trace.at(-1);
      if (last) x.lineTo(496, my(k, last[k]));
      x.stroke();
    }
    x.fillStyle = '#ffa62b';
    for (let i = s.log.length - 1; i >= 0; i--) {
      const e = s.log[i];
      if (e.hour * 60 < from - 60) break;
      if (e.kind === 'command' && e.auto && e.minute! >= from) x.fillRect(mx(e.minute!), 174, 2, 6);
    }
    x.font = '12px sans-serif';
    x.fillStyle = '#8be3c4';
    x.fillText('直近24時間（センサ）', 304, 64);
  }

  /** 警報の帯（見出しの行を覆う）。赤地に白で目立たせる */
  private alert(text: string | null) {
    if (!text) return;
    const x = this.ctx;
    x.fillStyle = '#d64545';
    x.fillRect(0, 0, W, 46);
    x.fillStyle = '#fff';
    x.font = 'bold 22px sans-serif';
    x.fillText('⚠ ' + text, 16, 31);
  }

  /** 停電：画面が消える（制御盤とモニタは非常用電源につながっていない設定） */
  drawOff(): void {
    const x = this.ctx;
    x.fillStyle = '#06090a';
    x.fillRect(0, 0, W, H);
    this.texture.needsUpdate = true;
  }

  /** 値を伏せる。quiz＝症状診断モードの出題中、noProbe＝経営モードで連続測定センサがない */
  drawBlind(why: Blind, alert: string | null = null): void {
    const x = this.ctx;
    x.fillStyle = '#0f2a2e';
    x.fillRect(0, 0, W, H);
    x.font = 'bold 22px sans-serif';
    x.fillStyle = '#8be3c4';
    x.fillText(why === 'quiz' ? '症状診断中' : 'センサなし', 16, 32);
    x.fillStyle = '#d9efe6';
    x.font = '20px sans-serif';
    x.fillText(why === 'quiz' ? 'センサの値は答えたあとに表示します' : 'ペン型の計器で測った値は画面の左に出ます', 16, 140);
    if (why === 'noProbe') x.fillText('連続測定センサを付けると毎時表示します', 16, 172);
    this.alert(alert);
    this.texture.needsUpdate = true;
  }
}
