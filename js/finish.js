import { db, uid } from './db.js';
import { pdfjsLib } from './pdf.js';
import { R, sessionStart, sessionEnd, setTool, addPageEndMarker, drawMarkers, updatePanel, persistDoc, annotBBox, groupInk } from './reader.js';
import { hlById, penById, $, h, toast, busy, fmtDate, fmtSize, slug, pad, shareFiles, posKey } from './common.js';
import { zipSync, strToU8 } from '../vendor/fflate.js';
import { PDFDocument, StandardFonts, rgb } from '../vendor/pdf-lib.esm.min.js';

const APP_VERSION = 1;

/* ===================== diálogo ===================== */
export async function openFinish() {
  const dlg = $('#dlg-finish');
  const s = sessionStart(), e = sessionEnd();
  $('#fin-sub').textContent = R.doc.name;
  const noMarker = !e;
  $('#fin-nomarker').hidden = !noMarker;
  $('#fin-content').hidden = noMarker;
  $('#fin-queue').hidden = noMarker;
  $('#fin-export').hidden = noMarker;
  let marks = [];
  if (!noMarker) {
    marks = marksInRange(e);
    $('#fin-start').textContent = 'p. ' + s.page;
    $('#fin-start-sub').textContent = s.fromMarker ? 'marco de ' + fmtDate(s.date) : 'início do documento';
    $('#fin-end').textContent = 'p. ' + e.page;
    $('#fin-end-sub').textContent = 'marco de ' + fmtDate(e.date);
    const c = k => marks.filter(k).length;
    const stats = [
      [e.page - s.page + 1 + ' p.', 'Trecho completo', '#F1F0EC', '#3D4A57'],
      [c(a => a.type !== 'ink' && a.color === 'yellow'), 'Amarelo · marcação', '#FBF6DC', '#4A4020'],
      [c(a => a.type !== 'ink' && a.color === 'orange'), 'Laranja · importante', '#FDEBD6', '#5A3410'],
      [c(a => a.type !== 'ink' && a.color === 'red'), 'Vermelho · atenção', '#FBE1DD', '#6A231B'],
      [c(a => a.type !== 'ink' && (a.color === 'blue' || a.color === 'green')), 'Azul / verde', '#E3F0FB', '#16466F'],
      [c(a => a.doubt), 'Dúvidas', '#E6EAF0', '#13263A'],
      [groupInk(marks.filter(a => a.type === 'ink')).length, 'Anotações à mão', '#E3ECFB', '#143D8F']
    ];
    $('#fin-stats').innerHTML = '';
    for (const [n, l, bg, fg] of stats) $('#fin-stats').append(h('div', { class: 'stat', style: `background:${bg};color:${fg}` }, h('b', {}, String(n)), h('span', {}, l)));
    $('#fin-stats').append(h('div', { class: 'stat', style: 'grid-column:span 1;background:#EEF5F5;color:#0B4E55;justify-content:center' },
      h('span', { style: 'font-size:12.5px;font-weight:700' }, 'Não marcado também vira nota'),
      h('span', {}, 'quando for conceito, regra, número ou definição cobrável')));
    $('#fin-size').textContent = 'Calculando tamanho…';
    estimate(s, e, marks).then(t => { $('#fin-size').innerHTML = ''; $('#fin-size').append(h('strong', {}, t), h('br'), 'Destino: Drive › PSPP2027 › _entrada · sem internet, fica na fila.'); });
  }
  dlg.returnValue = '';
  dlg.showModal();
  const v = await new Promise(res => dlg.addEventListener('close', () => res(dlg.returnValue), { once: true }));
  if (v === 'place') { setTool('end'); toast('Toque com a S Pen onde você parou.', 3000); return; }
  if (v === 'pageend') { await addPageEndMarker(); return openFinish(); }
  if (v === 'queue' || v === 'export') {
    try {
      busy(true, 'Montando o pacote…');
      const pkg = await buildPackage(s, e, marks);
      busy(false);
      if (v === 'export') await exportPackages([pkg]);
      else toast('Pacote salvo na fila (' + fmtSize(pkg.size) + ').');
    } catch (err) {
      busy(false); console.error(err); toast('Erro ao montar o pacote: ' + err.message, 5000);
    }
  }
}

function marksInRange(e) {
  const endK = posKey(e.page, e.y);
  return R.annots.filter(a => !a.packaged && posKey(a.page, a.top) < endK)
    .sort((a, b) => posKey(a.page, a.top) - posKey(b.page, b.top));
}

async function estimate(s, e, marks) {
  let t = 0, img = 0;
  for (let n = s.page; n <= e.page; n++) {
    const p = R.pages[n - 1];
    if (p.hasText == null) {
      const tc = await p.page.getTextContent();
      p.hasText = tc.items.map(i => i.str || '').join('').replace(/\s+/g, '').length >= 30;
    }
    p.hasText ? t++ : img++;
  }
  const crops = groupInk(marks.filter(a => a.type === 'ink')).length + marks.filter(a => a.type === 'free').length;
  const bytes = t * 4500 + img * 150000 + crops * 35000 + 6000;
  return 'Pacote ≈ ' + fmtSize(bytes) + ' · ' + t + ' pág. com texto, ' + img + ' pág. escaneadas, ' + crops + ' recortes';
}

/* ===================== render auxiliar ===================== */
const pageCanvasCache = new Map();
async function pageCanvas(n, scale) {
  const key = n + '@' + scale;
  if (pageCanvasCache.has(key)) return pageCanvasCache.get(key);
  const page = R.pages[n - 1].page;
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  pageCanvasCache.set(key, c);
  return c;
}

function paintAnnots(ctx, list, scale) {
  ctx.save();
  ctx.scale(scale, scale);
  for (const a of list) {
    if (a.type === 'text') {
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = hlById(a.color).hex;
      for (const r of a.rects) ctx.fillRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
    } else {
      ctx.globalCompositeOperation = a.type === 'free' ? 'multiply' : 'source-over';
      ctx.globalAlpha = 1;
      ctx.strokeStyle = a.type === 'free' ? hlById(a.color).hex : penById(a.color).hex;
      ctx.lineWidth = a.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      a.points.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function toJpeg(canvas, q) {
  return new Promise(res => canvas.toBlob(b => b.arrayBuffer().then(ab => res(new Uint8Array(ab))), 'image/jpeg', q));
}

async function cropOf(n, bbox, pageAnnots, pad = 24) {
  const scale = 2;
  const src = await pageCanvas(n, scale);
  const p = R.pages[n - 1];
  const x0 = Math.max(0, bbox[0] - pad), y0 = Math.max(0, bbox[1] - pad);
  const x1 = Math.min(p.w1, bbox[2] + pad), y1 = Math.min(p.h1, bbox[3] + pad);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round((x1 - x0) * scale)); c.height = Math.max(1, Math.round((y1 - y0) * scale));
  const ctx = c.getContext('2d');
  ctx.drawImage(src, x0 * scale, y0 * scale, c.width, c.height, 0, 0, c.width, c.height);
  ctx.translate(-x0 * scale, -y0 * scale);
  paintAnnots(ctx, pageAnnots, scale);
  // limita tamanho
  const maxW = 1100;
  if (c.width > maxW) {
    const d = document.createElement('canvas');
    d.width = maxW; d.height = Math.round(c.height * maxW / c.width);
    d.getContext('2d').drawImage(c, 0, 0, d.width, d.height);
    return toJpeg(d, 0.72);
  }
  return toJpeg(c, 0.72);
}

async function pageImage(n, yMin, yMax) {
  const p = R.pages[n - 1];
  const scale = Math.min(2.2, 1400 / p.w1);
  const src = await pageCanvas(n, scale);
  const c = document.createElement('canvas');
  const y0 = Math.floor(yMin * scale), y1 = Math.ceil(yMax * scale);
  c.width = src.width; c.height = Math.max(1, y1 - y0);
  const ctx = c.getContext('2d');
  ctx.filter = 'grayscale(1) contrast(1.15)';
  ctx.drawImage(src, 0, y0, src.width, c.height, 0, 0, c.width, c.height);
  return toJpeg(c, 0.6);
}

// Itens de texto com posição (unidades da página, origem no topo)
async function textItems(n) {
  const page = R.pages[n - 1].page;
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  return tc.items.filter(i => 'str' in i).map(i => {
    const t = pdfjsLib.Util.transform(vp.transform, i.transform);
    const fh = Math.hypot(t[2], t[3]) || 10;
    return { str: i.str, eol: i.hasEOL, x: t[4], y: t[5], top: t[5] - fh, h: fh };
  });
}
function joinItems(items) {
  let out = '', lastY = null;
  for (const it of items) {
    if (lastY != null && Math.abs(it.y - lastY) > it.h * 0.6 && !out.endsWith('\n')) out += '\n';
    out += it.str;
    if (it.eol) out += '\n';
    lastY = it.y;
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ===================== pacote ===================== */
async function buildPackage(s, e, marks) {
  pageCanvasCache.clear();
  const files = {};
  const doc = R.doc;
  const manifest = {
    app: 'pspp-leitor', versao_app: APP_VERSION,
    documento: { nome: doc.name, grupo: doc.group || '', paginas: R.pages.length, id: doc.id },
    sessao: {
      inicio: { pagina: s.page, y: s.y, marco: s.fromMarker ? new Date(s.date).toISOString() : null },
      fim: { pagina: e.page, y: e.y, marco: new Date(e.date).toISOString() },
      gerado_em: new Date().toISOString()
    },
    legenda: {
      grifo_amarelo: 'marcação', grifo_laranja: 'mais importante', grifo_vermelho: 'extrema atenção', grifo_azul: 'significado a definir', grifo_verde: 'significado a definir',
      duvida: 'marcador ? — explicar', caneta: 'anotação à mão: referência a outro documento, dúvida, reforço ou reflexão',
      unidades: 'pontos PDF, origem no canto superior esquerdo da página'
    },
    paginas: [], marcacoes: []
  };
  const textCache = new Map();
  const getItems = async n => { if (!textCache.has(n)) textCache.set(n, await textItems(n)); return textCache.get(n); };

  for (let n = s.page; n <= e.page; n++) {
    const p = R.pages[n - 1];
    const items = await getItems(n);
    const hasText = items.map(i => i.str).join('').replace(/\s+/g, '').length >= 30;
    const yMin = n === s.page ? s.y : 0;
    const yMax = n === e.page ? e.y : p.h1;
    const entry = { pagina: n, tipo: hasText ? 'texto' : 'imagem', recorte_y: [Math.round(yMin), Math.round(yMax)] };
    if (hasText) {
      const sel = items.filter(i => i.y > yMin + 1 && i.top < yMax);
      const name = `texto/p-${pad(n, 3)}.txt`;
      files[name] = [strToU8(joinItems(sel)), { level: 6 }];
      entry.arquivo = name;
    } else {
      const name = `paginas/p-${pad(n, 3)}.jpg`;
      files[name] = [await pageImage(n, yMin, yMax), { level: 0 }];
      entry.arquivo = name;
    }
    manifest.paginas.push(entry);
  }

  const pageAnnots = n => R.annots.filter(a => a.page === n);
  const inks = groupInk(marks.filter(a => a.type === 'ink'));
  const out = [];
  let k = 0;
  for (const a of marks.filter(m => m.type !== 'ink')) {
    const c = hlById(a.color);
    const m = { id: a.id, tipo: a.type === 'text' ? 'grifo' : 'marca-texto', cor: c.nome, significado: c.significado, duvida: !!a.doubt, pagina: a.page, y: Math.round(a.top), criado_em: new Date(a.createdAt).toISOString() };
    if (a.type === 'text' && a.text) {
      m.texto = a.text;
      const b = annotBBox(a);
      const items = await getItems(a.page);
      m.contexto = joinItems(items.filter(i => i.y > b[1] - 36 && i.top < b[3] + 36)).replace(/\n/g, ' ');
    } else {
      const name = `recortes/m-${pad(++k, 3)}.jpg`;
      files[name] = [await cropOf(a.page, annotBBox(a), pageAnnots(a.page), 20), { level: 0 }];
      m.recorte = name;
      const b = annotBBox(a);
      const items = await getItems(a.page);
      const near = items.filter(i => i.y > b[1] - 6 && i.top < b[3] + 6 && i.x < b[2] && i.x + 2 > b[0] - 400);
      if (near.length) m.texto_provavel = joinItems(near).replace(/\n/g, ' ');
    }
    out.push(m);
  }
  for (const g of inks) {
    const bs = g.map(annotBBox);
    const bb = [Math.min(...bs.map(b => b[0])), Math.min(...bs.map(b => b[1])), Math.max(...bs.map(b => b[2])), Math.max(...bs.map(b => b[3]))];
    const name = `recortes/m-${pad(++k, 3)}.jpg`;
    files[name] = [await cropOf(g[0].page, bb, pageAnnots(g[0].page), 34), { level: 0 }];
    const cores = [...new Set(g.map(a => penById(a.color).nome))];
    out.push({ id: g[0].id, ids: g.map(a => a.id), tipo: 'caneta', cores, pagina: g[0].page, y: Math.round(bb[1]), recorte: name, classificar: 'referência | dúvida | reforço | reflexão', criado_em: new Date(Math.min(...g.map(a => a.createdAt))).toISOString() });
  }
  out.sort((a, b) => posKey(a.pagina, a.y) - posKey(b.pagina, b.y));
  manifest.marcacoes = out;
  manifest.marcadores_de_pagina = (doc.bookmarks || []).filter(n => n >= s.page && n <= e.page);

  files['manifesto.json'] = [strToU8(JSON.stringify(manifest, null, 2)), { level: 6 }];
  files['LEIAME.md'] = [strToU8(readme(manifest)), { level: 6 }];
  const zip = zipSync(files);
  const d = new Date(e.date);
  const fileName = `PSPP_${slug(doc.name)}_p${pad(s.page, 3)}-${pad(e.page, 3)}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.pdf`;
  // O Android só compartilha alguns tipos de arquivo (PDF sim, ZIP não).
  // O pacote vai como um PDF de capa com o .zip anexado dentro.
  const pdfBytes = await wrapInPdf(zip, manifest, out);
  const pkg = {
    id: uid(), docId: doc.id, docName: doc.name, createdAt: Date.now(), fileName,
    start: s.page, end: e.page, pagesCount: e.page - s.page + 1,
    imgPages: manifest.paginas.filter(p => p.tipo === 'imagem').length,
    marksCount: out.length, size: pdfBytes.byteLength, blob: new Blob([pdfBytes], { type: 'application/pdf' }), status: 'fila'
  };
  await db.put('packages', pkg);
  // fecha a sessão
  for (const a of marks) { a.packaged = true; a.packageId = pkg.id; await db.put('annots', a); }
  e.done = true; e.packageId = pkg.id;
  await persistDoc();
  drawMarkers(); updatePanel();
  pageCanvasCache.clear();
  return pkg;
}

const latin = t => String(t).replace(/[→]/g, '->').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[—–]/g, '-').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
async function wrapInPdf(zip, m, marks) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(latin('Pacote de sessão - ' + m.documento.nome));
  pdf.setProducer('Leitor PSPP 2027');
  const f = await pdf.embedFont(StandardFonts.Helvetica), fb = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([595, 842]);
  let y = 780;
  const line = (t, size = 11, font = f, color = rgb(0.08, 0.13, 0.17)) => { page.drawText(latin(t), { x: 56, y, size, font, color, maxWidth: 480 }); y -= size + 9; };
  line('Pacote de sessão', 22, fb); y -= 6;
  line(m.documento.nome, 14, fb);
  if (m.documento.grupo) line('Grupo: ' + m.documento.grupo);
  line('Trecho: p. ' + m.sessao.inicio.pagina + ' até p. ' + m.sessao.fim.pagina);
  line('Gerado em: ' + fmtDate(Date.parse(m.sessao.gerado_em), true));
  y -= 8;
  const c = k => marks.filter(k).length;
  line('Marcações: ' + marks.length, 12, fb);
  line('Amarelo (marcação): ' + c(x => x.cor === 'amarelo') + '   Laranja (mais importante): ' + c(x => x.cor === 'laranja') + '   Vermelho (atenção): ' + c(x => x.cor === 'vermelho'));
  line('Azul: ' + c(x => x.cor === 'azul' && x.tipo !== 'caneta') + '   Verde: ' + c(x => x.cor === 'verde' && x.tipo !== 'caneta'));
  line('Dúvidas: ' + c(x => x.duvida) + '   Anotações à mão: ' + c(x => x.tipo === 'caneta'));
  line('Páginas com texto: ' + m.paginas.filter(p => p.tipo === 'texto').length + '   Páginas escaneadas: ' + m.paginas.filter(p => p.tipo === 'imagem').length);
  y -= 14;
  line('O conteúdo completo está ANEXADO a este PDF (pacote.zip).', 11, fb, rgb(0.04, 0.43, 0.47));
  line('Salve em Drive > PSPP2027 > _entrada e diga "processa" no Projeto PSPP 2027.', 10, f, rgb(0.36, 0.4, 0.44));
  await pdf.attach(zip, 'pacote.zip', { mimeType: 'application/zip', description: 'Pacote de sessão do Leitor PSPP 2027', creationDate: new Date(), modificationDate: new Date() });
  return pdf.save();
}

function readme(m) {
  return `# Pacote de sessão — ${m.documento.nome}

Gerado pelo Leitor PSPP 2027 em ${m.sessao.gerado_em}.

- Trecho: da p. ${m.sessao.inicio.pagina} à p. ${m.sessao.fim.pagina} (entre os marcos de sessão).
- \`texto/\`: texto integral do trecho, por página (PDF com texto reconhecido).
- \`paginas/\`: imagens do trecho, por página (PDF escaneado) — transcrever.
- \`recortes/\`: recortes das marcações livres e das anotações à mão.
- \`manifesto.json\`: lista de marcações com cor, significado, dúvida, página, trecho exato e contexto.

Legenda: amarelo = marcação · laranja = mais importante · vermelho = extrema atenção · ? = dúvida.
Processar TODO o trecho, não só o marcado; as marcações definem prioridade e ênfase.
`;
}

/* ===================== exportar ===================== */
export async function exportPackages(pkgs) {
  if (!pkgs.length) { toast('Nenhum pacote pendente.'); return; }
  const files = pkgs.map(p => new File([p.blob], p.fileName, { type: p.fileName.endsWith('.zip') ? 'application/zip' : 'application/pdf' }));
  const r = await shareFiles(files, 'Pacotes PSPP 2027');
  if (r === 'aborted') { toast('Exportação cancelada. Os pacotes continuam na fila.'); return; }
  for (const p of pkgs) { p.status = 'enviado'; p.sentAt = Date.now(); await db.put('packages', p); }
  toast(r === 'shared' ? 'Enviado. Escolha Drive › PSPP2027 › _entrada.' : 'Pacote baixado.');
  document.dispatchEvent(new CustomEvent('packages-changed'));
}
