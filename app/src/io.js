// ファイル入出力
// Chrome / Edge の「フォルダを開く」(File System Access API) を優先。
// 使えない場合はファイル選択とダウンロードで代替する。データは PC の外に出ない。

import { download } from './util.js';

export const canPickFolder = () => typeof window.showDirectoryPicker === 'function';

export async function pickFolder() {
  return await window.showDirectoryPicker({ id: 'archboard', mode: 'readwrite' });
}

async function fileFromDir(dir, name) {
  try { return await (await dir.getFileHandle(name)).getFile(); } catch { return null; }
}

function parseErr(msg) { const e = new Error(msg); e.user = true; return e; }

async function finish(manifestFile, glbFile, projectFile) {
  if (!manifestFile) throw parseErr('manifest.json が見つかりません。Blender の ArchBoard アドオンで書き出したフォルダを選んでください。');
  const manifest = JSON.parse(await manifestFile.text());
  if (manifest.format !== 'archboard-manifest') throw parseErr('manifest.json の形式が ArchBoard 用ではありません。');
  if (!glbFile) throw parseErr(`${manifest.model || 'model.glb'} が見つかりません。`);
  const glb = await glbFile.arrayBuffer();
  let project = null;
  if (projectFile) {
    try { project = JSON.parse(await projectFile.text()); } catch { throw parseErr('project.json を読み込めませんでした（壊れている可能性があります）。'); }
  }
  return { manifest, glb, project };
}

export async function readFromDir(dir) {
  const manifestFile = await fileFromDir(dir, 'manifest.json');
  let glbName = 'model.glb';
  if (manifestFile) { try { glbName = JSON.parse(await manifestFile.text()).model || glbName; } catch { /* finish で報告 */ } }
  return finish(manifestFile, await fileFromDir(dir, glbName), await fileFromDir(dir, 'project.json'));
}

export async function readFromFiles(files) {
  const list = Array.from(files);
  const by = (pred) => list.find(pred) || null;
  return finish(
    by((f) => f.name === 'manifest.json'),
    by((f) => /\.glb$/i.test(f.name)),
    by((f) => f.name === 'project.json'),
  );
}

async function ensureWrite(dir) {
  if (!dir) return false;
  try {
    if ((await dir.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
    return (await dir.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch { return false; }
}

async function writeFile(dir, name, blob) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
}

// 戻り値: 'folder'（フォルダへ保存）または 'download'
export async function saveProject(dir, project) {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  if (await ensureWrite(dir)) { await writeFile(dir, 'project.json', blob); return 'folder'; }
  download(blob, 'project.json');
  return 'download';
}

export async function saveExport(dir, name, blob) {
  if (await ensureWrite(dir)) {
    const sub = await dir.getDirectoryHandle('exports', { create: true });
    await writeFile(sub, name, blob);
    return 'folder';
  }
  download(blob, name);
  return 'download';
}

export function dataURLtoBlob(url) {
  const [head, b64] = url.split(',');
  const mime = head.match(/data:(.*?);/)[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
