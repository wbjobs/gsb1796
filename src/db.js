// IndexedDB 持久层：tenants（租户树）、configs（当前 overrides + 版本）、history（历史快照，用于回滚）。

const DB_NAME = 'tenant-config-db';
const DB_VERSION = 1;

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tenants')) {
        db.createObjectStore('tenants', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('configs')) {
        db.createObjectStore('configs', { keyPath: 'tenantId' });
      }
      if (!db.objectStoreNames.contains('history')) {
        const store = db.createObjectStore('history', { keyPath: 'key' });
        store.createIndex('byTenant', 'tenantId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const result = fn(t);
    t.oncomplete = () => resolve(result?.value);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAll(db, store) {
  return reqToPromise(db.transaction(store, 'readonly').objectStore(store).getAll());
}

export async function getOne(db, store, key) {
  return reqToPromise(db.transaction(store, 'readonly').objectStore(store).get(key));
}

export async function put(db, store, value) {
  return reqToPromise(db.transaction(store, 'readwrite').objectStore(store).put(value));
}

// 原子写：更新 config 并追加 history 快照（同事务，失败一起回滚）。
export function putConfigWithHistory(db, configRecord, historyRecord) {
  return tx(db, ['configs', 'history'], 'readwrite', (t) => {
    t.objectStore('configs').put(configRecord);
    t.objectStore('history').put(historyRecord);
  });
}

export async function getHistory(db, tenantId) {
  const rows = await reqToPromise(
    db.transaction('history', 'readonly').objectStore('history').index('byTenant').getAll(tenantId)
  );
  return rows.sort((a, b) => b.version - a.version);
}

export async function seedIfEmpty(db, seedTenants, seedConfigs) {
  const existing = await getAll(db, 'tenants');
  if (existing.length > 0) return false;
  await tx(db, ['tenants', 'configs', 'history'], 'readwrite', (t) => {
    for (const tenant of seedTenants) t.objectStore('tenants').put(tenant);
    for (const cfg of seedConfigs) {
      t.objectStore('configs').put(cfg);
      t.objectStore('history').put({
        key: `${cfg.tenantId}@${cfg.version}`,
        tenantId: cfg.tenantId,
        version: cfg.version,
        overrides: cfg.overrides,
        updatedAt: cfg.updatedAt,
        updatedBy: cfg.updatedBy,
        reason: 'seed',
      });
    }
  });
  return true;
}
