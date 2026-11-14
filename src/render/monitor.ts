// 壁掛けモニタ（CanvasTexture に養液の値とグラフを描く）

import * as THREE from 'three';
import { cropSpec, dayOf, isLit, type Diagnosis, type SimState } from '../sim';

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

  /** clock は部屋の時計（経過時間 h。経営モードでは s.hour が播いてからの時間なので別に渡す）。alert は警報の帯（ポンプの停止） */
  draw(s: SimState, d: Diagnosis, clock = s.hour, alert: string | null = null): void {
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
    x.strokeStyle = '#2c5a5e';
    x.lineWidth = 1;
    x.strokeRect(300, 50, 196, 130);
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
