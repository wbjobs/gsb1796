// 主线程客户端：RPC 调用 Worker + 监听 BroadcastChannel 实现热更新事件。

export class ConfigClient {
  constructor() {
    this.worker = new Worker('./src/worker.js', { type: 'module' });
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.ready = new Promise((resolve) => {
      const onMsg = (e) => {
        if (e.data.id === '__ready__') {
          this.worker.removeEventListener('message', onMsg);
          resolve();
        }
      };
      this.worker.addEventListener('message', onMsg);
    });

    this.worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      ok ? p.resolve(result) : p.reject(new Error(error));
    };

    // 热更新：Worker 广播的变更（含其他标签页的写入）在此转成事件
    this.bus = new BroadcastChannel('tenant-config-bus');
    this.bus.onmessage = (e) => {
      for (const fn of this.listeners) fn(e.data);
    };
  }

  call(action, payload) {
    const id = `req-${++this.seq}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, action, payload });
    });
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  listTenants() { return this.call('listTenants'); }
  getEffective(tenantId) { return this.call('getEffective', { tenantId }); }
  getHistory(tenantId) { return this.call('getHistory', { tenantId }); }
  setConfig(opts) { return this.call('setConfig', opts); }
  rollback(tenantId, toVersion, updatedBy) {
    return this.call('rollback', { tenantId, toVersion, updatedBy });
  }
}
