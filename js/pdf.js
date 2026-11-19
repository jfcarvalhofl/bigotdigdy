import * as pdfjsLib from '../vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
const base = new URL('../vendor/', import.meta.url).href;

export { pdfjsLib };

export function closePdf(doc) {
  try { (doc?.loadingTask || doc?._transport?.loadingTask)?.destroy?.(); } catch (e) { console.warn(e); }
}

export function loadPdf(bytes) {
  // pdf.js transfere o buffer para o worker: passa sempre uma cópia
  return pdfjsLib.getDocument({
    data: new Uint8Array(bytes.slice(0)),
    wasmUrl: base + 'wasm/',
    standardFontDataUrl: base + 'standard_fonts/',
    cMapUrl: base + 'cmaps/',
    cMapPacked: true,
    isEvalSupported: false,
    enableScripting: false
  }).promise;
}

// Página "tem texto" se a camada de texto tiver conteúdo relevante
export async function pageText(page) {
  const tc = await page.getTextContent();
  const str = tc.items.map(i => i.str || '').join('').replace(/\s+/g, '');
  return { tc, hasText: str.length >= 30 };
}
