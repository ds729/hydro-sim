// カメラ：プリセット・ドラッグ回転・ホイールでズーム
// 距離は「収める点がパネルに隠れない領域（safe）に収まる距離」とプリセット距離の大きい方を使い、
// 投影をずらして点の外接矩形を safe の中央に置く

import * as THREE from 'three';

type P3 = [number, number, number];
/** 直方体の8隅 */
const corners = ([a, b]: [P3, P3]): P3[] =>
  [...Array(8)].map((_, i) => [i & 1 ? b[0] : a[0], i & 2 ? b[1] : a[1], i & 4 ? b[2] : a[2]]);

interface Preset {
  /** 方位・仰角（rad）・距離・注視点の高さ */
  theta: number; phi: number; r: number; y: number;
  /** 画面に収める点 */
  fit: P3[];
}

/** 全景＝部屋（床スラブ＋壁の上端）、断面＝栽培槽、寄り＝トレイ、モニタ＝モニタ */
export const PRESETS = {
  全景: { theta: 0.6, phi: 1.12, r: 12.5, y: 1.6, fit: [...corners([[-4.7, -1.26, -3.7], [4.7, 0, 3.7]]), [-4.7, 4.72, -3.7], [4.7, 4.72, -3.7], [-4.7, 4.72, 3.7]] },
  断面: { theta: 0, phi: 1.45, r: 9.5, y: 1.5, fit: corners([[-1.6, 0, -0.5], [2.8, 3.2, 2.1]]) },
  寄り: { theta: 0.35, phi: 1.05, r: 5.6, y: 1.9, fit: corners([[-1.25, 1.8, -0.2], [2.45, 2.5, 1.8]]) },
  モニタ: { theta: 0, phi: 1.4, r: 6.2, y: 2.7, fit: corners([[-1.3, 1.95, -3.45], [1.3, 3.45, -3.3]]) },
} satisfies Record<string, Preset>;
export type PresetName = keyof typeof PRESETS;

/** [方位, 仰角, 距離, 注視点の高さ, 投影のずらし x, y] */
type Pose = [number, number, number, number, number, number];
/** [左, 上, 右, 下]（px） */
export type Rect = [number, number, number, number];

export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(34, 1, 0.1, 200);
  private size: [number, number] = [1, 1];
  private safe: Rect = [0, 0, 1, 1];
  private preset: PresetName | null = null;
  /** プリセットに合わせた距離（ズームの上限とリサイズ時の補正に使う） */
  private fitDist = 1;
  private goal: Pose = [0, 1, 10, 0, 0, 0];
  private cur: Pose = [0, 1, 10, 0, 0, 0];
  private v = new THREE.Vector3();

  private place(theta: number, phi: number, r: number, y: number) {
    const c = this.camera;
    c.position.set(Math.sin(theta) * Math.sin(phi) * r, y + Math.cos(phi) * r, Math.cos(theta) * Math.sin(phi) * r);
    c.lookAt(0, y, 0);
  }

  /** プリセットの点が safe に収まる距離と、外接矩形を safe の中央に置くずらし量 */
  private fit(name: PresetName): [number, number, number] {
    const p = PRESETS[name], [w, h] = this.size, sf = this.safe, cam = this.camera;
    cam.clearViewOffset();
    let box: Rect = [0, 0, 0, 0];
    const ok = (r: number) => {
      this.place(p.theta, p.phi, r, p.y);
      cam.updateMatrixWorld();
      box = [1e9, 1e9, -1e9, -1e9];
      for (const q of p.fit) {
        this.v.set(...q).project(cam);
        if (this.v.z > 1) return false;
        const x = ((this.v.x + 1) / 2) * w, y = ((1 - this.v.y) / 2) * h;
        box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
      }
      return box[2] - box[0] <= sf[2] - sf[0] && box[3] - box[1] <= sf[3] - sf[1];
    };
    let r = p.r;
    if (!ok(r)) {
      let lo = r, hi = 150;
      for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (ok(m)) hi = m; else lo = m; }
      ok((r = hi));
    }
    return [r, (box[0] + box[2] - sf[0] - sf[2]) / 2, (box[1] + box[3] - sf[1] - sf[3]) / 2];
  }

  /** 画面サイズとパネルに隠れない領域を設定し、今のプリセットに合わせ直す */
  setViewport(w: number, h: number, safe: Rect): void {
    this.size = [w, h];
    this.safe = safe;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (!this.preset) return;
    const [r, ox, oy] = this.fit(this.preset), k = r / this.fitDist;
    this.goal[2] *= k;
    this.cur[2] *= k;
    this.fitDist = r;
    this.goal[4] = this.cur[4] = ox;
    this.goal[5] = this.cur[5] = oy;
  }

  /** プリセットへ移る。instant なら補間せずにその場で切り替える */
  goTo(name: PresetName, instant = false): void {
    const p = PRESETS[name], [r, ox, oy] = this.fit(name);
    this.preset = name;
    this.fitDist = r;
    this.goal = [p.theta, p.phi, r, p.y, ox, oy];
    if (instant) this.cur = [...this.goal];
  }

  /** 毎フレーム呼ぶ。目標の姿勢に 12% ずつ近づける */
  update(): void {
    this.cur = this.cur.map((v, i) => v + (this.goal[i] - v) * 0.12) as Pose;
    const [t, p, r, y, ox, oy] = this.cur, [w, h] = this.size;
    this.place(t, p, r, y);
    this.camera.setViewOffset(w, h, ox, oy, w, h);
  }

  /** ドラッグで回転、ホイールでズーム */
  attach(el: HTMLElement): void {
    let drag: [number, number] | null = null;
    el.addEventListener('pointerdown', e => { drag = [e.clientX, e.clientY]; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointerup', () => { drag = null; });
    el.addEventListener('pointermove', e => {
      if (!drag) return;
      this.goal[0] -= (e.clientX - drag[0]) * 0.006;
      this.goal[1] = Math.max(0.5, Math.min(1.65, this.goal[1] - (e.clientY - drag[1]) * 0.006));
      drag = [e.clientX, e.clientY];
    });
    el.addEventListener('wheel', e => {
      e.preventDefault();
      const f = this.fitDist;
      this.goal[2] = Math.max(3, Math.min(Math.max(20, f * 1.6), this.goal[2] + e.deltaY * 0.005 * Math.max(1, f / 12)));
    }, { passive: false });
  }
}
