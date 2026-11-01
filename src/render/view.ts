// 描画層の入口：レンダラ・ジオラマ・カメラをまとめる

import * as THREE from 'three';
import { mulberry32, type SimState } from '../sim';
import { CameraRig, type Rect } from './camera';
import { Diorama } from './diorama';

// 色管理は three の既定（有効）：16進の色は sRGB として読み、リニアで光を計算して sRGB で出力する。
// トーンマッピングは Neutral（Khronos PBR Neutral）。ACES より指定した色の色相・彩度を崩しにくく、パレットで色を決める画調に合う

/** 画質：shadows はリアルタイムの影（焼き込みの接地影は常に出す）、dpr は devicePixelRatio の上限 */
export interface Quality { shadows: boolean; dpr: number }

export class View {
  readonly renderer: THREE.WebGLRenderer;
  readonly rig = new CameraRig();
  private diorama: Diorama;

  constructor(canvas: HTMLCanvasElement, seed = 1) {
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NeutralToneMapping;
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    // PCFSoftShadowMap は three r18x で廃止され PCFShadowMap に統合された（ぼかしは shadow.radius で付ける）
    r.shadowMap.type = THREE.PCFShadowMap;
    // 苗の配置などの見た目の乱数。sim の乱数とは別に固定シードで作る（スクリーンショットを再現できるように）
    this.diorama = new Diorama(mulberry32(seed));
    this.rig.attach(canvas);
  }

  /** 画質を変える。影の有無はシェーダーの作り直しになるので、切り替えた直後の1フレームは重い */
  setQuality(q: Quality): void {
    this.diorama.sun.castShadow = q.shadows;
    // setPixelRatio は今の大きさで描画バッファを作り直す（resize を呼び直さなくてよい）
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, q.dpr));
  }

  /** safes：3D がパネルに隠れない領域の候補（カメラは被写体が大きく映る方を使う） */
  resize(w: number, h: number, safes: Rect[]): void {
    this.renderer.setSize(w, h, false);
    this.rig.setViewport(w, h, safes);
  }

  /** 状態を反映して1フレーム描く。t は秒、blind はセンサの表示を伏せる（症状診断モード） */
  frame(s: SimState, t: number, blind = false): void {
    this.diorama.update(s, t, blind);
    this.rig.update();
    this.renderer.render(this.diorama.scene, this.rig.camera);
  }
}
