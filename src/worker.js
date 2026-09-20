// Web Worker：唯一写入口。所有配置写操作在此串行执行，保证一致性；
// 每次变更通过 BroadcastChannel 广播，实现跨标签页热更新。

import { openDB, getAll, getOne, put, putConfigWithHistory, getHistory, seedIfEmpty } from './db.js';
import { resolveChain, deepMerge, detectShadows, checkVersionConflict } from './merge.js';

const bus = new BroadcastChannel('tenant-config-bus');
let db;

const SEED_TENANTS = [
  { id: 'global', name: '全局默认', parentId: null },
  { id: 'region-cn', name: '中国区', parentId: 'global' },
  { id: 'tenant-a', name: '租户 A', parentId: 'region-cn' },
  { id: 'tenant-b', name: '租户 B', parentId: 'region-cn' },
];

const now = () => Date.now();

const SEED_CONFIGS = [
  {
    tenantId: 'global', version: 1, updatedAt: now(), updatedBy: 'system',
    overrides: {
      theme: { primaryColor: '#1677ff', darkMode: false },
      features: { export: true, aiAssistant: false },
      limits: { maxUsers: 100, maxStorageGB: 10 },
      locale: 'zh-CN',
    },
  },
  {
    tenantId: 'region-cn', version: 1, updatedAt: now(), updatedBy: 'system',
    overrides: { features: { aiAssistant: true }, limits: { maxUsers: 500 } },
  },
  {
    tenantId: 'tenant-a', version: 1, updatedAt: now(), updatedBy: 'system',
    overrides: { theme: { primaryColor: '#f5222d' } },
  },
  { tenantId: 'tenant-b', version: 1, updatedAt: now(), updatedBy: 'system', overrides: {} },
];

async function loadState() {
  const tenants = await getAll(db, 'tenants');
  const configs = await getAll(db, 'configs');
  return {
    tenantsById: new Map(tenants.map((t) => [t.id, t])),
    configsByTenant: new Map(configs.map((c) => [c.tenantId, c])),
  };
}

function broadcast(payload) {
  bus.postMessage({ ...payload, at: Date.now() });
}

const actions = {
  async listTenants() {
    const { tenantsById } = await loadState();
    return [...tenantsById.values()];
  },

  async getEffective({ tenantId }) {
    const { tenantsById, configsByTenant } = await loadState();
    const resolved = resolveChain(tenantsById, configsByTenant, tenantId);
    const record = configsByTenant.get(tenantId);
    return { ...resolved, version: record?.version ?? 0, overrides: record?.overrides ?? {} };
  },

  // 写入 override 补丁。payload: { tenantId, patch, baseVersion, updatedBy, force }
  async setConfig({ tenantId, patch, baseVersion, updatedBy = 'anonymous', force = false }) {
    const { tenantsById, configsByTenant } = await loadState();
    if (!tenantsById.has(tenantId)) throw new Error(`租户不存在: ${tenantId}`);

    const current = configsByTenant.get(tenantId) || { tenantId, version: 0, overrides: {} };
    if (!force) {
      const conflict = checkVersionConflict(current.version, baseVersion);
      if (conflict) return { ok: false, conflict };
    }

    // 遮蔽检测：父级写入被子孙覆盖的键时给出警告（不阻断）
    const shadows = detectShadows(tenantsById, configsByTenant, tenantId, patch);

    const next = {
      tenantId,
      version: current.version + 1,
      overrides: deepMerge(current.overrides, patch),
      updatedAt: Date.now(),
      updatedBy,
    };
    await putConfigWithHistory(db, next, {
      key: `${tenantId}@${next.version}`,
      tenantId,
      version: next.version,
      overrides: next.overrides,
      updatedAt: next.updatedAt,
      updatedBy,
      reason: 'set',
    });
    broadcast({ type: 'config-changed', tenantId, version: next.version, updatedBy });
    return { ok: true, version: next.version, shadows };
  },

  async getHistory({ tenantId }) {
    return getHistory(db, tenantId);
  },

  // 回滚：把指定历史版本的 overrides 作为新版本写入（历史本身不可变，回滚也是一次新版本）。
  async rollback({ tenantId, toVersion, updatedBy = 'anonymous' }) {
    const history = await getHistory(db, tenantId);
    const target = history.find((h) => h.version === toVersion);
    if (!target) throw new Error(`历史版本不存在: ${tenantId}@v${toVersion}`);
    const current = (await getOne(db, 'configs', tenantId)) || { tenantId, version: 0 };
    const next = {
      tenantId,
      version: current.version + 1,
      overrides: structuredClone(target.overrides),
      updatedAt: Date.now(),
      updatedBy,
    };
    await putConfigWithHistory(db, next, {
      key: `${tenantId}@${next.version}`,
      tenantId,
      version: next.version,
      overrides: next.overrides,
      updatedAt: next.updatedAt,
      updatedBy,
      reason: `rollback-to-v${toVersion}`,
    });
    broadcast({ type: 'config-changed', tenantId, version: next.version, updatedBy, rollback: true });
    return { ok: true, version: next.version };
  },
};

self.onmessage = async (e) => {
  const { id, action, payload } = e.data;
  try {
    const result = await actions[action](payload || {});
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message });
  }
};

(async () => {
  db = await openDB();
  await seedIfEmpty(db, SEED_TENANTS, SEED_CONFIGS);
  self.postMessage({ id: '__ready__', ok: true });
})();
