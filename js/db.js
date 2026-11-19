// IndexedDB simples: docs, files (bytes do PDF), annots, packages
const DB_NAME = 'pspp-leitor';
const DB_VER = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('annots')) {
        const s = db.createObjectStore('annots', { keyPath: 'id' });
        s.createIndex('docId', 'docId');
      }
      if (!db.objectStoreNames.contains('packages')) db.createObjectStore('packages', { keyPath: 'id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

function req(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export const db = {
  async get(name, key) { return req((await store(name)).get(key)); },
  async all(name) { return req((await store(name)).getAll()); },
  async put(name, val) { return req((await store(name, 'readwrite')).put(val)); },
  async del(name, key) { return req((await store(name, 'readwrite')).delete(key)); },
  async byDoc(docId) { return req((await store('annots')).index('docId').getAll(docId)); },
  async delByDoc(docId) {
    const list = await this.byDoc(docId);
    const s = await store('annots', 'readwrite');
    await Promise.all(list.map(a => req(s.delete(a.id))));
  }
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
