// カメラ：正投影。プリセット・ドラッグ回転・ホイールでズーム
// 倍率は「収める点がパネルに隠れない領域（safe）に収まる最大の倍率」。safe の候補が複数あるときは被写体が大きく映る方を使い、
// 投影をずらして点の外接矩形を safe の中央に置く。
// cut のあるプリセットは近クリップ面を注視点の手前に置き、それより手前の物を切り落とす（断面図の考え方。モニタの前の枠・ケーブルなど）

import * as THREE from 'three';
import { SLAB } from './build';

type P3 = [number, number, number];
/** 直方体の8隅 */
const corners = ([a, b]: [P3, P3]): P3[] =>
  [...Array(8)].map((_, i) => [i & 1 ? b[0] : a[0], i & 2 ? b[1] : a[1], i & 4 ? b[2] : a[2]]);

interface Preset {
  /** 方位・天頂からの角（rad） */
  theta: number; phi: number;
  /** 画面に収める点。注視点（回転の中心）はその外接直方体の中心 */
  fit: P3[];
  /** 近クリップ面を注視点から何 m 手前に置くか。省略すると切らない */
  cut?: number;
}

/** 等角図の天頂角（視線が (1,1,1) 方向、仰角 35.26°） */
const ISO = Math.acos(1 / Math.sqrt(3));

/**
 * 全景＝部屋（床スラブ＋壁の上端）の等角図、平面＝床（高さ 2.75m で切り、LED バー・枠・ケーブルを外す）、
 * 断面＝栽培槽の正面（上の壁のモニタまで）、寄り＝トレイ、モニタ＝モニタ（栽培槽の後ろで切り、枠・ケーブルを外す）
 */
export const PRESETS = {
  全景: { theta: Math.PI / 4, phi: ISO, fit: [...corners([[-4.7, -SLAB, -3.7], [4.7, 0, 3.7]]), [-4.7, 4.72, -3.7], [4.7, 4.72, -3.7], [-4.7, 4.72, 3.7]] },
  平面: { theta: 0, phi: 0.001, fit: corners([[-4.7, 0, -3.7], [4.7, 0, 3.7]]), cut: 2.75 },
  断面: { theta: 0, phi: 1.5, fit: corners([[-1.6, 0, -0.5], [2.8, 4.45, 2.1]]) },
  寄り: { theta: 0.35, phi: 0.9, fit: corners([[-1.25, 1.0, -0.2], [2.45, 2.1, 1.8]]) },
  モニタ: { theta: 0, phi: 1.52, fit: corners([[-1.5, 2.85, -3.45], [1.5, 4.55, -3.3]]), cut: 2.7 },
} satisfies Record<string, Preset>;
export type PresetName = keyof typeof PRESETS;

/** カメラと注視点の距離（正投影なので見え方は変わらない。近クリップ面の基準） */
const D = 40;
/** 切らないときの cut（近クリップ面がシーンより手前に来る） */
const NO_CUT = 30;

/** [方位, 天頂角, 倍率（px/m）, 注視点 x, y, z, 投影のずらし x, y, cut] */
type Pose = [number, number, number, number, number, number, number, number, number];
/** [左, 上, 右, 下]（px） */
export type Rect = [number, number, number, number];

export class CameraRig {
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2 * D);
  private size: [number, number] = [1, 1];
  private safes: Rect[] = [[0, 0, 1, 1]];
  private preset: PresetName | null = null;
  /** プリセットに合わせた倍率（ズームの範囲とリサイズ時の補正に使う） */
  private fitZoom = 1;
  private goal: Pose = [0, 1, 1, 0, 0, 0, 0, 0, NO_CUT];
  private cur: Pose = [0, 1, 1, 0, 0, 0, 0, 0, NO_CUT];
  private v = new THREE.Vector3();

  private place([theta, phi, zoom, tx, ty, tz, , , cut]: Pose) {
    const c = this.camera, s = Math.sin(phi);
    c.position.set(tx + Math.sin(theta) * s * D, ty + Math.cos(phi) * D, tz + Math.cos(theta) * s * D);
    c.lookAt(tx, ty, tz);
    c.zoom = zoom;
    c.near = Math.max(0.1, D - cut);
  }

  /** プリセットの点が safe に収まる最大の倍率・注視点・外接矩形を safe の中央に置くずらし量 */
  private fit(name: PresetName): [number, P3, number, number] {
    const p: Preset = PRESETS[name], [w, h] = this.size, cam = this.camera;
    const lo = [0, 1, 2].map(k => Math.min(...p.fit.map(q => q[k]))), hi = [0, 1, 2].map(k => Math.max(...p.fit.map(q => q[k])));
    const t = lo.map((v, k) => (v + hi[k]) / 2) as P3;
    this.place([p.theta, p.phi, 1, ...t, 0, 0, NO_CUT]);
    cam.updateMatrixWorld();
    // 収める点をカメラ座標（m）に移して外接矩形を取る
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const q of p.fit) {
      const { x, y } = this.v.set(...q).applyMatrix4(cam.matrixWorldInverse);
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    }
    let best = 0, ox = 0, oy = 0;
    for (const s of this.safes) {
      const z = Math.min(Math.max(1, s[2] - s[0]) / (x1 - x0), Math.max(1, s[3] - s[1]) / (y1 - y0));
      if (z <= best) continue;
      best = z;
      ox = w / 2 + ((x0 + x1) / 2) * z - (s[0] + s[2]) / 2;
      oy = h / 2 - ((y0 + y1) / 2) * z - (s[1] + s[3]) / 2;
    }
    return [best, t, ox, oy];
  }

  /** 画面サイズとパネルに隠れない領域の候補を設定し、今のプリセットに合わせ直す */
  setViewport(w: number, h: number, safes: Rect[]): void {
    this.size = [w, h];
    this.safes = safes;
    Object.assign(this.camera, { left: -w / 2, right: w / 2, top: h / 2, bottom: -h / 2 });
    if (!this.preset) return;
    const [z, , ox, oy] = this.fit(this.preset), k = z / this.fitZoom;
    this.goal[2] *= k;
    this.cur[2] *= k;
    this.fitZoom = z;
    this.goal[6] = this.cur[6] = ox;
    this.goal[7] = this.cur[7] = oy;
  }

  /** プリセットへ移る。instant なら補間せずにその場で切り替える */
  goTo(name: PresetName, instant = false): void {
    const p: Preset = PRESETS[name], [z, t, ox, oy] = this.fit(name);
    this.preset = name;
    this.fitZoom = z;
    this.goal = [p.theta, p.phi, z, ...t, ox, oy, p.cut ?? NO_CUT];
    // ドラッグで何周も回した後でも近い向きから回り込む
    this.cur[0] = p.theta + (((this.cur[0] - p.theta) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    if (instant) this.cur = [...this.goal];
  }

  /** 毎フレーム呼ぶ。目標の姿勢に 12% ずつ近づける */
  update(): void {
    this.cur = this.cur.map((v, i) => v + (this.goal[i] - v) * 0.12) as Pose;
    const [w, h] = this.size;
    this.place(this.cur);
    // setViewOffset が投影行列も作り直す（倍率・近クリップ面の変更もここで反映される）
    this.camera.setViewOffset(w, h, this.cur[6], this.cur[7], w, h);
  }

  /** ドラッグで回転、ホイールでズーム */
  attach(el: HTMLElement): void {
    let drag: [number, number] | null = null;
    el.addEventListener('pointerdown', e => { drag = [e.clientX, e.clientY]; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointerup', () => { drag = null; });
    el.addEventListener('pointermove', e => {
      if (!drag) return;
      this.goal[0] -= (e.clientX - drag[0]) * 0.006;
      this.goal[1] = Math.max(0.001, Math.min(1.62, this.goal[1] - (e.clientY - drag[1]) * 0.006));
      drag = [e.clientX, e.clientY];
    });
    el.addEventListener('wheel', e => {
      e.preventDefault();
      const f = this.fitZoom;
      this.goal[2] = Math.min(f * 5, Math.max(f * 0.6, this.goal[2] * Math.exp(-e.deltaY * 0.0015)));
    }, { passive: false });
  }
}
