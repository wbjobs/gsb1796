/**
 * IndexedDB 持久化层（在 Web Worker 内运行）。
 * 两个 object store：
 * - layers:  key = tenantId，value = { tenantId, parent, overrides, version, updatedAt, updatedBy }
 * - history: 自增 id，value = { tenantId, version, parent, overrides, ts, source, label }
 * 每次写入先落 history 快照再更新 layer，保证任意版本可回滚。
 */

const DB_NAME = 'tenant-config-db';
const DB_VERSION = 1;

export function openStore(dbName = DB_NAME) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('layers')) {
        db.createObjectStore('layers', { keyPath: 'tenantId' });
      }
      if (!db.objectStoreNames.contains('history')) {
        const h = db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
        h.createIndex('byTenant', 'tenantId', { unique: false });
        h.createIndex('byTenantVersion', ['tenantId', 'version'], { unique: true });
      }
    };
    req.onsuccess = () => resolve(wrapDb(req.result));
    req.onerror = () => reject(req.error);
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function wrapDb(db) {
  return {
    async getLayer(tenantId) {
      const t = db.transaction('layers', 'readonly');
      return reqToPromise(t.objectStore('layers').get(tenantId));
    },

    async getAllLayers() {
      const t = db.transaction('layers', 'readonly');
      const all = await reqToPromise(t.objectStore('layers').getAll());
      const map = {};
      for (const l of all) map[l.tenantId] = l;
      return map;
    },

    /** 原子写入：history 快照 + layer 更新，同一事务保证一致性 */
    async commitLayer(layer, historyEntry) {
      const t = db.transaction(['layers', 'history'], 'readwrite');
      t.objectStore('history').add(historyEntry);
      t.objectStore('layers').put(layer);
      return new Promise((resolve, reject) => {
        t.oncomplete = () => resolve(layer);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('commit aborted'));
      });
    },

    async getHistory(tenantId, limit = 50) {
      const t = db.transaction('history', 'readonly');
      const idx = t.objectStore('history').index('byTenant');
      const all = await reqToPromise(idx.getAll(tenantId));
      return all.sort((a, b) => b.version - a.version).slice(0, limit);
    },

    async getHistoryVersion(tenantId, version) {
      const t = db.transaction('history', 'readonly');
      const idx = t.objectStore('history').index('byTenantVersion');
      return reqToPromise(idx.get([tenantId, version]));
    },

    async clear() {
      const t = db.transaction(['layers', 'history'], 'readwrite');
      t.objectStore('layers').clear();
      t.objectStore('history').clear();
      return new Promise((resolve, reject) => {
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      });
    },
  };
}
