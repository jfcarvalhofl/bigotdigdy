export const APP_VERSION = '1.1';
export const HL = [
  { id: 'yellow', hex: '#F5CF1F', fill: 'rgba(255,214,0,0.42)', label: 'Marcação', nome: 'amarelo', significado: 'marcação' },
  { id: 'orange', hex: '#F28C1E', fill: 'rgba(255,140,20,0.45)', label: 'Mais importante', nome: 'laranja', significado: 'mais importante' },
  { id: 'red', hex: '#E2584A', fill: 'rgba(240,90,75,0.42)', label: 'Extrema atenção', nome: 'vermelho', significado: 'extrema atenção' }
];
export const PENS = [
  { id: 'red', hex: '#D32F2F', label: 'Vermelho', nome: 'vermelho' },
  { id: 'blue', hex: '#1E5BD8', label: 'Azul', nome: 'azul' },
  { id: 'black', hex: '#111111', label: 'Preto', nome: 'preto' },
  { id: 'green', hex: '#2E7D32', label: 'Verde', nome: 'verde' },
  { id: 'purple', hex: '#6A3FB5', label: 'Roxo', nome: 'roxo' }
];
export const hlById = id => HL.find(c => c.id === id) || HL[0];
export const penById = id => PENS.find(c => c.id === id) || PENS[1];
export const colorOf = a => (a.type === 'ink' ? penById(a.color).hex : hlById(a.color).hex);

export function hexToRgb01(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
}

let toastT = 0;
export function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms);
}

export function busy(on, text = 'Processando…') {
  $('#busy').hidden = !on; $('#busy-text').textContent = text;
}

export const pad = (n, w = 2) => String(n).padStart(w, '0');
export function fmtDate(ts, withYear = false) {
  const d = new Date(ts);
  return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + (withYear ? '/' + d.getFullYear() : '') + ' · ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
export function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return Math.round(b / 1024) + ' KB';
  return (b / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
}
export function slug(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\.pdf$/i, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'documento';
}

// Compartilhar (Android: abre o menu de compartilhar → Drive). Fallback: download.
export async function shareFiles(files, title) {
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files, title }); return 'shared'; }
    catch (e) { if (e.name === 'AbortError') return 'aborted'; console.warn(e); }
  }
  for (const f of files) {
    const a = h('a', { href: URL.createObjectURL(f), download: f.name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  return 'downloaded';
}

// Posição de leitura comparável: (página, distância do topo em pontos PDF)
export const posKey = (page, fromTop) => page * 1e6 + fromTop;
