// 苗（茎・葉・巻きひげ）の InstancedMesh。葉の形は作物ごとに crops.json の look.leafShape で選ぶ
// 形はローポリ＋フラットシェーディング（面数を抑えた押し出し形）。色は症状に合わせて外から入れる

import * as THREE from 'three';
import type { LeafShape } from '../sim';
import { mat } from './build';

/** 茎（根元が原点、高さ 1） */
const STEM_GEO = new THREE.CylinderGeometry(0.014, 0.02, 1, 5).translate(0, 0.5, 0);

/**
 * 葉の輪郭（u＝付け根から先への長さ、v＝幅）を押し出し、水平に寝かせた形。付け根が原点で、葉は +x へ伸びる。
 * bevel は面取り（厚い子葉だけ）
 */
function leafGeo(outline: (s: THREE.Shape) => void, depth: number, bevel = 0): THREE.BufferGeometry {
  const s = new THREE.Shape();
  outline(s);
  const g = new THREE.ExtrudeGeometry(s, {
    depth, curveSegments: 3, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1,
  });
  // 押し出しの向き（+z）を上（+y）に、幅（y）を奥行き（z）にする
  return g.rotateX(-Math.PI / 2).translate(0, -depth / 2, 0);
}

/** 葉の形。長さはどれも 0.13〜0.17（sz 1 のとき） */
const LEAF_GEOS: Record<LeafShape, THREE.BufferGeometry> = {
  // かいわれ型の子葉：付け根が細く、先が幅広く、先端の中央がくぼむハート形（ラディッシュ・ブロッコリー）
  heart: leafGeo(s => {
    s.moveTo(0, 0);
    s.bezierCurveTo(0.03, 0.012, 0.05, 0.07, 0.11, 0.06);
    s.quadraticCurveTo(0.145, 0.045, 0.125, 0);
    s.quadraticCurveTo(0.145, -0.045, 0.11, -0.06);
    s.bezierCurveTo(0.05, -0.07, 0.03, -0.012, 0, 0);
  }, 0.01),
  // ひまわりの子葉：細長い楕円で厚い（面取りして厚みを見せる）
  oval: leafGeo(s => {
    s.moveTo(0, 0);
    s.bezierCurveTo(0.03, 0.03, 0.09, 0.05, 0.14, 0.035);
    s.quadraticCurveTo(0.175, 0.02, 0.17, 0);
    s.quadraticCurveTo(0.175, -0.02, 0.14, -0.035);
    s.bezierCurveTo(0.09, -0.05, 0.03, -0.03, 0, 0);
  }, 0.012, 0.004),
  // 豆苗の小葉：丸みのある卵形
  pea: leafGeo(s => {
    s.moveTo(0, 0);
    s.bezierCurveTo(0.02, 0.045, 0.08, 0.055, 0.105, 0.025);
    s.quadraticCurveTo(0.12, 0, 0.105, -0.025);
    s.bezierCurveTo(0.08, -0.055, 0.02, -0.045, 0, 0);
  }, 0.008),
};

/** 巻きひげ（豆苗）：茎の先から上へ伸びて先が巻く細い管。根元が原点、高さ約 0.16 */
const TENDRIL_GEO = (() => {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12, curl = Math.max(0, t - 0.55) / 0.45, r = 0.025 * curl;
    pts.push(new THREE.Vector3(0.02 * t + r * Math.sin(curl * 7), 0.15 * t - r * (1 - Math.cos(curl * 7)) * 0.5, r * (1 - Math.cos(curl * 7))));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 10, 0.005, 3);
})();

/**
 * 形ごとの葉の付き方。nodes は [茎の高さに対する位置, 大きさの倍率, 向きのずれ（rad）] で、節ごとに葉が左右に1対付く。
 * lift は葉の立ち上がりの角度（rad）、tendril は巻きひげの有無
 */
interface Form { nodes: [number, number, number][]; lift: number; tendril: boolean }
const FORMS: Record<LeafShape, Form> = {
  // 子葉が茎の先に1対、V字に立つ
  heart: { nodes: [[1, 1, 0]], lift: 0.4, tendril: false },
  // 厚い子葉が茎の先に1対、ほぼ水平に開く
  oval: { nodes: [[1, 1, 0]], lift: 0.2, tendril: false },
  // 本葉（小葉）が2段、上の段は90°ずらす。先に巻きひげ
  pea: { nodes: [[0.62, 0.8, 0], [1, 1, Math.PI / 2]], lift: 0.45, tendril: true },
};
const MAX_LEAVES = Math.max(...Object.values(FORMS).map(f => f.nodes.length * 2));

export class Seedlings {
  readonly stems: THREE.InstancedMesh;
  readonly leaves: THREE.InstancedMesh;
  readonly tendrils: THREE.InstancedMesh;
  private form = FORMS.heart;
  private shape: LeafShape | null = null;
  private du = new THREE.Object3D();

  constructor(parent: THREE.Object3D, private n: number) {
    this.stems = new THREE.InstancedMesh(STEM_GEO, mat(0xffffff), n);
    this.leaves = new THREE.InstancedMesh(LEAF_GEOS.heart, mat(0xffffff), n * MAX_LEAVES);
    this.tendrils = new THREE.InstancedMesh(TENDRIL_GEO, mat(0xffffff), n);
    for (const m of [this.stems, this.leaves, this.tendrils]) {
      m.castShadow = true;
      parent.add(m);
    }
    this.setShape('heart');
  }

  /** 葉の形を変える。変わったときだけ形と数を入れ替え、true を返す */
  setShape(shape: LeafShape): boolean {
    if (shape === this.shape) return false;
    this.shape = shape;
    this.form = FORMS[shape];
    this.leaves.geometry = LEAF_GEOS[shape];
    this.leaves.count = this.n * this.form.nodes.length * 2;
    this.tendrils.count = this.form.tendril ? this.n : 0;
    return true;
  }

  /**
   * i 番の苗を置く。y は茎の根元、hg は茎の高さ、sz は葉の大きさ、a は葉の向き、sw は揺れ（茎の傾き）、
   * droop は葉の垂れ（0〜1。しおれ・不調）、wd は茎の太さの倍率
   */
  set(i: number, x: number, y: number, z: number, hg: number, sz: number, a: number, sw: number, droop: number, wd: number): void {
    const du = this.du, f = this.form, per = f.nodes.length * 2;
    du.position.set(x, y, z);
    du.rotation.set(0, 0, sw);
    du.scale.set(wd, hg, wd);
    du.updateMatrix();
    this.stems.setMatrixAt(i, du.matrix);
    // 茎は z 軸まわりに sw 傾くので、高さ h の点は x に −sin(sw)·h ずれる
    f.nodes.forEach(([at, scale, turn], k) => {
      const h = hg * at, px = x - Math.sin(sw) * h, py = y + Math.cos(sw) * h;
      for (let side = 0; side < 2; side++) {
        const b = a + turn + side * Math.PI;
        du.position.set(px, py, z);
        du.rotation.set(0, -b, f.lift - droop * 1.3);
        du.scale.setScalar(sz * scale);
        du.updateMatrix();
        this.leaves.setMatrixAt(i * per + k * 2 + side, du.matrix);
      }
    });
    if (f.tendril) {
      du.position.set(x - Math.sin(sw) * hg, y + Math.cos(sw) * hg, z);
      du.rotation.set(0, -a, sw - droop * 0.8);
      du.scale.setScalar(sz);
      du.updateMatrix();
      this.tendrils.setMatrixAt(i, du.matrix);
    }
  }

  /** i 番の苗の色（茎・巻きひげ、葉） */
  setColor(i: number, stem: THREE.Color, leaf: THREE.Color): void {
    const per = this.form.nodes.length * 2;
    this.stems.setColorAt(i, stem);
    if (this.form.tendril) this.tendrils.setColorAt(i, stem);
    for (let k = 0; k < per; k++) this.leaves.setColorAt(i * per + k, leaf);
  }

  /** 行列と色を描画に反映する（set・setColor の後に1回） */
  commit(): void {
    for (const m of [this.stems, this.leaves, this.tendrils]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }
}
