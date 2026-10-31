// 描画層の入口：レンダラ・ジオラマ・カメラをまとめる

import * as THREE from 'three';
import { mulberry32, type SimState } from '../sim';
import { CameraRig, type Rect } from './camera';
import { Diorama } from './diorama';

// v0.4.1（three r128）と同じ色の出方にそろえる：色管理なし・リニア出力。
// sRGB 出力・トーンマッピングは Phase 2（見た目強化）で入れる
THREE.ColorManagement.enabled = false;

export class View {
  readonly renderer: THREE.WebGLRenderer;
  readonly rig = new CameraRig();
  private diorama: Diorama;

  constructor(canvas: HTMLCanvasElement, seed = 1) {
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }));
    r.outputColorSpace = THREE.LinearSRGBColorSpace;
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    // PCFSoftShadowMap は three r18x で廃止され PCFShadowMap に統合された
    r.shadowMap.type = THREE.PCFShadowMap;
    // 苗の配置などの見た目の乱数。sim の乱数とは別に固定シードで作る（スクリーンショットを再現できるように）
    this.diorama = new Diorama(mulberry32(seed));
    this.rig.attach(canvas);
  }

  resize(w: number, h: number, safe: Rect): void {
    this.renderer.setSize(w, h, false);
    this.rig.setViewport(w, h, safe);
  }

  /** 状態を反映して1フレーム描く。t は秒 */
  frame(s: SimState, t: number): void {
    this.diorama.update(s, t);
    this.rig.update();
    this.renderer.render(this.diorama.scene, this.rig.camera);
  }
}
