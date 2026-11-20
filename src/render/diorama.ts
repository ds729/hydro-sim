// 工場の一室の断面ジオラマ（手前の壁と天井は外してある）。寸法の単位はメートル
// 苗・水位・ランプ・モニタは sim の状態から毎フレーム作り直す

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LIGHT, RULE_LIMIT, bedOf, cropSpec, diagnose, mulberry32, o2Fitness, powered, pumpRunning, rackValues, type CropSpec, type Diagnosis, type FarmState, type SimState } from '../sim';
import { bakedShadow, boxSet, Builder, LED, mat, SLAB, type BoxSpec } from './build';
import { loadModel } from './models';
import { Monitor, type Blind } from './monitor';
import { FarmRacks, RACK_TANK, tankWaterY } from './farmrack';
import { DOSE_COLOR, Particles } from './particles';
import { C_DEAD, Seedlings, SYMPTOM } from './seedling';

/** 栽培槽：幅・奥行き・水位の最大高さ・底板の上面 */
const W = 4, D = 2.4, HM = 1.45, WB = 0.23;
/** 浮きトレイの受けの高さ（水位の最大に対する割合）。液量が容量のこの割合を下回るとトレイが受けに乗り、根が水から離れる */
const STOP = 0.4;
/** 苗の並び */
const NX = 14, NZ = 8, N = NX * NZ;
/** 補助ラックの苗の茎の高さの上限（マットの上面から上の棚の LED まで約 0.55m。葉の分を引く） */
const RACK_PLANT_MAX = 0.4;
/** EC・pH センサのプローブ（栽培槽の中の x と z、頭の高さ） */
const PROBE_X = 1.88, PROBE_Z = [-0.9, 0.9], PROBE_TOP = 2.05;

/**
 * 折れ線を角だけ丸めた管（ケーブル・ホース）。r は管の半径、bend は角の丸めの長さ
 */
function tube(points: [number, number, number][], r: number, color: number, bend = 0.08): THREE.Mesh {
  const p = points.map(q => new THREE.Vector3(...q)), path = new THREE.CurvePath<THREE.Vector3>();
  let from = p[0];
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i].clone().sub(p[i - 1]), b = p[i + 1].clone().sub(p[i]);
    const d = Math.min(bend, a.length() / 2, b.length() / 2);
    const s = p[i].clone().addScaledVector(a.normalize(), -d), e = p[i].clone().addScaledVector(b.normalize(), d);
    path.add(new THREE.LineCurve3(from, s));
    path.add(new THREE.QuadraticBezierCurve3(s, p[i], e));
    from = e;
  }
  path.add(new THREE.LineCurve3(from, p[p.length - 1]));
  const len = path.getLength();
  return new THREE.Mesh(new THREE.TubeGeometry(path, Math.ceil(len * 24), r, 5), mat(color));
}

/** 床に寝かせた輪を重ねた形（巻いたホース）。rings は [輪の半径, x のずれ, 高さ]、r は管の半径 */
function mergeTori(rings: readonly (readonly [number, number, number])[], r: number): THREE.BufferGeometry {
  return mergeGeometries(rings.map(([R, x, y]) => new THREE.TorusGeometry(R, r, 4, 14).rotateX(Math.PI / 2).translate(x, y, 0)));
}

/** 伏せた状態ランプの色（消灯） */
const LAMP_OFF = 0x3a4048;
const C_ROOT = new THREE.Color(0xf6f2e6), C_ROOT_BAD = new THREE.Color(0x7d5632);

/** 高窓の空の色（昼・夕・夜） */
const SKY_DAY = new THREE.Color(0xc4e4f2), SKY_DUSK = new THREE.Color(0xf0b487), SKY_NIGHT = new THREE.Color(0x27325a);
/** 主光源と環境光の色（昼・夜）。夜も天井灯は点いている設定で、症状の色が見分けられる明るさを残す */
const SUN_DAY = new THREE.Color(0xfff0dc), SUN_NIGHT = new THREE.Color(0xc8d4ff);
const HEMI_DAY = new THREE.Color(0xfff6ea), HEMI_NIGHT = new THREE.Color(0xdde4ff);
/** 高窓の中心 x（奥の壁の柱の間。補助ラックの上） */
const WINDOWS_X = [-3.425, -2.275, 2.325, 3.475], WINDOW_Y = 3.55;
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

interface Seedling { x: number; z: number; delay: number; size: number; phase: number }
/** 設備の見た目：通電しているか、止まっているポンプがあるか、（選んでいる区画の）ポンプが回っているか */
interface Power { on: boolean; pumpDown: boolean; running: boolean }
/** 停電中の部屋の光の割合（天井灯が消え、高窓からの光だけ。昼は窓の分だけ明るい） */
const OUT_NIGHT = 0.25, OUT_DAY = 0.45;
/** 資材を入れる口（養液タンクの点検口。部屋の座標）としずくを落とし始める高さ・蓋の高さ */
const PORT = [3.7, 1.0] as const, PORT_DROP = 1.65, PORT_LID = 1.24;
/** ポンプの吐出口（栽培槽の右の面、部屋の座標。nutrient_tank の配管の先） */
const INLET = [2.56, 0.5, 1.0] as const;
/** 資材を入れてから、その色の養液が吐出口から出てくるまでと、出ている間（秒） */
const TINT_DELAY = 0.8, TINT_FOR = 1.6;
/** ポンプの運転ランプの色（運転・停止） */
const PUMP_OK = 0x5fe09a, PUMP_NG = 0xff4040;
type Lamp = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
/**
 * 自動制御ルールのランプ（制御盤の扉の非常停止の下に横1列、行1〜6。制御盤の座標）。
 * 行なし・停電は消灯、無効の行は灰、有効は暗い緑、動いた直後（RULE_FLASH 秒）は橙
 */
const RULE_LAMP = { x: 0.3, y: 0.8, z0: -0.3, dz: 0.12 } as const;
const RULE_OFF = new THREE.Color(0x2b3138), RULE_IDLE = new THREE.Color(0x2f7a52), RULE_DISABLED = new THREE.Color(0x6a7078), RULE_FIRE = new THREE.Color(0xffa62b);
const RULE_PLATE = new THREE.Color(0x1d2228);
export const RULE_FLASH = 0.8;

export class Diorama {
  readonly scene = new THREE.Scene();
  /** 主光源（リアルタイムの影を落とす。画質設定で影を切る） */
  readonly sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  /** 昼夜：LED バーの発光（栽培槽・補助ラック・経営の棚）と LED の照り返し、高窓の空 */
  private ledMats: THREE.MeshStandardMaterial[] = [];
  private ledLight!: THREE.PointLight;
  private sky!: THREE.MeshBasicMaterial;
  private monitor = new Monitor();
  /** 状態ランプとポンプの運転ランプ（.glb の読み込み後に入る） */
  private lamps: Lamp[] = [];
  private pumpLed?: Lamp;
  /** 自動制御ルールのランプ（台1枚＋行ごと。1回の描画）と、行ごとに最後に動いた時刻（秒） */
  private ruleLamps?: THREE.InstancedMesh;
  private ruleFlash: number[] = [];
  /** 栽培槽（ガラス槽・浮きトレイ・苗・センサ）とセンサケーブル。経営モードでは隠して棚を出す */
  private tank!: THREE.Group;
  private cables: THREE.Object3D[] = [];
  /** 経営モードの栽培棚（初めて経営モードを描くときに作る） */
  private farm?: FarmRacks;
  private water!: THREE.Mesh;
  private raft!: THREE.Group;
  /** 栽培槽の苗（茎・葉・巻きひげ） */
  private plants!: Seedlings;
  private roots!: THREE.InstancedMesh;
  /** 補助ラックの苗と、その配置 [x, y, z, 生育段階, 向き, 傾き, 明るさのずれ] */
  private rackPlants!: Seedlings;
  private rackLayout: [number, number, number, number, number, number, number][] = [];
  /** 苗の見た目を合わせている作物（変わったら葉の形と補助ラックの苗を作り直す） */
  private cropId = '';
  private bubbles!: THREE.InstancedMesh;
  private seedlings: Seedling[] = [];
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();
  private color2 = new THREE.Color();
  /** 作物の健康な茎・葉の色（update で crops.json の look から入れる） */
  private stemColor = new THREE.Color();
  private leafColor = new THREE.Color();
  /** 表示中の液量（実際の値に滑らかに追従させる） */
  private shownWater = 2;
  /** 生育段階（4段階）が変わった時刻。苗が弾む演出に使う */
  private stage = 0;
  private popAt = -9;
  private monitorAt = -9;
  /** モニタに描いている画面（変わったらすぐ描き直す） */
  private screen = '';
  /** 表示中の通電（0〜1。停電で滑らかに暗くする） */
  private shownPower = 1;
  /** パーティクル（資材のしずく・水流・泡）と、前のフレームの時刻・見ている記録（新しい操作だけに反応する） */
  private fx: Particles;
  private lastT = -1;
  private seen: { log: readonly unknown[]; n: number } = { log: [], n: 0 };
  /** 資材の色の養液が吐出口から出る時間（秒の範囲）と色 */
  private tint = { from: 0, to: 0, color: 0 };
  /** 描いているモード（変わったらパーティクルを消す） */
  private scene3 = '';

  constructor(private rand: () => number) {
    const sc = this.scene;
    // 光の強度は物理単位（π で旧来の 1 に相当）。上向きの面がほぼ指定色になり、影の側は 6 割ほどの明るさに残る（影は薄く）
    sc.add((this.hemi = new THREE.HemisphereLight(0xfff6ea, 0xb4bccf, 2.3)));
    const sun = (this.sun = new THREE.DirectionalLight(0xfff0dc, 1.7));
    // 左の面（+z）を明るく、右の面（+x）を暗くして立体感を出す（参照画像の光の向き）。仰角は 49° のまま（上向きの面の明るさを変えない）
    sun.position.set(1, 9.5, 8.2);
    sun.castShadow = true;
    // 解像度を下げてぼかす（柔らかい影。スマホでも安い）
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.radius = 4;
    sun.shadow.normalBias = 0.02;
    Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 30 });
    sc.add(sun);
    // 台座の下の落ち影（背景に落ちる）。光の向きの反対側へ少しずらす
    const drop = bakedShadow(14, 12, [[-0.6, -0.4, 9.4, 7.4, 0.36]], 1.8, 6);
    drop.position.y = -SLAB;
    sc.add(drop);
    // 床の接地影：壁際と機器の足元を暗くする（AO の代わり）。矩形は各部品の床の上の外形
    const ao = bakedShadow(9.4, 7.4, [
      [0, -3.55, 9.4, 0.34, 0.3], [-4.55, 0, 0.34, 7.4, 0.3],
      [-2.4, -2.8, 2.3, 0.95, 0.22], [3.2, -2.8, 2.3, 0.95, 0.22],
      [-4.15, 0.6, 0.5, 1.3, 0.38],
      [3.7, 1.0, 0.9, 0.9, 0.38], [3.1, 0.2, 0.4, 0.35, 0.3],
      [-3.2, 2.6, 0.7, 0.5, 0.38], [-2.4, 2.7, 0.7, 0.5, 0.38],
      [4.15, 2.05, 0.3, 0.3, 0.32], [3.37, 2.95, 0.45, 0.45, 0.25], [-4.15, 1.87, 0.42, 0.65, 0.35], [-2.75, 0.25, 2.3, 0.18, 0.18],
      // 小物（room_props）：台車・消火器・踏み台・ポリ容器
      [-2.65, 1.45, 0.95, 0.6, 0.3], [-4.22, 3.3, 0.2, 0.2, 0.32], [4.0, -1.42, 0.45, 0.5, 0.3], [4.12, 2.85, 0.26, 0.34, 0.32],
    ], 0.45, 24);
    ao.position.y = 0.02;
    sc.add(ao);
    this.fx = new Particles(sc);
    const b = new Builder(sc);
    this.buildSlab(b);
    this.buildRoom(b);
    this.buildRacks(b);
    this.buildEquipment(b);
    this.buildTank();
    // 小さな箱（ケーブルプロテクター・小物）は InstancedMesh 1つにまとめる
    const boxes: BoxSpec[] = [];
    this.buildCables(boxes);
    this.buildProps(b, boxes);
    boxSet(sc, boxes);
  }

  /**
   * 台座＝床スラブの断面（参照画像の土台の地層を工場の床に置き換えたもの）。上から
   * 床仕上げ・コンクリート・配管層（奥へ凹ませ、配管の切り口と支柱を見せる）・砕石・土（2色）。配管・支柱・石は InstancedMesh 1つずつ
   */
  private buildSlab(b: Builder) {
    const SX = 9.4, SZ = 7.4;
    /** [上端, 下端, 色, 凹み] */
    const layers: [number, number, number, number][] = [
      [0, -0.06, 0xcfc6b8, -0.01], [-0.06, -0.4, 0xb3adb5, 0], [-0.4, -0.8, 0x6e6a72, 0.12],
      [-0.8, -1.0, 0xa39684, 0], [-1.0, -1.3, 0xa8735a, 0], [-1.3, -SLAB, 0x8c5e48, 0],
    ];
    for (const [top, bottom, color, inset] of layers) {
      // 床の上面以外は影を落とさない（落ち影は焼き込み）
      b.box(SX - 2 * inset, top - bottom, SZ - 2 * inset, color, 0, (top + bottom) / 2, 0).castShadow = top === 0;
    }
    const du = this.dummy, c = this.color;
    // 配管層の配管：[向き, 位置（x か z）, 高さ, 半径, 色]。給水＝青・養液＝青緑・排水＝灰・電線管＝橙
    const pipes: ['x' | 'z', number, number, number, number][] = [
      ['z', -3.6, -0.6, 0.08, 0x5b8fc4], ['z', -2.9, -0.66, 0.05, 0xd9893f], ['z', -0.8, -0.58, 0.11, 0x9aa3a8],
      ['z', 1.4, -0.62, 0.07, 0x4fb3b0], ['z', 3.4, -0.6, 0.09, 0x5b8fc4],
      ['x', -2.6, -0.64, 0.09, 0x9aa3a8], ['x', -0.6, -0.58, 0.06, 0x4fb3b0], ['x', 1.2, -0.66, 0.05, 0xd9893f], ['x', 2.9, -0.6, 0.08, 0x5b8fc4],
    ];
    const pm = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 10), mat(0xffffff, { roughness: 0.6 }), pipes.length);
    pipes.forEach(([axis, p, y, r, color], i) => {
      // 切り口が台座の側面から 1cm 出るように長さを取る
      if (axis === 'z') { du.position.set(p, y, 0); du.rotation.set(Math.PI / 2, 0, 0); du.scale.set(r, SZ + 0.02, r); }
      else { du.position.set(0, y, p); du.rotation.set(0, 0, Math.PI / 2); du.scale.set(r, SX + 0.02, r); }
      du.updateMatrix();
      pm.setMatrixAt(i, du.matrix);
      pm.setColorAt(i, c.setHex(color));
    });
    pm.receiveShadow = true;
    b.parent.add(pm);
    // 配管層の凹みに見えるスラブの支柱（配管と重ならない位置）
    const posts: [number, number][] = [[-2.25, SZ / 2], [0.3, SZ / 2], [2.4, SZ / 2], [SX / 2, -1.6], [SX / 2, 0.3], [SX / 2, 2.1]];
    const qm = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat(0xb3adb5), posts.length);
    posts.forEach(([x, z], i) => {
      const front = z === SZ / 2;
      du.position.set(front ? x : x - 0.065, -0.6, front ? z - 0.065 : z);
      du.rotation.set(0, 0, 0);
      du.scale.set(front ? 0.22 : 0.13, 0.4, front ? 0.13 : 0.22);
      du.updateMatrix();
      qm.setMatrixAt(i, du.matrix);
    });
    qm.receiveShadow = true;
    b.parent.add(qm);
    // 砕石と土の中の石（見える2面：手前 +z と右 +x）。苗の配置の乱数を変えないよう別のシードで作る
    const r = mulberry32(7), stones: [number, number, number, number, boolean][] = [];
    for (const front of [true, false]) {
      const len = front ? SX : SZ;
      for (let k = 0; k < 70; k++) stones.push([(r() - 0.5) * len, -0.82 - r() * 0.16, 0.025 + r() * 0.03, 0x8f8a9a, front]);
      for (let k = 0; k < 14; k++) stones.push([(r() - 0.5) * (len - 0.6), -1.08 - r() * 0.42, 0.06 + r() * 0.07, 0x8f8a9a, front]);
    }
    const sm = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), mat(0xffffff), stones.length);
    stones.forEach(([u, y, s, color, front], i) => {
      // 中心を側面に置き、半分だけ外へ出す
      if (front) du.position.set(u, y, SZ / 2); else du.position.set(SX / 2, y, u);
      du.rotation.set(r() * 3, r() * 3, r() * 3);
      du.scale.set(s, s * 0.75, s);
      du.updateMatrix();
      sm.setMatrixAt(i, du.matrix);
      sm.setColorAt(i, c.setHex(color).offsetHSL(0, 0, (r() - 0.5) * 0.06));
    });
    b.parent.add(sm);
  }

  private buildRoom(b: Builder) {
    b.box(9.4, 4.6, 0.3, 0xcfe1d4, 0, 2.3, -3.55);
    b.box(0.3, 4.6, 7.4, 0xc6dccf, -4.55, 2.3, 0);
    b.box(9.4, 0.4, 0.34, 0x9fb8aa, 0, 0.2, -3.55);
    b.box(0.34, 0.4, 7.4, 0x9fb8aa, -4.55, 0.2, 0);
    b.box(9.4, 0.12, 0.42, 0xeee9df, 0, 4.66, -3.55);
    b.box(0.42, 0.12, 7.4, 0xeee9df, -4.55, 4.66, 0);
    b.cyl(0.07, 9, 0xa9b3bb, 0, 4.5, -3.3).rotation.z = Math.PI / 2;
    // 壁の柱と床の黄色い区画線
    const boxes: BoxSpec[] = [];
    for (let i = 0; i < 8; i++) boxes.push([0.08, 4.2, 0.06, 0xb7cfc0, -4 + i * 1.15, 2.4, -3.38]);
    for (const [x, z, w, d] of [[0.6, -0.7, 4.8, 0.08], [0.6, 2.3, 4.8, 0.08], [-1.8, 0.8, 0.08, 3], [3, 0.8, 0.08, 3]]) {
      boxes.push([w, 0.012, d, 0xf2c230, x, 0.006, z]);
    }
    // 高窓（奥の壁の柱の間）。空の色で昼夜を見せる（setClock）。枠は箱の並びに、ガラスは InstancedMesh 1つ
    for (const x of WINDOWS_X) {
      boxes.push(
        [0.98, 0.06, 0.07, 0xeee9df, x, WINDOW_Y + 0.455, -3.37], [0.98, 0.06, 0.07, 0xeee9df, x, WINDOW_Y - 0.455, -3.37],
        [0.06, 0.97, 0.07, 0xeee9df, x - 0.46, WINDOW_Y, -3.37], [0.06, 0.97, 0.07, 0xeee9df, x + 0.46, WINDOW_Y, -3.37],
        [0.035, 0.85, 0.04, 0xeee9df, x, WINDOW_Y, -3.38], [1.04, 0.05, 0.14, 0xe2dccf, x, WINDOW_Y - 0.5, -3.33],
      );
    }
    this.sky = new THREE.MeshBasicMaterial({ color: SKY_DAY, toneMapped: false });
    const glass = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.86, 0.85), this.sky, WINDOWS_X.length), du = new THREE.Object3D();
    WINDOWS_X.forEach((x, i) => {
      du.position.set(x, WINDOW_Y, -3.395);
      du.updateMatrix();
      glass.setMatrixAt(i, du.matrix);
    });
    b.parent.add(glass);
    boxSet(b.parent, boxes);
  }

  /**
   * 奥の壁沿いの補助ラック（飾り）。棚ごとに播種日をずらしたトレイを置く（生育段階が棚で違う）。
   * ラック本体（棚・トレイ・マット・LED）は .glb（aux_rack）を2台に使い回す。
   * 苗は栽培槽と同じ間隔・縮尺で並べ、形と色は今育てている作物に合わせる（paintRack）
   */
  private buildRacks(b: Builder) {
    const racks = [[-2.4, -2.8], [3.2, -2.8]];
    loadModel('aux_rack').then(m => racks.forEach(([x, z], i) => {
      // LED バーの発光（clone は材質を共有するので1台目から取る）
      if (!i) m.getObjectByName('rack_led')?.traverse(o => { if (o instanceof THREE.Mesh) this.ledMats.push(o.material); });
      const o = i ? m.clone() : m;
      o.position.set(x, 0, z);
      this.scene.add(o);
    }), e => console.error(e));
    // 栽培槽の苗の配置の乱数を変えないよう別のシードで作る
    const r = mulberry32(11), plants: [number, number, number, number][] = [];
    /** 棚の生育段階（0〜1）。棚の高さ 0.85 に収まるよう栽培槽の収穫前より手前で止める */
    const stages = [0.15, 0.35, 0.55];
    racks.forEach(([x, z], ri) => {
      for (let t = 0; t < 3; t++) {
        // 棚の高さ（aux_rack の RACK_SHELVES と同じ）。苗の根元はマットの上面（棚 + 0.1）
        const y = 0.5 + t * 0.85, g = stages[(t + ri * 2) % 3];
        // 栽培槽と同じ約 0.27m 間隔
        for (let i = 0; i < 7; i++) for (let j = 0; j < 3; j++) {
          plants.push([x + (i - 3) * 0.27 + (r() - 0.5) * 0.05, y + 0.1, z + (j - 1) * 0.24 + (r() - 0.5) * 0.05, g * (0.85 + r() * 0.3)]);
        }
      }
    });
    plants.forEach(([x, y, z, g]) => this.rackLayout.push([x, y, z, g, r() * 6.28, (r() - 0.5) * 0.06, (r() - 0.5) * 0.04]));
    this.rackPlants = new Seedlings(b.parent, plants.length);
  }

  /** 補助ラックの苗を作物の形と色にする（栽培槽と同じ作物を育てている設定。生育段階は棚ごとに固定） */
  private paintRack(spec: CropSpec) {
    const rp = this.rackPlants, lk = spec.look, cs = this.stemColor.set(lk.stem), cl = this.leafColor.set(lk.leaf);
    rp.setShape(lk.leafShape);
    this.rackLayout.forEach(([x, y, z, g, a, sw, l], i) => {
      // 背の高い作物（豆苗）でも上の棚の LED に届かない高さまで
      rp.set(i, x, y, z, Math.min(RACK_PLANT_MAX, 0.02 + g * 0.55 * lk.height), 0.25 + g * 1.3 * lk.leafSize, a, sw, 0, lk.stemWidth);
      rp.setColor(i, this.color.copy(cs).offsetHSL(0, 0, l), this.color2.copy(cl).offsetHSL(0, 0, l));
    });
    rp.commit();
  }

  /** 制御盤・状態ランプ・モニタ・養液タンク・ポンプ。制御盤と養液タンク（ポンプ・配管込み）は .glb */
  private buildEquipment(b: Builder) {
    const sc = this.scene;
    // ランプは状態で色を変えるので、1つずつ自前の発光マテリアルに差し替える
    const lamp = (m: THREE.Object3D, name: string) => {
      const o = m.getObjectByName(name) as THREE.Mesh;
      o.material = mat(0x5fe09a, { emissive: 0x5fe09a, emissiveIntensity: 0.9 });
      o.castShadow = false;
      return o as Lamp;
    };
    loadModel('control_panel').then(m => {
      m.position.set(-4.15, 0, 0.6);
      // 状態ランプ（上から EC・pH・液量）
      this.lamps = ['lamp_ec', 'lamp_ph', 'lamp_wt'].map(n => lamp(m, n));
      m.add((this.ruleLamps = ruleLamps()));
      sc.add(m);
    }, e => console.error(e));
    loadModel('nutrient_tank').then(m => {
      m.position.set(3.7, 0, 1.0);
      this.pumpLed = lamp(m, 'pump_led');
      sc.add(m);
    }, e => console.error(e));
    // モニタは高めに掛ける（断面・全景で栽培槽の枠と LED バーに隠れないように）
    b.box(2.4, 1.4, 0.12, 0x2d3640, 0, 3.7, -3.38);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.2), new THREE.MeshBasicMaterial({ map: this.monitor.texture, toneMapped: false }));
    screen.position.set(0, 3.7, -3.31);
    sc.add(screen);
  }

  /** 栽培槽（主役）：ガラス槽・水・浮きトレイ・LED・センサ・苗 */
  private buildTank() {
    const tg = (this.tank = new THREE.Group()), b = new Builder(tg), r = this.rand;
    tg.position.set(0.6, 0, 0.8);
    this.scene.add(tg);
    // 槽の台の接地影（部屋の接地影とは別の板にして、経営モードで槽と一緒に隠す）
    const ao = bakedShadow(W + 1.3, D + 1.3, [[0, 0, W + 0.3, D + 0.3, 0.42]], 0.45, 24);
    ao.position.y = 0.021;
    tg.add(ao);
    b.box(W + 0.3, 0.23, D + 0.3, 0x7f8894, 0, 0.115, 0);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(W, 2.1, D), mat(0xcdeeff, { transparent: true, opacity: 0.14, depthWrite: false }));
    glass.position.y = WB + 1.05;
    tg.add(glass);
    for (const i of [-1, 1]) for (const j of [-1, 1]) b.cyl(0.05, 3.0, 0xa9b3bb, (i * W) / 2, 1.5, (j * D) / 2, {}, 6);
    for (const j of [-1, 1]) b.box(W, 0.08, 0.08, 0xa9b3bb, 0, 3.0, (j * D) / 2);
    for (const i of [-1, 1]) b.box(0.08, 0.08, D, 0xa9b3bb, (i * W) / 2, 3.0, 0);
    this.water = new THREE.Mesh(new THREE.BoxGeometry(W - 0.08, 1, D - 0.08), mat(0x5cc0c8, { transparent: true, opacity: 0.6 }));
    tg.add(this.water);
    // 浮きトレイ（湛液型の定植パネル）：水面に浮き、液量が減ると受けに乗る。苗と根はトレイの子にする（原点＝トレイの中心）
    this.raft = new THREE.Group();
    tg.add(this.raft);
    const rb = new Builder(this.raft);
    rb.box(W - 0.06, 0.07, D - 0.06, 0xf4ecd8, 0, 0, 0);
    rb.box(W - 0.3, 0.03, D - 0.4, 0x857b6e, 0, 0.06, 0);
    // トレイの受け（ガラスの内側の長辺に4つ）。上面がトレイの底になる高さ
    boxSet(tg, [-1.3, 1.3].flatMap(x => [-1, 1].map((z): BoxSpec => [0.16, 0.04, 0.05, 0xa9b3bb, x, WB + STOP * HM - 0.02, z * (D / 2 - 0.03)])));
    // LED バーは細く（寄りで苗を隠す幅を減らす）
    for (const z of [-0.55, 0.55]) this.ledMats.push(b.box(W - 0.4, 0.08, 0.14, 0xffffff, 0, 2.85, z, LED).material);
    // LED の照り返し（トレイと苗をほんのり桃色に）。decay 1 で距離に対して緩やかに減衰させる
    const pl = (this.ledLight = new THREE.PointLight(0xffc4ec, 1.2, 7, 1));
    pl.position.set(0, 2.65, 0);
    tg.add(pl);
    // EC・pH センサのプローブ（槽の枠に固定。トレイの穴を通して液量が少ないときも水に届く長さ）
    PROBE_Z.forEach((z, i) => {
      b.cyl(0.03, PROBE_TOP - 0.4, 0x333c46, PROBE_X, (PROBE_TOP + 0.4) / 2 - 0.05, z, {}, 6);
      b.add(new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 5), mat([0x4cc38a, 0x4a8fe0][i])), PROBE_X, PROBE_TOP, z);
    });
    for (let i = 0; i < NX; i++) for (let j = 0; j < NZ; j++) {
      this.seedlings.push({
        x: (i / (NX - 1) - 0.5) * (W - 0.5) + (r() - 0.5) * 0.05,
        z: (j / (NZ - 1) - 0.5) * (D - 0.5) + (r() - 0.5) * 0.05,
        delay: r() * 0.25, size: 0.8 + r() * 0.4, phase: r() * 6.28,
      });
    }
    const inst = (parent: THREE.Object3D, geo: THREE.BufferGeometry, n: number, cast: boolean) => {
      const m = new THREE.InstancedMesh(geo, mat(0xffffff), n);
      m.castShadow = cast;
      parent.add(m);
      return m;
    };
    const root = new THREE.CylinderGeometry(0.007, 0.003, 1, 4).translate(0, -0.5, 0);
    this.plants = new Seedlings(this.raft, N);
    this.roots = inst(this.raft, root, N, false);
    this.bubbles = inst(tg, new THREE.IcosahedronGeometry(0.04, 0), 12, false);
    Object.assign(this.bubbles.material, { transparent: true, opacity: 0.6 });
  }

  /**
   * センサケーブル（プローブ→制御盤）。宙を渡さず、槽の枠の梁の外側（右→奥）→左奥の柱の裏→槽の台→床のケーブルプロテクターの下を通す。
   * 正面（断面）からは梁と柱の陰に隠れる。座標は部屋の座標（栽培槽の原点は (0.6, 0, 0.8)）
   */
  private buildCables(boxes: BoxSpec[]) {
    const ox = 0.6, oz = 0.8, R = ox + W / 2, L = ox - W / 2, BK = oz - D / 2, duct = 0.25;
    PROBE_Z.forEach((z, i) => {
      // 2本は梁の上では上下に、床では左右にずらして並べる
      const d = (i - 0.5) * 0.045, px = ox + PROBE_X, pz = oz + z, y = 3.0 + d;
      this.cables.push(tube([
        [px, PROBE_TOP + 0.05, pz], [px, 2.75, pz], [R + 0.06, 2.9, pz], [R + 0.06, y, pz], [R + 0.06, y, BK - 0.06],
        [L + d, y, BK - 0.07], [L + d, 0.25, BK - 0.07], [L - 0.09, 0.25, BK - 0.07], [L - 0.09, 0.25, duct + d],
        [L - 0.17, 0.25, duct + d], [L - 0.17, 0.02, duct + d], [-3.95, 0.02, duct + d],
      ], 0.02, 0x2b3138));
    });
    this.scene.add(...this.cables);
    // 床のケーブルプロテクター（槽の台の左端から制御盤の前まで）。灰色の本体に黄色の筋
    const x0 = L - 0.12, x1 = -3.9, cx = (x0 + x1) / 2, len = x0 - x1;
    boxes.push([len, 0.035, 0.18, 0x4a5058, cx, 0.0175, duct], [len, 0.004, 0.05, 0xf2c230, cx, 0.037, duct]);
  }

  /**
   * 作業の小物。木箱・バケツ・肥料袋（A液・B液）・壁のクリップボード・台車と播種トレイ・消火器・薬剤棚・踏み台・ポリ容器・排水口は
   * .glb（room_props。原点は部屋の原点）。ホース（管）と計量カップ（半透明）は手続き生成
   */
  private buildProps(b: Builder, boxes: BoxSpec[]) {
    loadModel('room_props').then(m => this.scene.add(m), e => console.error(e));
    // 巻いたホース（3巻きを1つの形にまとめる）と、養液タンクへ伸びる先
    const hose = 0x2f7062, coil = mergeTori([0, 1, 2].map(k => [0.22 - k * 0.01, k * 0.02, 0.025 + k * 0.045] as const), 0.025);
    b.add(new THREE.Mesh(coil, mat(hose)), 3.35, 0, 2.95);
    this.scene.add(tube([[3.57, 0.07, 2.95], [3.85, 0.025, 2.6], [3.88, 0.025, 1.7], [3.85, 0.15, 1.42]], 0.025, hose, 0.2));
    // 計量カップ（木箱の上）と取っ手
    b.add(new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.05, 0.13, 8), mat(0xf2f6f8, { transparent: true, opacity: 0.75 })), -3.35, 0.865, 2.5);
    boxes.push([0.06, 0.02, 0.02, 0xf2f6f8, -3.27, 0.89, 2.5]);
  }

  /**
   * 状態を見た目に反映する。t は秒。最も悪い要因が苗の色と形を決める。
   * blind：センサの表示（制御盤の状態ランプ・モニタ）を伏せる（症状診断モードで見た目だけから当てさせる、経営モードで連続測定センサがない）
   */
  update(s: SimState, t: number, blind: Blind = false, clock = s.hour): void {
    this.showTank(true);
    const fx = s.facility, bed = bedOf(s), running = pumpRunning(fx, bed.id);
    const pw: Power = { on: powered(fx), pumpDown: fx.pumpDown.includes(bed.id), running };
    this.setClock(clock, pw.on);
    const dg = diagnose(s), { key: wk, side } = dg.worst, ws = 1 - dg.worst.value;
    const hp = s.crop.health, g = s.crop.growth, du = this.dummy, tc = this.color;
    // 作物ごとの形と色（crops.json の look）。症状の色はこの健康な色から寄せる
    const spec = cropSpec(s), look = spec.look;
    if (s.crop.id !== this.cropId) {
      this.cropId = s.crop.id;
      this.plants.setShape(look.leafShape);
      this.paintRack(spec);
    }
    const cs = this.stemColor.set(look.stem), cl = this.leafColor.set(look.leaf);
    const sick = Math.min(1, 1 - hp / 100 + ws * 0.4);
    // 根の酸欠：根が茶色になり、苗がしおれる（溶存酸素は FACTORS の外なので diagnose に入らない）
    const hyp = 1 - o2Fitness(bed);
    const wilt = Math.max(wk === 'water' && side === 'low' ? ws : 0, hyp * 0.8);
    const small = wk === 'ec' && side === 'high' ? ws * 0.35 : 0;
    const stage = Math.floor(g * 4);
    if (stage !== this.stage) { this.stage = stage; this.popAt = t; }
    const pa = t - this.popAt, pop = pa < 0.6 ? 1 + 0.22 * Math.sin(pa * 16) * Math.exp(-pa * 5) : 1;
    this.shownWater += (bed.water - this.shownWater) * 0.15;
    const h = (this.shownWater / bed.capacity) * HM;
    this.water.scale.y = h;
    this.water.position.y = WB + h / 2;
    // トレイは水面に浮く（底が 2cm 沈む）。受けより下には下がらない
    const ry = WB + Math.max(h, STOP * HM) + 0.015;
    this.raft.position.y = ry;
    // 根は槽の底を突き抜けない長さまで
    const rootMax = ry - WB - 0.06;
    const symptom = SYMPTOM[wk][side === 'low' ? 0 : 1];
    this.seedlings.forEach((p, i) => {
      const gg = Math.max(0, Math.min(1, (g - p.delay) / (1 - p.delay)));
      const hg = (0.02 + gg * 0.55 * p.size * look.height) * pop, sw = Math.sin(t * 1.6 + p.phase) * 0.04 * (0.3 + gg);
      const sz = (0.25 + gg * 1.3 * look.leafSize) * (1 - small) * pop;
      this.plants.set(i, p.x, 0.08, p.z, hg, sz, p.phase, sw, sick * 0.6 + wilt * 0.9, look.stemWidth);
      const tint = (out: THREE.Color, c: THREE.Color) =>
        out.copy(c).lerp(symptom, Math.min(1, ws * 1.3)).lerp(C_DEAD, Math.max(0, (1 - hp / 100) * 0.9)).offsetHSL(0, 0, (p.size - 1) * 0.08);
      this.plants.setColor(i, tint(tc, cs), tint(this.color2, cl));
      // 根：芽の段階でもトレイの底から水面に届く長さにする
      du.position.set(p.x, 0, p.z);
      du.rotation.set(0, 0, Math.sin(t * 1.2 + p.phase) * 0.05);
      du.scale.set(1, Math.min(rootMax, 0.08 + gg * 0.85), 1);
      du.updateMatrix();
      this.roots.setMatrixAt(i, du.matrix);
      this.roots.setColorAt(i, tc.copy(C_ROOT).lerp(C_ROOT_BAD, Math.min(1, Math.max(ws, hyp) * 1.3)));
    });
    // エアレーションの泡：ポンプが止まると出なくなる
    for (let j = 0; j < 12; j++) {
      du.position.set(-1.7 + Math.sin(t * 3 + j) * 0.04, WB + ((t * 0.5 + j / 12) % 1) * h, 0.8);
      du.rotation.set(0, 0, 0);
      du.scale.setScalar(running ? 0.6 + (j % 3) * 0.3 : 0);
      du.updateMatrix();
      this.bubbles.setMatrixAt(j, du.matrix);
    }
    // 資材は養液タンクの点検口に入れ、ポンプが回っていれば少し遅れてその色の養液が吐出口から出てくる
    const dt = this.step(t, 'grow', s.log);
    for (const { cmd, auto, rule } of this.newDoses(s.log)) {
      const color = this.doseColor(cmd), all = cmd.type === 'replaceSolution';
      if (rule !== undefined) this.ruleFlash[rule] = t;
      this.fx.dose(color, PORT[0], PORT_DROP, PORT[1], PORT_LID, all ? 36 : auto ? 4 : 10, all ? 0.18 : 0.06);
      if (!all && cmd.supply !== 'water') this.tint = { from: t + TINT_DELAY, to: t + TINT_DELAY + TINT_FOR, color };
    }
    // ポンプの水流（吐出口が水の中にあるときだけ）
    if (running && WB + h > INLET[1] + 0.12) this.fx.stream(dt, INLET[0], INLET[1], INLET[2], t >= this.tint.from && t < this.tint.to ? this.tint.color : null);
    this.fx.update(dt);
    this.plants.commit();
    this.roots.instanceMatrix.needsUpdate = true;
    this.roots.instanceColor!.needsUpdate = true;
    this.bubbles.instanceMatrix.needsUpdate = true;
    // 制御盤のランプとモニタはセンサの読み（苗の見た目は本当の値）
    this.panel(s, diagnose(s, 'sensor'), t, blind, clock, pw);
  }

  /**
   * 経営モード：栽培槽の代わりに棚を出す。rack・slot は選んでいるトレイ（枠で示す）。
   * 制御盤のランプとモニタは選んだトレイの見かけの栽培槽 mon で描く（連続測定センサがなければ blind で伏せる）
   */
  updateFarm(f: FarmState, rack: number, slot: number, mon: SimState, t: number, blind: Blind, clock = f.hour): void {
    this.showTank(false);
    if (!this.farm) {
      this.farm = new FarmRacks(this.scene);
      this.ledMats.push(this.farm.ledMaterial);
    }
    this.farm.update(f, rack, slot, t);
    // 経営モードのポンプの運転ランプ（養液タンク）は棚のどれかが止まっていたら停止を示す。非常用電源があれば停電中も回る
    const fx = f.facility, ups = f.equipment.ups > 0, down = fx.pumpDown.length > 0;
    const pw: Power = { on: powered(fx), pumpDown: down, running: !down && (powered(fx) || ups) };
    // 資材は棚の養液タンクに入れる（自動給水・pH 自動調整も）。ポンプが回っている棚はタンクに泡
    const dt = this.step(t, 'farm', f.log);
    for (const { cmd, auto } of this.newDoses(f.log)) {
      const i = f.racks.findIndex(r => r.id === cmd.target);
      if (i < 0) continue;
      const wy = tankWaterY(rackValues(f, cmd.target).water), all = cmd.type === 'replaceSolution';
      this.fx.dose(this.doseColor(cmd), RACK_TANK.x[i], RACK_TANK.top + 0.08, RACK_TANK.z, wy, all ? 20 : auto ? 3 : 8, all ? 0.25 : 0.08);
    }
    f.racks.forEach((r, i) => {
      if (fx.pumpDown.includes(r.id) || !(pw.on || ups)) return;
      this.fx.bubbles(r.id, dt, 8, RACK_TANK.x[i], 0.04, RACK_TANK.z, RACK_TANK.w, RACK_TANK.d, tankWaterY(rackValues(f, r.id).water));
    });
    this.fx.update(dt);
    this.setClock(clock, pw.on);
    this.panel(mon, diagnose(mon, 'sensor'), t, blind, clock, pw);
  }

  /** 前のフレームからの秒（初回・タブを戻したときは小さく）。モードが変わったらパーティクルを消し、記録の見始めを今にする */
  private step(t: number, scene: string, log: readonly unknown[]): number {
    const dt = this.lastT < 0 ? 0 : Math.min(0.1, Math.max(0, t - this.lastT));
    this.lastT = t;
    if (scene !== this.scene3) { this.scene3 = scene; this.fx.clear(); this.seen = { log, n: log.length }; }
    return dt;
  }

  /** 記録に新しく入った養液の操作（資材・全交換）を返す。記録が別のもの（始め直し・別の sim）なら今から見る */
  private newDoses<E extends { kind: string }>(log: readonly E[]): { cmd: { type: string; target: string; supply?: string }; auto?: boolean; rule?: number }[] {
    if (log !== this.seen.log) { this.seen = { log, n: log.length }; this.ruleFlash = []; return []; }
    const out = log.slice(this.seen.n).filter(e => e.kind === 'command') as unknown as { command: { type: string; target: string; supply?: string }; auto?: boolean; rule?: number }[];
    this.seen.n = log.length;
    // 自動の操作が1フレームに何十回あっても、しずくは行ごとに1回分
    const seenRule = new Set<number>();
    return out.filter(e => (e.command.type === 'dose' || e.command.type === 'replaceSolution') && (e.rule === undefined || !seenRule.has(e.rule) && !!seenRule.add(e.rule)))
      .map(e => ({ cmd: e.command, auto: e.auto, rule: e.rule }));
  }

  private doseColor(c: { type: string; supply?: string }) {
    return DOSE_COLOR[(c.type === 'dose' ? c.supply : 'solution') as keyof typeof DOSE_COLOR];
  }

  /**
   * 昼夜：clock は経過時間 h（小数で滑らかに）。LED は sim と同じ時刻（LIGHT）で点き、高窓の空と部屋の光は朝夕に移り変わる。
   * 夜も天井灯は点いている設定で暗くしすぎない（症状の色を見分けられるように）。
   * 停電（on が false）は LED と天井灯が消え、高窓からの光だけになる（暗転。0.5秒ほどで移る）
   */
  private setClock(clock: number, on = true) {
    const h = ((clock % 24) + 24) % 24;
    this.shownPower += ((on ? 1 : 0) - this.shownPower) * 0.12;
    const pw = this.shownPower;
    // 境目の手前 0.2h で移り変わり、整数の時刻では sim の isLit と一致する
    const led = smooth(LIGHT.on - 0.2, LIGHT.on, h) * (1 - smooth(LIGHT.off - 0.2, LIGHT.off, h)) * pw;
    const day = smooth(5, 7, h) * (1 - smooth(18, 20, h));
    const room = 1 - (1 - pw) * (1 - (OUT_NIGHT + (OUT_DAY - OUT_NIGHT) * day));
    for (const m of this.ledMats) m.emissiveIntensity = 0.9 * led;
    this.ledLight.intensity = 1.2 * led;
    this.sky.color.copy(SKY_NIGHT).lerp(SKY_DAY, day).lerp(SKY_DUSK, 4 * day * (1 - day) * 0.7);
    this.sun.intensity = (0.95 + 0.75 * day) * room;
    this.sun.color.copy(SUN_NIGHT).lerp(SUN_DAY, day);
    this.hemi.intensity = (1.6 + 0.7 * day) * room;
    this.hemi.color.copy(HEMI_NIGHT).lerp(HEMI_DAY, day);
  }

  private showTank(v: boolean) {
    this.tank.visible = v;
    for (const c of this.cables) c.visible = v;
    if (this.farm) this.farm.visible = !v;
  }

  /**
   * 制御盤の状態ランプ・ポンプの運転ランプ・モニタ。停電中は制御盤とモニタが消える。
   * ポンプの運転ランプは運転中は緑でゆっくり明滅、止まったら赤で速く点滅、停電で回っていなければ消える
   */
  private panel(s: SimState, dg: Diagnosis, t: number, blind: Blind, clock: number, pw: Power) {
    const f = dg.fitness;
    this.lamps.forEach((m, i) => {
      const q = [f.ec, f.ph, f.water][i];
      m.material.color.setHex(blind || !pw.on ? LAMP_OFF : q > 0.9 ? 0x5fe09a : q > 0.5 ? 0xf2c230 : 0xff6b6b);
      m.material.emissive.copy(m.material.color);
    });
    if (this.pumpLed) {
      const m = this.pumpLed.material;
      if (pw.pumpDown) { m.color.setHex(PUMP_NG); m.emissiveIntensity = Math.sin(t * 9) > 0 ? 1.2 : 0.05; }
      else if (pw.running) { m.color.setHex(PUMP_OK); m.emissiveIntensity = 0.5 + 0.5 * Math.sin(t * 4); }
      else { m.color.setHex(LAMP_OFF); m.emissiveIntensity = 0; }
      m.emissive.copy(m.color);
    }
    // 自動制御ルールの行ごとの状態（0＝行なし・1＝無効・2＝有効・3＝動いた直後）。停電・伏せているときは消す
    const rs = Array.from({ length: RULE_LIMIT }, (_, i) => {
      const r = s.control.rules[i];
      return !r || blind || !pw.on ? 0 : !r.on ? 1 : t - (this.ruleFlash[i] ?? -9) < RULE_FLASH ? 3 : 2;
    });
    if (this.ruleLamps) {
      rs.forEach((v, i) => this.ruleLamps!.setColorAt(i + 1, [RULE_OFF, RULE_DISABLED, RULE_IDLE, RULE_FIRE][v]));
      this.ruleLamps.instanceColor!.needsUpdate = true;
    }
    const alert = pw.pumpDown ? 'ポンプ停止：養液が循環していない' : null;
    const screen = `${pw.on}:${blind}:${alert}:${rs.join('')}`;
    // 表示が変わったら（ランプの点滅で頻繁に変わるので 0.1秒はあけて）描き直す
    if (t - this.monitorAt > 0.4 || (screen !== this.screen && t - this.monitorAt > 0.1)) {
      this.monitorAt = t;
      this.screen = screen;
      if (!pw.on) this.monitor.drawOff();
      else if (blind) this.monitor.drawBlind(blind, alert); else this.monitor.draw(s, dg, clock, alert, rs);
    }
  }
}

/** 自動制御ルールのランプ：0 番は台（黒い板）、1〜RULE_LIMIT 番が行のランプ。制御盤の .glb の子にする */
function ruleLamps(): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ toneMapped: false }), RULE_LIMIT + 1);
  const du = new THREE.Object3D(), { x, y, z0, dz } = RULE_LAMP;
  du.position.set(x - 0.008, y, z0 + (dz * (RULE_LIMIT - 1)) / 2);
  du.scale.set(0.012, 0.09, dz * RULE_LIMIT + 0.04);
  du.updateMatrix();
  m.setMatrixAt(0, du.matrix);
  m.setColorAt(0, RULE_PLATE);
  for (let i = 0; i < RULE_LIMIT; i++) {
    du.position.set(x, y, z0 + dz * i);
    du.scale.set(0.02, 0.045, 0.07);
    du.updateMatrix();
    m.setMatrixAt(i + 1, du.matrix);
    m.setColorAt(i + 1, RULE_OFF);
  }
  m.castShadow = false;
  return m;
}
