// 3D ビュー（Three.js）
// モデルは読み取り専用。表示スタイルの切替は「表示用マテリアルの差し替え」だけで行い、
// ジオメトリ（頂点）には一切触れない。

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { PropertyBinding } from 'three';
import { SHEET_W, SHEET_H, SHEET_ASPECT, b2t } from './util.js';

const noRaycast = () => {};

// 補助表示（輪郭線・断面塗り）を除いた、頂点ベースの正確なバウンディングボックス
function preciseBox(node) {
  const box = new THREE.Box3(), v = new THREE.Vector3();
  node.updateMatrixWorld(true);
  node.traverse((m) => {
    if (!m.isMesh || m.userData.abHelper) return;
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) box.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld));
  });
  return box;
}
const GLASSY = new Set(['WIN', 'RAIL']);

export class Viewer {
  constructor(canvas, { onCameraChange } = {}) {
    this.canvas = canvas;
    this.onCameraChange = onCameraChange || (() => {});
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.localClippingEnabled = true;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xffffff);

    this.persp = new THREE.PerspectiveCamera(45, SHEET_ASPECT, 0.1, 3000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 3000);
    this.orthoHeight = 30;
    this.camera = this.persp;
    this.controls = new OrbitControls(this.persp, canvas);
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => { this.dirty = true; this.onCameraChange(); });

    // 光源
    const hemi = new THREE.HemisphereLight(0xffffff, 0xb8b2a8, 1.6);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.4);
    this.sun.position.copy(b2t([22, -26, 34]));
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    const sc = this.sun.shadow.camera;
    sc.left = -40; sc.right = 40; sc.top = 40; sc.bottom = -40; sc.near = 1; sc.far = 150;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // 断面（常に 1 枚。無効時は遠くに置く）
    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);
    this.planes = [this.clipPlane];
    this.sectionOn = false;

    this.styleMats = this._makeStyleMaterials();
    this.lineMat = new LineMaterial({ color: 0x1e1e1e, linewidth: 1, clippingPlanes: this.planes });
    this.lineMatLight = new LineMaterial({ color: 0x6f8794, linewidth: 1, clippingPlanes: this.planes });
    this.capMat = new THREE.MeshBasicMaterial({ color: 0x2a2a2a, side: THREE.BackSide, clippingPlanes: this.planes });
    this.capMatCtx = new THREE.MeshBasicMaterial({ color: 0xb4b2ad, side: THREE.BackSide, clippingPlanes: this.planes });
    this.lineMM = 0.12;

    this.root = null;
    this.meshes = [];
    this.nodeByName = new Map();
    this.style = 'white';
    this.highlights = null;
    this.raycaster = new THREE.Raycaster();
    this.dirty = true;
    this.cssW = 800; this.cssH = 566;

    const loop = () => {
      if (this.dirty) { this.dirty = false; this.renderer.render(this.scene, this.camera); }
      requestAnimationFrame(loop);
    };
    loop();
  }

  _makeStyleMaterials() {
    const P = this.planes;
    const std = (c, extra = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.92, metalness: 0, clippingPlanes: P, ...extra });
    const glass = (c, o) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.1, transparent: true, opacity: o, depthWrite: false, clippingPlanes: P });
    const basic = (c, extra = {}) => new THREE.MeshBasicMaterial({ color: c, clippingPlanes: P, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, ...extra });
    return {
      white: {
        default: std(0xf5f4f1, { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
        LAND: std(0xeceae6, { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
        CTX: std(0xe4e3e0, { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
        TREE: std(0xdfe4dc),
        glass: glass(0xb9d0db, 0.35),
      },
      line: {
        default: basic(0xffffff),
        TREE: basic(0xffffff),
        glass: basic(0xffffff, { transparent: true, opacity: 0.15, depthWrite: false }),
      },
      highlight: {
        changed: std(0xff8a1f, { emissive: 0x6a2c00 }),
        added: std(0x3fae5a, { emissive: 0x0b3a16 }),
      },
    };
  }

  // ------------------------------------------------------------------ モデル
  async loadModel(arrayBuffer, manifest) {
    const gltf = await new Promise((res, rej) => new GLTFLoader().parse(arrayBuffer, '', res, rej));
    if (this.root) this.scene.remove(this.root);
    this.root = gltf.scene;
    this.meshes = [];
    this.nodeByName.clear();

    const info = new Map((manifest.objects || []).map((o) => [o.name, o]));
    for (const [name, o] of info) {
      const node = this.root.getObjectByName(PropertyBinding.sanitizeNodeName(name));
      if (node) { node.userData.abName = name; node.userData.abInfo = o; this.nodeByName.set(name, node); }
    }

    this.root.updateMatrixWorld(true);
    const found = [];
    this.root.traverse((m) => { if (m.isMesh) found.push(m); });
    found.forEach((m) => {
      let n = m;
      while (n && !n.userData.abName) n = n.parent;
      const abName = n ? n.userData.abName : m.name;
      const cat = (abName.split('_')[0] || '').toUpperCase();
      m.userData.abName = abName;
      m.userData.abCat = cat;
      m.userData.origMat = m.material;
      const om = Array.isArray(m.material) ? m.material : [m.material];
      om.forEach((mat) => { mat.clippingPlanes = this.planes; mat.side = THREE.FrontSide; });
      m.castShadow = !GLASSY.has(cat);
      m.receiveShadow = true;

      // 輪郭線（樹木は角度しきい値を上げて線を減らす）
      const eg = new THREE.EdgesGeometry(m.geometry, cat === 'TREE' ? 50 : 25);
      const lg = new LineSegmentsGeometry().fromEdgesGeometry(eg);
      const lines = new LineSegments2(lg, GLASSY.has(cat) ? this.lineMatLight : this.lineMat);
      lines.userData.abHelper = 'edges';
      lines.raycast = noRaycast;
      m.add(lines);

      // 断面の塗り（裏面を暗色で描く）
      if (!GLASSY.has(cat) && cat !== 'TREE') {
        const cap = new THREE.Mesh(m.geometry, cat === 'CTX' ? this.capMatCtx : this.capMat);
        cap.userData.abHelper = 'cap';
        cap.raycast = noRaycast;
        cap.visible = false;
        m.add(cap);
      }
      this.meshes.push(m);
    });
    this.scene.add(this.root);

    // 整合チェック：manifest のバウンディングボックスと読み込んだ形状を照合（許容 2mm）
    const missing = [], mismatch = [];
    for (const [name, o] of info) {
      const node = this.nodeByName.get(name);
      if (!node) { missing.push(name); continue; }
      const box = preciseBox(node);
      const bmin = b2t(o.bboxMin), bmax = b2t(o.bboxMax);
      const exp = new THREE.Box3().setFromPoints([bmin, bmax]);
      const d = Math.max(box.min.distanceTo(exp.min), box.max.distanceTo(exp.max));
      if (!(d < 0.002)) mismatch.push(name);
    }
    this.applyMaterials();
    this.dirty = true;
    return { total: info.size, ok: info.size - missing.length - mismatch.length, missing, mismatch };
  }

  // ------------------------------------------------------------------ 表示
  applyMaterials() {
    for (const m of this.meshes) {
      const cat = m.userData.abCat;
      const hl = this.highlights && this.highlights.get(m.userData.abName);
      let mat;
      if (hl) mat = this.styleMats.highlight[hl];
      else if (this.style === 'material') mat = m.userData.origMat;
      else {
        const set = this.styleMats[this.style] || this.styleMats.white;
        mat = GLASSY.has(cat) ? set.glass : (set[cat] || set.default);
      }
      m.material = mat;
      m.castShadow = !GLASSY.has(cat) && this.style !== 'line';
    }
    this.dirty = true;
  }

  setHighlights(map) { this.highlights = map && map.size ? map : null; this.applyMaterials(); }

  applySheet(sheet) {
    this.style = sheet.style || 'white';
    this.applyMaterials();
    this.setEdges(sheet.edges !== false, sheet.lineMM || 0.12);
    this.sun.castShadow = sheet.shadows !== false && this.style !== 'line';
    this.renderer.shadowMap.needsUpdate = true;
    this.setSection(sheet.section);
    this.setCameraState(sheet.camera);
    this.controls.enabled = !sheet.lockCamera;
    this.dirty = true;
  }

  setEdges(on, lineMM) {
    this.lineMM = lineMM;
    for (const m of this.meshes) for (const c of m.children) if (c.userData.abHelper === 'edges') c.visible = on;
    this._updateLineRes(this.cssW, this.cssH);
    this.dirty = true;
  }

  _updateLineRes(w, h) {
    const px = Math.max(0.6, this.lineMM * (w / SHEET_W));
    for (const lm of [this.lineMat, this.lineMatLight]) { lm.resolution.set(w, h); lm.linewidth = px; }
  }

  // section: { enabled, axis: 'z'|'x'|'y'（Blender 軸）, value（m）, flip }
  setSection(section) {
    const s = section || {};
    this.sectionOn = !!s.enabled;
    if (!this.sectionOn) {
      this.clipPlane.set(new THREE.Vector3(0, -1, 0), 1e6);
    } else {
      const nb = { x: [-1, 0, 0], y: [0, -1, 0], z: [0, 0, -1] }[s.axis || 'z'];
      const sign = s.flip ? -1 : 1;
      const n = b2t(nb.map((v) => v * sign));
      this.clipPlane.set(n, sign * (s.value ?? 1.5));
    }
    for (const m of this.meshes) for (const c of m.children) if (c.userData.abHelper === 'cap') c.visible = this.sectionOn;
    this.dirty = true;
  }

  // ------------------------------------------------------------------ カメラ
  resize(cssW, cssH) {
    this.cssW = cssW; this.cssH = cssH;
    this.renderer.setSize(cssW, cssH, false);
    this.persp.aspect = SHEET_ASPECT; this.persp.updateProjectionMatrix();
    this._updateOrtho();
    this._updateLineRes(cssW, cssH);
    this.dirty = true;
  }

  _updateOrtho() {
    const h = this.orthoHeight / 2, w = h * SHEET_ASPECT;
    Object.assign(this.ortho, { left: -w, right: w, top: h, bottom: -h });
    this.ortho.updateProjectionMatrix();
  }

  setCameraState(c) {
    if (!c) return;
    const cam = c.type === 'orthographic' ? this.ortho : this.persp;
    cam.position.fromArray(c.position);
    cam.up.fromArray(c.up || [0, 1, 0]);
    if (c.type === 'orthographic') {
      this.orthoHeight = c.orthoHeight || 30;
      cam.zoom = c.zoom || 1;
      this._updateOrtho();
    } else {
      cam.fov = c.fov || 45;
      this._applyShift(cam, c.twoPoint ? (c.shift || 0) : 0);
    }
    this.twoPoint = c.type !== 'orthographic' && !!c.twoPoint;
    this.shift = this.twoPoint ? (c.shift || 0) : 0;
    // 2点透視：視線を水平に保ち、回転は水平方向のみ
    this.controls.minPolarAngle = this.twoPoint ? Math.PI / 2 : 0;
    this.controls.maxPolarAngle = this.twoPoint ? Math.PI / 2 : Math.PI;
    this.camera = cam;
    this.controls.object = cam;
    this.controls.target.fromArray(c.target);
    this.controls.update();
    this.dirty = true;
  }

  // 上下シフト（あおり補正）。shift>0 で見上げ側へ画面をずらす
  _applyShift(cam, shift) {
    if (shift) {
      const H = 1000, W = H * SHEET_ASPECT;
      cam.setViewOffset(W, H, 0, -shift * H, W, H);
    } else cam.clearViewOffset();
    cam.updateProjectionMatrix();
  }

  getCameraState() {
    const cam = this.camera;
    const st = {
      type: cam.isOrthographicCamera ? 'orthographic' : 'perspective',
      position: cam.position.toArray().map((v) => +v.toFixed(5)),
      target: this.controls.target.toArray().map((v) => +v.toFixed(5)),
      up: cam.up.toArray().map((v) => +v.toFixed(5)),
    };
    if (cam.isOrthographicCamera) { st.orthoHeight = this.orthoHeight; st.zoom = +cam.zoom.toFixed(6); }
    else {
      st.fov = +cam.fov.toFixed(4);
      if (this.twoPoint) { st.twoPoint = true; st.shift = this.shift; }
    }
    return st;
  }

  // 平行投影時の縮尺 1:N（A3 用紙上）
  getScale() {
    if (!this.camera.isOrthographicCamera) return null;
    return (this.orthoHeight / this.camera.zoom) * 1000 / SHEET_H;
  }

  // ------------------------------------------------------------------ 投影・ピック
  // ワールド座標 → 用紙座標（mm）
  toSheet(world) {
    const v = world.clone().project(this.camera);
    return { x: (v.x + 1) / 2 * SHEET_W, y: (1 - v.y) / 2 * SHEET_H, behind: v.z > 1 || v.z < -1 };
  }

  _visibleByClip(p) { return !this.sectionOn || this.clipPlane.distanceToPoint(p) >= -1e-4; }

  _ndcFromClient(cx, cy) {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  }

  // 画面上の点から部材を拾う。snap=true なら近くの頂点に吸着
  pick(cx, cy, { snap = false } = {}) {
    if (!this.root) return null;
    const ndc = this._ndcFromClient(cx, cy);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.meshes, false)
      .filter((h) => this._visibleByClip(h.point) && h.object.visible);
    if (!hits.length) return null;
    const h = hits[0];
    let point = h.point.clone(), snapped = false;
    if (snap && h.face) {
      const r = this.canvas.getBoundingClientRect();
      const pos = h.object.geometry.attributes.position;
      let best = null, bestD = 14;
      for (const idx of [h.face.a, h.face.b, h.face.c]) {
        const w = new THREE.Vector3().fromBufferAttribute(pos, idx).applyMatrix4(h.object.matrixWorld);
        const s = w.clone().project(this.camera);
        const sx = (s.x + 1) / 2 * r.width + r.left, sy = (1 - s.y) / 2 * r.height + r.top;
        const d = Math.hypot(sx - cx, sy - cy);
        if (d < bestD) { bestD = d; best = w; }
      }
      if (best) { point = best; snapped = true; }
    }
    const name = h.object.userData.abName;
    return { point, name, node: this.nodeByName.get(name) || h.object, snapped };
  }

  // アンカー点が手前の部材に隠れているか（ガラスは除外）
  isOccluded(world) {
    if (!this.root) return false;
    const s = world.clone().project(this.camera);
    if (Math.abs(s.x) > 1.2 || Math.abs(s.y) > 1.2) return false;
    this.raycaster.setFromCamera(new THREE.Vector2(s.x, s.y), this.camera);
    const target = this.raycaster.ray.origin.distanceTo(world);
    const hits = this.raycaster.intersectObjects(this.meshes, false);
    for (const h of hits) {
      if (GLASSY.has(h.object.userData.abCat) || !this._visibleByClip(h.point)) continue;
      return h.distance < target - 0.03;
    }
    return false;
  }

  // ------------------------------------------------------------------ 書き出し
  renderImage(w, h, { background = true } = {}) {
    const prevPR = this.renderer.getPixelRatio();
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this._updateLineRes(w, h);
    const bg = this.scene.background;
    if (!background) this.scene.background = null;
    this.renderer.setClearColor(0xffffff, background ? 1 : 0);
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL('image/png');
    this.scene.background = bg;
    this.renderer.setClearColor(0xffffff, 1);
    this.renderer.setPixelRatio(prevPR);
    this.resize(this.cssW, this.cssH);
    this.renderer.render(this.scene, this.camera);
    return url;
  }
}
