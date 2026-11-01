// .glb の読み込み。ファイルは public/models/ に置き、Vite の base（Pages では /hydro-sim/）を前に付けて読む
// モデルは tools/blender/build_models.py で作る（meshopt 圧縮）

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

/** 読み込みの状態（確認用。hydro.models から見る） */
export const modelStatus: Record<string, string> = {};

/** models/<name>.glb を読み、影の設定をしたシーンを返す */
export async function loadModel(name: string): Promise<THREE.Group> {
  const url = `${import.meta.env.BASE_URL}models/${name}.glb`;
  modelStatus[name] = 'loading';
  try {
    const { scene } = await loader.loadAsync(url);
    scene.traverse(o => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true;
    });
    modelStatus[name] = 'ok';
    return scene;
  } catch (e) {
    modelStatus[name] = `error: ${url}`;
    throw e;
  }
}
