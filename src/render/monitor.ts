// 壁掛けモニタ（CanvasTexture に養液の値とグラフを描く）

import * as THREE from 'three';
import { cropSpec, dayOf, type Diagnosis, type SimState } from '../sim';

const W = 512, H = 278;
const lamp = (q: number) => (q > 0.9 ? '#5fe09a' : q > 0.5 ? '#f2c230' : '#ff6b6b');

export class Monitor {
  readonly texture: THREE.CanvasTexture;
  private ctx: CanvasRenderingContext2D;

  constructor() {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    this.ctx = c.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(c);
  }

  draw(s: SimState, d: Diagnosis): void {
    const x = this.ctx, days = cropSpec(s).days, dy = dayOf(s), { values: v, fitness: f } = d;
    x.fillStyle = '#0f2a2e';
    x.fillRect(0, 0, W, H);
    x.font = 'bold 22px sans-serif';
    x.fillStyle = '#8be3c4';
    x.fillText('養液モニタ　Day ' + dy + (dy > days ? '（超過）' : ''), 16, 32);
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
    this.texture.needsUpdate = true;
  }
}
