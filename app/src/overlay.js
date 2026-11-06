// 注釈レイヤー（SVG）
// 座標系は A3 用紙そのもの（viewBox 0 0 420 297、単位 mm）。
// 画面表示も書き出しも同じ関数で作るので、見たままが印刷される。

import { SHEET_W, SHEET_H, PT, FONT_STACK, measureText, escapeXML as X, fmtMM } from './util.js';

export const COLORS = [
  { v: '#1a1a1a', n: '黒' },
  { v: '#5b5b5b', n: 'グレー' },
  { v: '#ffffff', n: '白' },
  { v: '#c8102e', n: '赤' },
  { v: '#1f5fa8', n: '青' },
  { v: '#d9730d', n: 'オレンジ' },
];

const SEL = '#2b7cff';
const WARN = '#e0245e';
const isLight = (c) => /^#(f|e)/i.test(c);
const halo = (c) => (isLight(c) ? '#1a1a1a' : '#ffffff');
const f = (n) => (Math.round(n * 100) / 100).toString();

function textBlock(lines, x, yFirst, sizeMM, color, anchor, weight, withHalo) {
  const lh = sizeMM * 1.45;
  const stroke = withHalo ? ` stroke="${halo(color)}" stroke-width="${f(sizeMM * 0.28)}" stroke-linejoin="round" paint-order="stroke"` : '';
  const tspans = lines.map((t, i) => `<tspan x="${f(x)}" y="${f(yFirst + i * lh)}">${X(t || ' ')}</tspan>`).join('');
  return `<text font-family="${X(FONT_STACK)}" font-size="${f(sizeMM)}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}"${stroke}>${tspans}</text>`;
}

function blockSize(lines, sizeMM, weight) {
  const w = Math.max(1, ...lines.map((t) => measureText(t, sizeMM, weight)));
  return { w, h: sizeMM * 1.45 * (lines.length - 1) + sizeMM };
}

function selRect(x, y, w, h) {
  return `<rect x="${f(x - 1.2)}" y="${f(y - 1.2)}" width="${f(w + 2.4)}" height="${f(h + 2.4)}" fill="none" stroke="${SEL}" stroke-width="0.3" stroke-dasharray="1.2 0.8"/>`;
}

// ------------------------------------------------------------------ 各注釈
function leader(a, ctx, sel) {
  const r = ctx.resolve(a.anchor);
  if (!r) return '';
  const A = ctx.toSheet(r.world);
  if (A.behind) return '';
  const occl = r.ok && ctx.isOccluded(r.world);
  const color = r.ok ? a.color : WARN;
  const size = a.size * PT;
  const lines = String(a.text || '').split('\n');
  const { w, h } = blockSize(lines, size, a.weight || 'normal');
  const L = { x: A.x + a.dx, y: A.y + a.dy };
  const right = L.x >= A.x;
  const x0 = right ? L.x : L.x - w;
  const lw = 0.25;
  const lh = size * 1.45;
  const yFirst = L.y - 0.9 - (lines.length - 1) * lh;
  let s = `<g data-id="${a.id}">`;
  const dash = occl ? ' stroke-dasharray="0.8 0.6"' : '';
  s += `<line x1="${f(A.x)}" y1="${f(A.y)}" x2="${f(L.x)}" y2="${f(L.y)}" stroke="${color}" stroke-width="${lw}"${dash}/>`;
  s += `<line x1="${f(x0)}" y1="${f(L.y)}" x2="${f(x0 + w)}" y2="${f(L.y)}" stroke="${color}" stroke-width="${lw}"/>`;
  s += occl
    ? `<circle cx="${f(A.x)}" cy="${f(A.y)}" r="0.8" fill="#fff" stroke="${color}" stroke-width="0.25"/>`
    : `<circle cx="${f(A.x)}" cy="${f(A.y)}" r="0.8" fill="${color}"/>`;
  s += textBlock(lines, right ? L.x : L.x, yFirst, size, color, right ? 'start' : 'end', a.weight || 'normal', a.halo !== false);
  if (!r.ok) s += warnBadge(A);
  if (!ctx.forExport) {
    s += `<rect class="hit" data-id="${a.id}" data-role="label" x="${f(x0 - 1)}" y="${f(yFirst - size - 0.5)}" width="${f(w + 2)}" height="${f(h + 2.5)}" fill="transparent"/>`;
    if (sel) {
      s += selRect(x0, yFirst - size, w, h + 1);
      s += `<circle class="hit" data-id="${a.id}" data-role="anchor" cx="${f(A.x)}" cy="${f(A.y)}" r="1.8" fill="none" stroke="${SEL}" stroke-width="0.3"/>`;
    }
  }
  return s + '</g>';
}

function warnBadge(P) {
  return `<g><rect x="${f(P.x + 1.5)}" y="${f(P.y - 6)}" width="13" height="4.4" rx="0.8" fill="${WARN}"/>` +
    `<text x="${f(P.x + 8)}" y="${f(P.y - 2.7)}" font-family="${X(FONT_STACK)}" font-size="2.8" fill="#fff" text-anchor="middle">要確認</text></g>`;
}

function arrow(a, ctx, sel) {
  const ra = ctx.resolve(a.a), rb = ctx.resolve(a.b);
  if (!ra || !rb) return '';
  const P = ctx.toSheet(ra.world), Q = ctx.toSheet(rb.world);
  if (P.behind || Q.behind) return '';
  const ok = ra.ok && rb.ok;
  const color = ok ? a.color : WARN;
  const w = a.width || 0.6;
  const dx = Q.x - P.x, dy = Q.y - P.y, len = Math.hypot(dx, dy);
  if (len < 0.5) return '';
  const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
  const hl = Math.min(len * 0.45, Math.max(3, w * 5)), hw = hl * 0.38;
  const ex = Q.x - ux * hl * 0.9, ey = Q.y - uy * hl * 0.9;
  let s = `<g data-id="${a.id}">`;
  const dash = a.dashed ? ` stroke-dasharray="${f(w * 3)} ${f(w * 2)}"` : '';
  s += `<line x1="${f(P.x)}" y1="${f(P.y)}" x2="${f(ex)}" y2="${f(ey)}" stroke="${color}" stroke-width="${f(w)}" stroke-linecap="round"${dash}/>`;
  const b1x = Q.x - ux * hl + nx * hw, b1y = Q.y - uy * hl + ny * hw;
  const b2x = Q.x - ux * hl - nx * hw, b2y = Q.y - uy * hl - ny * hw;
  s += `<path d="M${f(Q.x)} ${f(Q.y)} L${f(b1x)} ${f(b1y)} L${f(b2x)} ${f(b2y)} Z" fill="${color}"/>`;
  if (a.text) {
    const size = a.size * PT;
    const lines = String(a.text).split('\n');
    const mx = (P.x + Q.x) / 2, my = (P.y + Q.y) / 2;
    s += textBlock(lines, mx, my - 2.2 - (lines.length - 1) * size * 1.45, size, color, 'middle', 'normal', a.halo !== false);
  }
  if (!ok) s += warnBadge(P);
  if (!ctx.forExport) {
    s += `<line class="hit" data-id="${a.id}" data-role="body" x1="${f(P.x)}" y1="${f(P.y)}" x2="${f(Q.x)}" y2="${f(Q.y)}" stroke="transparent" stroke-width="4"/>`;
    if (sel) {
      s += `<circle cx="${f(P.x)}" cy="${f(P.y)}" r="1.4" fill="none" stroke="${SEL}" stroke-width="0.3"/>`;
      s += `<circle cx="${f(Q.x)}" cy="${f(Q.y)}" r="1.4" fill="none" stroke="${SEL}" stroke-width="0.3"/>`;
    }
  }
  return s + '</g>';
}

function dim(a, ctx, sel) {
  const ra = ctx.resolve(a.a), rb = ctx.resolve(a.b);
  if (!ra || !rb) return '';
  const P = ctx.toSheet(ra.world), Q = ctx.toSheet(rb.world);
  if (P.behind || Q.behind) return '';
  const ok = ra.ok && rb.ok;
  const color = ok ? a.color : WARN;
  const dx = Q.x - P.x, dy = Q.y - P.y, len = Math.hypot(dx, dy);
  if (len < 1) return '';
  const ux = dx / len, uy = dy / len;
  const nx = uy, ny = -ux; // 画面上で「上」側を正にする
  const o = a.offset ?? 8, sg = o >= 0 ? 1 : -1;
  const P2 = { x: P.x + nx * o, y: P.y + ny * o }, Q2 = { x: Q.x + nx * o, y: Q.y + ny * o };
  const lw = 0.22;
  let s = `<g data-id="${a.id}">`;
  for (const [B, B2] of [[P, P2], [Q, Q2]]) {
    s += `<line x1="${f(B.x + nx * sg * 1)}" y1="${f(B.y + ny * sg * 1)}" x2="${f(B2.x + nx * sg * 1.5)}" y2="${f(B2.y + ny * sg * 1.5)}" stroke="${color}" stroke-width="${lw}"/>`;
  }
  s += `<line x1="${f(P2.x - ux * 1.5)}" y1="${f(P2.y - uy * 1.5)}" x2="${f(Q2.x + ux * 1.5)}" y2="${f(Q2.y + uy * 1.5)}" stroke="${color}" stroke-width="${lw}"/>`;
  // 45° の斜線（建築の寸法止め）
  const c45 = Math.SQRT1_2, tx = (ux + nx) * c45 * 1.3, ty = (uy + ny) * c45 * 1.3;
  for (const B of [P2, Q2]) s += `<line x1="${f(B.x - tx)}" y1="${f(B.y - ty)}" x2="${f(B.x + tx)}" y2="${f(B.y + ty)}" stroke="${color}" stroke-width="0.45"/>`;
  // 値はモデルから自動計算（手入力で書き換えられない）
  const meters = ra.world.distanceTo(rb.world);
  const label = (a.prefix || '') + fmtMM(meters) + (a.suffix || '');
  const orig = Math.atan2(uy, ux) * 180 / Math.PI;
  const flip = (orig > 90 || orig <= -90) ? -1 : 1;
  const ang = flip < 0 ? (orig > 0 ? orig - 180 : orig + 180) : orig;
  const mx = (P2.x + Q2.x) / 2, my = (P2.y + Q2.y) / 2;
  const size = a.size * PT;
  // 寸法値は寸法線の外側（部材から離れる側）に置く
  const tyy = flip * sg > 0 ? -1.0 : size + 0.6;
  s += `<g transform="translate(${f(mx)} ${f(my)}) rotate(${f(ang)})">` +
    textBlock([label], 0, tyy, size, color, 'middle', 'normal', a.halo !== false) + '</g>';
  if (!ok) s += warnBadge(P);
  if (!ctx.forExport) {
    const w = measureText(label, size) + 3;
    s += `<g transform="translate(${f(mx)} ${f(my)}) rotate(${f(ang)})"><rect class="hit" data-id="${a.id}" data-role="dimtext" x="${f(-w / 2)}" y="${f(-size - 2)}" width="${f(w)}" height="${f(size * 2 + 3)}" fill="transparent"/>` +
      (sel ? `<rect x="${f(-w / 2)}" y="${f(-size - 2)}" width="${f(w)}" height="${f(size * 2 + 3)}" fill="none" stroke="${SEL}" stroke-width="0.3" stroke-dasharray="1.2 0.8"/>` : '') + '</g>';
  }
  return s + '</g>';
}

function text(a, ctx, sel) {
  const size = a.size * PT;
  const weight = a.weight || 'normal';
  const lines = String(a.text || '').split('\n');
  const { w, h } = blockSize(lines, size, weight);
  const anchor = a.align || 'start';
  const x0 = anchor === 'middle' ? a.x - w / 2 : anchor === 'end' ? a.x - w : a.x;
  let s = `<g data-id="${a.id}">` + textBlock(lines, a.x, a.y + size, size, a.color, anchor, weight, !!a.halo);
  if (!ctx.forExport) {
    s += `<rect class="hit" data-id="${a.id}" data-role="text" x="${f(x0 - 1)}" y="${f(a.y - 1)}" width="${f(w + 2)}" height="${f(h + 2.5)}" fill="transparent"/>`;
    if (sel) s += selRect(x0, a.y, w, h + 0.5);
  }
  return s + '</g>';
}

// ------------------------------------------------------------------ 図枠
function frame(sheet, ctx) {
  const m = 8, W = SHEET_W, H = SHEET_H;
  let s = `<path d="M0 0H${W}V${H}H0Z M${m} ${m}V${H - m}H${W - m}V${m}Z" fill="#fff" fill-rule="evenodd"/>`;
  s += `<rect x="${m}" y="${m}" width="${W - 2 * m}" height="${H - 2 * m}" fill="none" stroke="#1a1a1a" stroke-width="0.35"/>`;
  const bw = 132, bh = 20, bx = W - m - bw, by = H - m - bh;
  const t = (x, y, sz, str, wt = 'normal', col = '#1a1a1a') =>
    `<text x="${f(x)}" y="${f(y)}" font-family="${X(FONT_STACK)}" font-size="${f(sz)}" font-weight="${wt}" fill="${col}">${X(str)}</text>`;
  s += `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="#fff" stroke="#1a1a1a" stroke-width="0.35"/>`;
  s += `<line x1="${bx}" y1="${by + 11}" x2="${bx + bw}" y2="${by + 11}" stroke="#1a1a1a" stroke-width="0.2"/>`;
  s += `<line x1="${bx + 96}" y1="${by + 11}" x2="${bx + 96}" y2="${by + bh}" stroke="#1a1a1a" stroke-width="0.2"/>`;
  s += t(bx + 3, by + 4.2, 2.2, 'PROJECT', 'normal', '#777');
  s += t(bx + 3, by + 9, 4.2, ctx.projectName || '', 'bold');
  s += t(bx + 3, by + 14.2, 2.2, 'SHEET', 'normal', '#777');
  s += t(bx + 3, by + 18.3, 3.3, sheet.name || '');
  s += t(bx + 99, by + 14.2, 2.2, ctx.scaleText ? 'SCALE' : 'DATE', 'normal', '#777');
  s += t(bx + 99, by + 18.3, 3.0, ctx.scaleText || ctx.date || '');
  s += t(bx + bw - 3, by + 4.2, 2.0, `${ctx.sheetNo || ''}  形状ID ${ctx.hashShort || '-'}`, 'normal', '#777')
    .replace('<text ', '<text text-anchor="end" ');
  return s;
}

// ------------------------------------------------------------------ 本体
export function buildOverlay(sheet, ctx) {
  let body = '';
  if (sheet.frame !== false) body += frame(sheet, ctx);
  for (const a of sheet.annotations || []) {
    const sel = a.id === ctx.selectedId;
    if (a.type === 'leader') body += leader(a, ctx, sel);
    else if (a.type === 'arrow') body += arrow(a, ctx, sel);
    else if (a.type === 'dim') body += dim(a, ctx, sel);
    else if (a.type === 'text') body += text(a, ctx, sel);
  }
  if (ctx.extra) body += ctx.extra;
  return body;
}

export function exportSVG(sheet, ctx, imageDataURL, meta) {
  const inner = buildOverlay(sheet, { ...ctx, forExport: true, selectedId: null });
  const img = imageDataURL
    ? `<g id="model-view"><image href="${imageDataURL}" x="0" y="0" width="${SHEET_W}" height="${SHEET_H}" preserveAspectRatio="none"/></g>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET_W}mm" height="${SHEET_H}mm" viewBox="0 0 ${SHEET_W} ${SHEET_H}">\n` +
    `<metadata>${X(JSON.stringify(meta))}</metadata>\n` +
    (imageDataURL ? `<rect width="${SHEET_W}" height="${SHEET_H}" fill="#fff"/>` : '') +
    img + `\n<g id="annotations">${inner}</g>\n</svg>\n`;
}
