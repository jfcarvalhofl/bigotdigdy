import { db, uid } from './db.js';
import { loadPdf, pageText, closePdf } from './pdf.js';
import { $, h, toast, busy, fmtDate, fmtSize } from './common.js';
import { exportPackages } from './finish.js';
import { exportMarkedPdf } from './pdfexport.js';

let openReader = null;
export function initLibrary(onOpen) {
  openReader = onOpen;
  $('#file-input').addEventListener('change', onImport);
  $('#btn-export-pending').addEventListener('click', async () => {
    const pk = (await db.all('packages')).filter(p => p.status === 'fila').sort((a, b) => a.createdAt - b.createdAt);
    await exportPackages(pk);
    renderLibrary();
  });
  document.addEventListener('packages-changed', renderLibrary);
}

/* ===================== importar ===================== */
async function onImport(e) {
  const files = [...e.target.files].filter(f => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
  e.target.value = '';
  if (!files.length) return;
  const dlg = $('#dlg-import');
  $('#imp-files').textContent = files.map(f => f.name).join(' · ');
  await fillGroups();
  $('#imp-group').value = '';
  dlg.returnValue = '';
  dlg.showModal();
  const v = await new Promise(res => dlg.addEventListener('close', () => res(dlg.returnValue), { once: true }));
  if (v !== 'ok') return;
  const group = $('#imp-group').value.trim() || 'Sem grupo';
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    busy(true, `Importando ${i + 1}/${files.length}: ${f.name}`);
    try {
      const buf = await f.arrayBuffer();
      const pdf = await loadPdf(buf);
      let textPages = 0;
      const sample = Math.min(pdf.numPages, 4);
      for (let n = 1; n <= sample; n++) if ((await pageText(await pdf.getPage(n))).hasText) textPages++;
      const id = uid();
      await db.put('files', { id, blob: new Blob([buf], { type: 'application/pdf' }) });
      await db.put('docs', {
        id, name: f.name.replace(/\.pdf$/i, ''), group, pages: pdf.numPages, lastPage: 1,
        kind: textPages >= Math.ceil(sample / 2) ? 'texto' : 'escaneado', size: f.size,
        createdAt: Date.now(), markers: [], bookmarks: []
      });
      closePdf(pdf);
    } catch (err) {
      console.error(err); toast('Não consegui abrir ' + f.name + ': ' + err.message, 5000);
    }
  }
  busy(false);
  renderLibrary();
}

async function fillGroups() {
  const docs = await db.all('docs');
  const dl = $('#groups-list'); dl.innerHTML = '';
  const gs = new Set(['Provas anteriores', ...docs.map(d => d.group)]);
  for (const g of gs) dl.append(h('option', { value: g }));
}

/* ===================== listar ===================== */
export async function renderLibrary() {
  const [docs, annots, pkgs] = await Promise.all([db.all('docs'), db.all('annots'), db.all('packages')]);
  const pend = new Map();
  for (const a of annots) if (!a.packaged) pend.set(a.docId, (pend.get(a.docId) || 0) + 1);
  const box = $('#lib-groups'); box.innerHTML = '';
  if (!docs.length) {
    box.append(h('div', { class: 'empty' },
      h('strong', {}, 'Nenhum documento ainda.'), h('br'),
      'Toque em “Importar PDF” e escolha os arquivos (do Drive ou do tablet).', h('br'),
      'Os PDFs ficam guardados no app e funcionam sem internet.'));
  }
  const groups = new Map();
  for (const d of docs) { if (!groups.has(d.group)) groups.set(d.group, []); groups.get(d.group).push(d); }
  const names = [...groups.keys()].sort((a, b) => (/prova/i.test(b) - /prova/i.test(a)) || a.localeCompare(b, 'pt'));
  for (const g of names) {
    const list = groups.get(g).sort((a, b) => a.name.localeCompare(b.name, 'pt', { numeric: true }));
    box.append(h('section', { class: 'group' },
      h('h2', {}, g, h('span', { class: 'muted' }, list.length + (list.length > 1 ? ' documentos' : ' documento'))),
      h('div', { class: 'cards' }, list.map(d => card(d, pend.get(d.id) || 0)))));
  }
  renderQueue(pkgs);
}

function card(d, pending) {
  const pct = Math.round(((d.lastPage || 1) / d.pages) * 100);
  const done = (d.markers || []).filter(m => m.done).sort((a, b) => b.page - a.page)[0];
  const where = done ? 'processado até p. ' + done.page : 'p. ' + (d.lastPage || 1) + ' de ' + d.pages;
  return h('div', { class: 'card' },
    h('button', { class: 'card-open', type: 'button', 'aria-label': 'Abrir ' + d.name, onclick: () => openReader(d.id) }),
    h('div', { class: 'card-top' },
      h('span', { class: 'card-name' }, d.name),
      h('span', { class: 'pill' + (d.kind === 'escaneado' ? ' scan' : '') }, d.kind === 'escaneado' ? 'Escaneado' : 'Texto'),
      h('button', { class: 'card-more', type: 'button', 'aria-label': 'Opções', onclick: e => { e.stopPropagation(); docMenu(d); } },
        (() => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>'; return s; })())),
    h('div', { class: 'bar' }, h('div', { style: 'width:' + pct + '%' })),
    h('div', { class: 'card-foot' }, h('span', {}, where), h('span', {}, pending ? pending + ' a processar' : '—')));
}

async function docMenu(d) {
  const dlg = $('#dlg-doc');
  await fillGroups();
  $('#doc-dlg-title').textContent = d.name;
  $('#doc-dlg-name').value = d.name;
  $('#doc-dlg-group').value = d.group;
  dlg.returnValue = '';
  dlg.showModal();
  const v = await new Promise(res => dlg.addEventListener('close', () => res(dlg.returnValue), { once: true }));
  if (v === 'save') {
    d.name = $('#doc-dlg-name').value.trim() || d.name;
    d.group = $('#doc-dlg-group').value.trim() || 'Sem grupo';
    await db.put('docs', d); renderLibrary();
  } else if (v === 'pdf') {
    await exportMarkedPdf(d.id);
  } else if (v === 'delete') {
    if (!confirmDelete(d)) return;
    await db.delByDoc(d.id); await db.del('files', d.id); await db.del('docs', d.id);
    toast('Documento excluído do app.'); renderLibrary();
  }
}
function confirmDelete(d) {
  // confirmação simples sem diálogo do navegador
  const now = Date.now();
  if (d._delAsk && now - d._delAsk < 5000) return true;
  d._delAsk = now;
  toast('Toque em “Excluir do app” de novo em 5 s para confirmar. As marcações deste PDF serão apagadas.', 5000);
  setTimeout(() => docMenu(d), 50);
  return false;
}

/* ===================== fila ===================== */
function renderQueue(pkgs) {
  const L = $('#queue-list'); L.innerHTML = '';
  pkgs.sort((a, b) => b.createdAt - a.createdAt);
  const waiting = pkgs.filter(p => p.status === 'fila');
  const btn = $('#btn-export-pending');
  btn.disabled = !waiting.length;
  btn.textContent = waiting.length ? `Exportar ${waiting.length} pendente${waiting.length > 1 ? 's' : ''} (${fmtSize(waiting.reduce((s, p) => s + p.size, 0))})` : 'Nada pendente';
  if (!pkgs.length) { L.append(h('div', { class: 'panel-empty' }, 'Os pacotes aparecem aqui quando você finaliza uma sessão.')); return; }
  for (const p of pkgs.slice(0, 40)) {
    L.append(h('div', { class: 'qitem' },
      h('div', { class: 'qitem-top' },
        h('span', { class: 'qitem-title' }, `${p.docName} · p. ${p.start} → ${p.end}`),
        h('span', { class: 'pill ' + (p.status === 'fila' ? 'wait' : 'ok') }, p.status === 'fila' ? 'Na fila' : 'Enviado')),
      h('div', { class: 'qitem-meta' }, `${fmtDate(p.createdAt)} · ${p.pagesCount} pág.${p.imgPages ? ' (' + p.imgPages + ' escaneadas)' : ''} · ${p.marksCount} marcações · ${fmtSize(p.size)}`),
      h('div', { class: 'qitem-actions' },
        h('button', { type: 'button', onclick: async () => { await exportPackages([p]); renderLibrary(); } }, p.status === 'fila' ? 'Exportar' : 'Exportar de novo'),
        p.status !== 'fila' ? h('button', { type: 'button', onclick: async () => { await db.del('packages', p.id); renderLibrary(); } }, 'Remover') : null)));
  }
}
