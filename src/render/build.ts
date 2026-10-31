// ローポリ＋フラットシェーディングの部品を置く小道具

import * as THREE from 'three';

export const mat = (color: number, o: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.85, ...o });

/** LED バーの発光 */
export const LED = { emissive: 0xffa8e0, emissiveIntensity: 1 };

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
