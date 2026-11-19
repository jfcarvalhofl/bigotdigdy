import os, hashlib, json
root='.'
files=[]
for d,_,fs in os.walk(root):
    for f in fs:
        p=os.path.relpath(os.path.join(d,f),root).replace(os.sep,'/')
        if p in ('sw.js','build-sw.py','README.md','.nojekyll') or p.startswith('.git/') or p.startswith('vendor/cmaps/') or p.endswith('.map') or 'LICENSE' in p: continue
        files.append(p)
files.sort()
h=hashlib.sha256()
for p in files: h.update(open(os.path.join(root,p),'rb').read())
ver=h.hexdigest()[:10]
pre=['./']+files
sw=f"""// gerado por build-sw.py
const VERSION = '{ver}';
const CACHE = 'pspp-' + VERSION;
const RUNTIME = 'pspp-runtime';
const PRECACHE = {json.dumps(pre, indent=0)};
self.addEventListener('install', e => {{
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
}});
self.addEventListener('activate', e => {{
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== RUNTIME).map(k => caches.delete(k)))).then(() => self.clients.claim()));
}});
self.addEventListener('fetch', e => {{
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {{
    const hit = await caches.match(e.request, {{ ignoreSearch: true }});
    if (hit) return hit;
    if (e.request.mode === 'navigate') {{ const idx = await caches.match('./'); if (idx) return idx; }}
    const res = await fetch(e.request);
    if (res.ok && url.pathname.includes('/vendor/cmaps/')) (await caches.open(RUNTIME)).put(e.request, res.clone());
    return res;
  }})());
}});
"""
open(os.path.join(root,'sw.js'),'w').write(sw)
tot=sum(os.path.getsize(os.path.join(root,p)) for p in files)
print('version',ver,'files',len(files),'precache MB',round(tot/1e6,2))
