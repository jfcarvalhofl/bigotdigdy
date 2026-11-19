import { db, uid } from './db.js';
import { loadPdf, closePdf, pdfjsLib } from './pdf.js';
import { HL, PENS, hlById, penById, colorOf, $, $$, h, toast, fmtDate, posKey } from './common.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const FREE_W = 11;      // espessura do marca-texto livre (pontos PDF)
const PEN_W = 1.5;      // espessura da caneta (pontos PDF)
const HOLD_MS = 550;    // segurar parado no fim do traço → endireita

export const R = {
  doc: null, pdf: null, pages: [], annots: [],
  zoom: 1, scale: 1,
  tool: 'text', color: 'yellow', pen: 'blue', doubt: false,
  panelOpen: false, filter: 'all',
  undo: [], current: 1, onClose: null
};

const pagesEl = () => $('#pages');
const innerEl = () => $('#pages-inner');
let io = null;
let saveT = 0;

/* ===================== abrir / fechar ===================== */
export async function openDoc(docId, onClose) {
  R.onClose = onClose;
  const doc = await db.get('docs', docId);
  const file = await db.get('files', docId);
  R.doc = doc;
  R.annots = await db.byDoc(docId);
  R.undo = [];
  R.pdf = await loadPdf(await file.blob.arrayBuffer());
  $('#doc-name').textContent = doc.name;
  $('#doc-page').textContent = 'p. ' + (doc.lastPage || 1) + ' / ' + R.pdf.numPages;
  R.current = doc.lastPage || 1;
  $('#view-library').hidden = true;
  $('#view-reader').hidden = false;
  await buildPages();
  layout();
  scrollToPos(doc.lastPage || 1, 0);
  updatePanel();
  renderToolbar();
}

export async function closeDoc() {
  await persistDoc();
  io?.disconnect();
  for (const p of R.pages) unrenderPage(p);
  innerEl().innerHTML = '';
  closePdf(R.pdf);
  R.pdf = null; R.pages = []; R.doc = null;
  $('#view-reader').hidden = true;
  $('#view-library').hidden = false;
  R.onClose?.();
}

async function buildPages() {
  innerEl().innerHTML = '';
  R.pages = [];
  for (let n = 1; n <= R.pdf.numPages; n++) {
    const page = await R.pdf.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const el = h('div', { class: 'page', 'data-page': n });
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'overlay');
    svg.setAttribute('viewBox', `0 0 ${vp.width} ${vp.height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    el.append(h('div', { class: 'loading' }, 'p. ' + n), svg, h('div', { class: 'pnum' }, String(n)));
    innerEl().append(el);
    R.pages.push({ n, page, w1: vp.width, h1: vp.height, el, svg, canvas: null, textDiv: null, renderedScale: 0, task: null, hasText: null });
  }
  io?.disconnect();
  io = new IntersectionObserver(onIntersect, { root: pagesEl(), rootMargin: '900px 0px' });
  R.pages.forEach(p => io.observe(p.el));
  R.pages.forEach(drawOverlay);
  drawMarkers();
}

/* ===================== layout e render ===================== */
function fitScale() {
  const maxW = Math.max(...R.pages.map(p => p.w1));
  const avail = Math.max(320, pagesEl().clientWidth - 40);
  return Math.min(avail / maxW, 2.2);
}

export function layout() {
  if (!R.pages.length) return;
  R.scale = fitScale() * R.zoom;
  for (const p of R.pages) {
    p.el.style.width = Math.floor(p.w1 * R.scale) + 'px';
    p.el.style.height = Math.floor(p.h1 * R.scale) + 'px';
    p.el.style.setProperty('--total-scale-factor', R.scale);
    p.el.style.setProperty('--scale-factor', R.scale);
    if (p.visible) renderPage(p);
  }
}

function onIntersect(entries) {
  for (const e of entries) {
    const p = R.pages[+e.target.dataset.page - 1];
    p.visible = e.isIntersecting;
    if (e.isIntersecting) renderPage(p); else unrenderPage(p);
  }
}

async function renderPage(p) {
  if (p.renderedScale === R.scale || p.rendering === R.scale) return;
  p.rendering = R.scale;
  const scale = R.scale;
  const vp = p.page.getViewport({ scale });
  const dpr = window.devicePixelRatio || 1;
  const maxPx = 14e6;
  const os = Math.min(dpr, Math.sqrt(maxPx / (vp.width * vp.height)));
  const canvas = h('canvas', { class: 'render' });
  canvas.width = Math.floor(vp.width * os);
  canvas.height = Math.floor(vp.height * os);
  try {
    p.task?.cancel();
    p.task = p.page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, transform: os !== 1 ? [os, 0, 0, os, 0, 0] : null });
    await p.task.promise;
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException') console.warn(e);
    if (p.rendering === scale) p.rendering = 0;
    return;
  }
  if (R.scale !== scale) return; // zoom mudou enquanto renderizava
  p.canvas?.remove(); p.textDiv?.remove();
  p.el.querySelector('.loading')?.remove();
  p.canvas = canvas;
  p.el.prepend(canvas);
  // camada de texto
  const textDiv = h('div', { class: 'textLayer' });
  p.textDiv = textDiv;
  canvas.after(textDiv);
  try {
    const tc = await p.page.getTextContent();
    if (p.hasText == null) p.hasText = tc.items.map(i => i.str || '').join('').replace(/\s+/g, '').length >= 30;
    const tl = new pdfjsLib.TextLayer({ textContentSource: tc, container: textDiv, viewport: vp });
    await tl.render();
  } catch (e) { console.warn('textLayer', e); }
  p.renderedScale = scale;
  p.rendering = 0;
}

function unrenderPage(p) {
  p.task?.cancel();
  if (p.canvas) { p.canvas.width = 0; p.canvas.height = 0; p.canvas.remove(); p.canvas = null; }
  p.textDiv?.remove(); p.textDiv = null;
  p.renderedScale = 0; p.rendering = 0;
  if (!p.el.querySelector('.loading')) p.el.prepend(h('div', { class: 'loading' }, 'p. ' + p.n));
}

/* ===================== overlay (anotações) ===================== */
function svgEl(tag, attrs) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

export function annotBBox(a) {
  if (a.type === 'text') {
    const xs = a.rects.flatMap(r => [r[0], r[2]]), ys = a.rects.flatMap(r => [r[1], r[3]]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  const xs = a.points.map(q => q[0]), ys = a.points.map(q => q[1]);
  const pad = a.width / 2;
  return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
}

const ptsAttr = pts => pts.map(q => q[0].toFixed(1) + ',' + q[1].toFixed(1)).join(' ');

function shapeFor(a) {
  const g = svgEl('g', { 'data-id': a.id });
  if (a.type === 'text') {
    for (const r of a.rects) g.append(svgEl('rect', { x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1], fill: hlById(a.color).fill, style: 'mix-blend-mode:multiply' }));
  } else if (a.type === 'free') {
    g.append(svgEl('polyline', { points: ptsAttr(a.points), fill: 'none', stroke: hlById(a.color).hex, 'stroke-width': a.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.42, style: 'mix-blend-mode:multiply' }));
  } else {
    g.append(svgEl('polyline', { points: ptsAttr(a.points), fill: 'none', stroke: penById(a.color).hex, 'stroke-width': a.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  }
  if (a.doubt) {
    const b = annotBBox(a);
    const cx = b[2] + 7, cy = b[1] + 2;
    g.append(svgEl('circle', { cx, cy, r: 6.5, fill: '#13263A' }));
    const t = svgEl('text', { x: cx, y: cy + 3.4, 'text-anchor': 'middle', 'font-size': 9.5, 'font-weight': 800, fill: '#fff', 'font-family': 'system-ui,sans-serif' });
    t.textContent = '?';
    g.append(t);
  }
  return g;
}

export function drawOverlay(p) {
  p.svg.querySelectorAll('g[data-id]').forEach(n => n.remove());
  const list = R.annots.filter(a => a.page === p.n);
  // marca-texto por baixo, caneta por cima
  list.sort((a, b) => (a.type === 'ink') - (b.type === 'ink'));
  for (const a of list) p.svg.append(shapeFor(a));
}

export function drawMarkers() {
  $$('.page .marker, .page .ribbon').forEach(n => n.remove());
  for (const m of R.doc.markers || []) {
    const p = R.pages[m.page - 1]; if (!p) continue;
    const el = h('div', { class: 'marker' + (m.done ? ' done' : ''), 'data-marker': m.id, style: `top:${(m.y / p.h1) * 100}%` },
      h('span', { class: 'tag' }, (m.done ? 'Sessão processada · ' : 'Fim da sessão · ') + fmtDate(m.date)),
      h('span', { class: 'ln' }));
    p.el.append(el);
  }
  for (const n of R.doc.bookmarks || []) R.pages[n - 1]?.el.append(h('div', { class: 'ribbon', title: 'Marcador de página' }));
}

/* ===================== ferramentas ===================== */
export function renderToolbar() {
  $$('.tool[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === R.tool));
  $('#btn-doubt').setAttribute('aria-pressed', R.doubt);
  const isPen = R.tool === 'pen';
  const list = isPen ? PENS : HL;
  const cur = isPen ? R.pen : R.color;
  const sw = $('#swatches');
  sw.innerHTML = '';
  for (const c of list) {
    sw.append(h('button', {
      type: 'button', class: 'sw' + (c.id === cur ? ' on' : ''), 'aria-label': c.label, 'data-tip': c.label,
      onclick: () => { if (isPen) R.pen = c.id; else { R.color = c.id; if (!['text', 'free'].includes(R.tool)) R.tool = 'text'; } renderToolbar(); }
    }, h('span', { style: 'background:' + c.hex })));
  }
  document.body.classList.toggle('mode-eraser', R.tool === 'eraser');
  $('#panel').hidden = !R.panelOpen;
  $('#btn-panel').setAttribute('aria-pressed', R.panelOpen);
}

export function setTool(t) { R.tool = t; renderToolbar(); }

/* ===================== entrada (S Pen / mouse) ===================== */
let act = null;   // ação em curso
let lastHL = 'text';
const pinch = { on: false };

function pageAt(x, y) {
  for (const el of document.elementsFromPoint(x, y)) {
    const pe = el.closest?.('.page');
    if (pe) return R.pages[+pe.dataset.page - 1];
  }
  return null;
}
function toUnits(p, x, y) {
  const r = p.el.getBoundingClientRect();
  return [(x - r.left) / R.scale, (y - r.top) / R.scale];
}

export function bindInput() {
  const el = pagesEl();
  // impede a rolagem quando a S Pen encosta; o dedo continua rolando
  el.addEventListener('touchstart', e => {
    if ([...e.touches].some(t => t.touchType === 'stylus')) { e.preventDefault(); return; }
    if (e.touches.length === 2) startPinch(e);
  }, { passive: false });
  el.addEventListener('touchmove', e => { if (pinch.on) { e.preventDefault(); movePinch(e); } }, { passive: false });
  el.addEventListener('touchend', e => { if (pinch.on && e.touches.length < 2) endPinch(); });
  el.addEventListener('touchcancel', () => { if (pinch.on) endPinch(); });

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onCancel);
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('selectstart', e => e.preventDefault());
  el.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomAt(R.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX, e.clientY);
  }, { passive: false });
  el.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => { if (R.doc) { const pos = currentPos(); layout(); scrollToPos(pos.page, pos.y); } });
}

function onDown(e) {
  if (!R.doc || pinch.on) return;
  if (e.pointerType === 'touch') return;          // dedo = rolar
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  // botão lateral da S Pen: alterna grifo ↔ caneta
  if (e.pointerType === 'pen' && (e.buttons & 2 || e.button === 2)) {
    if (R.tool === 'pen') setTool(lastHL); else { if (['text', 'free'].includes(R.tool)) lastHL = R.tool; setTool('pen'); }
    toast(R.tool === 'pen' ? 'Caneta' : (R.tool === 'free' ? 'Marca-texto livre' : 'Grifo de texto'), 1000);
    e.preventDefault();
    return;
  }
  const p = pageAt(e.clientX, e.clientY);
  if (!p) return;
  e.preventDefault();
  pagesEl().setPointerCapture(e.pointerId);
  const pt = toUnits(p, e.clientX, e.clientY);
  const tool = R.tool;
  if (tool === 'eraser') { act = { tool, p }; eraseAt(e.clientX, e.clientY); return; }
  if (tool === 'bookmark') { toggleBookmark(p.n); return; }
  if (tool === 'end') { placeEndMarker(p.n, pt[1]); return; }
  if (tool === 'text' && p.textDiv && p.hasText) {
    const start = caretAt(p, e.clientX, e.clientY);
    act = { tool: 'text', p, start, preview: svgEl('g', {}) };
    p.svg.append(act.preview);
    return;
  }
  // marca-texto livre (também no escaneado com a ferramenta de grifo) ou caneta
  const type = tool === 'pen' ? 'ink' : 'free';
  const width = type === 'ink' ? PEN_W : FREE_W;
  const color = type === 'ink' ? R.pen : R.color;
  const line = svgEl('polyline', type === 'ink'
    ? { fill: 'none', stroke: penById(color).hex, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }
    : { fill: 'none', stroke: hlById(color).hex, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.42, style: 'mix-blend-mode:multiply' });
  p.svg.append(line);
  act = { tool: type, p, points: [pt], line, color, width, straight: false, hold: 0 };
  if (type === 'free') armHold();
}

function armHold() {
  clearTimeout(act.hold);
  act.hold = setTimeout(() => {
    if (act && act.tool === 'free' && act.points.length > 2) {
      act.straight = true;
      const a = act.points[0], b = act.points[act.points.length - 1];
      act.line.setAttribute('points', ptsAttr([a, [b[0], Math.abs(b[1] - a[1]) < 14 ? a[1] : b[1]]]));
    }
  }, HOLD_MS);
}

function onMove(e) {
  if (!act || pinch.on) return;
  if (act.tool === 'eraser') { eraseAt(e.clientX, e.clientY); return; }
  if (act.tool === 'text') {
    const end = caretAt(act.p, e.clientX, e.clientY);
    act.end = end;
    const rects = rangeRects(act.p, act.start, end);
    act.preview.innerHTML = '';
    for (const r of rects) act.preview.append(svgEl('rect', { x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1], fill: hlById(R.color).fill, style: 'mix-blend-mode:multiply' }));
    act.rects = rects;
    return;
  }
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of evs) {
    const pt = toUnits(act.p, ev.clientX, ev.clientY);
    const last = act.points[act.points.length - 1];
    if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) < 0.6) continue;
    if (act.straight) {
      // saiu do "segurar": volta ao traço livre
      if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) > 6) act.straight = false; else continue;
    }
    act.points.push(pt);
    if (act.tool === 'free' && Math.hypot(pt[0] - last[0], pt[1] - last[1]) > 1.2) armHold();
  }
  if (!act.straight) act.line.setAttribute('points', ptsAttr(act.points));
}

async function onUp(e) {
  if (!act) return;
  const a = act; act = null;
  clearTimeout(a.hold);
  if (a.tool === 'eraser') return;
  if (a.tool === 'text') {
    a.preview.remove();
    const rects = a.rects || [];
    if (!rects.length || !a.end) return;
    const text = rangeText(a.start, a.end);
    if (!text.trim()) return;
    await addAnnot({ type: 'text', page: a.p.n, color: R.color, doubt: R.doubt, rects, text, top: Math.min(...rects.map(r => r[1])) });
    return;
  }
  a.line.remove();
  let pts = a.points;
  if (a.tool === 'free' && a.straight) {
    const s = pts[0], t = pts[pts.length - 1];
    pts = [s, [t[0], Math.abs(t[1] - s[1]) < 14 ? s[1] : t[1]]];
  }
  if (pts.length < 2) {
    if (a.tool === 'ink') pts = [pts[0], [pts[0][0] + 0.5, pts[0][1] + 0.5]]; // ponto
    else return;
  }
  pts = pts.map(q => [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10]);
  const ys = pts.map(q => q[1]);
  await addAnnot({ type: a.tool, page: a.p.n, color: a.color, doubt: a.tool === 'free' ? R.doubt : false, points: pts, width: a.width, top: Math.min(...ys) - a.width / 2 });
}
function onCancel() { if (act) { act.preview?.remove(); act.line?.remove(); clearTimeout(act.hold); act = null; } }

/* ---------- seleção de texto (grifo que segue a linha) ---------- */
function caretRaw(x, y) {
  if (document.caretPositionFromPoint) {
    const c = document.caretPositionFromPoint(x, y);
    return c ? { node: c.offsetNode, offset: c.offset } : null;
  }
  const r = document.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}
function caretAt(p, x, y) {
  const c = caretRaw(x, y);
  if (c && c.node.nodeType === 3 && p.textDiv.contains(c.node)) return c;
  // fora de um trecho de texto: procura o trecho mais próximo na mesma linha
  let best = null, bd = Infinity;
  for (const s of p.textDiv.querySelectorAll('span')) {
    if (!s.firstChild || s.firstChild.nodeType !== 3 || !s.textContent.trim()) continue;
    const r = s.getBoundingClientRect();
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const d = dy * 4 + dx;
    if (d < bd) { bd = d; best = { s, r }; }
  }
  if (!best) return null;
  const tn = best.s.firstChild;
  if (x <= best.r.left) return { node: tn, offset: 0 };
  if (x >= best.r.right) return { node: tn, offset: tn.length };
  const c2 = caretRaw(x, (best.r.top + best.r.bottom) / 2);
  if (c2 && c2.node === tn) return c2;
  return { node: tn, offset: x - best.r.left < best.r.right - x ? 0 : tn.length };
}
function makeRange(a, b) {
  if (!a || !b) return null;
  const r = document.createRange();
  r.setStart(a.node, a.offset); r.setEnd(a.node, a.offset);
  const r2 = document.createRange();
  r2.setStart(b.node, b.offset);
  if (r.compareBoundaryPoints(Range.START_TO_START, r2) <= 0) { r.setEnd(b.node, b.offset); }
  else { r.setStart(b.node, b.offset); r.setEnd(a.node, a.offset); }
  return r;
}
function rangeRects(p, a, b) {
  const r = makeRange(a, b);
  if (!r) return [];
  const pr = p.el.getBoundingClientRect();
  const raw = [...r.getClientRects()].filter(q => q.width > 0.5 && q.height > 0.5)
    .map(q => [(q.left - pr.left) / R.scale, (q.top - pr.top) / R.scale, (q.right - pr.left) / R.scale, (q.bottom - pr.top) / R.scale]);
  // junta retângulos da mesma linha
  raw.sort((u, v) => u[1] - v[1] || u[0] - v[0]);
  const lines = [];
  for (const q of raw) {
    const L = lines.find(l => {
      const ov = Math.min(l[3], q[3]) - Math.max(l[1], q[1]);
      return ov > 0.5 * Math.min(l[3] - l[1], q[3] - q[1]) && q[0] - l[2] < 40;
    });
    if (L) { L[0] = Math.min(L[0], q[0]); L[1] = Math.min(L[1], q[1]); L[2] = Math.max(L[2], q[2]); L[3] = Math.max(L[3], q[3]); }
    else lines.push([...q]);
  }
  return lines.map(l => l.map(v => Math.round(v * 10) / 10));
}
function rangeText(a, b) {
  const r = makeRange(a, b);
  if (!r) return '';
  // junta os trechos de cada linha com espaço (a camada de texto separa as linhas sem espaço)
  const frag = r.cloneContents();
  const parts = [];
  const w = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) parts.push(w.currentNode.nodeValue);
  if (!parts.length) parts.push(r.toString());
  return parts.join(' ').replace(/-\s+(?=[a-zà-ú])/g, '').replace(/\s+/g, ' ').trim();
}

/* ---------- borracha, marcador, marco ---------- */
function eraseAt(x, y) {
  for (const el of document.elementsFromPoint(x, y)) {
    const g = el.closest?.('g[data-id]');
    if (g) { deleteAnnot(g.dataset.id); return; }
    const m = el.closest?.('.marker:not(.done)');
    if (m) { removeMarker(m.dataset.marker); return; }
  }
}

async function toggleBookmark(n) {
  const b = new Set(R.doc.bookmarks || []);
  b.has(n) ? b.delete(n) : b.add(n);
  R.doc.bookmarks = [...b].sort((x, y) => x - y);
  drawMarkers(); await persistDoc();
  toast(b.has(n) ? 'Página marcada' : 'Marcador removido', 1200);
}

export function sessionStart() {
  const done = (R.doc.markers || []).filter(m => m.done).sort((a, b) => posKey(b.page, b.y) - posKey(a.page, a.y));
  return done[0] ? { page: done[0].page, y: done[0].y, date: done[0].date, fromMarker: true } : { page: 1, y: 0, fromMarker: false };
}
export function sessionEnd() { return (R.doc.markers || []).find(m => !m.done) || null; }

export async function placeEndMarker(page, y) {
  const s = sessionStart();
  if (posKey(page, y) <= posKey(s.page, s.y)) { toast('O marco precisa ficar depois do início da sessão (p. ' + s.page + ').'); return; }
  const prev = sessionEnd();
  R.doc.markers = (R.doc.markers || []).filter(m => m.done);
  R.doc.markers.push({ id: uid(), page, y: Math.round(y * 10) / 10, date: Date.now(), done: false });
  R.undo.push({ kind: 'marker', prev });
  drawMarkers(); await persistDoc();
  toast('Marco de fim colocado na p. ' + page, 1500);
  setTool(lastHL);
}
async function removeMarker(id) {
  const m = (R.doc.markers || []).find(x => x.id === id);
  R.doc.markers = (R.doc.markers || []).filter(x => x.id !== id);
  R.undo.push({ kind: 'marker', prev: m });
  drawMarkers(); await persistDoc();
}

/* ---------- anotações ---------- */
async function addAnnot(a) {
  const full = { id: uid(), docId: R.doc.id, createdAt: Date.now(), packaged: false, ...a };
  R.annots.push(full);
  await db.put('annots', full);
  R.undo.push({ kind: 'add', id: full.id });
  drawOverlay(R.pages[full.page - 1]);
  updatePanel();
}
export async function deleteAnnot(id, record = true) {
  const a = R.annots.find(x => x.id === id); if (!a) return;
  R.annots = R.annots.filter(x => x.id !== id);
  await db.del('annots', id);
  if (record) R.undo.push({ kind: 'del', annot: a });
  drawOverlay(R.pages[a.page - 1]);
  updatePanel();
}
async function toggleDoubtOf(id) {
  const a = R.annots.find(x => x.id === id); if (!a) return;
  a.doubt = !a.doubt;
  await db.put('annots', a);
  drawOverlay(R.pages[a.page - 1]); updatePanel();
}
export async function undo() {
  const u = R.undo.pop();
  if (!u) { toast('Nada para desfazer', 1000); return; }
  if (u.kind === 'add') await deleteAnnot(u.id, false);
  else if (u.kind === 'del') { R.annots.push(u.annot); await db.put('annots', u.annot); drawOverlay(R.pages[u.annot.page - 1]); updatePanel(); }
  else if (u.kind === 'marker') {
    R.doc.markers = (R.doc.markers || []).filter(m => m.done);
    if (u.prev) R.doc.markers.push(u.prev);
    drawMarkers(); await persistDoc();
  }
}

/* ===================== agrupar a escrita à mão ===================== */
export function groupInk(inks) {
  // traços próximos na mesma página = uma anotação
  const GAP = 22;
  const items = inks.map(a => ({ a, b: annotBBox(a) }));
  const parent = items.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const A = items[i], B = items[j];
    if (A.a.page !== B.a.page) continue;
    const dx = Math.max(0, Math.max(A.b[0], B.b[0]) - Math.min(A.b[2], B.b[2]));
    const dy = Math.max(0, Math.max(A.b[1], B.b[1]) - Math.min(A.b[3], B.b[3]));
    if (dx < GAP && dy < GAP) parent[find(i)] = find(j);
  }
  const groups = new Map();
  items.forEach((it, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(it.a); });
  return [...groups.values()];
}

/* ===================== painel de marcações ===================== */
const FILTERS = [
  { id: 'all', label: 'Todas' },
  { id: 'yellow', dot: '#F5CF1F', aria: 'Marcação' },
  { id: 'orange', dot: '#F28C1E', aria: 'Mais importante' },
  { id: 'red', dot: '#E2584A', aria: 'Extrema atenção' },
  { id: 'doubt', label: '?', aria: 'Dúvidas' },
  { id: 'hand', pen: true, aria: 'À mão' }
];
const penIcon = () => { const s = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }); s.append(svgEl('path', { d: 'M4 20l4-1 11-11-3-3L5 16z' })); return s; };

export function updatePanel() {
  const pend = R.annots.filter(a => !a.packaged);
  $('#panel-count').textContent = pend.length;
  $('#panel-total').textContent = pend.length;
  const f = $('#panel-filters'); f.innerHTML = '';
  for (const it of FILTERS) {
    f.append(h('button', { type: 'button', class: 'fbtn' + (R.filter === it.id ? ' on' : ''), 'aria-label': it.aria || it.label, onclick: () => { R.filter = it.id; updatePanel(); } },
      it.dot ? h('span', { class: 'dot', style: 'background:' + it.dot }) : it.pen ? penIcon() : it.label));
  }
  const list = pend.filter(a =>
    R.filter === 'all' ? true : R.filter === 'doubt' ? a.doubt : R.filter === 'hand' ? a.type === 'ink' : a.type !== 'ink' && a.color === R.filter)
    .sort((a, b) => posKey(a.page, a.top) - posKey(b.page, b.top));
  const L = $('#panel-list'); L.innerHTML = '';
  if (!list.length) { L.append(h('div', { class: 'panel-empty' }, pend.length ? 'Nada neste filtro.' : 'Nenhuma marcação pendente. Grife com a S Pen; o dedo rola a página.')); return; }
  // traços de caneta próximos aparecem como uma anotação só
  const inkGroups = groupInk(list.filter(a => a.type === 'ink'));
  const items = list.filter(a => a.type !== 'ink').map(a => ({ a, ids: [a.id] }));
  for (const g of inkGroups) {
    g.sort((x, y) => x.top - y.top);
    items.push({ a: g[0], ids: g.map(x => x.id), n: g.length, cores: [...new Set(g.map(x => penById(x.color).label.toLowerCase()))] });
  }
  items.sort((x, y) => posKey(x.a.page, x.a.top) - posKey(y.a.page, y.a.top));
  for (const { a, ids, cores } of items) {
    const label = a.type === 'text' ? a.text : a.type === 'free' ? 'Marca-texto livre' : 'Anotação à mão · ' + cores.join(', ');
    L.append(h('div', { class: 'mitem', onclick: () => scrollToPos(a.page, a.top - 40) },
      h('div', { class: 'mitem-top' },
        h('span', { class: 'dot' + (a.type === 'ink' ? ' sq' : ''), style: 'background:' + colorOf(a) }),
        h('span', {}, 'p. ' + a.page),
        h('span', { class: 'acts' },
          a.type !== 'ink' ? h('button', { type: 'button', class: a.doubt ? 'on' : '', 'aria-label': 'Dúvida', onclick: e => { e.stopPropagation(); toggleDoubtOf(a.id); } }, '?') : null,
          h('button', { type: 'button', 'aria-label': 'Apagar', onclick: async e => { e.stopPropagation(); for (const id of ids) await deleteAnnot(id); } }, (() => { const s = svgEl('svg', { viewBox: '0 0 24 24' }); s.append(svgEl('path', { d: 'M6 6l12 12M18 6L6 18' })); return s; })()))),
      h('div', { class: 'mitem-text' + (a.type === 'text' ? '' : ' hand') }, label.length > 220 ? label.slice(0, 220) + '…' : label)));
  }
}

/* ===================== rolagem, zoom e posição ===================== */
export function scrollToPos(page, y = 0) {
  const p = R.pages[Math.max(0, Math.min(R.pages.length - 1, page - 1))];
  if (!p) return;
  pagesEl().scrollTop = p.el.offsetTop + Math.max(0, y) * R.scale - 12;
}
function currentPos() {
  const el = pagesEl();
  const top = el.scrollTop + 60;
  for (const p of R.pages) {
    if (p.el.offsetTop + p.el.offsetHeight > top) return { page: p.n, y: Math.max(0, (top - p.el.offsetTop) / R.scale - 60 / R.scale) };
  }
  return { page: R.pages.length, y: 0 };
}
function onScroll() {
  if (!R.doc) return;
  const el = pagesEl();
  const mid = el.scrollTop + el.clientHeight / 3;
  let cur = 1;
  for (const p of R.pages) { if (p.el.offsetTop <= mid) cur = p.n; else break; }
  if (cur !== R.current) {
    R.current = cur;
    $('#doc-page').textContent = 'p. ' + cur + ' / ' + R.pages.length;
    R.doc.lastPage = cur;
    clearTimeout(saveT); saveT = setTimeout(persistDoc, 1200);
  }
}
function zoomAt(z, cx, cy) {
  z = Math.max(0.5, Math.min(4, z));
  const el = pagesEl();
  const r = el.getBoundingClientRect();
  const mx = cx - r.left, my = cy - r.top;
  const old = R.scale;
  const px = el.scrollLeft + mx, py = el.scrollTop + my;
  R.zoom = z; layout();
  const k = R.scale / old;
  el.scrollLeft = px * k - mx; el.scrollTop = py * k - my;
}
function startPinch(e) {
  const [a, b] = e.touches;
  const el = pagesEl(), r = el.getBoundingClientRect();
  Object.assign(pinch, { on: true, d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2, ratio: 1 });
  innerEl().style.transformOrigin = (el.scrollLeft + pinch.cx - r.left) + 'px ' + (el.scrollTop + pinch.cy - r.top) + 'px';
}
function movePinch(e) {
  if (e.touches.length < 2) return;
  const [a, b] = e.touches;
  pinch.ratio = Math.max(0.4, Math.min(5, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.d0));
  innerEl().style.transform = `scale(${pinch.ratio})`;
}
function endPinch() {
  pinch.on = false;
  innerEl().style.transform = '';
  if (Math.abs(pinch.ratio - 1) > 0.03) zoomAt(R.zoom * pinch.ratio, pinch.cx, pinch.cy);
}

export async function persistDoc() {
  if (!R.doc) return;
  clearTimeout(saveT);
  await db.put('docs', R.doc);
}

export function addPageEndMarker() {
  const p = R.pages[R.current - 1];
  return placeEndMarker(p.n, p.h1 - 1);
}
