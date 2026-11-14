// パーティクル（Phase 5）：資材のしずく・水はね、ポンプの水流、経営の棚の養液タンクの泡。
// 粒は InstancedMesh 1つ（draw call 1）に詰め、寿命の終わりに小さくして消す。半透明にすると水・ガラスとの描く順が崩れるので不透明にし、
// 水の中の粒は手前の半透明の水を通して見せる

import * as THREE from 'three';
import type { DoseSupply } from '../sim';

const MAX = 256;
const G = -6;

/** 資材の色（しずく）。全交換は水と同じ */
export const DOSE_COLOR: Record<DoseSupply | 'solution', number> = {
  fertilizer: 0xd9a441, water: 0x9ad8ff, phDown: 0xff7f7f, phUp: 0xa596ff, solution: 0x9ad8ff,
};

interface P {
  x: number; y: number; z: number; vx: number; vy: number; vz: number;
  /** 経過・寿命 s、大きさ m、重力を受けるか、この高さより下で消える（しずくが水面・蓋に届いた） */
  age: number; life: number; size: number; grav: boolean; floor: number;
  /** 消えるときに水はねを出すか */
  splash: boolean; color: number;
}

export class Particles {
  private mesh: THREE.InstancedMesh;
  private ps: P[] = [];
  private du = new THREE.Object3D();
  private c = new THREE.Color();
  /** 連続して出す粒の端数（水流・泡） */
  private carry = new Map<string, number>();

  constructor(parent: THREE.Object3D) {
    this.mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ toneMapped: false }), MAX);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    // 色の配列を先に作る（setColorAt を最初に呼ぶまで instanceColor がない）
    this.mesh.setColorAt(0, this.c.setHex(0xffffff));
    parent.add(this.mesh);
  }

  set visible(v: boolean) { this.mesh.visible = v; }

  private add(p: Omit<P, 'age'>) {
    if (this.ps.length >= MAX) return;
    this.ps.push({ ...p, age: 0 });
  }

  /**
   * 資材を入れる：口（x, top, z）の上からしずくを落とし、floor（蓋・水面）で水はねにする。
   * n は粒の数（全交換は多く、広く）、spread は落とす範囲の半径
   */
  dose(color: number, x: number, top: number, z: number, floor: number, n = 10, spread = 0.06) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28, r = Math.random() * spread;
      this.add({
        x: x + Math.cos(a) * r, y: top + Math.random() * 0.35, z: z + Math.sin(a) * r, vx: 0, vy: -0.4 - Math.random() * 0.6, vz: 0,
        life: 2, size: 0.04 + Math.random() * 0.02, grav: true, floor, splash: true, color,
      });
    }
  }

  /** 水はね：しずくが届いたところから小さな粒を少し跳ね上げる */
  private splash(p: P) {
    for (let i = 0; i < 3; i++) {
      const a = Math.random() * 6.28, v = 0.3 + Math.random() * 0.3;
      this.add({
        x: p.x, y: p.floor + 0.01, z: p.z, vx: Math.cos(a) * v, vy: 0.6 + Math.random() * 0.5, vz: Math.sin(a) * v,
        life: 0.35, size: p.size * 0.5, grav: true, floor: p.floor - 0.2, splash: false, color: p.color,
      });
    }
  }

  /**
   * 連続して出す（水流・泡）。rate は 1秒あたりの数、make は1粒を作る。key ごとに端数を持ち越す
   */
  emit(key: string, dt: number, rate: number, make: () => Omit<P, 'age'>) {
    let k = (this.carry.get(key) ?? Math.random()) + rate * dt;
    for (; k >= 1; k--) this.add(make());
    this.carry.set(key, k);
  }

  /**
   * ポンプの水流：吐出口（x, y, z）から -x へ流れ出る粒。tint は資材を入れた直後の色（なければ水の色）
   */
  stream(dt: number, x: number, y: number, z: number, tint: number | null) {
    this.emit('stream', dt, tint === null ? 22 : 40, () => ({
      x, y: y + (Math.random() - 0.5) * 0.04, z: z + (Math.random() - 0.5) * 0.04,
      vx: -0.7 - Math.random() * 0.4, vy: (Math.random() - 0.3) * 0.12, vz: (Math.random() - 0.5) * 0.18,
      life: 1.3 + Math.random() * 0.4, size: tint === null ? 0.022 : 0.032, grav: false, floor: -9, splash: false, color: tint ?? 0xe8f8ff,
    }));
  }

  /** 泡：底（x, y, z の周り w × d）から水面 top まで上がる */
  bubbles(key: string, dt: number, rate: number, x: number, y: number, z: number, w: number, d: number, top: number) {
    if (top - y < 0.03) return;
    this.emit(key, dt, rate, () => {
      const vy = 0.25 + Math.random() * 0.15;
      return {
        x: x + (Math.random() - 0.5) * w, y, z: z + (Math.random() - 0.5) * d, vx: 0, vy, vz: 0,
        life: (top - y) / vy, size: 0.012 + Math.random() * 0.01, grav: false, floor: -9, splash: false, color: 0xf2fbff,
      };
    });
  }

  /** dt 秒進めて、置き直す */
  update(dt: number) {
    const du = this.du, ps = this.ps;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.age += dt;
      if (p.grav) p.vy += G * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.y <= p.floor) {
        if (p.splash) this.splash(p);
        p.age = p.life;
      }
      if (p.age >= p.life) { ps[i] = ps[ps.length - 1]; ps.pop(); }
    }
    ps.forEach((p, i) => {
      // 寿命の最後の 3割で小さくして消す
      const s = p.size * Math.min(1, ((p.life - p.age) / p.life) / 0.3);
      du.position.set(p.x, p.y, p.z);
      du.scale.set(s, p.grav && p.splash ? s * 1.6 : s, s);
      du.updateMatrix();
      this.mesh.setMatrixAt(i, du.matrix);
      this.mesh.setColorAt(i, this.c.setHex(p.color));
    });
    this.mesh.count = ps.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }

  /** 全部消す（モードを切り替えたとき） */
  clear() { this.ps.length = 0; this.mesh.count = 0; }
}
