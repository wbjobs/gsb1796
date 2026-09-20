/**
 * 主线程门面：对应用暴露简洁 API。
 * - 与 Web Worker 请求/响应通信（IndexedDB 与合并逻辑都在 worker 内）
 * - 监听 BroadcastChannel，实现跨标签页 / 跨上下文的热更新
 * - watch() 订阅生效配置变更，变更事件携带扁平 diff
 */

export class TenantConfigClient {
  constructor(workerUrl = new URL('./worker.js', import.meta.url)) {
    this.worker = new Worker(workerUrl, { type: 'module' });
    this.channel = new BroadcastChannel('tenant-config');
    this.seq = 0;
    this.pending = new Map();
    this.cache = new Map();       // tenantId -> resolved snapshot
    this.watchers = new Map();    // tenantId -> Set<callback>
    this.clientId = `tab-${Math.random().toString(36).slice(2, 10)}`;

    this.worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (ok) p.resolve(result);
      else {
        const err = new Error(error.message);
        err.code = error.code;
        err.conflicts = error.conflicts;
        err.currentVersion = error.currentVersion;
        p.reject(err);
      }
    };

    // 热更新入口：worker 提交成功后广播，本标签页与其它标签页都会收到
    this.channel.onmessage = (e) => this._onBroadcast(e.data);
  }

  _call(type, payload) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload });
    });
  }

  async _onBroadcast(msg) {
    if (!msg || msg.type !== 'config-changed') return;
    const affected = msg.affected || [msg.tenantId];
    for (const tenantId of affected) {
      if (!this.watchers.has(tenantId) && !this.cache.has(tenantId)) continue;
      const prev = this.cache.get(tenantId);
      const next = await this.resolve(tenantId);
      this.cache.set(tenantId, next);
      const cbs = this.watchers.get(tenantId);
      if (cbs && prev) {
        const diff = flatDiff(prev.config, next.config);
        for (const cb of cbs) cb(next, diff, msg);
      } else if (cbs) {
        for (const cb of cbs) cb(next, [], msg);
      }
    }
  }

  /** 初始化（可选 seed 定义租户层级与默认覆盖） */
  init(seed) { return this._call('init', { seed }); }

  defineTenant(tenantId, parent, overrides) {
    return this._call('defineTenant', { tenantId, parent, overrides, source: this.clientId });
  }

  listTenants() { return this._call('listTenants'); }

  /** 解析租户生效配置（沿继承链合并后的结果） */
  async resolve(tenantId) {
    const resolved = await this._call('resolve', { tenantId });
    this.cache.set(tenantId, resolved);
    return resolved;
  }

  async get(tenantId, path) {
    const { config } = this.cache.get(tenantId) || await this.resolve(tenantId);
    if (!path) return config;
    return path.split('.').reduce((o, k) => (o == null ? o : o[k]), config);
  }

  /**
   * 提交覆盖。changes: { 'a.b': value }，value 为 null 表示删除（墓碑）。
   * opts.baseVersion 提供时启用乐观并发；冲突时按 opts.strategy 处理：
   * 'manual'(默认，抛 CONFLICT) | 'theirs'(只应用无冲突部分) | 'mine'(强制覆盖)
   */
  set(tenantId, changes, opts = {}) {
    return this._call('set', {
      tenantId, changes,
      priority: opts.priority || 0,
      baseVersion: opts.baseVersion,
      strategy: opts.strategy || 'manual',
      source: this.clientId,
    });
  }

  /** 回滚到指定历史版本（生成新版本，不篡改历史） */
  rollback(tenantId, toVersion) {
    return this._call('rollback', { tenantId, toVersion, source: this.clientId });
  }

  history(tenantId, limit = 50) { return this._call('history', { tenantId, limit }); }

  /**
   * 订阅租户生效配置。立即回调一次，之后任何热更新（含其它标签页触发）都会推送。
   * 返回取消订阅函数。
   */
  async watch(tenantId, cb) {
    if (!this.watchers.has(tenantId)) this.watchers.set(tenantId, new Set());
    this.watchers.get(tenantId).add(cb);
    const resolved = await this.resolve(tenantId);
    this.cache.set(tenantId, resolved);
    cb(resolved, [], { type: 'init' });
    return () => this.watchers.get(tenantId)?.delete(cb);
  }

  destroy() {
    this.worker.terminate();
    this.channel.close();
  }
}

/** 扁平化对象用于 diff */
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) flatten(v, path, out);
    else out[path] = v;
  }
  return out;
}

function flatDiff(a, b) {
  const fa = flatten(a);
  const fb = flatten(b);
  const diffs = [];
  for (const k of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
    if (JSON.stringify(fa[k]) !== JSON.stringify(fb[k])) {
      diffs.push({ path: k, oldValue: fa[k], newValue: fb[k] });
    }
  }
  return diffs;
}

export function createConfigClient(workerUrl) {
  return new TenantConfigClient(workerUrl);
}
