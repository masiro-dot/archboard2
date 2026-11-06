# ArchBoard Exporter — Blender add-on (Phase 0)
#
# Blender のシーンを ArchBoard（ブラウザのプレゼン編集アプリ）用に書き出す。
#   model.glb      … 軽量 3D モデル（形状は一切変更しない。モディファイアは適用した見た目で出力）
#   manifest.json  … オブジェクト一覧・カメラ・形状ハッシュ（改変／変更検知用）
#
# 座標は Blender のまま（Z 上向き・メートル）で manifest に記録する。

bl_info = {
    "name": "ArchBoard Exporter",
    "author": "ArchBoard Phase 0",
    "version": (0, 1, 0),
    "blender": (4, 2, 0),
    "location": "3Dビューポート > サイドバー(N) > ArchBoard",
    "description": "建築プレゼン用に glTF とマニフェスト（カメラ・形状ハッシュ）を書き出す",
    "category": "Import-Export",
}

import bpy
import bmesh
import hashlib
import json
import math
import os
import re
from datetime import datetime
from mathutils import Vector, Matrix

MANIFEST_FORMAT = "archboard-manifest"
MANIFEST_VERSION = 1
QUANT = 10000  # 0.1mm 単位で量子化してハッシュ化する
NAME_RULE = re.compile(r"^[A-Z]{2,6}_[A-Za-z0-9]+(_[A-Za-z0-9\-]+)*$")

CATEGORY_LABELS = {
    "SLAB": "床スラブ", "WALL": "壁", "COL": "柱", "BEAM": "梁", "ROOF": "屋根",
    "WIN": "窓・ガラス", "DOOR": "扉", "STAIR": "階段", "RAIL": "手摺",
    "LAND": "敷地・外構", "TREE": "樹木", "CTX": "周辺建物", "FURN": "家具",
}


# ---------------------------------------------------------------------------
# 形状ハッシュ
# ---------------------------------------------------------------------------

def object_geometry_hash(obj, depsgraph):
    """評価後メッシュ（モディファイア適用後）のワールド座標と面構成から SHA-256 を計算する。"""
    eval_obj = obj.evaluated_get(depsgraph)
    mesh = eval_obj.to_mesh()
    try:
        mw = obj.matrix_world
        h = hashlib.sha256()
        coords = []
        for v in mesh.vertices:
            w = mw @ v.co
            q = (round(w.x * QUANT), round(w.y * QUANT), round(w.z * QUANT))
            coords.append(q)
            h.update(("%d,%d,%d;" % q).encode())
        h.update(b"|")
        for p in mesh.polygons:
            h.update((",".join(str(i) for i in p.vertices) + ";").encode())
        if coords:
            mn = [min(c[i] for c in coords) / QUANT for i in range(3)]
            mx = [max(c[i] for c in coords) / QUANT for i in range(3)]
        else:
            mn = mx = [0.0, 0.0, 0.0]
        return h.hexdigest(), len(mesh.vertices), len(mesh.polygons), mn, mx
    finally:
        eval_obj.to_mesh_clear()


def camera_record(cam_obj, scene):
    cam = cam_obj.data
    mw = cam_obj.matrix_world
    pos = mw.translation
    forward = (mw.to_3x3() @ Vector((0, 0, -1))).normalized()
    up = (mw.to_3x3() @ Vector((0, 1, 0))).normalized()
    dist = max(5.0, (Vector((0, 0, 0)) - pos).length * 0.8)
    target = pos + forward * dist
    rx, ry = scene.render.resolution_x, scene.render.resolution_y
    aspect = rx / ry if ry else 1.0
    rec = {
        "name": cam_obj.name,
        "label": cam_obj.get("label_ja", cam_obj.name),
        "type": "orthographic" if cam.type == "ORTHO" else "perspective",
        "position": [round(c, 5) for c in pos],
        "target": [round(c, 5) for c in target],
        "up": [round(c, 5) for c in up],
        "renderAspect": round(aspect, 5),
    }
    if cam.type == "ORTHO":
        rec["orthoScale"] = cam.ortho_scale  # 長辺方向の表示幅（m）
    else:
        # 水平画角（ラジアン → 度）。sensor_fit=AUTO の横長画面を想定
        sensor = cam.sensor_width if cam.sensor_fit in ("AUTO", "HORIZONTAL") else cam.sensor_height * aspect
        hfov = 2 * math.atan(sensor / (2 * cam.lens))
        rec["hfov"] = round(math.degrees(hfov), 5)
        rec["lens"] = cam.lens
    return rec


def build_manifest(context, glb_name):
    scene = context.scene
    depsgraph = context.evaluated_depsgraph_get()
    objects, issues = [], []
    for obj in scene.objects:
        if obj.type != "MESH" or not obj.visible_get():
            continue
        digest, nv, nf, mn, mx = object_geometry_hash(obj, depsgraph)
        prefix = obj.name.split("_")[0]
        objects.append({
            "name": obj.name,
            "label": obj.get("label_ja", ""),
            "category": prefix if prefix in CATEGORY_LABELS else "",
            "collection": obj.users_collection[0].name if obj.users_collection else "",
            "hash": digest,
            "vertices": nv,
            "faces": nf,
            "bboxMin": mn,
            "bboxMax": mx,
        })
        if not NAME_RULE.match(obj.name):
            issues.append(obj.name)
    objects.sort(key=lambda o: o["name"])
    total = hashlib.sha256("".join(o["name"] + ":" + o["hash"] + ";" for o in objects).encode()).hexdigest()
    cameras = [camera_record(o, scene) for o in sorted(scene.objects, key=lambda o: o.name)
               if o.type == "CAMERA"]
    return {
        "format": MANIFEST_FORMAT,
        "version": MANIFEST_VERSION,
        "exportedAt": datetime.now().isoformat(timespec="seconds"),
        "blenderVersion": bpy.app.version_string,
        "sourceFile": os.path.basename(bpy.data.filepath) or "(未保存)",
        "units": "m",
        "upAxis": "Z",
        "model": glb_name,
        "geometryHash": total,
        "objects": objects,
        "cameras": cameras,
        "namingIssues": issues,
        "categories": CATEGORY_LABELS,
    }


# ---------------------------------------------------------------------------
# 書き出し
# ---------------------------------------------------------------------------

def resolve_dir(scene):
    raw = scene.archboard_export_dir or "//archboard/"
    path = bpy.path.abspath(raw)
    if raw.startswith("//") and not bpy.data.filepath:
        return None
    return os.path.normpath(path)


def export_archboard(context, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    glb_name = "model.glb"
    glb_path = os.path.join(out_dir, glb_name)
    bpy.ops.export_scene.gltf(
        filepath=glb_path,
        export_format="GLB",
        use_visible=True,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
        export_apply=True,
        export_yup=True,
        export_animations=False,
        export_materials="EXPORT",
    )
    manifest = build_manifest(context, glb_name)
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    return manifest


class ARCHBOARD_OT_export(bpy.types.Operator):
    bl_idname = "archboard.export"
    bl_label = "ArchBoard 用に書き出し"
    bl_description = "model.glb と manifest.json を書き出します（形状は変更しません）"

    def execute(self, context):
        out_dir = resolve_dir(context.scene)
        if out_dir is None:
            self.report({"ERROR"}, "先に .blend を保存するか、書き出し先に絶対パスを指定してください")
            return {"CANCELLED"}
        manifest = export_archboard(context, out_dir)
        msg = "書き出し完了: %d オブジェクト / %d カメラ → %s" % (
            len(manifest["objects"]), len(manifest["cameras"]), out_dir)
        if manifest["namingIssues"]:
            msg += "（命名ルール外: %d 件）" % len(manifest["namingIssues"])
            self.report({"WARNING"}, msg)
        else:
            self.report({"INFO"}, msg)
        context.scene.archboard_last_hash = manifest["geometryHash"][:12]
        return {"FINISHED"}


# ---------------------------------------------------------------------------
# サンプル建物（架空）
# ---------------------------------------------------------------------------

def _material(name, color, alpha=1.0, rough=0.6, metal=0.0):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (*color, 1.0)
        bsdf.inputs["Roughness"].default_value = rough
        bsdf.inputs["Metallic"].default_value = metal
        bsdf.inputs["Alpha"].default_value = alpha
    mat.diffuse_color = (*color, alpha)
    if alpha < 1.0 and hasattr(mat, "surface_render_method"):
        mat.surface_render_method = "BLENDED"
    return mat


def _collection(name, parent):
    col = bpy.data.collections.get(name)
    if col is None:
        col = bpy.data.collections.new(name)
        parent.children.link(col)
    return col


def _boxes(name, col, boxes, mat, label):
    """boxes: [((x0,y0,z0),(x1,y1,z1)), ...] の直方体をまとめて 1 オブジェクトにする（原点は最初の箱の中心）"""
    bm = bmesh.new()
    (a0, a1) = boxes[0]
    origin = Vector(((a0[0] + a1[0]) / 2, (a0[1] + a1[1]) / 2, a0[2]))
    for (p0, p1) in boxes:
        size = Vector((p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]))
        center = Vector(((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2)) - origin
        m = Matrix.Translation(center) @ Matrix.Diagonal((size.x, size.y, size.z, 1.0))
        bmesh.ops.create_cube(bm, size=1.0, matrix=m)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    obj.location = origin
    me.materials.append(mat)
    obj["label_ja"] = label
    col.objects.link(obj)
    return obj


def _wall(axis, fixed, a0, a1, z0, z1, t, openings):
    """壁を開口付きの直方体群に分割する。axis='x' は x 方向に伸びる壁（y=fixed）。
    openings: [(start, end, sill, head), ...]"""
    boxes = []
    cur = a0
    for (s, e, sill, head) in sorted(openings):
        if s > cur:
            boxes.append((cur, s, z0, z1))
        if sill > z0:
            boxes.append((s, e, z0, sill))
        if head < z1:
            boxes.append((s, e, head, z1))
        cur = e
    if cur < a1:
        boxes.append((cur, a1, z0, z1))
    out = []
    for (s, e, b, h) in boxes:
        if axis == "x":
            out.append(((s, fixed - t / 2, b), (e, fixed + t / 2, h)))
        else:
            out.append(((fixed - t / 2, s, b), (fixed + t / 2, e, h)))
    return out


def build_sample(context):
    scene = context.scene
    # 既存のサンプルを消す
    for name in ("AB_構造", "AB_外皮", "AB_開口", "AB_外構", "AB_周辺"):
        col = bpy.data.collections.get(name)
        if col:
            for o in list(col.objects):
                bpy.data.objects.remove(o, do_unlink=True)
            bpy.data.collections.remove(col)
    for o in list(scene.objects):
        if o.name.startswith("CAM_"):
            bpy.data.objects.remove(o, do_unlink=True)

    root = scene.collection
    c_str = _collection("AB_構造", root)
    c_env = _collection("AB_外皮", root)
    c_opn = _collection("AB_開口", root)
    c_ext = _collection("AB_外構", root)
    c_ctx = _collection("AB_周辺", root)

    concrete = _material("MAT_Concrete", (0.72, 0.71, 0.69), rough=0.8)
    wood = _material("MAT_WoodCladding", (0.42, 0.29, 0.19), rough=0.7)
    glass = _material("MAT_Glass", (0.55, 0.70, 0.78), alpha=0.28, rough=0.05)
    steel = _material("MAT_Steel", (0.18, 0.18, 0.19), rough=0.4, metal=0.8)
    ground = _material("MAT_Ground", (0.46, 0.52, 0.38), rough=0.95)
    road = _material("MAT_Road", (0.30, 0.30, 0.31), rough=0.9)
    paving = _material("MAT_Paving", (0.62, 0.60, 0.56), rough=0.85)
    ctx = _material("MAT_Context", (0.86, 0.86, 0.85), rough=0.9)
    tree = _material("MAT_TreeCrown", (0.30, 0.42, 0.26), rough=0.9)
    trunk = _material("MAT_TreeTrunk", (0.30, 0.22, 0.16), rough=0.9)

    # --- 敷地・外構
    _boxes("LAND_Site", c_ext, [((-25, -20, -0.10), (25, 20, 0.0))], ground, "敷地")
    _boxes("LAND_Road", c_ext, [((-25, -20, 0.0), (25, -13, 0.02))], road, "前面道路（幅員7m）")
    _boxes("LAND_Approach", c_ext, [((-9.5, -13, 0.0), (-8.0, -1.0, 0.03)),
                                    ((-9.5, -1.0, 0.0), (-6.0, 0.6, 0.03))], paving, "アプローチ")
    _boxes("LAND_Deck", c_ext, [((-6.0, -6.2, 0.0), (6.0, -4.0, 0.25))], wood, "南側ウッドデッキ")

    FL1, H1 = 0.3, 3.3    # 1F 床上端 / 2F 床スラブ下端
    FL2, H2 = 3.6, 6.4    # 2F 床上端 / 屋根スラブ下端
    T = 0.2

    # --- スラブ
    _boxes("SLAB_1F", c_str, [((-6, -4, 0.0), (6, 4, FL1))], concrete, "1階床スラブ")
    # 2F 床（階段開口 x:-1..3, y:2.8..3.8 を抜く）。東へ 3m キャンチレバー
    _boxes("SLAB_2F", c_str, [
        ((-6, -4, H1), (9, 2.8, FL2)),
        ((-6, 2.8, H1), (-1, 4, FL2)),
        ((3, 2.8, H1), (9, 4, FL2)),
        ((-1, 3.8, H1), (3, 4, FL2)),
    ], concrete, "2階床スラブ（東側3mキャンチレバー）")
    _boxes("ROOF_Main", c_str, [((-2.3, -4.6, H2), (9.3, 4.3, H2 + 0.3))], concrete, "屋根スラブ（南側庇600）")
    _boxes("ROOF_Entrance", c_str, [((-8.4, -0.9, 2.6), (-6, 1.3, 2.75))], steel, "玄関庇")

    # --- 柱（1F 南面）
    for i, x in enumerate((-4.0, 0.0, 4.0), start=1):
        _boxes("COL_1F_%02d" % i, c_str, [((x - 0.075, -3.95, FL1), (x + 0.075, -3.8, H1))], steel,
               "1階 南面スチール柱 %d" % i)

    # --- 1F 外壁（南面は全面ガラス）
    _boxes("WALL_1F_N", c_env, _wall("x", 3.9, -6, 6, FL1, H1, T, [(-4.5, -2.5, 1.1, 2.4), (3.5, 5.0, 1.8, 2.4)]),
           concrete, "1階 北面外壁（RC打放し）")
    _boxes("WALL_1F_E", c_env, _wall("y", 5.9, -4, 3.8, FL1, H1, T, [(-2.0, 0.5, 0.9, 2.4)]),
           concrete, "1階 東面外壁")
    _boxes("WALL_1F_W", c_env, _wall("y", -5.9, -4, 3.8, FL1, H1, T, [(-0.6, 0.6, FL1, 2.5)]),
           concrete, "1階 西面外壁（玄関）")
    _boxes("WALL_1F_INT01", c_env, [((4.4, -1.0, FL1), (4.5, 3.8, H1))], concrete, "1階 間仕切壁（水回り）")
    _boxes("WIN_1F_S", c_opn, [((-6, -4.0, FL1), (6, -3.97, H1))], glass, "1階 南面ガラスカーテンウォール")
    _boxes("WIN_1F_N01", c_opn, [((-4.5, 3.89, 1.1), (-2.5, 3.91, 2.4))], glass, "1階 北面窓")
    _boxes("WIN_1F_E01", c_opn, [((5.89, -2.0, 0.9), (5.91, 0.5, 2.4))], glass, "1階 東面窓")
    _boxes("DOOR_1F_Entrance", c_opn, [((-5.95, -0.6, FL1), (-5.85, 0.6, 2.5))], wood, "玄関扉")

    # --- 2F 外壁（木製サイディング）
    _boxes("WALL_2F_S", c_env, _wall("x", -3.4, -2, 9, FL2, H2, T, [(-1.0, 8.0, 4.4, 5.9)]),
           wood, "2階 南面外壁（横連窓）")
    _boxes("WALL_2F_N", c_env, _wall("x", 3.9, -2, 9, FL2, H2, T, [(6.0, 7.5, 4.6, 5.9)]),
           wood, "2階 北面外壁")
    _boxes("WALL_2F_E", c_env, _wall("y", 8.9, -3.3, 3.8, FL2, H2, T, [(-2.5, 3.0, 4.0, 6.0)]),
           wood, "2階 東面外壁（ピクチャーウィンドウ）")
    _boxes("WALL_2F_W", c_env, [((-2.0, -3.5, FL2), (-1.8, 4.0, H2))], wood, "2階 西面外壁")
    _boxes("WIN_2F_S", c_opn, [((-1.0, -3.41, 4.4), (8.0, -3.39, 5.9))], glass, "2階 南面横連窓")
    _boxes("WIN_2F_E", c_opn, [((8.89, -2.5, 4.0), (8.91, 3.0, 6.0))], glass, "2階 東面ピクチャーウィンドウ")
    _boxes("WIN_2F_N01", c_opn, [((6.0, 3.89, 4.6), (7.5, 3.91, 5.9))], glass, "2階 北面窓")

    # --- 屋上テラス（1F 屋根の西側）ガラス手摺
    _boxes("RAIL_2F_Terrace", c_opn, [((-6, -4, FL2), (-1.8, -3.97, FL2 + 1.1)),
                                      ((-6, -4, FL2), (-5.97, 4, FL2 + 1.1)),
                                      ((-6, 3.97, FL2), (-1.8, 4, FL2 + 1.1))], glass, "2階テラス ガラス手摺 H1100")

    # --- 階段（1F→2F、16 段）
    steps = []
    rise = (FL2 - FL1) / 16
    for i in range(16):
        x0 = -1.0 + i * 0.25
        steps.append(((x0, 2.8, FL1 + i * rise), (x0 + 0.25, 3.8, FL1 + (i + 1) * rise)))
    _boxes("STAIR_1F_2F", c_str, steps, wood, "階段（1階→2階 16段）")

    # --- 樹木
    tree_pos = [(-12, -8, 6.5), (15.5, 1.0, 5.5), (13, 6, 7.0), (-13, 7, 6.0), (-3, -10, 4.5)]
    for i, (x, y, h) in enumerate(tree_pos, start=1):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=10, radius1=0.15, radius2=0.12, depth=h * 0.45,
                              matrix=Matrix.Translation((0, 0, h * 0.225)))
        me = bpy.data.meshes.new("TREE_%02d_trunk" % i)
        bm.to_mesh(me); bm.free()
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=2, radius=h * 0.32,
                                   matrix=Matrix.Translation((0, 0, h * 0.68)) @ Matrix.Diagonal((1, 1, 1.15, 1)))
        me2 = bpy.data.meshes.new("TREE_%02d" % i)
        bm.to_mesh(me2); bm.free()
        o = bpy.data.objects.new("TREE_%02d" % i, me2)
        o.location = (x, y, 0)
        me2.materials.append(tree)
        o["label_ja"] = "樹木 %d（H%.1fm）" % (i, h)
        c_ext.objects.link(o)
        t = bpy.data.objects.new("TREE_%02d_Trunk" % i, me)
        t.location = (x, y, 0)
        me.materials.append(trunk)
        t["label_ja"] = "樹木 %d 幹" % i
        c_ext.objects.link(t)

    # --- 周辺建物
    _boxes("CTX_North01", c_ctx, [((-14, 10, 0), (-2, 19, 7.5))], ctx, "隣地建物（北）")
    _boxes("CTX_North02", c_ctx, [((2, 11, 0), (16, 19, 9.0))], ctx, "隣地建物（北東）")
    _boxes("CTX_West01", c_ctx, [((-24, -6, 0), (-16, 6, 6.0))], ctx, "隣地建物（西）")

    # --- カメラ
    def add_cam(name, label, loc, look, lens=None, ortho=None):
        cd = bpy.data.cameras.new(name)
        if ortho:
            cd.type = "ORTHO"
            cd.ortho_scale = ortho
        else:
            cd.lens = lens
        co = bpy.data.objects.new(name, cd)
        co.location = loc
        d = Vector(look) - Vector(loc)
        co.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        co["label_ja"] = label
        root.objects.link(co)
        return co

    add_cam("CAM_01_SE", "南東からの外観", (17.0, -18.5, 1.6), (1.5, 0, 3.0), lens=28)
    add_cam("CAM_02_Aerial", "南西からの鳥瞰", (-20.0, -24.0, 22.0), (1.5, 0, 2.0), lens=35)
    add_cam("CAM_03_Plan", "平面（真上）", (1.5, 0, 40.0), (1.5, 0.001, 0), ortho=24)

    scene.render.resolution_x = 4961   # A3 横 300dpi
    scene.render.resolution_y = 3508
    scene.camera = bpy.data.objects["CAM_01_SE"]
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0


class ARCHBOARD_OT_sample(bpy.types.Operator):
    bl_idname = "archboard.build_sample"
    bl_label = "サンプル建物を生成"
    bl_description = "動作確認用の架空の住宅モデルとカメラを作成します（既存の AB_ コレクションは置き換え）"

    def execute(self, context):
        build_sample(context)
        self.report({"INFO"}, "サンプル建物を生成しました")
        return {"FINISHED"}


# ---------------------------------------------------------------------------
# UI
# ---------------------------------------------------------------------------

class ARCHBOARD_PT_panel(bpy.types.Panel):
    bl_label = "ArchBoard"
    bl_idname = "ARCHBOARD_PT_panel"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "ArchBoard"

    def draw(self, context):
        sc = context.scene
        col = self.layout.column(align=True)
        col.label(text="書き出し先フォルダ")
        col.prop(sc, "archboard_export_dir", text="")
        self.layout.operator("archboard.export", icon="EXPORT")
        if sc.archboard_last_hash:
            self.layout.label(text="形状ハッシュ: " + sc.archboard_last_hash)
        box = self.layout.box()
        box.label(text="命名ルール: 種別_階_名前")
        box.label(text="例) WALL_1F_N / WIN_2F_S / SLAB_2F")
        self.layout.separator()
        self.layout.operator("archboard.build_sample", icon="HOME")


CLASSES = (ARCHBOARD_OT_export, ARCHBOARD_OT_sample, ARCHBOARD_PT_panel)


def register():
    for c in CLASSES:
        bpy.utils.register_class(c)
    bpy.types.Scene.archboard_export_dir = bpy.props.StringProperty(
        name="書き出し先", subtype="DIR_PATH", default="//archboard/")
    bpy.types.Scene.archboard_last_hash = bpy.props.StringProperty(default="")


def unregister():
    for c in reversed(CLASSES):
        bpy.utils.unregister_class(c)
    del bpy.types.Scene.archboard_export_dir
    del bpy.types.Scene.archboard_last_hash
