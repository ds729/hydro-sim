// 工場の一室の断面ジオラマ（手前の壁と天井は外してある）。寸法の単位はメートル
// 苗・水位・ランプ・モニタは sim の状態から毎フレーム作り直す

import * as THREE from 'three';
import { bedOf, diagnose, type Factor, type SimState } from '../sim';
import { bakedShadow, Builder, LED, mat } from './build';
import { loadModel } from './models';
import { Monitor } from './monitor';

/** 栽培槽：幅・奥行き・水位の最大高さ・トレイの高さ・底板の上面 */
const W = 4, D = 2.4, HM = 1.45, TY = 1.8, WB = 0.23;
/** 苗の並び */
const NX = 14, NZ = 8, N = NX * NZ;

const C_HEALTHY = new THREE.Color(0x6fd06a), C_DEAD = new THREE.Color(0x9a7a44);
const C_ROOT = new THREE.Color(0xf6f2e6), C_ROOT_BAD = new THREE.Color(0x7d5632);
/** 症状の色 [低い側, 高い側]。EC低＝黄緑、EC高＝茶、pH低＝紫、pH高＝白っぽい黄、液量不足＝くすんだ緑 */
const SYMPTOM: Record<Factor, [THREE.Color, THREE.Color]> = {
  ec: [new THREE.Color(0xc6dc5a), new THREE.Color(0xb3873a)],
  ph: [new THREE.Color(0xb98fc8), new THREE.Color(0xeceaa6)],
  water: [new THREE.Color(0xa9bf6a), new THREE.Color(0x9bc0a0)],
};

interface Seedling { x: number; z: number; delay: number; size: number; phase: number }

export class Diorama {
  readonly scene = new THREE.Scene();
  private monitor = new Monitor();
  private lamps: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>[] = [];
  private pumpLed!: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
  private water!: THREE.Mesh;
  private stems!: THREE.InstancedMesh;
  private leaves!: THREE.InstancedMesh;
  private roots!: THREE.InstancedMesh;
  private bubbles!: THREE.InstancedMesh;
  private seedlings: Seedling[] = [];
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();
  /** 表示中の液量（実際の値に滑らかに追従させる） */
  private shownWater = 2;
  /** 生育段階（4段階）が変わった時刻。苗が弾む演出に使う */
  private stage = 0;
  private popAt = -9;
  private monitorAt = -9;

  constructor(private rand: () => number) {
    const sc = this.scene;
    // 光の強度は物理単位（π で旧来の 1 に相当）。上向きの面がほぼ指定色になり、影の側は 6 割ほどの明るさに残る（影は薄く）
    sc.add(new THREE.HemisphereLight(0xfff6ea, 0xb4bccf, 2.3));
    const sun = new THREE.DirectionalLight(0xfff0dc, 1.7);
    sun.position.set(6, 9, 5);
    sun.castShadow = true;
    // 解像度を下げてぼかす（柔らかい影。スマホでも安い）
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.radius = 4;
    sun.shadow.normalBias = 0.02;
    Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 30 });
    sc.add(sun);
    // 台座の下の落ち影（背景に落ちる）。光の向きの反対側へ少しずらす
    const drop = bakedShadow(14, 12, [[-0.6, -0.4, 9.4, 7.4, 0.36]], 1.8, 6);
    drop.position.y = -1.26;
    sc.add(drop);
    // 床の接地影：壁際と機器の足元を暗くする（AO の代わり）。矩形は各部品の床の上の外形
    const ao = bakedShadow(9.4, 7.4, [
      [0, -3.55, 9.4, 0.34, 0.3], [-4.55, 0, 0.34, 7.4, 0.3],
      [-2.4, -2.8, 2.3, 0.95, 0.22], [3.2, -2.8, 2.3, 0.95, 0.22],
      [-4.15, 0.6, 0.5, 1.3, 0.38], [0.6, 0.8, W + 0.3, D + 0.3, 0.42],
      [3.7, 1.0, 0.9, 0.9, 0.38], [3.1, 0.2, 0.4, 0.35, 0.3],
      [-3.2, 2.6, 0.7, 0.5, 0.38], [-2.4, 2.7, 0.7, 0.5, 0.38],
    ], 0.45, 24);
    ao.position.y = 0.02;
    sc.add(ao);
    this.buildRoom(new Builder(sc));
    this.buildRacks(new Builder(sc));
    this.buildEquipment(new Builder(sc));
    this.buildTank();
    this.buildCables();
  }

  private buildRoom(b: Builder) {
    b.box(9.4, 0.36, 7.4, 0xcfc6b8, 0, -0.18, 0);
    b.box(9.4, 0.9, 7.4, 0xa57b63, 0, -0.81, 0);
    b.box(9.4, 4.6, 0.3, 0xcfe1d4, 0, 2.3, -3.55);
    b.box(0.3, 4.6, 7.4, 0xc6dccf, -4.55, 2.3, 0);
    b.box(9.4, 0.4, 0.34, 0x9fb8aa, 0, 0.2, -3.55);
    b.box(0.34, 0.4, 7.4, 0x9fb8aa, -4.55, 0.2, 0);
    b.box(9.4, 0.12, 0.42, 0xeee9df, 0, 4.66, -3.55);
    b.box(0.42, 0.12, 7.4, 0xeee9df, -4.55, 4.66, 0);
    for (let i = 0; i < 8; i++) b.box(0.08, 4.2, 0.06, 0xb7cfc0, -4 + i * 1.15, 2.4, -3.38);
    b.cyl(0.07, 9, 0xa9b3bb, 0, 4.1, -3.3).rotation.z = Math.PI / 2;
    // 床の黄色い区画線
    for (const [x, z, w, d] of [[0.6, -0.7, 4.8, 0.08], [0.6, 2.3, 4.8, 0.08], [-1.8, 0.8, 0.08, 3], [3, 0.8, 0.08, 3]]) {
      b.box(w, 0.012, d, 0xf2c230, x, 0.006, z);
    }
  }

  /** 奥の壁沿いの補助ラック（飾り）。苗の塊は1つの InstancedMesh にまとめる */
  private buildRacks(b: Builder) {
    const r = this.rand, clumps: [number, number, number, number][] = [];
    for (const [x, z] of [[-2.4, -2.8], [3.2, -2.8]]) {
      for (const i of [-1, 1]) for (const j of [-1, 1]) b.cyl(0.04, 2.8, 0xa9b3bb, x + i * 1.1, 1.4, z + j * 0.42, {}, 6);
      for (let t = 0; t < 3; t++) {
        const y = 0.5 + t * 0.85;
        b.box(2.3, 0.06, 0.95, 0xe8eef2, x, y, z);
        b.box(2.0, 0.06, 0.2, 0xffffff, x, y + 0.55, z, LED);
        for (let k = 0; k < 13; k++) clumps.push([x - 0.95 + k * 0.15 + r() * 0.05, y + 0.1, z + (r() - 0.5) * 0.6, 0.08 + r() * 0.06]);
      }
    }
    const m = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), mat(0xffffff), clumps.length), du = this.dummy;
    clumps.forEach(([x, y, z, s], i) => {
      du.position.set(x, y, z);
      du.scale.set(s, s * 0.8, s);
      du.rotation.set(0, i, 0);
      du.updateMatrix();
      m.setMatrixAt(i, du.matrix);
      m.setColorAt(i, this.color.setHSL(0.27 + r() * 0.06, 0.45, 0.42 + r() * 0.12, THREE.SRGBColorSpace));
    });
    m.castShadow = true;
    b.parent.add(m);
  }

  /** 制御盤・状態ランプ・モニタ・養液タンク・ポンプ・木箱 */
  private buildEquipment(b: Builder) {
    const sc = this.scene;
    b.box(0.5, 2.1, 1.3, 0xe9e4da, -4.15, 1.05, 0.6);
    b.box(0.04, 1.7, 1.0, 0xd3cdc0, -3.89, 1.05, 0.6);
    // 状態ランプ（上から EC・pH・液量）
    this.lamps = [1.75, 1.55, 1.35].map(y => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), mat(0x5fe09a, { emissive: 0x5fe09a, emissiveIntensity: 0.9 }));
      m.position.set(-3.86, y, 0.6);
      sc.add(m);
      return m;
    });
    b.box(2.6, 1.5, 0.12, 0x2d3640, 0, 2.7, -3.38);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.3), new THREE.MeshBasicMaterial({ map: this.monitor.texture, toneMapped: false }));
    screen.position.set(0, 2.7, -3.31);
    sc.add(screen);
    b.cyl(0.45, 1.1, 0x6f9cc4, 3.7, 0.55, 1.0, {}, 10);
    b.cyl(0.47, 0.08, 0x4a7398, 3.7, 1.14, 1.0, {}, 10);
    b.cyl(0.06, 1, 0xa9b3bb, 3.1, 0.5, 1.0).rotation.z = Math.PI / 2;
    b.box(0.4, 0.3, 0.35, 0x3d4a55, 3.1, 0.15, 0.2);
    b.cyl(0.05, 0.9, 0xa9b3bb, 3.4, 0.3, 0.6).rotation.x = Math.PI / 2;
    this.pumpLed = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), mat(0x5fe09a, { emissive: 0x5fe09a }));
    this.pumpLed.position.set(3.1, 0.34, 0.2);
    sc.add(this.pumpLed);
    b.box(0.7, 0.4, 0.5, 0xb38e68, -3.2, 0.2, 2.6);
    b.box(0.7, 0.4, 0.5, 0xa27a55, -3.2, 0.6, 2.6);
    // 木箱の1つは .glb（v0.5 のダミー。読み込みとパスの確認用で、Phase 2 で本物のモデルに置き換える）
    loadModel('dummy-crate').then(m => {
      m.position.set(-2.4, 0, 2.7);
      sc.add(m);
    }, e => console.error(e));
  }

  /** 栽培槽（主役）：ガラス槽・水・浮きトレイ・LED・センサ・苗 */
  private buildTank() {
    const tg = new THREE.Group(), b = new Builder(tg), r = this.rand;
    tg.position.set(0.6, 0, 0.8);
    this.scene.add(tg);
    b.box(W + 0.3, 0.23, D + 0.3, 0x7f8894, 0, 0.115, 0);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(W, 2.1, D), mat(0xcdeeff, { transparent: true, opacity: 0.14, depthWrite: false }));
    glass.position.y = WB + 1.05;
    tg.add(glass);
    for (const i of [-1, 1]) for (const j of [-1, 1]) b.cyl(0.05, 3.1, 0xa9b3bb, (i * W) / 2, 1.55, (j * D) / 2, {}, 6);
    for (const j of [-1, 1]) b.box(W, 0.08, 0.08, 0xa9b3bb, 0, 3.1, (j * D) / 2);
    for (const i of [-1, 1]) b.box(0.08, 0.08, D, 0xa9b3bb, (i * W) / 2, 3.1, 0);
    this.water = new THREE.Mesh(new THREE.BoxGeometry(W - 0.08, 1, D - 0.08), mat(0x5cc0c8, { transparent: true, opacity: 0.6 }));
    tg.add(this.water);
    b.box(W - 0.06, 0.07, D - 0.06, 0xf4ecd8, 0, TY, 0);
    b.box(W - 0.3, 0.03, D - 0.4, 0x857b6e, 0, TY + 0.06, 0);
    for (const z of [-0.55, 0.55]) b.box(W - 0.4, 0.1, 0.35, 0xffffff, 0, 2.9, z, LED);
    // LED の照り返し（トレイと苗をほんのり桃色に）。decay 1 で距離に対して緩やかに減衰させる
    const pl = new THREE.PointLight(0xffc4ec, 1.2, 7, 1);
    pl.position.set(0, 2.7, 0);
    tg.add(pl);
    // EC・pH センサのプローブ
    for (const [z, c] of [[-0.9, 0x4cc38a], [0.9, 0x4a8fe0]]) {
      b.cyl(0.03, 1.4, 0x333c46, 1.88, TY - 0.5, z, {}, 6);
      b.add(new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 5), mat(c)), 1.88, TY + 0.25, z);
    }
    for (let i = 0; i < NX; i++) for (let j = 0; j < NZ; j++) {
      this.seedlings.push({
        x: (i / (NX - 1) - 0.5) * (W - 0.5) + (r() - 0.5) * 0.05,
        z: (j / (NZ - 1) - 0.5) * (D - 0.5) + (r() - 0.5) * 0.05,
        delay: r() * 0.25, size: 0.8 + r() * 0.4, phase: r() * 6.28,
      });
    }
    const inst = (geo: THREE.BufferGeometry, n: number, cast: boolean) => {
      const m = new THREE.InstancedMesh(geo, mat(0xffffff), n);
      m.castShadow = cast;
      tg.add(m);
      return m;
    };
    const stem = new THREE.CylinderGeometry(0.014, 0.02, 1, 5).translate(0, 0.5, 0);
    const root = new THREE.CylinderGeometry(0.007, 0.003, 1, 4).translate(0, -0.5, 0);
    this.stems = inst(stem, N, true);
    this.leaves = inst(new THREE.IcosahedronGeometry(0.075, 1), N * 2, true);
    this.roots = inst(root, N, false);
    this.bubbles = inst(new THREE.IcosahedronGeometry(0.04, 0), 12, false);
    Object.assign(this.bubbles.material, { transparent: true, opacity: 0.6 });
  }

  /** センサケーブル（プローブ→制御盤） */
  private buildCables() {
    for (const z of [-0.9, 0.9]) {
      const s = new THREE.Vector3(0.6 + 1.88, TY + 0.3, 0.8 + z);
      const curve = new THREE.CatmullRomCurve3([
        s, new THREE.Vector3(s.x, 3.3, s.z), new THREE.Vector3(-1, 3.5, -0.3),
        new THREE.Vector3(-4, 3.3, 0.6), new THREE.Vector3(-4.15, 2.2, 0.6 + z * 0.15),
      ]);
      this.scene.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 30, 0.022, 4), mat(0x2b3138)));
    }
  }

  /** 状態を見た目に反映する。t は秒。最も悪い要因が苗の色と形を決める */
  update(s: SimState, t: number): void {
    const dg = diagnose(s), f = dg.fitness, { key: wk, side } = dg.worst, ws = 1 - dg.worst.value;
    const hp = s.crop.health, g = s.crop.growth, du = this.dummy, tc = this.color;
    const sick = Math.min(1, 1 - hp / 100 + ws * 0.4);
    const wilt = wk === 'water' && side === 'low' ? ws : 0;
    const small = wk === 'ec' && side === 'high' ? ws * 0.35 : 0;
    const stage = Math.floor(g * 4);
    if (stage !== this.stage) { this.stage = stage; this.popAt = t; }
    const pa = t - this.popAt, pop = pa < 0.6 ? 1 + 0.22 * Math.sin(pa * 16) * Math.exp(-pa * 5) : 1;
    const bed = bedOf(s);
    this.shownWater += (bed.water - this.shownWater) * 0.15;
    const h = (this.shownWater / bed.capacity) * HM;
    this.water.scale.y = h;
    this.water.position.y = WB + h / 2;
    const symptom = SYMPTOM[wk][side === 'low' ? 0 : 1];
    this.seedlings.forEach((p, i) => {
      const gg = Math.max(0, Math.min(1, (g - p.delay) / (1 - p.delay)));
      const hg = (0.02 + gg * 0.55 * p.size) * pop, sw = Math.sin(t * 1.6 + p.phase) * 0.04 * (0.3 + gg);
      du.position.set(p.x, TY + 0.08, p.z);
      du.rotation.set(0, 0, sw);
      du.scale.set(1, hg, 1);
      du.updateMatrix();
      this.stems.setMatrixAt(i, du.matrix);
      tc.copy(C_HEALTHY).lerp(symptom, Math.min(1, ws * 1.3)).lerp(C_DEAD, Math.max(0, (1 - hp / 100) * 0.9)).offsetHSL(0, 0, (p.size - 1) * 0.08);
      this.stems.setColorAt(i, tc);
      for (let k = 0; k < 2; k++) {
        const a = p.phase + k * Math.PI, sz = (0.25 + gg * 1.3) * (1 - small) * pop;
        du.position.set(p.x + Math.cos(a) * 0.06 * sz + sw * hg, TY + 0.08 + hg, p.z + Math.sin(a) * 0.06 * sz);
        du.rotation.set(0, -a, (k ? 1 : -1) * (sick * 0.6 + wilt * 0.9));
        du.scale.set(sz, sz * 0.28, sz * 0.85);
        du.updateMatrix();
        this.leaves.setMatrixAt(i * 2 + k, du.matrix);
        this.leaves.setColorAt(i * 2 + k, tc);
      }
      du.position.set(p.x, TY, p.z);
      du.rotation.set(0, 0, Math.sin(t * 1.2 + p.phase) * 0.05);
      du.scale.set(1, 0.05 + gg * 0.9, 1);
      du.updateMatrix();
      this.roots.setMatrixAt(i, du.matrix);
      this.roots.setColorAt(i, tc.copy(C_ROOT).lerp(C_ROOT_BAD, Math.min(1, ws * 1.3)));
    });
    for (let j = 0; j < 12; j++) {
      du.position.set(-1.7 + Math.sin(t * 3 + j) * 0.04, WB + ((t * 0.5 + j / 12) % 1) * h, 0.8);
      du.rotation.set(0, 0, 0);
      du.scale.setScalar(0.6 + (j % 3) * 0.3);
      du.updateMatrix();
      this.bubbles.setMatrixAt(j, du.matrix);
    }
    for (const m of [this.stems, this.leaves, this.roots]) {
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor!.needsUpdate = true;
    }
    this.bubbles.instanceMatrix.needsUpdate = true;
    this.lamps.forEach((m, i) => {
      const q = [f.ec, f.ph, f.water][i];
      m.material.color.setHex(q > 0.9 ? 0x5fe09a : q > 0.5 ? 0xf2c230 : 0xff6b6b);
      m.material.emissive.copy(m.material.color);
    });
    this.pumpLed.material.emissiveIntensity = 0.5 + 0.5 * Math.sin(t * 4);
    if (t - this.monitorAt > 0.4) {
      this.monitorAt = t;
      this.monitor.draw(s, dg);
    }
  }
}
