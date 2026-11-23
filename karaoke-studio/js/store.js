// Local storage of projects and their audio files in IndexedDB (stays on this device).

const DB_NAME = 'karaoke-studio';
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      if (!('indexedDB' in window)) return rej(new Error('no-idb'));
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('projects', { keyPath: 'id' });
        d.createObjectStore('files');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}

function tx(store, mode, fn) {
  return db().then(d => new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => res(result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('aborted'));
  }));
}

const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const store = {
  async listProjects() {
    return tx('projects', 'readonly', s => req(s.getAll()));
  },
  async getProject(id) {
    return tx('projects', 'readonly', s => req(s.get(id)));
  },
  async putProject(p) {
    p.updatedAt = Date.now();
    return tx('projects', 'readwrite', s => { s.put(JSON.parse(JSON.stringify(p))); });
  },
  async deleteProject(p) {
    await tx('files', 'readwrite', s => {
      for (const k of fileKeysOf(p)) s.delete(p.id + '/' + k);
    });
    return tx('projects', 'readwrite', s => { s.delete(p.id); });
  },
  async putFile(projectId, key, blob) {
    return tx('files', 'readwrite', s => { s.put(blob, projectId + '/' + key); });
  },
  async getFile(projectId, key) {
    return tx('files', 'readonly', s => req(s.get(projectId + '/' + key)));
  },
  async deleteFile(projectId, key) {
    return tx('files', 'readwrite', s => { s.delete(projectId + '/' + key); });
  },
  async estimate() {
    try { return await navigator.storage.estimate(); } catch { return null; }
  },
  async persist() {
    try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch {}
    return false;
  },
};

export function fileKeysOf(p) {
  const keys = [];
  for (const t of p.tracks || []) keys.push(t.fileKey);
  for (const t of p.takes || []) keys.push(t.fileKey);
  if (p.originalFileKey) keys.push(p.originalFileKey);
  return keys;
}

export function isQuotaError(e) {
  return e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''));
}
