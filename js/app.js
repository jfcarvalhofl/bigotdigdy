import { $, $$, toast, APP_VERSION } from './common.js';
import { initLibrary, renderLibrary } from './library.js';
import { R, DIAG, openDoc, closeDoc, bindInput, setTool, renderToolbar, undo, layout } from './reader.js';
import { openFinish } from './finish.js';

async function start() {
  try { await navigator.storage?.persist?.(); } catch {}
  initLibrary(id => openDoc(id, renderLibrary).catch(err => { console.error(err); toast('Erro ao abrir: ' + err.message, 5000); }));
  bindInput();
  const ver = Object.assign(document.createElement('span'), { className: 'ver', textContent: 'v' + APP_VERSION });
  ver.addEventListener('click', () => { DIAG.on = !DIAG.on; ver.textContent = 'v' + APP_VERSION + (DIAG.on ? ' · diagnóstico' : ''); if (!DIAG.on) document.querySelector('#diag')?.remove(); toast(DIAG.on ? 'Diagnóstico ligado: aparece uma faixa no rodapé do leitor.' : 'Diagnóstico desligado.'); });
  $('.brand').append(ver);

  $$('.tool[data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('#btn-doubt').addEventListener('click', () => { R.doubt = !R.doubt; renderToolbar(); toast(R.doubt ? 'Próximos grifos marcados como dúvida' : 'Dúvida desligada', 1200); });
  $('#btn-undo').addEventListener('click', undo);
  const togglePanel = () => { R.panelOpen = !R.panelOpen; renderToolbar(); requestAnimationFrame(layout); };
  $('#btn-panel').addEventListener('click', togglePanel);
  $('#btn-panel-close').addEventListener('click', togglePanel);
  $('#btn-back').addEventListener('click', closeDoc);
  $('#btn-finish').addEventListener('click', openFinish);
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && R.doc) { e.preventDefault(); undo(); }
  });

  const net = () => {
    $('#net-status').classList.toggle('online', navigator.onLine);
    $('.net-label').textContent = navigator.onLine ? 'Online' : 'Offline · tudo salvo no tablet';
  };
  addEventListener('online', net); addEventListener('offline', net); net();

  await renderLibrary();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) toast('Nova versão instalada. Feche e abra o app para usar.', 6000);
        });
      });
    }).catch(e => console.warn('SW', e));
  }
}

start();
