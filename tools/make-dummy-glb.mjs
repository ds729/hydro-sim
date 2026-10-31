// ダミーの .glb（木箱1個）を作る。.glb の読み込みと、Pages 上でのパス（/hydro-sim/）を確かめるためのもの
// Blender を使わず glTF 2.0 のバイナリを直接書く。Phase 2 で Blender 自作のモデルに置き換える
// node tools/make-dummy-glb.mjs  → public/models/dummy-crate.glb
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = 'public/models/dummy-crate.glb';
// 木箱：幅 0.7 × 高さ 0.4 × 奥行き 0.5 m。原点は接地面の中心、Y-up
const [W, H, D] = [0.7, 0.4, 0.5];
// 色は手続き生成の木箱（0xd9a05b）と同じ。色管理を切っている間（v0.5）は 0〜255 をそのまま 0〜1 にした値で同じ見た目になる
const COLOR = [0xd9, 0xa0, 0x5b].map(v => v / 255);

// 面ごとに頂点を分けて法線を持たせる（フラットシェーディング）
const pos = [], nrm = [], idx = [];
for (const axis of [0, 1, 2]) for (const sign of [1, -1]) {
  const u = (axis + 1) % 3, v = (axis + 2) % 3, base = pos.length / 3;
  for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const p = [0, 0, 0];
    p[axis] = sign; p[u] = a; p[v] = b;
    pos.push(p[0] * W / 2, (p[1] + 1) * H / 2, p[2] * D / 2);
    nrm.push(...[0, 1, 2].map(i => (i === axis ? sign : 0)));
  }
  // 外から見て反時計回りを表にする
  idx.push(...(sign > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]).map(i => base + i));
}

const bin = Buffer.concat([new Float32Array(pos), new Float32Array(nrm), new Uint16Array(idx)].map(a => Buffer.from(a.buffer)));
const view = (byteOffset, byteLength, target) => ({ buffer: 0, byteOffset, byteLength, target });
const gltf = {
  asset: { version: '2.0', generator: 'hydro-sim tools/make-dummy-glb.mjs' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ name: 'crate', mesh: 0 }],
  meshes: [{ name: 'crate', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
  // 手続き生成の部品（build.ts の mat）と同じ質感：金属でない・粗さ 0.85
  materials: [{ name: 'wood', pbrMetallicRoughness: { baseColorFactor: [...COLOR, 1], metallicFactor: 0, roughnessFactor: 0.85 } }],
  accessors: [
    { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: [-W / 2, 0, -D / 2], max: [W / 2, H, D / 2] },
    { bufferView: 1, componentType: 5126, count: nrm.length / 3, type: 'VEC3' },
    { bufferView: 2, componentType: 5123, count: idx.length, type: 'SCALAR' },
  ],
  bufferViews: [view(0, pos.length * 4, 34962), view(pos.length * 4, nrm.length * 4, 34962), view((pos.length + nrm.length) * 4, idx.length * 2, 34963)],
  buffers: [{ byteLength: bin.length }],
};

// GLB：ヘッダ（12 バイト）＋ JSON チャンク（空白で 4 バイト境界に詰める）＋ BIN チャンク（0 で詰める）
const pad = (b, fill) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
const chunk = (type, data) => {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(data.length, 0);
  h.writeUInt32LE(type, 4);
  return Buffer.concat([h, data]);
};
const body = Buffer.concat([chunk(0x4e4f534a, pad(Buffer.from(JSON.stringify(gltf)), 0x20)), chunk(0x004e4942, pad(bin, 0))]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + body.length, 8);
mkdirSync('public/models', { recursive: true });
writeFileSync(OUT, Buffer.concat([header, body]));
console.log(`${OUT}: ${12 + body.length} bytes`);
