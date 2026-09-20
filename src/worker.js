/**
 * 配置中心 Web Worker：
 * - 独占 IndexedDB 写入，串行化所有写操作（promise 队列）
 * - 乐观并发：baseVersion 校验 + 三方合并，冲突可检测/可策略化处理
 * - 写入成功后通过 BroadcastChannel 广播变更（含受继承影响的下游租户）
 */
import { openStore } from './core/store.js';
import {
  ROOT_TENANT, buildChain, resolveChain, applyDiffs,
  threeWayMerge, diffOverrides, deepClone,
} from './core/merge.js';

const channel = new BroadcastChannel('tenant-config');
// Node 环境下 unref，避免测试进程无法退出（浏览器中无 unref）
if (typeof window === 'undefined' && typeof channel.unref === 'function') channel.unref();
let store = null;
let writeQueue = Promise.resolve();

/** 写操作串行化，保证版本号单调、提交有序 */
function enqueueWrite(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch(() => {});
  return run;
}

function descendantsOf(tenantId, layers) {
  const children = new Map();
  for (const l of Object.values(layers)) {
    if (!children.has(l.parent)) children.set(l.parent, []);
    children.get(l.parent).push(l.tenantId);
  }
  const out = [];
  const stack = [tenantId];
  while (stack.length) {
    const cur = stack.pop();
    for (const c of children.get(cur) || []) {
      out.push(c);
      stack.push(c);
    }
  }
  return out;
}

async function resolveTenant(tenantId) {
  const layers = await store.getAllLayers();
  const chain = buildChain(tenantId, layers);
  const { config, sources } = resolveChain(chain);
  const self = layers[tenantId];
  return {
    tenantId,
    version: self?.version ?? 0,
    chain: chain.map(l => l.tenantId),
    config,
    sources,
  };
}

function changesToDiffs(changes, baseOverrides) {
  const incoming = {};
  for (const [path, value] of Object.entries(changes)) {
    incoming[path] = value === null ? { deleted: true } : { value };
  }
  return diffOverrides(baseOverrides, incoming);
}

async function handleSet({ tenantId, changes, priority = 0, baseVersion, strategy = 'manual', source = 'unknown' }) {
  return enqueueWrite(async () => {
    const layers = await store.getAllLayers();
    const current = layers[tenantId];
    if (!current) throw Object.assign(new Error(`tenant not found: ${tenantId}`), { code: 'NOT_FOUND' });

    const currentVersion = current.version;
    let toApply = changesToDiffs(changes, current.overrides);

    if (baseVersion !== undefined && baseVersion !== currentVersion) {
      // 版本不一致：取共同祖先快照做三方合并
      const baseSnap = await store.getHistoryVersion(tenantId, baseVersion);
      const baseOverrides = baseSnap?.overrides || {};
      const incoming = applyDiffs(baseOverrides, changesToDiffs(changes, baseOverrides), priority);
      const { clean, conflicts } = threeWayMerge(baseOverrides, current.overrides, incoming);

      if (conflicts.length > 0 && strategy === 'manual') {
        throw Object.assign(new Error('conflict detected'), {
          code: 'CONFLICT',
          conflicts,
          currentVersion,
        });
      }
      toApply = strategy === 'mine'
        ? changesToDiffs(changes, current.overrides)   // 我方全量覆盖
        : clean;                                        // theirs：仅应用无冲突部分
    }

    const nextOverrides = applyDiffs(current.overrides, toApply, priority);
    const nextVersion = currentVersion + 1;
    const now = Date.now();
    const layer = { ...current, overrides: nextOverrides, version: nextVersion, updatedAt: now, updatedBy: source };
    await store.commitLayer(layer, {
      tenantId, version: nextVersion, parent: current.parent,
      overrides: deepClone(nextOverrides), ts: now, source, label: 'set',
    });

    const affected = [tenantId, ...descendantsOf(tenantId, layers)];
    channel.postMessage({
      type: 'config-changed', tenantId, version: nextVersion,
      changedKeys: toApply.map(d => d.path), affected, source, rollback: false,
    });
    return { version: nextVersion, applied: toApply.map(d => d.path) };
  });
}

async function handleRollback({ tenantId, toVersion, source = 'unknown' }) {
  return enqueueWrite(async () => {
    const layers = await store.getAllLayers();
    const current = layers[tenantId];
    if (!current) throw Object.assign(new Error(`tenant not found: ${tenantId}`), { code: 'NOT_FOUND' });
    const snap = await store.getHistoryVersion(tenantId, toVersion);
    if (!snap) throw Object.assign(new Error(`history version not found: ${tenantId}@${toVersion}`), { code: 'NOT_FOUND' });

    const nextVersion = current.version + 1;
    const now = Date.now();
    const restored = deepClone(snap.overrides);
    const layer = { ...current, overrides: restored, version: nextVersion, updatedAt: now, updatedBy: source };
    await store.commitLayer(layer, {
      tenantId, version: nextVersion, parent: current.parent,
      overrides: deepClone(restored), ts: now, source, label: `rollback-to-v${toVersion}`,
    });

    const changedKeys = diffOverrides(current.overrides, restored).map(d => d.path);
    const affected = [tenantId, ...descendantsOf(tenantId, layers)];
    channel.postMessage({
      type: 'config-changed', tenantId, version: nextVersion,
      changedKeys, affected, source, rollback: true, restoredFrom: toVersion,
    });
    return { version: nextVersion, restoredFrom: toVersion, changedKeys };
  });
}

async function handleDefineTenant({ tenantId, parent = ROOT_TENANT, overrides = {}, source = 'system' }) {
  return enqueueWrite(async () => {
    const existing = await store.getLayer(tenantId);
    if (existing) return { version: existing.version, existed: true };
    const now = Date.now();
    const layer = { tenantId, parent, overrides, version: 1, updatedAt: now, updatedBy: source };
    await store.commitLayer(layer, {
      tenantId, version: 1, parent, overrides: deepClone(overrides), ts: now, source, label: 'create',
    });
    return { version: 1, existed: false };
  });
}

const handlers = {
  async init({ seed }) {
    store = await openStore();
    if (seed) {
      const existing = await store.getAllLayers();
      for (const [tenantId, def] of Object.entries(seed)) {
        if (!existing[tenantId]) {
          await handleDefineTenant({ tenantId, parent: def.parent, overrides: def.overrides || {} });
        }
      }
    }
    return { ok: true };
  },
  resolve: ({ tenantId }) => resolveTenant(tenantId),
  set: handleSet,
  rollback: handleRollback,
  defineTenant: handleDefineTenant,
  history: ({ tenantId, limit }) => store.getHistory(tenantId, limit),
  listTenants: async () => {
    const layers = await store.getAllLayers();
    return Object.values(layers).map(l => ({
      tenantId: l.tenantId, parent: l.parent, version: l.version, updatedAt: l.updatedAt,
    }));
  },
};

self.onmessage = async (e) => {
  const { id, type, payload } = e.data || {};
  try {
    const handler = handlers[type];
    if (!handler) throw new Error(`unknown message type: ${type}`);
    const result = await handler(payload || {});
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({
      id, ok: false,
      error: {
        code: err.code || 'ERROR',
        message: err.message,
        conflicts: err.conflicts,
        currentVersion: err.currentVersion,
      },
    });
  }
};
