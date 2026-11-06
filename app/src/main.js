// ArchBoard Phase 0 — アプリ本体
import './style.css';
import * as THREE from 'three';
import { Viewer } from './viewer.js';
import { buildOverlay, exportSVG, COLORS } from './overlay.js';
import * as IO from './io.js';
import { loadSampleData, sampleSheets } from './sample.js';
import {
  SHEET_W, SHEET_H, SHEET_ASPECT, PT, b2t, t2b, uid, fmtMM, todayStr, runtimeGeometryHash,
  escapeXML as X, deepClone,
} from './util.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

// ------------------------------------------------------------------ 状態
const S = {
  project: null, manifest: null, dir: null, integrity: null, runtimeHash: null,
  sheetIdx: 0, selectedId: null, tool: 'select', pending: null, hover: null, reanchor: null,
  diff: null, undo: [], redo: [], lastJSON: null, unsaved: false,
};
const sheet = () => S.project && S.project.sheets[S.sheetIdx];
const findAnn = (id) => sheet()?.annotations.find((a) => a.id === id);

// ------------------------------------------------------------------ 3D
const viewer = new Viewer($('#gl'), {
  onCameraChange: () => {
    const sh = sheet();
    if (sh && !sh.lockCamera) sh.camera = viewer.getCameraState();
    drawOverlay();
    if (!S.selectedId) updateCameraReadout();
  },
});
viewer.controls.addEventListener('end', () => commit());

// ------------------------------------------------------------------ 用紙のレイアウト
const stage = $('#stage'), paper = $('#paper'), svg = $('#ov');
function layout() {
  const r = stage.getBoundingClientRect();
  const availW = r.width - 48, availH = r.height - 96;
  let w = availW, h = w / SHEET_ASPECT;
  if (h > availH) { h = availH; w = h * SHEET_ASPECT; }
  w = Math.max(320, Math.floor(w)); h = Math.floor(w / SHEET_ASPECT);
  paper.style.width = w + 'px'; paper.style.height = h + 'px';
  viewer.resize(w, h);
  drawOverlay();
}
new ResizeObserver(layout).observe(stage);

// ------------------------------------------------------------------ アンカー
function makeAnchor(name, worldVec) {
  const node = viewer.nodeByName.get(name);
  const local = node ? node.worldToLocal(worldVec.clone()) : worldVec.clone();
  return { obj: name, local: local.toArray().map((v) => +v.toFixed(5)), world: worldVec.toArray().map((v) => +v.toFixed(5)) };
}
function resolve(anchor) {
  if (!anchor) return null;
  const node = viewer.nodeByName.get(anchor.obj);
  if (node) return { world: node.localToWorld(new THREE.Vector3().fromArray(anchor.local)), ok: true };
  return { world: new THREE.Vector3().fromArray(anchor.world), ok: false };
}
function objLabel(name) {
  const o = viewer.nodeByName.get(name)?.userData.abInfo;
  return o && o.label ? `${name}（${o.label}）` : name;
}

// ------------------------------------------------------------------ 注釈の描画
function overlayCtx(extra = {}) {
  const sh = sheet();
  const sc = viewer.getScale();
  return {
    resolve,
    toSheet: (w) => viewer.toSheet(w),
    isOccluded: (w) => viewer.isOccluded(w),
    selectedId: S.selectedId,
    projectName: S.project?.name || '',
    date: todayStr(),
    scaleText: sc ? `1 : ${Math.round(sc)}（A3）` : '',
    sheetNo: `No.${String(S.sheetIdx + 1).padStart(2, '0')}`,
    hashShort: (S.manifest?.geometryHash || '').slice(0, 8),
    sheetObj: sh,
    ...extra,
  };
}

function previewMarkup() {
  let s = '';
  const hv = S.hover;
  if (hv && S.tool !== 'select' && S.tool !== 'text') {
    const p = viewer.toSheet(hv.point);
    s += hv.snapped
      ? `<rect x="${p.x - 1.3}" y="${p.y - 1.3}" width="2.6" height="2.6" fill="none" stroke="#2b7cff" stroke-width="0.35"/>`
      : `<circle cx="${p.x}" cy="${p.y}" r="1.1" fill="none" stroke="#2b7cff" stroke-width="0.35"/>`;
  }
  if (S.pending && hv) {
    const a = viewer.toSheet(S.pending.point), b = viewer.toSheet(hv.point);
    s += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#2b7cff" stroke-width="0.3" stroke-dasharray="1 0.8"/>`;
    if (S.tool === 'dim') {
      const t = fmtMM(S.pending.point.distanceTo(hv.point));
      s += `<text x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2 - 2}" font-size="3.4" fill="#2b7cff" text-anchor="middle" stroke="#fff" stroke-width="0.8" paint-order="stroke">${t}</text>`;
    }
  }
  return s;
}

let overlayQueued = false;
function drawOverlay() {
  if (overlayQueued) return;
  overlayQueued = true;
  requestAnimationFrame(() => {
    overlayQueued = false;
    const sh = sheet();
    svg.innerHTML = sh ? buildOverlay(sh, overlayCtx({ extra: previewMarkup() })) : '';
  });
}

// ------------------------------------------------------------------ 履歴（元に戻す）
const snapshot = () => JSON.stringify({ name: S.project.name, sheets: S.project.sheets });
function commit() {
  if (!S.project) return;
  const now = snapshot();
  if (now === S.lastJSON) return;
  if (S.lastJSON) { S.undo.push(S.lastJSON); if (S.undo.length > 100) S.undo.shift(); }
  S.redo = [];
  S.lastJSON = now;
  setUnsaved(true);
}
function restore(json) {
  const st = JSON.parse(json);
  S.project.name = st.name;
  S.project.sheets = st.sheets;
  S.lastJSON = json;
  S.sheetIdx = Math.min(S.sheetIdx, S.project.sheets.length - 1);
  if (S.selectedId && !findAnn(S.selectedId)) S.selectedId = null;
  viewer.applySheet(sheet());
  renderAll();
  setUnsaved(true);
}
function undo() { if (S.undo.length) { S.redo.push(snapshot()); restore(S.undo.pop()); } }
function redo() { if (S.redo.length) { S.undo.push(snapshot()); restore(S.redo.pop()); } }
function setUnsaved(v) { S.unsaved = v; $('#btnSave').classList.toggle('attn', v); }

// ------------------------------------------------------------------ カメラ変換
function camFromManifest(c) {
  const position = b2t(c.position).toArray(), target = b2t(c.target).toArray();
  const fwd = b2t(c.target).sub(b2t(c.position)).normalize();
  const up = Math.abs(fwd.y) > 0.99 ? b2t(c.up).toArray() : [0, 1, 0];
  if (c.type === 'orthographic') {
    const aspect = c.renderAspect || SHEET_ASPECT;
    const orthoHeight = aspect >= 1 ? c.orthoScale / SHEET_ASPECT : c.orthoScale;
    return { type: 'orthographic', position, target, up, orthoHeight, zoom: 1 };
  }
  const h = (c.hfov || 50) * Math.PI / 180;
  const fov = 2 * Math.atan(Math.tan(h / 2) / SHEET_ASPECT) * 180 / Math.PI;
  return { type: 'perspective', position, target, up, fov };
}

function fitCamera() {
  const box = new THREE.Box3();
  for (const o of S.manifest.objects) {
    if (o.category === 'LAND' || o.category === 'CTX' || o.category === 'TREE') continue;
    box.expandByPoint(b2t(o.bboxMin)); box.expandByPoint(b2t(o.bboxMax));
  }
  if (box.isEmpty()) box.setFromObject(viewer.root);
  const c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length();
  const pos = c.clone().add(b2t([0.9, -1.1, 0.75]).normalize().multiplyScalar(r * 1.4));
  return { type: 'perspective', position: pos.toArray(), target: c.toArray(), up: [0, 1, 0], fov: 32 };
}

function newSheet(name, camera) {
  return {
    id: uid('s'), name, camera, style: 'white', edges: true, lineMM: 0.12, shadows: true,
    section: { enabled: false, axis: 'z', value: 1.5, flip: false }, lockCamera: false, frame: true, annotations: [],
  };
}

const lensFromFov = (vfov) => 18 / Math.tan(Math.atan(Math.tan(vfov * Math.PI / 360) * SHEET_ASPECT));
const fovFromLens = (lens) => 2 * Math.atan(Math.tan(Math.atan(18 / lens)) / SHEET_ASPECT) * 180 / Math.PI;

function setScale(sh, n) {
  sh.camera.zoom = (sh.camera.orthoHeight * 1000) / (SHEET_H * n);
}

// ------------------------------------------------------------------ 読み込み
async function openData({ manifest, glb, project }, { dir = null, sample = false } = {}) {
  showBusy('モデルを読み込んでいます…');
  try {
    const integrity = await viewer.loadModel(glb, manifest);
    S.manifest = manifest; S.dir = dir; S.integrity = integrity;
    S.runtimeHash = runtimeGeometryHash(viewer.root);
    S.diff = null; viewer.setHighlights(null);
    S.selectedId = null; S.tool = 'select'; S.pending = null;
    let diffResult = null;
    if (project && project.format === 'archboard-project') {
      S.project = project;
      diffResult = diffManifest(project.modelSnapshot, manifest);
    } else {
      S.project = createProject(manifest, sample);
    }
    S.project.modelSnapshot = snapshotOf(manifest);
    S.sheetIdx = 0; S.undo = []; S.redo = []; S.lastJSON = snapshot();
    setUnsaved(!project);
    $('#empty').hidden = true;
    viewer.applySheet(sheet());
    renderAll();
    layout();
    if (diffResult && diffResult.count) showDiff(diffResult, '前回保存したときからモデルが変更されています');
    else toast(sample ? 'サンプルを開きました' : `${manifest.objects.length} 個の部材を読み込みました`);
  } catch (e) {
    console.error(e);
    alertBox('読み込めませんでした', e.user ? e.message : `エラー: ${e.message}`);
  } finally { hideBusy(); }
}

function createProject(manifest, sample) {
  const api = {
    sheetFromCamera: (camName, name) => {
      const c = manifest.cameras.find((x) => x.name === camName);
      return newSheet(name, c ? camFromManifest(c) : fitCamera());
    },
    anchor: (obj, bp) => makeAnchor(obj, b2t(bp)),
    leader: (obj, bp, text, dx, dy) => ({ id: uid(), type: 'leader', anchor: api.anchor(obj, bp), dx, dy, text, size: 9, color: '#1a1a1a', halo: true }),
    arrow: (o1, p1, o2, p2, text, dashed) => ({ id: uid(), type: 'arrow', a: api.anchor(o1, p1), b: api.anchor(o2, p2), text, size: 9, color: '#d9730d', width: 0.7, dashed }),
    dim: (o1, p1, o2, p2, offset, prefix = '') => ({ id: uid(), type: 'dim', a: api.anchor(o1, p1), b: api.anchor(o2, p2), offset, size: 8, color: '#1a1a1a', prefix, suffix: '', halo: true }),
    text: (x, y, text, size, weight = 'normal') => ({ id: uid(), type: 'text', x, y, text, size, weight, color: '#1a1a1a', align: 'start', halo: false }),
    setScale,
  };
  const name = sample ? 'サンプル住宅（架空）' : (manifest.sourceFile || 'プロジェクト').replace(/\.blend$/i, '');
  let sheets;
  if (sample) sheets = sampleSheets(api);
  else if (manifest.cameras.length) sheets = manifest.cameras.map((c, i) => newSheet(`${String(i + 1).padStart(2, '0')} ${c.label || c.name}`, camFromManifest(c)));
  else sheets = [newSheet('01 外観', fitCamera())];
  return { format: 'archboard-project', version: 1, name, created: new Date().toISOString(), sheets };
}

const snapshotOf = (m) => ({
  geometryHash: m.geometryHash, exportedAt: m.exportedAt,
  objects: Object.fromEntries(m.objects.map((o) => [o.name, o.hash])),
});

function diffManifest(prev, cur) {
  const res = { changed: [], added: [], removed: [], count: 0 };
  if (!prev || !prev.objects) return res;
  const now = Object.fromEntries(cur.objects.map((o) => [o.name, o.hash]));
  for (const [n, h] of Object.entries(now)) {
    if (!(n in prev.objects)) res.added.push(n);
    else if (prev.objects[n] !== h) res.changed.push(n);
  }
  for (const n of Object.keys(prev.objects)) if (!(n in now)) res.removed.push(n);
  res.count = res.changed.length + res.added.length + res.removed.length;
  return res;
}

function annotationsTouching(names) {
  const set = new Set(names), hits = [];
  S.project.sheets.forEach((sh) => sh.annotations.forEach((a) => {
    const objs = [a.anchor, a.a, a.b].filter(Boolean).map((x) => x.obj);
    if (objs.some((o) => set.has(o))) hits.push({ sheet: sh.name, a });
  }));
  return hits;
}

function showDiff(d, title) {
  S.diff = d;
  const map = new Map();
  d.changed.forEach((n) => map.set(n, 'changed'));
  d.added.forEach((n) => map.set(n, 'added'));
  viewer.setHighlights(map);
  const list = (arr) => arr.length ? arr.map((n) => `<li>${X(objLabel(n))}</li>`).join('') : '<li class="muted">なし</li>';
  const affected = annotationsTouching([...d.changed, ...d.removed]);
  const affHTML = affected.length
    ? `<h4>確認が必要な注釈（${affected.length}）</h4><ul>${affected.map((x) => `<li>${X(x.sheet)}：${X(annTitle(x.a))}</li>`).join('')}</ul>`
    : '';
  dialog(title, `
    <p>部材ごとの形状ハッシュを比べた結果です。ハイライトは 3D 上で色分けされています。</p>
    <div class="diffcols">
      <div><h4><span class="sw" style="background:#ff8a1f"></span>形状が変わった部材（${d.changed.length}）</h4><ul>${list(d.changed)}</ul></div>
      <div><h4><span class="sw" style="background:#3fae5a"></span>追加された部材（${d.added.length}）</h4><ul>${list(d.added)}</ul></div>
      <div><h4><span class="sw" style="background:#e0245e"></span>削除された部材（${d.removed.length}）</h4><ul>${list(d.removed)}</ul></div>
    </div>${affHTML}
    <p class="muted">削除された部材に付いた注釈は赤く「要確認」と表示されます。付け替えるか削除してください。</p>`,
  [{ label: 'ハイライトを消す', act: () => clearDiff() }, { label: 'ハイライトを残して閉じる', primary: true }]);
  renderAll();
}
function clearDiff() { S.diff = null; viewer.setHighlights(null); renderAll(); }

function annTitle(a) {
  if (a.type === 'dim') return `寸法 ${a.prefix || ''}${fmtMM(resolve(a.a).world.distanceTo(resolve(a.b).world))}`;
  const t = (a.text || '').split('\n')[0] || '（文字なし）';
  return { leader: 'ラベル', arrow: '矢印', text: 'テキスト' }[a.type] + '：' + t;
}

// ------------------------------------------------------------------ 左パネル
function renderSheets() {
  const ul = $('#sheetList');
  ul.innerHTML = S.project.sheets.map((sh, i) => `
    <li class="${i === S.sheetIdx ? 'on' : ''}" data-i="${i}">
      <span class="no">${String(i + 1).padStart(2, '0')}</span>
      <span class="nm">${X(sh.name.replace(/^\d+\s*/, ''))}</span>
      <span class="tags">${sh.camera.type === 'orthographic' ? '<i>平行</i>' : ''}${sh.section?.enabled ? '<i>断面</i>' : ''}</span>
      <span class="ops"><button data-op="up" title="上へ">↑</button><button data-op="dup" title="複製">⧉</button><button data-op="del" title="削除">×</button></span>
    </li>`).join('');
  const cams = S.manifest.cameras;
  $('#camList').innerHTML = cams.length
    ? cams.map((c, i) => `<li data-c="${i}"><span>${X(c.label || c.name)}</span><small>${c.type === 'orthographic' ? '平行投影' : `${Math.round(c.lens || 0)}mm`}</small></li>`).join('')
    : '<li class="muted">Blender にカメラがありません</li>';
}

$('#sheetList').addEventListener('click', (e) => {
  const li = e.target.closest('li'); if (!li) return;
  const i = +li.dataset.i, op = e.target.dataset.op;
  const sheets = S.project.sheets;
  if (op === 'del') {
    if (sheets.length === 1) return toast('最後のシートは削除できません');
    if (!confirm(`「${sheets[i].name}」を削除しますか？`)) return;
    sheets.splice(i, 1); S.sheetIdx = Math.min(S.sheetIdx, sheets.length - 1);
  } else if (op === 'dup') {
    const c = deepClone(sheets[i]); c.id = uid('s'); c.name += ' のコピー';
    c.annotations.forEach((a) => { a.id = uid(); });
    sheets.splice(i + 1, 0, c); S.sheetIdx = i + 1;
  } else if (op === 'up') {
    if (i === 0) return;
    [sheets[i - 1], sheets[i]] = [sheets[i], sheets[i - 1]]; S.sheetIdx = i - 1;
  } else S.sheetIdx = i;
  S.selectedId = null; S.pending = null;
  viewer.applySheet(sheet());
  commit(); renderAll();
});

$('#camList').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-c]'); if (!li) return;
  const c = S.manifest.cameras[+li.dataset.c];
  const sh = newSheet(`${String(S.project.sheets.length + 1).padStart(2, '0')} ${c.label || c.name}`, camFromManifest(c));
  S.project.sheets.push(sh); S.sheetIdx = S.project.sheets.length - 1; S.selectedId = null;
  viewer.applySheet(sh); commit(); renderAll();
  toast('Blender のカメラから新しいシートを作りました');
});

$('#addSheet').addEventListener('click', () => {
  const cur = sheet();
  const sh = newSheet(`${String(S.project.sheets.length + 1).padStart(2, '0')} 新しいシート`, viewer.getCameraState());
  Object.assign(sh, { style: cur.style, edges: cur.edges, lineMM: cur.lineMM, shadows: cur.shadows, section: deepClone(cur.section) });
  S.project.sheets.push(sh); S.sheetIdx = S.project.sheets.length - 1; S.selectedId = null;
  viewer.applySheet(sh); commit(); renderAll();
});

// ------------------------------------------------------------------ 右パネル（プロパティ）
const seg = (key, val, opts) => `<div class="seg" data-k="${key}">${opts.map(([v, l]) => `<button data-v="${v}" class="${String(val) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
const chk = (key, val, label) => `<label class="chk"><input type="checkbox" data-k="${key}" ${val ? 'checked' : ''}> ${label}</label>`;
const num = (key, val, min, max, step, unit = '') => `<span class="num"><input type="number" data-k="${key}" value="${val}" min="${min}" max="${max}" step="${step}">${unit}</span>`;
const swatches = (key, val) => `<div class="sws" data-k="${key}">${COLORS.map((c) => `<button title="${c.n}" data-v="${c.v}" class="${c.v === val ? 'on' : ''}" style="background:${c.v}"></button>`).join('')}</div>`;
const row = (label, html) => `<div class="row"><label>${label}</label><div>${html}</div></div>`;

function sectionRange(axis) {
  const box = new THREE.Box3();
  for (const o of S.manifest.objects) {
    if (o.category === 'LAND' || o.category === 'CTX' || o.category === 'TREE') continue;
    box.expandByPoint(new THREE.Vector3(...o.bboxMin)); box.expandByPoint(new THREE.Vector3(...o.bboxMax));
  }
  const i = { x: 0, y: 1, z: 2 }[axis];
  const lo = box.min.getComponent(i), hi = box.max.getComponent(i);
  return [Math.floor((lo - 0.5) * 10) / 10, Math.ceil((hi + 0.5) * 10) / 10];
}

function renderProps() {
  const el = $('#props');
  const a = S.selectedId && findAnn(S.selectedId);
  if (a) { el.innerHTML = annProps(a); return; }
  const sh = sheet();
  const c = sh.camera, sec = sh.section || {};
  const [lo, hi] = sectionRange(sec.axis || 'z');
  const persp = c.type !== 'orthographic';
  const sc = viewer.getScale();
  el.innerHTML = `
    <h3>シート</h3>
    ${row('名前', `<input type="text" data-k="name" value="${X(sh.name)}">`)}
    ${chk('frame', sh.frame !== false, '図枠を表示（A3）')}
    <h3>表示</h3>
    ${seg('style', sh.style, [['white', '白模型'], ['material', 'マテリアル'], ['line', '線画']])}
    ${chk('edges', sh.edges !== false, '輪郭線')}
    ${row('線の太さ', num('lineMM', sh.lineMM ?? 0.12, 0.03, 0.6, 0.01, 'mm'))}
    ${chk('shadows', sh.shadows !== false, '影')}
    <h3>断面</h3>
    ${chk('sec.enabled', !!sec.enabled, '断面で切る')}
    <div class="${sec.enabled ? '' : 'dim'}">
      ${seg('sec.axis', sec.axis || 'z', [['z', '水平（平面）'], ['x', '東西方向'], ['y', '南北方向']])}
      ${row('位置', `<input type="range" data-k="sec.value" min="${lo}" max="${hi}" step="0.05" value="${sec.value ?? 1.5}">`)}
      ${row('', `${num('sec.value', sec.value ?? 1.5, lo, hi, 0.05, 'm')}${chk('sec.flip', !!sec.flip, '反転')}`)}
    </div>
    <h3>カメラ</h3>
    ${seg('cam.type', c.type, [['perspective', '透視'], ['orthographic', '平行投影']])}
    ${persp ? `
      ${row('焦点距離', `${num('cam.lens', Math.round(lensFromFov(c.fov)), 10, 200, 1, 'mm')}`)}
      ${chk('cam.twoPoint', !!c.twoPoint, '垂直補正（2点透視）')}
      ${c.twoPoint ? row('上下シフト', `<input type="range" data-k="cam.shift" min="-0.5" max="0.5" step="0.01" value="${c.shift || 0}">`) : ''}
    ` : `
      ${row('縮尺 1 :', num('cam.scale', Math.round(sc), 1, 5000, 1))}
      <div class="presets">${[50, 100, 200, 300, 500].map((n) => `<button data-scale="${n}">1/${n}</button>`).join('')}</div>
    `}
    ${chk('lockCamera', !!sh.lockCamera, 'カメラを固定（誤操作防止）')}
    <div class="campos muted" id="camReadout"></div>
    <p class="hint">左ドラッグ：回転　右ドラッグ：移動　ホイール：ズーム</p>`;
  updateCameraReadout();
}

function updateCameraReadout() {
  const el = $('#camReadout'); if (!el || !sheet()) return;
  const c = sheet().camera;
  const p = t2b(new THREE.Vector3(...c.position)).map((v) => v.toFixed(2));
  el.textContent = `視点 X ${p[0]} / Y ${p[1]} / Z ${p[2]} m`;
}

function annProps(a) {
  const typeName = { leader: '引出線ラベル', arrow: '矢印', dim: '寸法', text: 'テキスト' }[a.type];
  let h = `<h3>${typeName}</h3>`;
  if (a.type === 'dim') {
    const ra = resolve(a.a), rb = resolve(a.b);
    h += `<div class="locked"><b>${fmtMM(ra.world.distanceTo(rb.world))}</b> mm<small>モデルから自動計算。値は手入力で変更できません</small></div>`;
    h += row('前に付ける', `<input type="text" data-k="prefix" value="${X(a.prefix || '')}" placeholder="例：天井高 ">`);
    h += row('後に付ける', `<input type="text" data-k="suffix" value="${X(a.suffix || '')}">`);
    h += row('寸法線の離れ', num('offset', a.offset ?? 8, -80, 80, 0.5, 'mm'));
  } else {
    h += `<textarea data-k="text" rows="3" id="annText">${X(a.text || '')}</textarea>`;
  }
  h += row('文字サイズ', num('size', a.size, 4, 72, 0.5, 'pt'));
  if (a.type === 'leader' || a.type === 'text') h += chk('weightBold', a.weight === 'bold', '太字');
  if (a.type === 'text') h += seg('align', a.align || 'start', [['start', '左揃え'], ['middle', '中央'], ['end', '右揃え']]);
  if (a.type === 'arrow') { h += row('線の太さ', num('width', a.width || 0.6, 0.1, 5, 0.1, 'mm')); h += chk('dashed', !!a.dashed, '破線（動線など）'); }
  h += row('色', swatches('color', a.color));
  h += chk('halo', a.type === 'text' ? !!a.halo : a.halo !== false, '白フチ（背景の上で読みやすく）');
  const anchors = a.type === 'leader' ? [['anchor', '指している部材']] : a.type === 'text' ? [] : [['a', '始点の部材'], ['b', '終点の部材']];
  for (const [k, label] of anchors) {
    const ok = viewer.nodeByName.has(a[k].obj);
    h += `<div class="anch ${ok ? '' : 'bad'}"><small>${label}</small><div>${X(objLabel(a[k].obj))}${ok ? '' : '<br><b>この部材はモデルにありません</b>'}</div>
      <button data-reanchor="${k}">${S.reanchor?.key === k ? 'クリックで選択中…' : '付け替える'}</button></div>`;
  }
  h += `<div class="btns"><button id="annDel" class="danger">削除</button><button id="annDone">選択解除</button></div>`;
  return h;
}

function setPath(obj, path, val) {
  const ks = path.split('.'); let o = obj;
  while (ks.length > 1) o = o[ks.shift()];
  o[ks[0]] = val;
}

function onPropInput(e, final) {
  const t = e.target, k = t.dataset.k; if (!k) return;
  const val = t.type === 'checkbox' ? t.checked : t.type === 'number' || t.type === 'range' ? parseFloat(t.value) : t.value;
  if (t.type === 'number' && !Number.isFinite(val)) return;
  const a = S.selectedId && findAnn(S.selectedId);
  if (a) {
    if (k === 'weightBold') a.weight = val ? 'bold' : 'normal';
    else a[k] = val;
    drawOverlay();
    if (final) commit();
    return;
  }
  applySheetProp(k, val, final);
}

function applySheetProp(k, val, final) {
  const sh = sheet();
  if (k.startsWith('sec.')) {
    setPath(sh.section, k.slice(4), val);
    if (k === 'sec.axis') { const [lo, hi] = sectionRange(val); sh.section.value = +((lo + hi) / 2).toFixed(2); }
    viewer.setSection(sh.section);
  } else if (k === 'cam.type') {
    sh.camera = convertCamera(sh.camera, val);
    viewer.setCameraState(sh.camera);
  } else if (k === 'cam.lens') {
    sh.camera.fov = fovFromLens(val); viewer.setCameraState(sh.camera);
  } else if (k === 'cam.twoPoint') {
    const c = sh.camera;
    if (val) {
      // 現在の見上げ角を、視線を水平にした上下シフトに置き換える
      const p = new THREE.Vector3(...c.position), t = new THREE.Vector3(...c.target);
      const d = t.clone().sub(p), horiz = Math.hypot(d.x, d.z);
      const pitch = Math.atan2(d.y, horiz);
      c.shift = +Math.max(-0.5, Math.min(0.5, Math.tan(pitch) / Math.tan(c.fov * Math.PI / 360) / 2)).toFixed(3);
      c.target[1] = c.position[1];
      c.twoPoint = true;
    } else { c.twoPoint = false; c.shift = 0; }
    viewer.setCameraState(c);
  } else if (k === 'cam.shift') {
    sh.camera.shift = val; viewer.setCameraState(sh.camera);
  } else if (k === 'cam.scale') {
    if (val > 0) { setScale(sh, val); viewer.setCameraState(sh.camera); }
  } else {
    sh[k] = val;
    if (k === 'lockCamera') viewer.controls.enabled = !val;
    else if (k !== 'name' && k !== 'frame') viewer.applySheet(sh);
  }
  drawOverlay();
  if (final) {
    commit();
    if (k === 'name') renderAll('keepProps');
    else if (!['cam.shift', 'sec.value', 'lineMM'].includes(k)) renderAll();
  }
}

function convertCamera(c, type) {
  if (c.type === type) return c;
  const p = new THREE.Vector3(...c.position), t = new THREE.Vector3(...c.target);
  const dist = p.distanceTo(t);
  if (type === 'orthographic') {
    const vis = 2 * dist * Math.tan(c.fov * Math.PI / 360);
    return { type, position: c.position, target: c.target, up: c.up, orthoHeight: vis, zoom: 1 };
  }
  const vis = c.orthoHeight / c.zoom;
  const fov = 35;
  const d = vis / (2 * Math.tan(fov * Math.PI / 360));
  const np = t.clone().add(p.clone().sub(t).normalize().multiplyScalar(d));
  const fwd = t.clone().sub(np).normalize();
  return { type, position: np.toArray(), target: c.target, up: Math.abs(fwd.y) > 0.99 ? c.up : [0, 1, 0], fov };
}

const props = $('#props');
props.addEventListener('input', (e) => onPropInput(e, e.target.type === 'checkbox'));
props.addEventListener('change', (e) => {
  if (e.target.type === 'checkbox') return;
  onPropInput(e, true);
  if (e.target.dataset.k === 'sec.value') { syncSectionInputs(); }
});
function syncSectionInputs() {
  const v = sheet().section.value;
  $$('[data-k="sec.value"]', props).forEach((i) => { i.value = v; });
}
props.addEventListener('input', (e) => { if (e.target.dataset.k === 'sec.value') syncSectionInputs(); });
props.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const segEl = b.closest('.seg, .sws');
  if (segEl) {
    const k = segEl.dataset.k, v = b.dataset.v;
    const a = S.selectedId && findAnn(S.selectedId);
    if (a) { a[k] = v; drawOverlay(); commit(); renderProps(); }
    else { applySheetProp(k, v, true); renderProps(); }
    return;
  }
  if (b.dataset.scale) { applySheetProp('cam.scale', +b.dataset.scale, true); renderProps(); return; }
  if (b.dataset.reanchor) { S.reanchor = { key: b.dataset.reanchor }; setTool('select', true); renderProps(); hint('新しく指す部材の位置をクリックしてください（Esc で中止）'); return; }
  if (b.id === 'annDel') deleteSelected();
  if (b.id === 'annDone') select(null);
});

// ------------------------------------------------------------------ ツール
const TOOL_HINT = {
  select: '注釈をクリックで選択・ドラッグで移動。何もない所をドラッグすると視点が回ります',
  leader: '指したい部材をクリックしてください（Esc で中止）',
  arrow: '矢印の始点の部材をクリック → 終点をクリック（Esc で中止）',
  dim: '寸法の始点をクリック → 終点をクリック。角に近いと頂点に吸着します（Alt で吸着なし）',
  text: '用紙上の置きたい位置をクリックしてください',
};
function setTool(t, keepReanchor = false) {
  S.tool = t; S.pending = null; S.hover = null;
  if (!keepReanchor) S.reanchor = null;
  $$('#toolbar button[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  paper.classList.toggle('tooling', t !== 'select' || !!S.reanchor);
  hint(TOOL_HINT[t]);
  drawOverlay();
}
$('#toolbar').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.tool) setTool(b.dataset.tool);
  if (b.id === 'btnUndo') undo();
  if (b.id === 'btnRedo') redo();
});

function select(id) {
  S.selectedId = id;
  if (!id) S.reanchor = null;
  renderProps(); drawOverlay();
}
function deleteSelected() {
  const sh = sheet(); if (!S.selectedId) return;
  sh.annotations = sh.annotations.filter((a) => a.id !== S.selectedId);
  S.selectedId = null; commit(); renderProps(); drawOverlay();
}

function sheetPt(e) {
  const r = svg.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width * SHEET_W, y: (e.clientY - r.top) / r.height * SHEET_H };
}

// 用紙（SVG）上の操作
let drag = null;
svg.addEventListener('pointerdown', (e) => {
  if (!S.project || e.button !== 0) return;
  const pt = sheetPt(e);
  // 付け替えモード
  if (S.reanchor) {
    const hit = viewer.pick(e.clientX, e.clientY, { snap: !e.altKey });
    const a = findAnn(S.selectedId);
    if (hit && a) { a[S.reanchor.key] = makeAnchor(hit.name, hit.point); commit(); toast(`${objLabel(hit.name)} に付け替えました`); }
    S.reanchor = null; setTool('select'); renderProps(); return;
  }
  if (S.tool === 'select') {
    const h = e.target.closest('.hit'); if (!h) return;
    const a = findAnn(h.dataset.id); if (!a) return;
    if (S.selectedId !== a.id) select(a.id);
    const role = h.dataset.role;
    let geom = null;
    if (role === 'dimtext') {
      const P = viewer.toSheet(resolve(a.a).world), Q = viewer.toSheet(resolve(a.b).world);
      const len = Math.hypot(Q.x - P.x, Q.y - P.y) || 1;
      geom = { nx: (Q.y - P.y) / len, ny: -(Q.x - P.x) / len };
    }
    drag = { id: a.id, role, start: pt, orig: deepClone(a), geom, moved: false };
    svg.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  if (S.tool === 'text') {
    const a = { id: uid(), type: 'text', x: +pt.x.toFixed(1), y: +pt.y.toFixed(1), text: 'テキスト', size: 12, weight: 'normal', color: '#1a1a1a', align: 'start', halo: false };
    sheet().annotations.push(a); commit(); setTool('select'); select(a.id); focusText(); return;
  }
  const hit = viewer.pick(e.clientX, e.clientY, { snap: S.tool === 'dim' ? !e.altKey : false });
  if (!hit) { toast('部材の上をクリックしてください'); return; }
  if (S.tool === 'leader') {
    const info = viewer.nodeByName.get(hit.name)?.userData.abInfo;
    const p = viewer.toSheet(hit.point);
    const a = { id: uid(), type: 'leader', anchor: makeAnchor(hit.name, hit.point), dx: p.x > SHEET_W * 0.7 ? -22 : 22, dy: p.y < 40 ? 16 : -16, text: info?.label || hit.name, size: 9, color: '#1a1a1a', halo: true };
    sheet().annotations.push(a); commit(); setTool('select'); select(a.id); focusText(); return;
  }
  if (!S.pending) { S.pending = hit; drawOverlay(); return; }
  const A = makeAnchor(S.pending.name, S.pending.point), B = makeAnchor(hit.name, hit.point);
  const a = S.tool === 'arrow'
    ? { id: uid(), type: 'arrow', a: A, b: B, text: '', size: 9, color: '#d9730d', width: 0.7, dashed: false }
    : { id: uid(), type: 'dim', a: A, b: B, offset: 8, size: 8, color: '#1a1a1a', prefix: '', suffix: '', halo: true };
  sheet().annotations.push(a); commit();
  const tool = S.tool; setTool('select'); select(a.id);
  if (tool === 'arrow') focusText();
});

svg.addEventListener('pointermove', (e) => {
  if (drag) {
    const pt = sheetPt(e), a = findAnn(drag.id), o = drag.orig;
    const dx = pt.x - drag.start.x, dy = pt.y - drag.start.y;
    if (Math.hypot(dx, dy) > 0.3) drag.moved = true;
    if (drag.role === 'label') { a.dx = +(o.dx + dx).toFixed(1); a.dy = +(o.dy + dy).toFixed(1); }
    else if (drag.role === 'text') { a.x = +(o.x + dx).toFixed(1); a.y = +(o.y + dy).toFixed(1); }
    else if (drag.role === 'dimtext') { a.offset = +((o.offset ?? 8) + dx * drag.geom.nx + dy * drag.geom.ny).toFixed(1); }
    drawOverlay();
    return;
  }
  if (S.tool === 'select' && !S.reanchor) return;
  if (S.tool === 'text') return;
  const hit = viewer.pick(e.clientX, e.clientY, { snap: (S.tool === 'dim' || S.reanchor) ? !e.altKey : false });
  S.hover = hit;
  hint(hit ? `${objLabel(hit.name)}${hit.snapped ? '　［頂点に吸着］' : ''}` : (S.reanchor ? '新しく指す部材の位置をクリックしてください（Esc で中止）' : TOOL_HINT[S.tool]));
  drawOverlay();
});
svg.addEventListener('pointerup', () => {
  if (drag) { if (drag.moved) commit(); drag = null; renderProps(); }
});
svg.addEventListener('dblclick', (e) => { if (e.target.closest('.hit')) focusText(); });
// ツール使用中もホイールでズームできるように 3D 側へ渡す
svg.addEventListener('wheel', (e) => {
  if (!paper.classList.contains('tooling')) return;
  e.preventDefault();
  $('#gl').dispatchEvent(new WheelEvent('wheel', e));
}, { passive: false });

// 3D 上のクリック（選択解除）
let downAt = null;
$('#gl').addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
$('#gl').addEventListener('pointerup', (e) => {
  if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 4 && S.selectedId) select(null);
  downAt = null;
});

function focusText() {
  setTimeout(() => { const t = $('#annText'); if (t) { t.focus(); t.select(); } }, 30);
}

// ------------------------------------------------------------------ キーボード
window.addEventListener('keydown', (e) => {
  const inField = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
  if (!S.project) return;
  if (inField) { if (e.key === 'Escape') document.activeElement.blur(); return; }
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (e.key === 'Escape') { if (S.pending) { S.pending = null; drawOverlay(); } else if (S.tool !== 'select' || S.reanchor) { setTool('select'); renderProps(); } else select(null); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && S.selectedId) { e.preventDefault(); deleteSelected(); return; }
  const map = { v: 'select', l: 'leader', a: 'arrow', d: 'dim', t: 'text' };
  if (!mod && map[e.key.toLowerCase()]) setTool(map[e.key.toLowerCase()]);
  if (e.key === 'PageDown' || e.key === 'PageUp') {
    const n = S.sheetIdx + (e.key === 'PageDown' ? 1 : -1);
    if (n >= 0 && n < S.project.sheets.length) { S.sheetIdx = n; S.selectedId = null; viewer.applySheet(sheet()); renderAll(); }
  }
});

// ------------------------------------------------------------------ 形状ロック表示
function renderLock() {
  const el = $('#lock');
  if (!S.manifest) { el.hidden = true; return; }
  const it = S.integrity, good = it.ok === it.total;
  el.hidden = false;
  el.className = 'lock ' + (good ? 'good' : 'warn');
  el.innerHTML = `<svg viewBox="0 0 16 16" width="13" height="13"><path d="M4 7V5a4 4 0 0 1 8 0v2h1v8H3V7zm2 0h4V5a2 2 0 0 0-4 0z" fill="currentColor"/></svg>
    形状ロック <b>${it.ok}/${it.total}</b> 一致 <span class="mono">${S.manifest.geometryHash.slice(0, 8)}</span>
    ${S.diff ? `<button id="diffOff" title="差分ハイライトを消す">差分表示中 ×</button>` : ''}`;
}
$('#lock').addEventListener('click', (e) => {
  if (e.target.id === 'diffOff') { clearDiff(); return; }
  const m = S.manifest, it = S.integrity;
  dialog('形状ロック（モデルの整合性）', `
    <p>ArchBoard はモデルの形状を一切変更しません。読み込んだ 3D を Blender が書き出した記録（manifest.json）と照合しています。</p>
    <table class="kv">
      <tr><th>照合結果</th><td>${it.ok} / ${it.total} 部材が一致</td></tr>
      <tr><th>形状ハッシュ</th><td class="mono">${m.geometryHash}</td></tr>
      <tr><th>アプリ内検証値</th><td class="mono">${S.runtimeHash}</td></tr>
      <tr><th>書き出し元</th><td>${X(m.sourceFile)}（Blender ${X(m.blenderVersion)}）</td></tr>
      <tr><th>書き出し日時</th><td>${X(m.exportedAt)}</td></tr>
      <tr><th>カメラ</th><td>${m.cameras.length} 台</td></tr>
    </table>
    ${it.missing.length ? `<h4>3D に見つからない部材</h4><ul>${it.missing.map((n) => `<li>${X(n)}</li>`).join('')}</ul>` : ''}
    ${it.mismatch.length ? `<h4>大きさが記録と合わない部材</h4><ul>${it.mismatch.map((n) => `<li>${X(n)}</li>`).join('')}</ul>` : ''}
    ${m.namingIssues?.length ? `<h4>命名ルール外の名前（${m.namingIssues.length}）</h4><ul>${m.namingIssues.map((n) => `<li>${X(n)}</li>`).join('')}</ul>` : ''}
    <p class="muted">書き出し時にもアプリ内検証値を計算し直し、一致しない場合は書き出しを止めます。</p>`,
  [{ label: '閉じる', primary: true }]);
});

// ------------------------------------------------------------------ 保存・更新
function refreshAnchorCache() {
  for (const sh of S.project.sheets) for (const a of sh.annotations) for (const k of ['anchor', 'a', 'b']) {
    if (a[k] && viewer.nodeByName.has(a[k].obj)) a[k].world = resolve(a[k]).world.toArray().map((v) => +v.toFixed(5));
  }
}
async function save() {
  if (!S.project) return;
  refreshAnchorCache();
  S.project.updated = new Date().toISOString();
  try {
    const where = await IO.saveProject(S.dir, S.project);
    setUnsaved(false);
    toast(where === 'folder' ? 'フォルダの project.json に保存しました' : 'project.json をダウンロードしました。モデルと同じフォルダに置いてください');
  } catch (e) { alertBox('保存できませんでした', e.message); }
}

async function checkUpdate() {
  if (!S.project) return;
  let data;
  try {
    if (S.dir) data = await IO.readFromDir(S.dir);
    else { toast('新しく書き出した manifest.json と model.glb を選んでください'); data = await pickFilesOnce(false); if (!data) return; }
  } catch (e) { return alertBox('読み込めませんでした', e.user ? e.message : e.message); }
  const d = diffManifest(S.project.modelSnapshot, data.manifest);
  if (!d.count) { toast('モデルに変更はありません'); return; }
  showBusy('新しいモデルを読み込んでいます…');
  try {
    S.integrity = await viewer.loadModel(data.glb, data.manifest);
    S.manifest = data.manifest;
    S.runtimeHash = runtimeGeometryHash(viewer.root);
    S.project.modelSnapshot = snapshotOf(data.manifest);
    viewer.applySheet(sheet());
    setUnsaved(true);
    showDiff(d, 'モデルが更新されました');
  } finally { hideBusy(); }
}

// ------------------------------------------------------------------ 書き出し
const safeName = (s) => s.replace(/[\\/:*?"<>|]+/g, '_').trim();
function svgToImage(svgStr) {
  return new Promise((res, rej) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svgStr], { type: 'image/svg+xml' }));
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); rej(new Error('注釈の画像化に失敗しました')); };
    img.src = url;
  });
}
const loadImage = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
const canvasBlob = (cv) => new Promise((r) => cv.toBlob(r, 'image/png'));

function verifyLock() {
  const now = runtimeGeometryHash(viewer.root);
  if (now !== S.runtimeHash) throw new Error('形状の検証値が読み込み時と一致しません。書き出しを中止しました。');
  return now;
}

function exportMeta(sh) {
  return {
    generator: 'ArchBoard Phase 0', project: S.project.name, sheet: sh.name, exportedAt: new Date().toISOString(),
    geometryHash: S.manifest.geometryHash, runtimeHash: S.runtimeHash, modelExportedAt: S.manifest.exportedAt,
  };
}

async function renderSheetFiles(kind, dpi) {
  const sh = sheet();
  const W = Math.round(SHEET_W / 25.4 * dpi), H = Math.round(SHEET_H / 25.4 * dpi);
  const base = safeName(`${S.project.name}_${String(S.sheetIdx + 1).padStart(2, '0')}_${sh.name.replace(/^\d+\s*/, '')}`);
  const ctx = overlayCtx();
  const svgRaster = exportSVG(sh, ctx, null, exportMeta(sh)).replace(`width="${SHEET_W}mm" height="${SHEET_H}mm"`, `width="${W}" height="${H}"`);
  const out = [];
  if (kind === 'svg') {
    const img = viewer.renderImage(Math.round(W), Math.round(H));
    out.push([`${base}.svg`, new Blob([exportSVG(sh, ctx, img, exportMeta(sh))], { type: 'image/svg+xml' })]);
    return out;
  }
  const modelURL = viewer.renderImage(W, H);
  if (kind === 'png' || kind === 'layers') {
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    if (kind === 'png') {
      g.drawImage(await loadImage(modelURL), 0, 0, W, H);
      g.drawImage(await svgToImage(svgRaster), 0, 0, W, H);
      out.push([`${base}_${dpi}dpi.png`, await canvasBlob(cv)]);
    } else {
      out.push([`${base}_3D_${dpi}dpi.png`, IO.dataURLtoBlob(modelURL)]);
      g.drawImage(await svgToImage(svgRaster), 0, 0, W, H);
      out.push([`${base}_注釈_${dpi}dpi.png`, await canvasBlob(cv)]);
    }
  }
  return out;
}

async function doExport(kind, dpi, all = false) {
  if (!S.project) return;
  try { verifyLock(); } catch (e) { return alertBox('書き出しできません', e.message); }
  showBusy('書き出しています…');
  const keepIdx = S.sheetIdx, keepSel = S.selectedId;
  S.selectedId = null;
  let count = 0, where = 'download';
  try {
    const idxs = all ? S.project.sheets.map((_, i) => i) : [S.sheetIdx];
    for (const i of idxs) {
      S.sheetIdx = i; viewer.applySheet(sheet());
      await new Promise((r) => setTimeout(r, 30));
      for (const [name, blob] of await renderSheetFiles(kind, dpi)) { where = await IO.saveExport(S.dir, name, blob); count++; }
    }
  } catch (e) { console.error(e); alertBox('書き出しに失敗しました', e.message); }
  finally {
    S.sheetIdx = keepIdx; S.selectedId = keepSel; viewer.applySheet(sheet()); renderAll(); hideBusy();
  }
  if (count) toast(where === 'folder' ? `${count} 個のファイルを exports フォルダに保存しました` : `${count} 個のファイルをダウンロードしました`);
}

$('#exportMenu').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-ex]'); if (!b) return;
  $('#exportMenu').hidden = true;
  const [kind, dpi, all] = b.dataset.ex.split(':');
  doExport(kind, +dpi, all === 'all');
});
$('#btnExport').addEventListener('click', (e) => { e.stopPropagation(); if (S.project) $('#exportMenu').hidden = !$('#exportMenu').hidden; });
document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) $('#exportMenu').hidden = true; });

// ------------------------------------------------------------------ 開く
const fileIn = $('#fileIn');
function pickFilesOnce(dirMode) {
  return new Promise((res) => {
    fileIn.value = '';
    if (dirMode) fileIn.setAttribute('webkitdirectory', ''); else fileIn.removeAttribute('webkitdirectory');
    fileIn.onchange = async () => {
      try { res(fileIn.files.length ? await IO.readFromFiles(fileIn.files) : null); } catch (e) { alertBox('読み込めませんでした', e.message); res(null); }
    };
    fileIn.click();
  });
}

async function openFolder() {
  if (S.unsaved && !confirm('保存していない変更があります。破棄して開きますか？')) return;
  if (IO.canPickFolder()) {
    let dir;
    try { dir = await IO.pickFolder(); } catch (e) { if (e.name !== 'AbortError') alertBox('フォルダを開けませんでした', e.message); return; }
    try { await openData(await IO.readFromDir(dir), { dir }); } catch (e) { alertBox('読み込めませんでした', e.user ? e.message : e.message); }
  } else {
    const data = await pickFilesOnce(true);
    if (data) await openData(data, {});
  }
}
async function openSample() {
  if (S.unsaved && !confirm('保存していない変更があります。破棄してサンプルを開きますか？')) return;
  await openData(await loadSampleData(), { sample: true });
}

$('#btnOpen').addEventListener('click', openFolder);
$('#btnSample').addEventListener('click', openSample);
$('#btnSave').addEventListener('click', save);
$('#btnUpdate').addEventListener('click', checkUpdate);
$('#emptyOpen').addEventListener('click', openFolder);
$('#emptySample').addEventListener('click', openSample);
$('#projName').addEventListener('change', (e) => { if (S.project) { S.project.name = e.target.value; commit(); drawOverlay(); } });

// ドラッグ＆ドロップ（フォルダごと、またはファイル）
window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dropping'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
window.addEventListener('drop', async (e) => {
  e.preventDefault(); document.body.classList.remove('dropping');
  const items = Array.from(e.dataTransfer.items || []);
  try {
    if (items.length && items[0].getAsFileSystemHandle) {
      const h = await items[0].getAsFileSystemHandle();
      if (h && h.kind === 'directory') { await openData(await IO.readFromDir(h), { dir: h }); return; }
    }
    if (e.dataTransfer.files.length) await openData(await IO.readFromFiles(e.dataTransfer.files), {});
  } catch (err) { alertBox('読み込めませんでした', err.message); }
});
window.addEventListener('beforeunload', (e) => { if (S.unsaved) { e.preventDefault(); e.returnValue = ''; } });

// ------------------------------------------------------------------ 共通 UI
function renderAll(mode) {
  if (!S.project) return;
  if (document.activeElement !== $('#projName')) $('#projName').value = S.project.name;
  renderSheets();
  if (mode !== 'keepProps') renderProps();
  renderLock();
  drawOverlay();
}
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}
function hint(msg) { $('#hint').textContent = msg || ''; }
function showBusy(msg) { $('#busy').hidden = false; $('#busy span').textContent = msg; }
function hideBusy() { $('#busy').hidden = true; }
function dialog(title, html, buttons) {
  const d = $('#dialog');
  d.innerHTML = `<div class="dlg"><h2>${X(title)}</h2><div class="dlg-body">${html}</div><div class="dlg-btns">${buttons.map((b, i) => `<button data-i="${i}" class="${b.primary ? 'primary' : ''}">${X(b.label)}</button>`).join('')}</div></div>`;
  d.hidden = false;
  d.onclick = (e) => {
    const b = e.target.closest('.dlg-btns button');
    if (b) { d.hidden = true; buttons[+b.dataset.i].act?.(); } else if (e.target === d) d.hidden = true;
  };
}
function alertBox(title, msg) { dialog(title, `<p>${X(msg)}</p>`, [{ label: 'OK', primary: true }]); }

// テスト・自動確認用（ブラウザのコンソールから状態を確認できる）
window.ArchBoard = { S, viewer, openSample, doExport, setTool, select, undo, redo, renderSheetFiles, sheet };

setTool('select');
layout();
