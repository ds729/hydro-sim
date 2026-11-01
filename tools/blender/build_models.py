# 静的な大物の .glb を Blender で作る（制御盤・養液タンク・補助ラック）
# blender -b --factory-startup --python tools/blender/build_models.py  → public/models/<名前>.glb
#
# 制作ルール（docs/visual-style.md）
# - 単位はメートル、原点は接地面の中心。座標は three.js と同じ Y-up（x 右・y 上・z 手前）で書き、V() で Blender の Z-up に直す
# - 色は 256px のパレットテクスチャ1枚（16px のマス × 16×16）。面ごとに UV をマスの中心に置く（PALETTE に sRGB の16進で並べる）
# - 角は小さく面取り（bevel、1段）。法線は面ごと（フラットシェーディング）
# - AO は Cycles で頂点カラー（面の角ごと）に焼き込む。床と壁の板を置いて焼き、板は書き出さない
# - 圧縮は Blender の glTF 出力の meshopt（gltf-transform は使わない）
# - コードから触る部品は別の物体にして名前を付ける（lamp_ec・lamp_ph・lamp_wt・pump_led）。静的な部品は1つの物体にまとめる（draw call を減らす）
import math
import os

import bmesh
import bpy
from mathutils import Matrix, Vector

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'public', 'models')

# パレット（sRGB）。手続き生成側（diorama.ts）と同じ値を使う色は名前を揃える
PALETTE = {
    'body': 0xe9e4da,      # 機器の生成り
    'body2': 0xd3cdc0,     # 扉・一段暗い生成り
    'trim': 0x8a949c,      # 取っ手・蝶番・金具
    'metal': 0xa9b3bb,     # 支柱・配管
    'dark': 0x3d4a55,      # ポンプ・台座
    'black': 0x2b3138,     # ゴム・ケーブル口
    'plate': 0xfdfbf5,     # 銘板・ラベル
    'red': 0xd9534f,       # 非常停止
    'yellow': 0xf2c230,    # 非常停止の台・注意表示
    'tank': 0x6f9cc4,      # 養液タンク
    'tank2': 0x4a7398,     # タンクの蓋・帯
    'sight': 0xbfe6ea,     # 液面計（透明の管の代わり）
    'liquid': 0x5cc0c8,    # 液面計の中の養液
    'shelf': 0xe8eef2,     # ラックの棚板
    'tray': 0xf4ecd8,      # トレイ
    'mat': 0x857b6e,       # 培地マット
    'vent': 0xbdb6a8,      # 通気口の溝
    'wood': 0xb38e68,      # 木箱・棚板
    'wood2': 0xa27a55,     # 木箱（暗い方）・桟
    'bag': 0xe6dcc6,       # 肥料袋
    'bandA': 0xd9893f,     # A液の帯
    'bandB': 0x5b8fc4,     # B液の帯
    'bucket': 0xd9dde0,    # バケツ
    'poly': 0xe4ebec,      # ポリ容器・薬剤ボトル
    'cart': 0x5f7f99,      # 台車の荷台
}
NAMES = list(PALETTE)
CELL = 16


def V(x, y, z):
    """three.js の Y-up 座標 → Blender の Z-up 座標"""
    return Vector((x, -z, y))


def make_palette():
    img = bpy.data.images.new('palette', 256, 256, alpha=False)
    px = [0.0] * (256 * 256 * 4)
    for i, name in enumerate(NAMES):
        c = PALETTE[name]
        rgb = ((c >> 16) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255)
        cx, cy = (i % 16) * CELL, (i // 16) * CELL
        for y in range(cy, cy + CELL):
            for x in range(cx, cx + CELL):
                k = (y * 256 + x) * 4
                px[k:k + 4] = [*rgb, 1.0]
    img.pixels = px
    img.file_format = 'PNG'
    return img


def uv_of(name):
    i = NAMES.index(name)
    return ((i % 16 + 0.5) * CELL / 256, (i // 16 + 0.5) * CELL / 256)


def palette_material(img):
    m = bpy.data.materials.new('palette')
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']
    # 手続き生成の mat() と同じ質感：金属でない・粗さ 0.85
    bsdf.inputs['Roughness'].default_value = 0.85
    bsdf.inputs['Metallic'].default_value = 0.0
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    tex.interpolation = 'Closest'
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    return m


def flat_material(name, color, emissive=None, strength=0.9):
    """パレットを使わない単色（発光する LED・コードが差し替えるランプ）"""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes['Principled BSDF']
    lin = [((c / 255 + 0.055) / 1.055) ** 2.4 if c / 255 > 0.04045 else c / 255 / 12.92 for c in ((color >> 16), (color >> 8) & 255, color & 255)]
    bsdf.inputs['Base Color'].default_value = (*lin, 1)
    bsdf.inputs['Roughness'].default_value = 0.85
    if emissive is not None:
        e = [((c / 255 + 0.055) / 1.055) ** 2.4 for c in ((emissive >> 16), (emissive >> 8) & 255, emissive & 255)]
        bsdf.inputs['Emission Color'].default_value = (*e, 1)
        bsdf.inputs['Emission Strength'].default_value = strength
    return m


class Part:
    """1つの物体にまとめる部品群。形を足すたびに新しい面へ色（UV）を付ける"""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new('UVMap')
        self.done = set()

    def _paint(self, color):
        for f in self.bm.faces:
            if f not in self.done:
                f.smooth = False
                for loop in f.loops:
                    loop[self.uv].uv = uv_of(color)
                self.done.add(f)

    def _bevel(self, verts, bevel):
        if bevel <= 0:
            return
        edges = list({e for v in verts for e in v.link_edges})
        bmesh.ops.bevel(self.bm, geom=edges + list(verts), offset=bevel, segments=1, affect='EDGES', profile=0.5, clamp_overlap=True)

    def box(self, w, h, d, x, y, z, color, bevel=0.01, ry=0.0):
        """幅 w（x）・高さ h（y）・奥行き d（z）の箱。中心 (x, y, z)、Y 軸回りに ry"""
        m = Matrix.Translation(V(x, y, z)) @ Matrix.Rotation(ry, 4, 'Z') @ Matrix.Diagonal((w, d, h, 1))
        verts = bmesh.ops.create_cube(self.bm, size=1, matrix=m)['verts']
        self._bevel(verts, min(bevel, w / 3, h / 3, d / 3))
        self._paint(color)

    def cyl(self, r, length, x, y, z, color, axis='y', seg=12, r2=None, bevel=0.0):
        """円柱（r2 で上端の半径を変えると円錐台）。axis は three の軸（y：縦、x・z：横）。中心 (x, y, z)"""
        rot = {'y': Matrix.Identity(4), 'x': Matrix.Rotation(math.pi / 2, 4, 'Y'), 'z': Matrix.Rotation(math.pi / 2, 4, 'X')}[axis]
        m = Matrix.Translation(V(x, y, z)) @ rot
        verts = bmesh.ops.create_cone(self.bm, cap_ends=True, segments=seg, radius1=r, radius2=r if r2 is None else r2, depth=length, matrix=m)['verts']
        self._bevel(verts, bevel)
        self._paint(color)

    def sphere(self, r, x, y, z, color, sub=1):
        verts = bmesh.ops.create_icosphere(self.bm, subdivisions=sub, radius=r, matrix=Matrix.Translation(V(x, y, z)))['verts']
        self._paint(color)

    def tube(self, points, r, color, seg=8):
        """折れ線に沿った管（区間ごとの円柱。継ぎ目に球を置いて角を埋める）"""
        for a, b in zip(points, points[1:]):
            pa, pb = V(*a), V(*b)
            d = pb - pa
            rot = d.to_track_quat('Z', 'Y').to_matrix().to_4x4()
            m = Matrix.Translation((pa + pb) / 2) @ rot
            bmesh.ops.create_cone(self.bm, cap_ends=True, segments=seg, radius1=r, radius2=r, depth=d.length, matrix=m)
        for p in points[1:-1]:
            bmesh.ops.create_icosphere(self.bm, subdivisions=1, radius=r, matrix=Matrix.Translation(V(*p)))
        self._paint(color)

    def to_object(self, material, collection):
        me = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(me)
        self.bm.free()
        me.materials.append(material)
        ob = bpy.data.objects.new(self.name, me)
        collection.objects.link(ob)
        return ob


def solid(name, collection, material, build):
    """パレットを使わない単色の物体（LED・ランプ）。build(part) で形を作る"""
    p = Part(name)
    build(p)
    return p.to_object(material, collection)


# ---------------------------------------------------------------- 制御盤
def control_panel(col, pal, mats):
    """壁掛けの自立盤。幅 1.3（z）× 高さ 2.1 × 奥行き 0.5（x）。正面は +x。部屋の (-4.15, 0, 0.6) に置く"""
    p = Part('control_panel')
    # 台座（チャンネルベース）と本体
    p.box(0.46, 0.1, 1.26, 0, 0.05, 0, 'dark', 0.01)
    p.box(0.5, 2.0, 1.3, 0, 1.1, 0, 'body', 0.025)
    # 天板の庇
    p.box(0.54, 0.04, 1.34, 0, 2.12, 0, 'body', 0.012)
    # 扉（正面。1.7 × 1.0）と蝶番・取っ手
    p.box(0.04, 1.72, 1.04, 0.265, 1.12, 0, 'body2', 0.012)
    for y in (0.5, 1.75):
        p.cyl(0.018, 0.09, 0.29, y, -0.53, 'trim', seg=8)
    p.box(0.03, 0.22, 0.04, 0.3, 1.0, 0.43, 'trim', 0.008)
    p.box(0.02, 0.06, 0.06, 0.29, 1.0, 0.43, 'black', 0.005)
    # 状態ランプの台（ランプ本体は lamp_* で別の物体）。左に表示ラベル
    p.box(0.02, 0.62, 0.3, 0.292, 1.55, 0.0, 'dark', 0.008)
    for y in (1.75, 1.55, 1.35):
        p.cyl(0.085, 0.03, 0.305, y, 0.0, 'trim', axis='x', seg=12)
        p.box(0.006, 0.05, 0.16, 0.289, y, -0.28, 'plate', 0)
    # 銘板（扉の上部）
    p.box(0.008, 0.1, 0.42, 0.288, 1.9, 0, 'plate', 0.003)
    # 非常停止（黄色の台に赤いきのこ形）
    p.box(0.02, 0.16, 0.16, 0.293, 1.05, 0.0, 'yellow', 0.01)
    p.cyl(0.035, 0.04, 0.32, 1.05, 0.0, 'red', axis='x', seg=10)
    p.cyl(0.055, 0.035, 0.355, 1.05, 0.0, 'red', axis='x', seg=12)
    # 扉の下の通気口（溝）
    for k in range(5):
        p.box(0.012, 0.018, 0.5, 0.29, 0.36 + k * 0.05, 0, 'vent', 0)
    # 側面の通気口（手前 +z の面）
    for k in range(4):
        p.box(0.28, 0.018, 0.012, 0, 1.6 + k * 0.05, 0.655, 'vent', 0)
    # 足元のケーブル引き込み口（床のケーブルプロテクターの端を覆う。プロテクターは z=-0.35 に来る）
    p.box(0.1, 0.1, 0.22, 0.28, 0.05, -0.35, 'black', 0.01)
    # 天井へ上がる電線管（壁沿い）
    p.box(0.12, 2.4, 0.12, -0.16, 3.32, 0.4, 'metal', 0.01)
    p.box(0.16, 0.06, 0.16, -0.16, 2.17, 0.4, 'trim', 0.01)
    ob = p.to_object(pal, col)
    lamps = []
    for name, y in (('lamp_ec', 1.75), ('lamp_ph', 1.55), ('lamp_wt', 1.35)):
        lamps.append(solid(name, col, mats['lamp'], lambda q, y=y: q.sphere(0.07, 0.29, y, 0, 'body', sub=1)))
    return [ob, *lamps]


# ---------------------------------------------------------------- 養液タンク
def nutrient_tank(col, pal, mats):
    """円筒の養液タンク（直径 0.9・高さ 1.1）と送液ポンプ・配管。部屋の (3.7, 0, 1.0) に置く。
    配管はタンクの下の出口 → ポンプ（部屋の (3.1, 0, 0.2)）→ 立ち上がって栽培槽の右の面（部屋の x=2.62、高さ 0.5）へ"""
    p = Part('nutrient_tank')
    seg = 16
    # 台（4本脚のスキッド）
    p.box(0.86, 0.06, 0.86, 0, 0.03, 0, 'dark', 0.01)
    # 胴（下端と上端に帯）
    p.cyl(0.45, 1.0, 0, 0.6, 0, 'tank', seg=seg)
    p.cyl(0.462, 0.06, 0, 0.13, 0, 'tank2', seg=seg)
    p.cyl(0.462, 0.06, 0, 1.06, 0, 'tank2', seg=seg)
    # 肩と蓋（点検口）
    p.cyl(0.45, 0.06, 0, 1.13, 0, 'tank', seg=seg, r2=0.3)
    p.cyl(0.24, 0.06, 0, 1.19, 0, 'tank2', seg=seg)
    p.cyl(0.05, 0.04, 0.12, 1.24, 0, 'trim', seg=8)
    # 液面計（手前 +z の面に縦の管。中に養液）
    p.box(0.06, 0.82, 0.04, -0.2, 0.62, 0.44, 'trim', 0.008)
    p.box(0.035, 0.74, 0.03, -0.2, 0.62, 0.455, 'sight', 0)
    p.box(0.025, 0.46, 0.02, -0.2, 0.48, 0.468, 'liquid', 0)
    # 銘板（A液・B液を混ぜた養液）
    p.box(0.22, 0.14, 0.01, 0.15, 0.78, 0.452, 'plate', 0.003)
    # ホースの差し込み口（手前右。ホースは手続き生成で部屋の (3.85, 0.15, 1.42) に来る）
    p.cyl(0.035, 0.08, 0.15, 0.15, 0.44, 'trim', axis='z', seg=8)
    # 出口（下・左）→ ポンプ
    pump = (-0.6, -0.8)
    p.tube([(-0.44, 0.2, 0), (-0.6, 0.2, 0), (pump[0], 0.2, pump[1] + 0.2)], 0.045, 'metal')
    p.cyl(0.07, 0.05, -0.47, 0.2, 0, 'trim', axis='x', seg=10)
    # ポンプ（台・モーター・ポンプ部）
    p.box(0.42, 0.04, 0.38, pump[0], 0.02, pump[1], 'black', 0.008)
    p.box(0.4, 0.26, 0.32, pump[0], 0.17, pump[1], 'dark', 0.03)
    p.cyl(0.11, 0.16, pump[0], 0.18, pump[1] + 0.2, 'dark', axis='z', seg=12)
    for k in range(4):
        p.box(0.41, 0.012, 0.25, pump[0], 0.08 + k * 0.05, pump[1] - 0.02, 'trim', 0)
    # ポンプの吐出 → 立ち上がり → 栽培槽の右の面へ（高さ 0.5、z は栽培槽の中心 1.0 - 1.0 = 0）
    p.tube([(pump[0] - 0.2, 0.17, pump[1]), (-0.95, 0.17, pump[1]), (-0.95, 0.5, pump[1]), (-0.95, 0.5, 0), (-1.08, 0.5, 0)], 0.045, 'metal')
    p.cyl(0.07, 0.04, -0.95, 0.5, -0.4, 'trim', axis='z', seg=10)
    # 運転ランプの台座（ランプ本体は pump_led）
    p.box(0.08, 0.02, 0.08, pump[0], 0.31, pump[1], 'trim', 0.004)
    ob = p.to_object(pal, col)
    led = solid('pump_led', col, mats['lamp'], lambda q: q.sphere(0.04, pump[0], 0.34, pump[1], 'body', sub=1))
    return [ob, led]


# ---------------------------------------------------------------- 補助ラック
RACK_SHELVES = (0.5, 1.35, 2.2)


def aux_rack(col, pal, mats):
    """奥の壁沿いの栽培ラック（幅 2.3 × 高さ 2.8 × 奥行き 0.95）。3段で、棚ごとに LED バー。
    苗は手続き生成（diorama.ts）で、トレイのマットの上面（棚の高さ + 0.1）に置く。部屋の (-2.4, 0, -2.8) と (3.2, 0, -2.8) に置く"""
    p = Part('aux_rack')
    for i in (-1, 1):
        for j in (-1, 1):
            # 角パイプの支柱とアジャスタの足
            p.box(0.07, 2.76, 0.07, i * 1.1, 1.42, j * 0.42, 'metal', 0.012)
            p.cyl(0.045, 0.04, i * 1.1, 0.02, j * 0.42, 'black', seg=8)
        # 側面の筋交い（奥行き方向の横桟）
        for y in (0.2, 2.75):
            p.box(0.04, 0.04, 0.84, i * 1.1, y, 0, 'metal', 0.006)
    # 背面の横桟
    p.box(2.14, 0.04, 0.04, 0, 2.75, -0.42, 'metal', 0.006)
    for y in RACK_SHELVES:
        # 棚板（縁を立てる）・トレイ（縁つき）・マット・棚札
        p.box(2.3, 0.04, 0.95, 0, y - 0.01, 0, 'shelf', 0.008)
        for z in (-0.46, 0.46):
            p.box(2.3, 0.06, 0.03, 0, y, z, 'shelf', 0.006)
        # 棚板の上面が y + 0.01、マットの上面が y + 0.1（苗の根元）
        p.box(2.1, 0.02, 0.8, 0, y + 0.02, 0, 'tray', 0.005)
        for z in (-0.39, 0.39):
            p.box(2.1, 0.08, 0.02, 0, y + 0.05, z, 'tray', 0.005)
        for x in (-1.04, 1.04):
            p.box(0.02, 0.08, 0.8, x, y + 0.05, 0, 'tray', 0.005)
        p.box(1.9, 0.07, 0.6, 0, y + 0.065, 0, 'mat', 0.004)
        p.box(0.16, 0.06, 0.01, -0.8, y, 0.48, 'plate', 0.002)
        # LED バーの吊り金具
        for x in (-0.9, 0.9):
            p.box(0.02, 0.1, 0.02, x, y + 0.65, 0, 'trim', 0)
    # LED の電源（右の支柱）
    p.box(0.08, 0.3, 0.12, 1.16, 1.75, 0.3, 'dark', 0.01)
    ob = p.to_object(pal, col)
    led = solid('rack_led', col, mats['led'], lambda q: [q.box(2.0, 0.05, 0.16, 0, y + 0.575, 0, 'body', 0.008) for y in RACK_SHELVES])
    return [ob, led]


# ---------------------------------------------------------------- 部屋の小物
def room_props(col, pal, mats):
    """部屋に散らばる静的な小物をまとめた1つの物体。例外として原点は部屋の原点（床の中心）で、座標も部屋の座標で書く。
    木箱・バケツ・肥料袋・クリップボード（手続き生成から移した物）と、台車・播種トレイ・消火器・薬剤棚・踏み台・ポリ容器・排水口。
    ホース（管）と計量カップ（半透明）は手続き生成のまま"""
    p = Part('room_props')
    # 木箱（左手前に2段＋1つ）。上下の桟を付ける
    for x, y, z, c in ((-3.2, 0.2, 2.6, 'wood'), (-3.2, 0.6, 2.6, 'wood2'), (-2.4, 0.2, 2.7, 'wood')):
        p.box(0.7, 0.4, 0.5, x, y, z, c, 0.02)
        for dy in (-0.15, 0.15):
            p.box(0.72, 0.05, 0.52, x, y + dy, z, 'wood2' if c == 'wood' else 'wood', 0.01)
    # バケツ（養液タンクの手前）：胴・内側の底・取っ手
    p.cyl(0.13, 0.32, 4.15, 0.16, 2.05, 'bucket', seg=12, r2=0.17)
    p.cyl(0.155, 0.01, 4.15, 0.3, 2.05, 'vent', seg=12)
    p.tube([(4.15 - 0.16, 0.31, 2.05), (4.15 - 0.1, 0.42, 2.05 + 0.06), (4.15, 0.45, 2.05 + 0.1), (4.15 + 0.1, 0.42, 2.05 + 0.06), (4.15 + 0.16, 0.31, 2.05)], 0.008, 'trim', seg=5)
    # 肥料袋（左の壁際に2袋。帯の色で A液・B液を見分ける）。角を大きく丸めて袋らしく
    for y, z, ry, band in ((0.08, 1.85, 0, 'bandA'), (0.23, 1.9, 0.12, 'bandB')):
        p.box(0.4, 0.15, 0.6, -4.15, y, z, 'bag', 0.04, ry=ry)
        p.box(0.405, 0.152, 0.12, -4.15, y, z, band, 0.03, ry=ry)
    # 栽培日誌のクリップボード（左の壁、制御盤の手前）：板・紙・留め金
    p.box(0.02, 0.4, 0.3, -4.39, 1.55, 1.75, 'wood', 0.005)
    p.box(0.006, 0.32, 0.25, -4.377, 1.53, 1.75, 'plate', 0)
    p.box(0.03, 0.04, 0.1, -4.37, 1.74, 1.75, 'metal', 0.005)
    # 台車（制御盤と栽培槽の間）に播種トレイ（黒）を2山と種の袋
    cx, cz, ry = -2.65, 1.45, 0.15
    rot = lambda dx, dz: (cx + dx * math.cos(ry) + dz * math.sin(ry), cz - dx * math.sin(ry) + dz * math.cos(ry))
    x, z = rot(0, 0)
    p.box(1.0, 0.05, 0.6, x, 0.14, z, 'cart', 0.012, ry=ry)
    for dx in (-0.42, 0.42):
        for dz in (-0.24, 0.24):
            x, z = rot(dx, dz)
            p.box(0.06, 0.05, 0.06, x, 0.1, z, 'trim', 0.005, ry=ry)
            p.cyl(0.045, 0.035, x, 0.045, z, 'black', axis='x', seg=8)
    for dz in (-0.2, 0.2):
        x, z = rot(-0.48, dz)
        p.box(0.03, 0.7, 0.03, x, 0.5, z, 'metal', 0.006, ry=ry)
    x, z = rot(-0.48, 0)
    p.box(0.035, 0.035, 0.44, x, 0.85, z, 'metal', 0.008, ry=ry)
    for k in range(3):
        for dx in (-0.12, 0.3):
            x, z = rot(dx, 0)
            p.box(0.36, 0.05, 0.54, x, 0.19 + k * 0.05, z, 'black', 0.008, ry=ry)
    x, z = rot(0.3, 0.05)
    p.box(0.2, 0.05, 0.14, x, 0.34, z, 'bandA', 0.02, ry=ry + 0.3)
    # 消火器（左手前の隅）と壁の標識
    p.box(0.22, 0.02, 0.22, -4.22, 0.01, 3.3, 'dark', 0.005)
    p.cyl(0.085, 0.42, -4.22, 0.23, 3.3, 'red', seg=12)
    p.cyl(0.085, 0.06, -4.22, 0.47, 3.3, 'red', seg=12, r2=0.04)
    p.box(0.05, 0.06, 0.12, -4.22, 0.52, 3.3, 'black', 0.01)
    p.tube([(-4.22, 0.52, 3.36), (-4.22, 0.45, 3.4), (-4.22, 0.3, 3.4)], 0.012, 'black', seg=5)
    p.box(0.01, 0.24, 0.18, -4.395, 1.25, 3.3, 'red', 0.003)
    p.box(0.004, 0.1, 0.07, -4.39, 1.27, 3.3, 'plate', 0)
    # 薬剤棚（左の壁）：pH ダウン（赤い蓋）・pH アップ（青い蓋）・A液・B液のボトル
    p.box(0.24, 0.03, 0.9, -4.28, 1.25, -1.05, 'wood', 0.006)
    for z in (-1.4, -0.7):
        p.box(0.2, 0.12, 0.03, -4.32, 1.18, z, 'trim', 0.004)
    for z, cap in ((-1.38, 'red'), (-1.18, 'tank2'), (-0.92, 'bandA'), (-0.72, 'bandB')):
        p.cyl(0.05, 0.2, -4.27, 1.365, z, 'poly', seg=10)
        p.cyl(0.025, 0.04, -4.27, 1.485, z, cap, seg=8)
        p.box(0.004, 0.08, 0.06, -4.218, 1.36, z, 'plate', 0, ry=0)
    # 踏み台（右奥、ラックと養液タンクの間）
    p.box(0.45, 0.22, 0.26, 4.05, 0.11, -1.3, 'tank2', 0.02, ry=-0.2)
    p.box(0.45, 0.44, 0.24, 4.05 - 0.05, 0.22, -1.3 - 0.24, 'tank2', 0.02, ry=-0.2)
    # ポリ容器（20L の水。右手前）：胴・注ぎ口・取っ手
    p.box(0.26, 0.38, 0.34, 4.12, 0.19, 2.85, 'poly', 0.04)
    p.cyl(0.035, 0.05, 4.12, 0.4, 2.76, 'tank2', seg=8)
    p.box(0.04, 0.05, 0.16, 4.12, 0.41, 2.92, 'poly', 0.012)
    # 排水口（栽培槽の右手前の床）：枠と格子
    p.box(0.42, 0.012, 0.42, 2.95, 0.006, 2.85, 'trim', 0.004)
    for k in range(5):
        p.box(0.34, 0.014, 0.03, 2.95, 0.007, 2.71 + k * 0.07, 'black', 0)
    return [p.to_object(pal, col)]


# ---------------------------------------------------------------- 焼き込みと書き出し
def bake_ao(ob, strength):
    """物体の AO を面の角ごとの頂点カラーに焼く。strength は暗くする度合い（0〜1）"""
    me = ob.data
    attr = me.color_attributes.new('Color', 'BYTE_COLOR', 'CORNER')
    me.color_attributes.active_color = attr
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.bake(type='AO', target='VERTEX_COLORS')
    # 焼いた AO（白＝開けている）を弱めて、暗い所だけ少し落とす
    for d in attr.data:
        a = d.color[0]
        v = 1 - strength * (1 - a)
        d.color = (v, v, v, 1)


def occluders(col, walls):
    """焼くときだけ置く床と壁（物体の原点からの位置。three の座標で [中心 x, z, 幅, 奥行き] の床、壁は ('x' | 'z', 位置)）"""
    obs = []
    p = Part('floor')
    p.box(12, 0.02, 12, 0, -0.01, 0, 'body', 0)
    for axis, at in walls:
        if axis == 'x':
            p.box(0.02, 6, 12, at, 3, 0, 'body', 0)
        else:
            p.box(12, 6, 0.02, 0, 3, at, 'body', 0)
    obs.append(p.to_object(bpy.data.materials['palette'], col))
    return obs


def export(name, objs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    path = os.path.join(OUT, f'{name}.glb')
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_apply=True,
        export_normals=True, export_texcoords=True, export_materials='EXPORT', export_vertex_color='ACTIVE',
        export_all_vertex_colors=False, export_cameras=False, export_lights=False, export_extras=False,
        # meshopt 圧縮（EXT_meshopt_compression）。読み込み側は models.ts で MeshoptDecoder を設定する
        export_meshopt_compression_enable=True,
    )
    print(f'{path}: {os.path.getsize(path)} bytes, {sum(len(o.data.polygons) for o in objs)} faces')


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = 64
    sc.render.bake.target = 'VERTEX_COLORS'
    world = bpy.data.worlds.new('world')
    sc.world = world
    # AO の届く距離（m）。機器の足元と入隅が暗くなる程度
    world.light_settings.distance = 0.35
    pal = palette_material(make_palette())
    mats = {
        # ランプはコードが状態の色の発光マテリアルに差し替える
        'lamp': flat_material('lamp', 0x5fe09a, emissive=0x5fe09a),
        # LED バー（手続き生成の LED と同じ淡い桃色）
        'led': flat_material('led', 0xffffff, emissive=0xffd2ec),
    }
    os.makedirs(OUT, exist_ok=True)
    # [名前, 作る関数, 焼くときの壁（物体の原点から）]。制御盤は左の壁（背面 x=-0.25）、ラックは奥の壁（背面の 0.13 奥）に付く
    for name, build, walls in (
        ('control_panel', control_panel, [('x', -0.26)]),
        ('nutrient_tank', nutrient_tank, []),
        ('aux_rack', aux_rack, [('z', -0.6)]),
        # 小物は部屋の座標なので、壁も部屋の壁の位置（左 x=-4.4、奥 z=-3.4）
        ('room_props', room_props, [('x', -4.41), ('z', -3.41)]),
    ):
        col = bpy.data.collections.new(name)
        sc.collection.children.link(col)
        objs = build(col, pal, mats)
        occ = occluders(col, walls)
        bake_ao(objs[0], 0.55)
        for o in occ:
            bpy.data.objects.remove(o)
        export(name, objs)
        # 次のモデルの焼き込みに影響しないよう隠す
        col.hide_render = True
        for o in objs:
            o.hide_set(True)


main()
