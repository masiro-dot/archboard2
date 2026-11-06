// 共通ユーティリティ：座標変換・ハッシュ・文字計測・ID

import * as THREE from 'three';

export const SHEET_W = 420; // A3 横（mm）
export const SHEET_H = 297;
export const SHEET_ASPECT = SHEET_W / SHEET_H;
export const PT = 0.3528; // 1pt = 0.3528mm

export const FONT_STACK = "'Yu Gothic UI','Yu Gothic','YuGothic','Meiryo','Hiragino Sans','Noto Sans CJK JP','Noto Sans JP',sans-serif";

// Blender（Z 上向き）⇔ three.js（Y 上向き）
export const b2t = ([x, y, z]) => new THREE.Vector3(x, z, -y);
export const t2b = (v) => [v.x, -v.z, v.y];

export const uid = (p = 'a') => p + Math.random().toString(36).slice(2, 9);

export function fmtMM(meters) {
  return Math.round(meters * 1000).toLocaleString('ja-JP');
}

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

// cyrb53 を 2 本組み合わせた 128bit 風ハッシュ（同期・file:// でも動く）
export function hashString(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

// 読み込んだ 3D モデルの実行時ハッシュ（アプリ内で形状が変わっていないことの検証用）
export function runtimeGeometryHash(root) {
  const parts = [];
  const v = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh || o.userData.abHelper) return;
    const pos = o.geometry.attributes.position;
    let s = o.name + ':';
    for (let i = 0; i < pos.count; i += 1) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      s += Math.round(v.x * 1e3) + ',' + Math.round(v.y * 1e3) + ',' + Math.round(v.z * 1e3) + ';';
    }
    parts.push(hashString(s));
  });
  parts.sort();
  return hashString(parts.join('|'));
}

// 文字幅の計測（mm 単位）。書き出し時も同じ値になるよう canvas で測る
const _mctx = document.createElement('canvas').getContext('2d');
export function measureText(text, sizeMM, weight = 'normal') {
  _mctx.font = `${weight} ${sizeMM * 10}px ${FONT_STACK}`;
  return _mctx.measureText(text).width / 10;
}

export function escapeXML(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function deepClone(o) {
  return JSON.parse(JSON.stringify(o));
}

export function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
