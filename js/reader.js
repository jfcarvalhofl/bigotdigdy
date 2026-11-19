import { db, uid } from './db.js';
import { loadPdf, closePdf, pdfjsLib } from './pdf.js';
import { HL, PENS, hlById, penById, colorOf, $, $$, h, toast, fmtDate, posKey } from './common.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const FREE_W = 11;      // espessura do marca-texto livre (pontos PDF)
const PEN_W = 1.5;      // espessura da caneta (pontos PDF)
const HOLD_MS = 550;    // segurar parado no fim do traço → endireita
export const ERASER_MODES = [{ id: 'all', label: 'Apaga tudo' }, { id: 'ink', label: 'Só caneta' }, { id: 'hl', label: 'Só grifo' }];
export const ERASERS = [{ id: 's', d: 14, label: 'Borracha pequena' }, { id: 'm', d: 30, label: 'Borracha média' }, { id: 'l', d: 60, label: 'Borracha grande' }];

export const R = {
  doc: null, pdf: null, pages: [], annots: [],
  zoom: 1, scale: 1,
  tool: 'text', color: 'yellow', pen: 'blue', doubt: false,
  panelOpen: false, filter: 'all', eraser: 'm', eraserMode: 'all',
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
  clearSelection();
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
  if (sel && sel.page === p.n && p.svg.querySelector('.sel-box')) p.svg.append(p.svg.querySelector('.sel-box'));
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
  if (R.tool === 'eraser') {
    for (const z of ERASERS) {
      const px = Math.round(6 + z.d / 4);
      sw.append(h('button', { type: 'button', class: 'sw' + (z.id === R.eraser ? ' on' : ''), 'aria-label': z.label, 'data-tip': z.label, onclick: () => { R.eraser = z.id; renderToolbar(); } },
        h('span', { style: `width:${px}px;height:${px}px;background:transparent;border:2px solid #F1F4F7` })));
    }
    sw.append(h('span', { class: 'sep' }));
    const icons = { all: 'M8 20h12M4.5 15.5l9-9 6 6-7 7H9z', ink: 'M4 20l4-1 11-11-3-3L5 16z', hl: 'M7.5 18L12 5.5 16.5 18M9.2 13.5h5.6' };
    for (const m of ERASER_MODES) {
      const ic = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
      if (m.id === 'hl') ic.append(svgEl('rect', { x: 2.5, y: 9, width: 19, height: 9, rx: 1.5, fill: 'currentColor', opacity: '.35', stroke: 'none' }));
      ic.append(svgEl('path', { d: icons[m.id] }));
      sw.append(h('button', { type: 'button', class: 'tool' + (R.eraserMode === m.id ? ' on' : ''), 'aria-label': m.label, 'data-tip': m.label, onclick: () => { R.eraserMode = m.id; renderToolbar(); } }, ic));
    }
    document.body.classList.add('mode-eraser');
    $('#panel').hidden = !R.panelOpen;
    $('#btn-panel').setAttribute('aria-pressed', R.panelOpen);
    return;
  }
  if (['lasso', 'bookmark', 'end'].includes(R.tool)) {
    document.body.classList.remove('mode-eraser');
    $('#panel').hidden = !R.panelOpen; $('#btn-panel').setAttribute('aria-pressed', R.panelOpen);
    return;
  }
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

export function setTool(t) { R.tool = t; clearSelection(); eraserCursor(null); renderToolbar(); }

/* ===================== entrada (S Pen / mouse) ===================== */
let act = null;   // ação em curso
const noTextWarned = new Set();
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
  // A área das páginas não deixa o navegador rolar sozinho (touch-action: none).
  // O app rola com o dedo, faz pinça com dois dedos e desenha com a S Pen sem ser interrompido.
  el.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onCancel);
  el.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch' && !act) eraserCursor(null); });
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('selectstart', e => e.preventDefault());
  el.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomAt(R.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX, e.clientY);
  }, { passive: false });
  el.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => { if (R.doc) { const pos = currentPos(); layout(); scrollToPos(pos.page, pos.y); } });
  document.body.append(h('div', { id: 'eraser-cursor', hidden: true }));
}

/* ---------- diagnóstico (toque na versão, na biblioteca) ---------- */
export const DIAG = { on: false };
function diag(e) {
  if (!DIAG.on || !e?.type) return;
  let box = $('#diag');
  if (!box) { box = h('div', { id: 'diag' }); document.body.append(box); }
  box.textContent = `${e.type} · tipo=${e.pointerType} · buttons=${e.buttons} · button=${e.button} · pressão=${(e.pressure ?? 0).toFixed(2)} · ferramenta=${R.tool} · ação=${act?.tool || '-'}`;
}

/* ---------- dedo: rolar com inércia e pinça ---------- */
const touches = new Map();
let pan = null, momentumRaf = 0, lastPenTime = 0;

function touchDown(e) {
  if (act || Date.now() - lastPenTime < 300) return;   // palma apoiada enquanto escreve
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try { pagesEl().setPointerCapture(e.pointerId); } catch {}
  cancelAnimationFrame(momentumRaf);
  if (touches.size === 1) {
    const el = pagesEl();
    pan = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop, samples: [{ t: performance.now(), x: e.clientX, y: e.clientY }] };
  } else if (touches.size === 2) { pan = null; startPinch(); }
}
function touchMove(e) {
  if (!touches.has(e.pointerId)) return;
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch.on) { movePinch(); return; }
  if (!pan) return;
  const el = pagesEl();
  el.scrollLeft = pan.sl - (e.clientX - pan.x);
  el.scrollTop = pan.st - (e.clientY - pan.y);
  pan.samples.push({ t: performance.now(), x: e.clientX, y: e.clientY });
  if (pan.samples.length > 6) pan.samples.shift();
}
function touchUp(e) {
  if (!touches.has(e.pointerId)) return;
  touches.delete(e.pointerId);
  if (pinch.on) { if (touches.size < 2) endPinch(); return; }
  if (pan && touches.size === 0) {
    const sm = pan.samples, a = sm[0], b = sm[sm.length - 1];
    const dt = b.t - a.t;
    if (dt > 0 && performance.now() - b.t < 90) momentum((b.x - a.x) / dt, (b.y - a.y) / dt);
    pan = null;
  }
}
function momentum(vx, vy) {
  const el = pagesEl();
  let last = performance.now();
  const step = now => {
    const dt = Math.min(40, now - last); last = now;
    el.scrollLeft -= vx * dt; el.scrollTop -= vy * dt;
    const k = Math.pow(0.996, dt); vx *= k; vy *= k;
    if (Math.hypot(vx, vy) > 0.03) momentumRaf = requestAnimationFrame(step);
  };
  momentumRaf = requestAnimationFrame(step);
}
function stopTouches() { touches.clear(); pan = null; cancelAnimationFrame(momentumRaf); if (pinch.on) { pinch.on = false; innerEl().style.transform = ''; } }

/* ---------- cursor da borracha ---------- */
function eraserCursor(e, force = false) {
  const c = $('#eraser-cursor'); if (!c) return;
  if (!e || (R.tool !== 'eraser' && !force)) { c.hidden = true; return; }
  const d = (ERASERS.find(z => z.id === R.eraser) || ERASERS[1]).d;
  c.hidden = false;
  c.style.width = c.style.height = d + 'px';
  c.style.transform = `translate(${e.clientX - d / 2}px, ${e.clientY - d / 2}px)`;
}

function onDown(e) {
  diag(e);
  if (!R.doc) return;
  if (e.pointerType === 'touch') { touchDown(e); return; }   // dedo = rolar / pinça
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (e.pointerType === 'pen') { lastPenTime = Date.now(); stopTouches(); }
  const p = pageAt(e.clientX, e.clientY);
  if (!p) return;
  e.preventDefault();
  try { pagesEl().setPointerCapture(e.pointerId); } catch {}
  const pt = toUnits(p, e.clientX, e.clientY);
  const tool = R.tool;
  // botão lateral da S Pen segurado = borracha enquanto encostar
  const penButton = e.pointerType === 'pen' && ((e.buttons & 2) || (e.buttons & 32) || e.button === 2 || e.button === 5);
  if (tool === 'eraser' || penButton) {
    clearSelection();
    act = { tool: 'eraser', p, removed: [], added: new Set(), markers: [], pages: new Set(), temp: penButton && tool !== 'eraser' };
    eraserCursor(e, true); eraseAt(e.clientX, e.clientY);
    return;
  }
  // com algo selecionado: alça estica/encurta, arrastar dentro da caixa move
  if (sel && sel.page === p.n) {
    const hd = hitHandle(pt);
    if (hd) { act = { tool: 'handle', p, which: hd, prev: selItems().map(cloneA) }; hidePop(); return; }
    if (sel.bb && pt[0] >= sel.bb[0] - 4 && pt[0] <= sel.bb[2] + 4 && pt[1] >= sel.bb[1] - 4 && pt[1] <= sel.bb[3] + 4 && selItems().some(a => a.type !== 'text')) {
      act = { tool: 'move', p, from: pt, prev: selItems().map(cloneA), tap: [e.clientX, e.clientY] }; hidePop(); return;
    }
  }
  clearSelection();
  if (tool === 'lasso') {
    const line = svgEl('polyline', { fill: 'rgba(11,110,119,0.06)', stroke: '#0B6E77', 'stroke-width': 1.2 / Math.max(0.5, R.scale) * 1.6, 'stroke-dasharray': '4 3' });
    p.svg.append(line);
    act = { tool: 'lasso', p, points: [pt], line, tap: [e.clientX, e.clientY] };
    return;
  }
  if (tool === 'bookmark') { toggleBookmark(p.n); return; }
  if (tool === 'end') { placeEndMarker(p.n, pt[1]); return; }
  if (tool === 'text' && p.textDiv && p.hasText) {
    const start = caretAt(p, e.clientX, e.clientY);
    act = { tool: 'text', p, start, preview: svgEl('g', {}), tap: [e.clientX, e.clientY] };
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
  const snap = tool === 'text';   // ferramenta de grifo numa página sem texto reconhecido
  if (snap && !noTextWarned.has(p.n)) { noTextWarned.add(p.n); toast(p.hasText == null ? 'Página ainda carregando o texto: grifo em linha reta.' : 'Página sem texto reconhecido (escaneada): o grifo sai em linha reta.', 2600); }
  act = { tool: type, p, points: [pt], line, color, width, straight: false, hold: 0, tap: [e.clientX, e.clientY], snap };
  if (type === 'free' && !snap) armHold();
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
  diag(e);
  if (e.pointerType === 'touch') { touchMove(e); return; }
  if (e.pointerType === 'pen' && e.buttons) lastPenTime = Date.now();
  if (!act) { if (R.tool === 'eraser') eraserCursor(e); return; }
  if (act.tool === 'handle') { dragHandle(act, toUnits(act.p, e.clientX, e.clientY), e); return; }
  if (act.tool === 'move') { dragMove(act, toUnits(act.p, e.clientX, e.clientY)); return; }
  if (act.tool === 'lasso') {
    const pt = toUnits(act.p, e.clientX, e.clientY);
    act.points.push(pt);
    act.line.setAttribute('points', ptsAttr(act.points));
    return;
  }
  if (act.tool === 'eraser') {
    eraserCursor(e, true);
    const evs = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
    for (const ev of evs) eraseAt(ev.clientX, ev.clientY);
    return;
  }
  if (act.tool === 'text') {
    const end = caretAt(act.p, e.clientX, e.clientY);
    act.end = end;
    const rects = rangeRects(act.p, act.start, end);
    act.preview.innerHTML = '';
    for (const r of rects) act.preview.append(svgEl('rect', { x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1], fill: hlById(R.color).fill, style: 'mix-blend-mode:multiply' }));
    act.rects = rects;
    return;
  }
  const evs = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
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
  if (act.snap) { const a0 = act.points[0], z = act.points[act.points.length - 1]; act.line.setAttribute('points', ptsAttr([a0, [z[0], a0[1]]])); }
  else if (!act.straight) act.line.setAttribute('points', ptsAttr(act.points));
}

async function onUp(e) {
  diag(e);
  if (e.pointerType === 'touch') { touchUp(e); return; }
  if (e.pointerType === 'pen') lastPenTime = Date.now();
  if (!act) return;
  const a = act; act = null;
  clearTimeout(a.hold);
  if (a.tool === 'eraser') { await commitErase(a); if (a.temp) eraserCursor(null); else if (e.pointerType === 'mouse') eraserCursor(e); return; }
  if (a.tool === 'handle' || a.tool === 'move') {
    const items = selItems();
    const moved = a.tool === 'handle' || items.some((it, i) => JSON.stringify(it.points || it.rects) !== JSON.stringify(a.prev[i]?.points || a.prev[i]?.rects));
    if (moved) {
      R.undo.push({ kind: 'edit', prev: a.prev });
      for (const it of items) await db.put('annots', it);
      updatePanel();
    }
    showSelection(sel.ids, a.p);
    return;
  }
  if (a.tool === 'lasso') {
    a.line.remove();
    let len = 0;
    for (let i = 1; i < a.points.length; i++) len += Math.hypot(a.points[i][0] - a.points[i - 1][0], a.points[i][1] - a.points[i - 1][1]);
    if (len < 6) { trySelect(a.p, a.tap); return; }
    const ids = lassoPick(a.p, a.points);
    if (ids.length) showSelection(ids, a.p); else toast('Nada dentro do laço.', 1200);
    return;
  }
  if (a.tool === 'text') {
    a.preview.remove();
    const rects = a.rects || [];
    if (!rects.length || !a.end) { trySelect(a.p, a.tap); return; }
    const text = rangeText(a.start, a.end);
    if (!text.trim()) return;
    await addAnnot({ type: 'text', page: a.p.n, color: R.color, doubt: R.doubt, rects, text, top: Math.min(...rects.map(r => r[1])) });
    return;
  }
  a.line.remove();
  let pts = a.points;
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (len < 3 && trySelect(a.p, a.tap)) return;
  if (a.snap && len >= 3) {
    // linha reta na altura média do traço
    const xs = pts.map(q => q[0]), ym = pts.reduce((t, q) => t + q[1], 0) / pts.length;
    pts = [[Math.min(...xs), ym], [Math.max(...xs), ym]];
  } else if (a.tool === 'free' && a.straight) {
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
function onCancel(e) {
  if (e?.pointerType === 'touch') { touchUp(e); return; }
  if (!act) return;
  if (act.tool === 'eraser') { const a = act; act = null; commitErase(a); return; }
  // traço interrompido pelo sistema: salva o que já foi desenhado em vez de perder
  if (['free', 'ink', 'text', 'handle', 'move', 'lasso'].includes(act.tool)) { onUp({ pointerType: 'pen' }); return; }
  act = null;
}

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

/* ---------- seleção de uma marcação (toque rápido) ---------- */
let sel = null;   // { ids, page }

function distToPolyline(x, y, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return pts.length === 1 ? Math.hypot(x - pts[0][0], y - pts[0][1]) : best;
}
function hitAnnot(p, ux, uy) {
  const tol = 10 / R.scale;
  const list = R.annots.filter(a => a.page === p.n);
  // com a caneta, a escrita à mão tem preferência; com o grifo, o grifo
  const preferInk = R.tool === 'pen';
  list.sort((a, b) => preferInk ? (b.type === 'ink') - (a.type === 'ink') : (a.type === 'ink') - (b.type === 'ink'));
  for (const a of list) {
    if (a.type === 'text') { if (a.rects.some(q => ux >= q[0] - 2 && ux <= q[2] + 2 && uy >= q[1] - 2 && uy <= q[3] + 2)) return a; }
    else if (distToPolyline(ux, uy, a.points) <= a.width / 2 + tol) return a;
  }
  return null;
}
function trySelect(p, tap) {
  if (!tap) return false;
  const [ux, uy] = toUnits(p, tap[0], tap[1]);
  const a = hitAnnot(p, ux, uy);
  if (!a) return false;
  // escrita à mão: seleciona a anotação inteira (traços próximos)
  let ids = [a.id];
  if (a.type === 'ink') {
    const g = groupInk(R.annots.filter(q => q.type === 'ink' && q.page === p.n)).find(gr => gr.some(q => q.id === a.id));
    if (g) ids = g.map(q => q.id);
  }
  showSelection(ids, p);
  return true;
}
export function clearSelection() {
  sel = null;
  $('#sel-pop')?.remove();
  $$('.overlay .sel-box').forEach(n => n.remove());
}
const cloneA = a => JSON.parse(JSON.stringify(a));
const selItems = () => (sel ? R.annots.filter(q => sel.ids.includes(q.id)) : []);
function hidePop() { const pp = $('#sel-pop'); if (pp) pp.style.visibility = 'hidden'; }
function unionBB(items) {
  const bs = items.map(annotBBox);
  return [Math.min(...bs.map(b => b[0])), Math.min(...bs.map(b => b[1])), Math.max(...bs.map(b => b[2])), Math.max(...bs.map(b => b[3]))];
}
// alças: grifo de texto (início/fim) ou marca-texto reto (2 pontas)
function handlesOf(items) {
  if (items.length !== 1) return [];
  const a = items[0];
  if (a.type === 'text') {
    const f = a.rects[0], l = a.rects[a.rects.length - 1];
    return [{ id: 'start', x: f[0], y: f[3] + 5, top: f[1], bot: f[3] }, { id: 'end', x: l[2], y: l[3] + 5, top: l[1], bot: l[3] }];
  }
  if (a.type === 'free' && a.points.length === 2) return [{ id: 'p0', x: a.points[0][0], y: a.points[0][1] }, { id: 'p1', x: a.points[1][0], y: a.points[1][1] }];
  return [];
}
function hitHandle(pt) {
  const tol = 18 / R.scale;
  for (const hd of handlesOf(selItems())) if (Math.hypot(pt[0] - hd.x, pt[1] - hd.y) <= tol) return hd.id;
  return null;
}
function drawSelBox(p) {
  p.svg.querySelectorAll('.sel-box').forEach(n => n.remove());
  const items = selItems();
  if (!items.length) return;
  const bb = unionBB(items);
  sel.bb = bb;
  const k = 1 / Math.max(0.4, R.scale);
  const g = svgEl('g', { class: 'sel-box' });
  g.append(svgEl('rect', { x: bb[0] - 3, y: bb[1] - 3, width: bb[2] - bb[0] + 6, height: bb[3] - bb[1] + 6, fill: items.some(a => a.type !== 'text') ? 'rgba(11,110,119,0.05)' : 'none', stroke: '#0B6E77', 'stroke-width': 1.6 * k, 'stroke-dasharray': `${5 * k} ${4 * k}`, rx: 3 }));
  for (const hd of handlesOf(items)) {
    if (hd.top != null) g.append(svgEl('line', { x1: hd.x, y1: hd.top, x2: hd.x, y2: hd.bot, stroke: '#0B6E77', 'stroke-width': 2 * k }));
    g.append(svgEl('circle', { cx: hd.x, cy: hd.y, r: 7 * k, fill: '#0B6E77', stroke: '#fff', 'stroke-width': 2 * k }));
  }
  p.svg.append(g);
}
function showSelection(ids, p) {
  $('#sel-pop')?.remove();
  p.svg.querySelectorAll('.sel-box').forEach(n => n.remove());
  sel = { ids, page: p.n };
  const items = selItems();
  if (!items.length) { sel = null; return; }
  drawSelBox(p);
  const bb = sel.bb;
  const hl = items.filter(a => a.type !== 'ink'), ink = items.filter(a => a.type === 'ink');
  const same = (list, k) => list.length && list.every(a => a[k] === list[0][k]) ? list[0][k] : null;
  const icon = d => { const sv = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }); sv.append(svgEl('path', { d })); return sv; };
  const pop = h('div', { id: 'sel-pop', role: 'dialog', 'aria-label': 'Editar seleção' },
    items.length > 1 ? h('span', { class: 'sel-count' }, String(items.length)) : null,
    hl.length ? HL.map(c => h('button', { type: 'button', class: 'sw' + (c.id === same(hl, 'color') ? ' on' : ''), 'aria-label': c.label, 'data-tip': c.label, onclick: () => editSel(a => a.type !== 'ink', { color: c.id }) }, h('span', { style: 'background:' + c.hex }))) : null,
    hl.length && ink.length ? h('span', { class: 'sep' }) : null,
    ink.length ? PENS.map(c => h('button', { type: 'button', class: 'sw' + (c.id === same(ink, 'color') ? ' on' : ''), 'aria-label': 'Caneta ' + c.label.toLowerCase(), 'data-tip': 'Caneta ' + c.label.toLowerCase(), onclick: () => editSel(a => a.type === 'ink', { color: c.id }) }, h('span', { style: 'background:' + c.hex }))) : null,
    h('span', { class: 'sep' }),
    hl.length ? h('button', { type: 'button', class: 'tool' + (hl.every(a => a.doubt) ? ' on' : ''), 'aria-label': 'Dúvida', 'data-tip': 'Dúvida', onclick: () => editSel(a => a.type !== 'ink', { doubt: !hl.every(a => a.doubt) }) }, h('span', { class: 'q' }, '?')) : null,
    h('button', { type: 'button', class: 'tool', 'aria-label': 'Apagar', 'data-tip': 'Apagar', onclick: deleteSel }, icon('M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3')),
    h('button', { type: 'button', class: 'tool', 'aria-label': 'Fechar', 'data-tip': 'Fechar', onclick: clearSelection }, icon('M6 6l12 12M18 6L6 18')));
  document.body.append(pop);
  const pr = p.el.getBoundingClientRect();
  const x = pr.left + ((bb[0] + bb[2]) / 2) * R.scale, yTop = pr.top + bb[1] * R.scale, yBot = pr.top + bb[3] * R.scale;
  const w = pop.offsetWidth, hgt = pop.offsetHeight;
  let top = yTop - hgt - 14;
  if (top < 70) top = yBot + 26;
  pop.style.left = Math.max(8, Math.min(innerWidth - w - 8, x - w / 2)) + 'px';
  pop.style.top = Math.max(70, Math.min(innerHeight - hgt - 8, top)) + 'px';
}
async function editSel(filter, change) {
  if (!sel) return;
  const items = selItems().filter(filter);
  if (!items.length) return;
  R.undo.push({ kind: 'edit', prev: items.map(cloneA) });
  for (const a of items) { Object.assign(a, change); await db.put('annots', a); }
  if (change.color) { if (items[0].type === 'ink') R.pen = change.color; else R.color = change.color; }
  const p = R.pages[sel.page - 1];
  drawOverlay(p); updatePanel(); renderToolbar();
  showSelection(sel.ids, p);
}

/* ---------- arrastar alça / mover ---------- */
function dragHandle(a, pt, e) {
  const it = selItems()[0]; if (!it) return;
  const old = a.prev[0];
  if (it.type === 'text') {
    const pr = a.p.el.getBoundingClientRect();
    const f = old.rects[0], l = old.rects[old.rects.length - 1];
    const fixed = a.which === 'start' ? [l[2] - 0.6, (l[1] + l[3]) / 2] : [f[0] + 0.6, (f[1] + f[3]) / 2];
    const fx = pr.left + fixed[0] * R.scale, fy = pr.top + fixed[1] * R.scale;
    // a alça fica abaixo da linha: mira o meio da linha acima do dedo/caneta
    const mx = e.clientX, my = e.clientY - 10 * R.scale;
    const c1 = caretAt(a.p, fx, fy), c2 = caretAt(a.p, mx, my);
    const rects = rangeRects(a.p, c1, c2);
    if (!rects.length) return;
    it.rects = rects; it.text = rangeText(c1, c2); it.top = Math.min(...rects.map(r => r[1]));
  } else {
    const i = a.which === 'p0' ? 0 : 1, o = old.points[1 - i];
    it.points[i] = [Math.round(pt[0] * 10) / 10, Math.abs(pt[1] - o[1]) < 14 ? o[1] : Math.round(pt[1] * 10) / 10];
    it.top = Math.min(...it.points.map(q => q[1])) - it.width / 2;
  }
  drawOverlay(a.p); drawSelBox(a.p);
}
function dragMove(a, pt) {
  const dx = pt[0] - a.from[0], dy = pt[1] - a.from[1];
  const items = selItems();
  items.forEach((it, i) => {
    if (it.type === 'text') return;   // grifo de texto fica preso ao texto
    const pv = a.prev[i];
    it.points = pv.points.map(q => [Math.round((q[0] + dx) * 10) / 10, Math.round((q[1] + dy) * 10) / 10]);
    it.top = pv.top + dy;
  });
  drawOverlay(a.p); drawSelBox(a.p);
}

/* ---------- laço ---------- */
function inPoly(x, y, poly) {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
function lassoPick(p, poly) {
  const ids = [];
  for (const a of R.annots.filter(q => q.page === p.n)) {
    const pts = a.type === 'text' ? a.rects.map(r => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2]) : a.points;
    const step = Math.max(1, Math.floor(pts.length / 40));
    let n = 0, inside = 0;
    for (let i = 0; i < pts.length; i += step) { n++; if (inPoly(pts[i][0], pts[i][1], poly)) inside++; }
    if (n && inside / n >= 0.5) ids.push(a.id);
  }
  return ids;
}

async function deleteSel() {
  if (!sel) return;
  const items = R.annots.filter(q => sel.ids.includes(q.id));
  const p = R.pages[sel.page - 1];
  R.annots = R.annots.filter(q => !sel.ids.includes(q.id));
  for (const a of items) await db.del('annots', a.id);
  R.undo.push({ kind: 'batch', removed: items, added: [], markers: [] });
  clearSelection(); drawOverlay(p); updatePanel();
}

/* ---------- borracha, marcador, marco ---------- */
function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  return out;
}
const circleHitsRect = (cx, cy, r, q) => {
  const nx = Math.max(q[0], Math.min(cx, q[2])), ny = Math.max(q[1], Math.min(cy, q[3]));
  return Math.hypot(cx - nx, cy - ny) <= r;
};

function eraseAt(x, y) {
  const a = act; if (!a) return;
  const p = pageAt(x, y); if (!p) return;
  const [cx, cy] = toUnits(p, x, y);
  const d = (ERASERS.find(z => z.id === R.eraser) || ERASERS[1]).d;
  const r = d / 2 / R.scale;
  let changed = false;
  const mode = R.eraserMode;
  const allowed = an => mode === 'all' || (mode === 'ink' ? an.type === 'ink' : an.type !== 'ink');
  for (const an of R.annots.filter(q => q.page === p.n && q.doubt && mode !== 'ink')) {
    const b = annotBBox(an);
    if (Math.hypot(cx - (b[2] + 7), cy - (b[1] + 2)) <= r + 6.5) {
      R.annots = R.annots.filter(q => q !== an);
      if (a.added.has(an.id)) a.added.delete(an.id); else a.removed.push(an);
      const nw = { ...an, doubt: false, id: uid() };
      R.annots.push(nw); a.added.add(nw.id); a.pages.add(p.n); changed = true;
      (a.keep ||= new Set()).add(nw.id);   // tirar a dúvida não apaga o grifo
    }
  }
  for (const an of R.annots.filter(q => q.page === p.n && !a.keep?.has(q.id) && allowed(q))) {
    const b = annotBBox(an);
    if (cx < b[0] - r || cx > b[2] + r || cy < b[1] - r || cy > b[3] + r) continue;
    let pieces = null;
    if (an.type === 'text') {
      const keep = an.rects.filter(q => !circleHitsRect(cx, cy, r, q));
      if (keep.length === an.rects.length) continue;
      pieces = keep.length ? [{ rects: keep, top: Math.min(...keep.map(q => q[1])) }] : [];
    } else {
      const pts = densify(an.points, 1.5);
      const hitR = r + an.width / 2;
      const hit = pts.map(q => Math.hypot(q[0] - cx, q[1] - cy) <= hitR);
      if (!hit.some(Boolean)) continue;
      pieces = [];
      let run = [];
      pts.forEach((q, i) => { if (!hit[i]) run.push(q); else { if (run.length >= 2) pieces.push(run); run = []; } });
      if (run.length >= 2) pieces.push(run);
      pieces = pieces.map(run => ({ points: run.map(q => [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10]), top: Math.min(...run.map(q => q[1])) - an.width / 2 }));
    }
    // troca a anotação pelos pedaços que sobraram
    R.annots = R.annots.filter(q => q !== an);
    if (a.added.has(an.id)) a.added.delete(an.id); else a.removed.push(an);
    for (const pc of pieces) {
      const nw = { ...an, ...pc, id: uid(), createdAt: an.createdAt };
      R.annots.push(nw); a.added.add(nw.id);
    }
    a.pages.add(p.n);
    changed = true;
  }
  for (const m of (R.doc.markers || []).filter(m => !m.done && m.page === p.n && mode === 'all')) {
    if (Math.abs(m.y - cy) <= r && !a.markers.includes(m)) {
      R.doc.markers = R.doc.markers.filter(x => x !== m);
      a.markers.push(m); drawMarkers();
    }
  }
  if (changed) drawOverlay(p);
}

async function commitErase(a) {
  if (!a.removed.length && !a.added.size && !a.markers.length) return;
  for (const an of a.removed) await db.del('annots', an.id);
  const added = R.annots.filter(q => a.added.has(q.id));
  for (const an of added) await db.put('annots', an);
  R.undo.push({ kind: 'batch', removed: a.removed, added: [...a.added], markers: a.markers });
  if (a.markers.length) await persistDoc();
  updatePanel();
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
  else if (u.kind === 'edit') {
    const pages = new Set();
    for (const old of u.prev) {
      const i = R.annots.findIndex(q => q.id === old.id);
      if (i >= 0) R.annots[i] = old; else R.annots.push(old);
      pages.add(old.page); await db.put('annots', old);
    }
    clearSelection();
    pages.forEach(n => drawOverlay(R.pages[n - 1])); updatePanel();
  }
  else if (u.kind === 'batch') {
    const pages = new Set();
    for (const id of u.added) { const an = R.annots.find(q => q.id === id); if (an) pages.add(an.page); await db.del('annots', id); }
    R.annots = R.annots.filter(q => !u.added.includes(q.id));
    for (const an of u.removed) { R.annots.push(an); pages.add(an.page); await db.put('annots', an); }
    if (u.markers.length) { R.doc.markers = [...(R.doc.markers || []).filter(m => m.done), ...u.markers.slice(-1)]; drawMarkers(); await persistDoc(); }
    pages.forEach(n => drawOverlay(R.pages[n - 1]));
    updatePanel();
  }
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
  { id: 'blue', dot: '#4F9DF2', aria: 'Azul' },
  { id: 'green', dot: '#4DBB63', aria: 'Verde' },
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
  if (sel) clearSelection();
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
function startPinch() {
  const [a, b] = [...touches.values()];
  const el = pagesEl(), r = el.getBoundingClientRect();
  Object.assign(pinch, { on: true, d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, ratio: 1 });
  innerEl().style.transformOrigin = (el.scrollLeft + pinch.cx - r.left) + 'px ' + (el.scrollTop + pinch.cy - r.top) + 'px';
}
function movePinch() {
  const [a, b] = [...touches.values()];
  if (!b) return;
  pinch.ratio = Math.max(0.4, Math.min(5, Math.hypot(a.x - b.x, a.y - b.y) / pinch.d0));
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
