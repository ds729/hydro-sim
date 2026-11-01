// ローポリ＋フラットシェーディングの部品を置く小道具

import * as THREE from 'three';

export const mat = (color: number, o: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.85, ...o });

/** LED バーの発光 */
export const LED = { emissive: 0xffd2ec, emissiveIntensity: 0.9 };

/** 焼き込み影の矩形：中心 x・z、幅・奥行き、濃さ 0〜1（m。影の板の中心が原点） */
export type ShadowRect = [x: number, z: number, w: number, d: number, k: number];

/**
 * 地面に敷くぼかし影（接地影・AO の代わり）。起動時に矩形からの距離で濃さを計算した alphaMap を作る。
 * リアルタイムの影より安く、スマホでも柔らかい縁にできる。falloff は影が消えるまでの距離（m）、ppm は 1m あたりの画素数
 */
export function bakedShadow(w: number, d: number, rects: ShadowRect[], falloff: number, ppm: number): THREE.Mesh {
  const nx = Math.ceil(w * ppm), nz = Math.ceil(d * ppm), data = new Uint8Array(nx * nz * 4);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    // 板を X 軸で -90° 倒すので、テクスチャの行 0（v=0）は奥行きの手前側（+z）になる
    const px = ((i + 0.5) / nx - 0.5) * w, pz = (0.5 - (j + 0.5) / nz) * d;
    let a = 0;
    for (const [x, z, rw, rd, k] of rects) {
      const t = Math.min(1, Math.hypot(Math.max(Math.abs(px - x) - rw / 2, 0), Math.max(Math.abs(pz - z) - rd / 2, 0)) / falloff);
      a = Math.max(a, k * (1 - t) * (1 - t));
    }
    data.fill(Math.round(a * 255), (j * nx + i) * 4, (j * nx + i) * 4 + 4);
  }
  const tex = new THREE.DataTexture(data, nx, nz);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: tex, transparent: true, depthWrite: false }),
  );
  // 半透明の中で先に描く（ガラス槽・水より奥にあるため）
  m.renderOrder = -1;
  return m;
}

/** parent に影つきで部品を足す */
export class Builder {
  constructor(public parent: THREE.Object3D) {}

  add<T extends THREE.Mesh>(m: T, x: number, y: number, z: number): T {
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    this.parent.add(m);
    return m;
  }

  box(w: number, h: number, d: number, color: number, x: number, y: number, z: number, o?: THREE.MeshStandardMaterialParameters) {
    return this.add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, o)), x, y, z);
  }

  cyl(r: number, h: number, color: number, x: number, y: number, z: number, o?: THREE.MeshStandardMaterialParameters, seg = 8) {
    return this.add(new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat(color, o)), x, y, z);
  }
}
