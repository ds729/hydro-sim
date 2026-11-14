// 経営モードの栽培棚（4段×2枚のトレイ、最下段の下に養液タンク）。栽培モードの栽培槽と同じ床の区画に最大3台並べる。
// 苗はトレイごとに作物の形・生育・症状を出す。形（葉の付き方）ごとに Seedlings を1組ずつ持ち、苗を前から詰めて使う。
// 苗は揺らさない（台数が多いので、状態が変わったときだけ置き直す）

import * as THREE from 'three';
import { BUSINESS, CROPS, freshness, mulberry32, o2Fitness, powered, rackValues, side, trayFitness, LEAF_SHAPES, type FarmState, type LeafShape } from '../sim';
import { bakedShadow, LED, mat } from './build';
import { C_DEAD, Seedlings, SYMPTOM } from './seedling';

/** 棚の置き場所（x。z は栽培槽の中心と同じ）。1台目を真ん中に、増設は左・右へ */
const RACK_X = [0.6, -0.95, 2.15], RACK_Z = 0.8;
/** 棚の幅・奥行き・高さ、棚板の高さ（上から1段目〜4段目の順ではなく下から） */
const RW = 1.36, RD = 0.56, RH = 2.72, SHELVES = [0.45, 1.0, 1.55, 2.1];
/** トレイ（黒い樹脂）の幅・奥行き・厚さ、2枚の中心の x */
const TW = 0.6, TD = 0.46, TH = 0.05, TX = [-0.32, 0.32];
/** トレイ1枚の苗の並び（x 4 × z 3） */
const PX = 4, PZ = 3, PER = PX * PZ;
/** 苗の茎の高さの上限（トレイの上面から LED まで約 0.45m。葉の分を引く） */
const PLANT_MAX = 0.3;
const SLOTS = BUSINESS.slotsPerRack, MAX = BUSINESS.maxRacks;
/** 給液ポンプ（養液タンクの上、右奥の給液管の根元）の中心と、運転ランプの位置（ポンプの正面） */
const pumpPos = (x0: number): [number, number, number] => [x0 + RW / 2 - 0.12, 0.37, RACK_Z - RD / 2 + 0.11];
const LAMP_OK = new THREE.Color(0x5fe09a), LAMP_NG = new THREE.Color(0xff4040), LAMP_OFF = new THREE.Color(0x3a4048);

type Box = [w: number, h: number, d: number, color: number, x: number, y: number, z: number];

/** 箱を InstancedMesh 1つにまとめる（棚ごとに順に並べ、count で台数分だけ描く） */
function instanced(parent: THREE.Object3D, boxes: Box[], o?: THREE.MeshStandardMaterialParameters, cast = true) {
  const m = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat(0xffffff, o), boxes.length), du = new THREE.Object3D(), c = new THREE.Color();
  boxes.forEach(([w, h, d, color, x, y, z], i) => {
    du.position.set(x, y, z);
    du.scale.set(w, h, d);
    du.updateMatrix();
    m.setMatrixAt(i, du.matrix);
    m.setColorAt(i, c.setHex(color));
  });
  m.castShadow = cast;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

/** 棚の養液タンク：中心の x・z、幅・奥行き（内側）、口の高さ、液量 L から水面の高さ（満水＝容量 3L×8枚＝液量 3L/枚） */
export const RACK_TANK = { x: RACK_X, z: RACK_Z, w: RW - 0.2, d: RD - 0.12, top: 0.31 };
export const tankWaterY = (waterPerTray: number) => 0.02 + Math.max(0.01, Math.min(1, waterPerTray / 3)) * 0.27;

/** トレイの中心（部屋の座標）。slot 0・1 が最上段（画面のトレイの並びと同じ）、偶数が左 */
export function trayPos(rack: number, slot: number): THREE.Vector3 {
  const y = SHELVES[SHELVES.length - 1 - Math.floor(slot / 2)] + 0.015 + TH / 2;
  return new THREE.Vector3(RACK_X[rack] + TX[slot % 2], y, RACK_Z);
}

export class FarmRacks {
  readonly group = new THREE.Group();
  private frames: THREE.InstancedMesh;
  private leds: THREE.InstancedMesh;
  /** LED バーの発光（昼夜で点け消しする） */
  get ledMaterial(): THREE.MeshStandardMaterial { return this.leds.material as THREE.MeshStandardMaterial; }
  private trays: THREE.InstancedMesh;
  /** トレイの培地（播いたトレイだけ見せる） */
  private mats: THREE.InstancedMesh;
  private tanks: THREE.Mesh[] = [];
  /** 棚の接地影（台数分だけ見せる） */
  private shadows: THREE.Mesh[] = [];
  private waters: THREE.Mesh[] = [];
  private sel = new THREE.Group();
  /** 給液ポンプの運転ランプ（棚ごと。運転中は緑、止まったら赤の点滅、停電で回っていなければ消灯） */
  private lamps: THREE.InstancedMesh;
  private sets = {} as Record<LeafShape, Seedlings>;
  /** トレイの中の苗の配置 [x, z, 遅れ, 大きさ, 向き, 傾き] */
  private layout: [number, number, number, number, number, number][] = [];
  private framesPer = 0;
  private ledsPer = 0;
  private key = '';
  private du = new THREE.Object3D();
  private c1 = new THREE.Color();
  private c2 = new THREE.Color();
  private cs = new THREE.Color();
  private cl = new THREE.Color();

  constructor(parent: THREE.Object3D) {
    parent.add(this.group);
    const frame: Box[] = [], led: Box[] = [], tray: Box[] = [];
    RACK_X.forEach((x0, ri) => {
      const f: Box[] = [];
      // 支柱・天井の枠・棚板の受け（前後の桟と左右の桟）・養液を上げる管（右奥の柱沿い）
      for (const i of [-1, 1]) for (const j of [-1, 1]) f.push([0.04, RH, 0.04, 0xa9b3bb, x0 + i * (RW / 2 - 0.02), RH / 2, RACK_Z + j * (RD / 2 - 0.02)]);
      for (const y of [...SHELVES, RH - 0.02]) {
        for (const j of [-1, 1]) f.push([RW, 0.03, 0.03, 0xa9b3bb, x0, y, RACK_Z + j * (RD / 2 - 0.02)]);
        for (const i of [-1, 1]) f.push([0.03, 0.03, RD, 0xa9b3bb, x0 + i * (RW / 2 - 0.02), y, RACK_Z]);
      }
      f.push([0.03, SHELVES[3] - 0.25, 0.03, 0x4fb3b0, x0 + RW / 2 - 0.07, (SHELVES[3] + 0.25) / 2, RACK_Z - RD / 2 + 0.06]);
      // 給液ポンプ（養液タンクの上）
      const [px, py, pz] = pumpPos(x0);
      f.push([0.13, 0.11, 0.12, 0x3d4650, px, py, pz]);
      // 各段の上の LED バー（上の棚板の下、最上段は天井の枠の下）
      for (let k = 0; k < SHELVES.length; k++) {
        const top = k + 1 < SHELVES.length ? SHELVES[k + 1] : RH - 0.02;
        led.push([RW - 0.2, 0.025, 0.05, 0xffffff, x0, top - 0.035, RACK_Z]);
      }
      frame.push(...f);
      if (!ri) { this.framesPer = f.length; this.ledsPer = SHELVES.length; }
      for (let s = 0; s < SLOTS; s++) {
        const p = trayPos(ri, s);
        tray.push([TW, TH, TD, 0x2f3438, p.x, p.y, p.z]);
      }
      // 養液タンク（半透明の容器と水）
      const tank = new THREE.Mesh(new THREE.BoxGeometry(RW - 0.16, 0.3, RD - 0.08), mat(0xe8f2f4, { transparent: true, opacity: 0.35, depthWrite: false }));
      tank.position.set(x0, 0.16, RACK_Z);
      const water = new THREE.Mesh(new THREE.BoxGeometry(RW - 0.2, 1, RD - 0.12), mat(0x5cc0c8, { transparent: true, opacity: 0.7 }));
      water.position.set(x0, 0.02, RACK_Z);
      const ao = bakedShadow(RW + 0.9, RD + 0.9, [[0, 0, RW, RD, 0.4]], 0.4, 24);
      ao.position.set(x0, 0.021, RACK_Z);
      this.group.add(tank, water, ao);
      this.shadows.push(ao);
      this.tanks.push(tank);
      this.waters.push(water);
    });
    this.frames = instanced(this.group, frame);
    this.leds = instanced(this.group, led, LED, false);
    this.trays = instanced(this.group, tray);
    this.mats = instanced(this.group, tray.map(([, , , , x, y, z]): Box => [TW - 0.06, 0.02, TD - 0.06, 0x9c8b70, x, y + TH / 2, z]), {}, false);
    // 選んだトレイの枠（光る緑の細い棒4本）
    const sm = mat(0x5fe09a, { emissive: 0x5fe09a, emissiveIntensity: 0.9 });
    for (const [w, d, x, z] of [[TW + 0.06, 0.02, 0, TD / 2 + 0.03], [TW + 0.06, 0.02, 0, -TD / 2 - 0.03], [0.02, TD + 0.06, TW / 2 + 0.03, 0], [0.02, TD + 0.06, -TW / 2 - 0.03, 0]]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, d), sm);
      m.position.set(x, TH / 2 + 0.01, z);
      this.sel.add(m);
    }
    this.group.add(this.sel);
    this.lamps = new THREE.InstancedMesh(new THREE.BoxGeometry(0.04, 0.03, 0.012), new THREE.MeshBasicMaterial({ toneMapped: false }), MAX);
    RACK_X.forEach((x0, i) => {
      const [px, py, pz] = pumpPos(x0), du = this.du;
      du.position.set(px, py + 0.02, pz + 0.066);
      du.updateMatrix();
      this.lamps.setMatrixAt(i, du.matrix);
      this.lamps.setColorAt(i, LAMP_OK);
    });
    this.group.add(this.lamps);
    // 苗の配置は棚・トレイによらず同じ（栽培槽の苗の乱数を変えないよう別のシードで作る）
    const r = mulberry32(13);
    for (let i = 0; i < PX; i++) for (let j = 0; j < PZ; j++) {
      this.layout.push([((i + 0.5) / PX - 0.5) * (TW - 0.12) + (r() - 0.5) * 0.04, ((j + 0.5) / PZ - 0.5) * (TD - 0.12) + (r() - 0.5) * 0.04,
        r() * 0.2, 0.85 + r() * 0.3, r() * 6.28, (r() - 0.5) * 0.08]);
    }
    for (const shape of LEAF_SHAPES) {
      const s = new Seedlings(this.group, MAX * SLOTS * PER);
      s.setShape(shape);
      s.setCount(0);
      this.sets[shape] = s;
    }
  }

  set visible(v: boolean) { this.group.visible = v; }

  /** ポンプの運転ランプ（点滅するので毎フレーム）。t は秒 */
  private pumpLamps(f: FarmState, t: number) {
    const fx = f.facility, on = powered(fx) || f.equipment.ups > 0, blink = Math.sin(t * 9) > 0;
    this.lamps.count = f.racks.length;
    f.racks.forEach((r, i) => this.lamps.setColorAt(i, fx.pumpDown.includes(r.id) ? (blink ? LAMP_NG : LAMP_OFF) : on ? LAMP_OK : LAMP_OFF));
    this.lamps.instanceColor!.needsUpdate = true;
  }

  /** 状態を見た目に反映する（苗とトレイは状態か選択が変わったときだけ置き直す）。t は秒 */
  update(f: FarmState, rack: number, slot: number, t = 0): void {
    this.pumpLamps(f, t);
    const n = f.racks.length, key = `${f.hour}:${f.log.length}:${n}:${rack}:${slot}`;
    if (key === this.key) return;
    this.key = key;
    this.frames.count = n * this.framesPer;
    this.leds.count = n * this.ledsPer;
    this.trays.count = this.mats.count = n * SLOTS;
    this.tanks.forEach((m, i) => { m.visible = this.waters[i].visible = this.shadows[i].visible = i < n; });
    const used = Object.fromEntries(LEAF_SHAPES.map(s => [s, 0])) as Record<LeafShape, number>, du = this.du;
    f.racks.forEach((r, ri) => {
      const v = rackValues(f, r.id);
      // 根の酸欠（溶存酸素は棚で1つ）：苗がしおれる
      const hyp = 1 - o2Fitness(f.compartments.find(c => c.id === r.id)!);
      // 養液タンクの水位（液量は棚全体で、満水＝容量）
      const h = tankWaterY(v.water) - 0.02, w = this.waters[ri];
      w.scale.y = h;
      w.position.y = 0.02 + h / 2;
      r.slots.forEach((t, si) => {
        const p = trayPos(ri, si), mi = ri * SLOTS + si;
        du.position.set(p.x, p.y + TH / 2, p.z);
        du.rotation.set(0, 0, 0);
        du.scale.set(t ? TW - 0.06 : 0, 0.02, t ? TD - 0.06 : 0);
        du.updateMatrix();
        this.mats.setMatrixAt(mi, du.matrix);
        if (!t) return;
        const spec = CROPS[t.crop.id], look = spec.look, set = this.sets[look.leafShape], hp = Math.max(0, t.crop.health);
        const { worst } = trayFitness(f, r.id, t), ws = hp > 0 ? 1 - worst.value : 0;
        const sd = side(v[worst.key], spec.bands[worst.key]);
        // 育ちすぎ（適期を過ぎて価値が落ちる）は枯れの色に寄せ、葉を垂らす
        const over = 1 - freshness(t, f.hour);
        const sick = Math.min(1, 1 - hp / 100 + ws * 0.4 + over * 0.6);
        const wilt = hp > 0 ? Math.max(worst.key === 'water' && sd === 'low' ? ws : 0, hyp * 0.8) : 0, small = worst.key === 'ec' && sd === 'high' ? ws * 0.35 : 0;
        this.cs.set(look.stem);
        this.cl.set(look.leaf);
        const symptom = SYMPTOM[worst.key][sd === 'low' ? 0 : 1], dead = hp <= 0 ? 1 : Math.max((1 - hp / 100) * 0.9, over * 0.7);
        const tint = (out: THREE.Color, c: THREE.Color, size: number) =>
          out.copy(c).lerp(symptom, Math.min(1, ws * 1.3)).lerp(C_DEAD, Math.min(1, dead)).offsetHSL(0, 0, (size - 1) * 0.08);
        for (const [x, z, delay, size, a, lean] of this.layout) {
          const gg = Math.max(0, Math.min(1, (t.crop.growth - delay) / (1 - delay)));
          const hg = Math.min(PLANT_MAX, (0.015 + gg * 0.33 * size * look.height) * (hp > 0 ? 1 : 0.6));
          const sz = (0.15 + gg * 0.78 * look.leafSize) * (1 - small);
          const i = used[look.leafShape]++;
          set.set(i, p.x + x, p.y + TH / 2 + 0.01, p.z + z, hg, sz, a, lean, sick * 0.6 + wilt * 0.9, look.stemWidth * 0.8);
          set.setColor(i, tint(this.c1, this.cs, size), tint(this.c2, this.cl, size));
        }
      });
    });
    this.mats.instanceMatrix.needsUpdate = true;
    for (const s of LEAF_SHAPES) {
      this.sets[s].setCount(used[s]);
      this.sets[s].commit();
    }
    const p = trayPos(Math.min(rack, n - 1), slot);
    this.sel.position.copy(p);
  }
}
