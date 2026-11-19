// Grava as marcações no próprio PDF (anotações padrão: Highlight, Ink, Text) — abre no Xodo
import { PDFDocument, PDFName, PDFString, PDFHexString } from '../vendor/pdf-lib.esm.min.js';
import { loadPdf, closePdf } from './pdf.js';
import { db } from './db.js';
import { hlById, penById, hexToRgb01, fmtDate, shareFiles, toast, busy } from './common.js';

export async function exportMarkedPdf(docId) {
  busy(true, 'Gravando marcações no PDF…');
  try {
    const doc = await db.get('docs', docId);
    const file = await db.get('files', docId);
    const annots = await db.byDoc(docId);
    const bytes = new Uint8Array(await file.blob.arrayBuffer());
    // pdf.js dá a transformação unidade-da-tela → PDF de cada página (rotação, CropBox)
    const pjs = await loadPdf(bytes);
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const ctx = pdf.context;
    const pages = pdf.getPages();
    const byPage = new Map();
    for (const a of annots) { if (!byPage.has(a.page)) byPage.set(a.page, []); byPage.get(a.page).push(a); }
    for (const m of doc.markers || []) { if (!byPage.has(m.page)) byPage.set(m.page, []); byPage.get(m.page).push({ marker: true, ...m }); }

    for (const [n, list] of byPage) {
      const page = pages[n - 1]; if (!page) continue;
      const vp = (await pjs.getPage(n)).getViewport({ scale: 1 });
      const P = (x, y) => vp.convertToPdfPoint(x, y);
      for (const a of list) {
        const ref = a.marker ? markerAnnot(ctx, a, P, vp) : a.type === 'text' ? highlightAnnot(ctx, a, P) : inkAnnot(ctx, a, P);
        page.node.addAnnot(ref);
      }
    }
    const out = await pdf.save({ useObjectStreams: false });
    closePdf(pjs);
    busy(false);
    const name = doc.name.replace(/\.pdf$/i, '') + '_marcado.pdf';
    const r = await shareFiles([new File([out], name, { type: 'application/pdf' })], name);
    if (r !== 'aborted') toast('PDF marcado exportado.');
  } catch (e) {
    busy(false); console.error(e); toast('Erro ao gravar o PDF: ' + e.message, 5000);
  }
}

const num = v => Math.round(v * 100) / 100;
function bboxOf(pts) {
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
function common(a) {
  return {
    Type: 'Annot', F: 4, T: PDFHexString.fromText('PSPP'), NM: PDFString.of('pspp-' + a.id),
    M: PDFString.of(pdfDate(a.createdAt || a.date)),
    Contents: PDFHexString.fromText((a.doubt ? '[?] dúvida' : '') + (a.text ? (a.doubt ? ' — ' : '') + a.text.slice(0, 500) : ''))
  };
}
function pdfDate(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
function gs(ctx, alpha, multiply) {
  return ctx.obj({ Type: 'ExtGState', CA: alpha, ca: alpha, ...(multiply ? { BM: 'Multiply' } : {}) });
}

function highlightAnnot(ctx, a, P) {
  const c = hlById(a.color);
  const rgb = hexToRgb01(c.hex);
  const quads = [], all = [];
  for (const r of a.rects) {
    const tl = P(r[0], r[1]), tr = P(r[2], r[1]), bl = P(r[0], r[3]), br = P(r[2], r[3]);
    quads.push(tl, tr, bl, br); all.push(tl, tr, bl, br);
  }
  const bb = bboxOf(all);
  let ops = `/GS0 gs ${rgb.map(num).join(' ')} rg\n`;
  for (let i = 0; i < quads.length; i += 4) {
    const [tl, tr, bl, br] = quads.slice(i, i + 4);
    ops += `${num(tl[0])} ${num(tl[1])} m ${num(tr[0])} ${num(tr[1])} l ${num(br[0])} ${num(br[1])} l ${num(bl[0])} ${num(bl[1])} l h f\n`;
  }
  const ap = ctx.stream(ops, { Type: 'XObject', Subtype: 'Form', BBox: bb.map(num), Resources: { ExtGState: { GS0: gs(ctx, 1, true) } } });
  const dict = ctx.obj({
    ...common(a), Subtype: 'Highlight', Rect: bb.map(num), C: rgb.map(num), CA: 1,
    QuadPoints: quads.flat().map(num), AP: { N: ctx.register(ap) }
  });
  return ctx.register(dict);
}

function inkAnnot(ctx, a, P) {
  const free = a.type === 'free';
  const hex = free ? hlById(a.color).hex : penById(a.color).hex;
  const rgb = hexToRgb01(hex);
  const pts = a.points.map(q => P(q[0], q[1]));
  const w = a.width;
  const b = bboxOf(pts);
  const bb = [b[0] - w, b[1] - w, b[2] + w, b[3] + w];
  const alpha = 1;
  let ops = `/GS0 gs ${rgb.map(num).join(' ')} RG ${num(w)} w 1 J 1 j\n`;
  ops += pts.map((p, i) => `${num(p[0])} ${num(p[1])} ${i ? 'l' : 'm'}`).join(' ') + ' S\n';
  const ap = ctx.stream(ops, { Type: 'XObject', Subtype: 'Form', BBox: bb.map(num), Resources: { ExtGState: { GS0: gs(ctx, alpha, free) } } });
  const dict = ctx.obj({
    ...common(a), Subtype: 'Ink', Rect: bb.map(num), C: rgb.map(num), CA: alpha,
    BS: { W: num(w) }, InkList: [pts.flat().map(num)], AP: { N: ctx.register(ap) },
    ...(free ? { IT: PDFName.of('InkHighlight') } : {})
  });
  return ctx.register(dict);
}

function markerAnnot(ctx, m, P, vp) {
  const p = P(4, m.y);
  const rect = [p[0], p[1] - 10, p[0] + 18, p[1] + 10].map(num);
  const dict = ctx.obj({
    Type: 'Annot', Subtype: 'Text', F: 4, Rect: rect, Name: 'Note', Open: false,
    T: PDFHexString.fromText('PSPP'), NM: PDFString.of('pspp-marco-' + m.id), C: [0.95, 0.71, 0.27],
    Contents: PDFHexString.fromText((m.done ? 'Sessão processada · ' : 'Fim da sessão · ') + fmtDate(m.date, true))
  });
  return ctx.register(dict);
}
