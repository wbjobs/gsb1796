/**
 * 端到端集成测试：用内存版 IndexedDB shim + 真实 worker 代码，
 * 验证验收标准：租户覆盖 / 继承链 / 热更新广播 / 回滚 / 冲突检测。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// ---------- 内存版 IndexedDB 最小实现（覆盖 store.js 用到的 API） ----------
class FakeRequest {
  constructor() { this.onsuccess = null; this.onerror = null; }
  _ok(value) {
    this.result = value;
    setTimeout(() => this.onsuccess?.({ target: this }), 0);
  }
}

class FakeTransaction {
  constructor(db) {
    this.db = db;
    this.pending = 0;
    this.done = false;
    setTimeout(() => this._check(), 0);
  }
  objectStore(name) { return new FakeStore(this, this.db._stores[name]); }
  _track() { this.pending++; this.done = false; }
  _retire() { if (--this.pending === 0) setTimeout(() => this._check(), 0); }
  _check() { if (!this.done && this.pending === 0) { this.done = true; this.oncomplete?.(); } }
}

class FakeStore {
  constructor(tx, model) { this.tx = tx; this.m = model; }
  _req(fn) {
    const req = new FakeRequest();
    this.tx._track();
    setTimeout(() => { try { req._ok(fn()); } finally { this.tx._retire(); } }, 0);
    return req;
  }
  get(key) { return this._req(() => structuredClone(this.m.data.get(key))); }
  getAll() { return this._req(() => [...this.m.data.values()].map(v => structuredClone(v))); }
  put(v) { return this._req(() => { this.m.data.set(v[this.m.keyPath], structuredClone(v)); }); }
  add(v) { return this._req(() => { const id = ++this.m.seq; this.m.data.set(id, { ...structuredClone(v), id }); return id; }); }
  clear() { return this._req(() => this.m.data.clear()); }
  index(name) {
    const keyPath = this.m.indexes[name];
    const match = (v, k) => Array.isArray(keyPath)
      ? keyPath.every((p, i) => v[p] === k[i])
      : v[keyPath] === k;
    return {
      getAll: (k) => this._req(() => [...this.m.data.values()].filter(v => match(v, k)).map(x => structuredClone(x))),
      get: (k) => this._req(() => structuredClone([...this.m.data.values()].find(v => match(v, k)))),
    };
  }
}

function fakeIndexedDB() {
  const stores = {};
  return {
    open() {
      const req = new FakeRequest();
      setTimeout(() => {
        const db = {
          _stores: stores,
          objectStoreNames: { contains: (n) => n in stores },
          createObjectStore(name, opts) {
            stores[name] = { keyPath: opts.keyPath, data: new Map(), seq: 0, indexes: {} };
            return { createIndex: (n, kp) => { stores[name].indexes[n] = kp; } };
          },
          transaction: () => new FakeTransaction(db),
        };
        req.result = db;
        req.onupgradeneeded?.();
        req.onsuccess?.();
      }, 0);
      return req;
    },
  };
}

// ---------- 装配：全局 shim + 加载真实 worker ----------
const responses = new Map();
let msgSeq = 0;
const waiters = new Map();

globalThis.indexedDB = fakeIndexedDB();
globalThis.self = {
  onmessage: null,
  postMessage(msg) {
    responses.set(msg.id, msg);
    waiters.get(msg.id)?.(msg);
  },
};

await import('../src/worker.js');

const bus = new BroadcastChannel('tenant-config');
bus.unref();
const broadcasts = [];
bus.onmessage = (e) => broadcasts.push(e.data);

function call(type, payload) {
  const id = ++msgSeq;
  return new Promise((resolve, reject) => {
    waiters.set(id, (msg) => {
      waiters.delete(id);
      if (msg.ok) resolve(msg.result);
      else reject(Object.assign(new Error(msg.error.message), msg.error));
    });
    self.onmessage({ data: { id, type, payload } });
  });
}

const SEED = {
  __root__: { parent: null, overrides: {
    'theme.color': { value: 'blue' },
    'feature.chat': { value: false },
    'limits.api': { value: 100 },
  }},
  groupA: { parent: '__root__', overrides: {
    'theme.color': { value: 'green' },
    'feature.chat': { value: true },
  }},
  tenant1: { parent: 'groupA', overrides: { 'theme.color': { value: 'red' } } },
  tenant2: { parent: 'groupA', overrides: {} },
};

before(async () => {
  await call('init', { seed: SEED });
});

test('验收1 租户覆盖生效 + 继承链正确 + 租户隔离', async () => {
  const r1 = await call('resolve', { tenantId: 'tenant1' });
  assert.deepEqual(r1.chain, ['__root__', 'groupA', 'tenant1']);
  assert.equal(r1.config.theme.color, 'red');      // 自身覆盖
  assert.equal(r1.config.feature.chat, true);      // 继承 groupA
  assert.equal(r1.config.limits.api, 100);         // 继承 root

  const r2 = await call('resolve', { tenantId: 'tenant2' });
  assert.equal(r2.config.theme.color, 'green');    // 不受 tenant1 影响
});

test('验收2 热更新即时广播（含继承下游）', async () => {
  broadcasts.length = 0;
  await call('set', { tenantId: 'groupA', changes: { 'limits.api': 500 }, source: 'test' });
  await new Promise(r => setTimeout(r, 20)); // BroadcastChannel 异步投递
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].type, 'config-changed');
  assert.ok(broadcasts[0].affected.includes('tenant1'));
  assert.ok(broadcasts[0].affected.includes('tenant2'));

  const r = await call('resolve', { tenantId: 'tenant2' });
  assert.equal(r.config.limits.api, 500);          // 下游即时可见
});

test('验收3 冲突可检测（过期 baseVersion + 三方对比）', async () => {
  const before1 = await call('resolve', { tenantId: 'tenant1' });
  const stale = before1.version;
  await call('set', { tenantId: 'tenant1', changes: { 'theme.color': 'black' }, source: 'other-tab' });
  await assert.rejects(
    call('set', { tenantId: 'tenant1', changes: { 'theme.color': 'white' }, baseVersion: stale, strategy: 'manual' }),
    (err) => {
      assert.equal(err.code, 'CONFLICT');
      assert.equal(err.conflicts[0].path, 'theme.color');
      assert.equal(err.conflicts[0].currentValue, 'black');
      assert.equal(err.conflicts[0].incomingValue, 'white');
      return true;
    },
  );
  // theirs 策略：冲突键保持线上值，干净键正常应用
  const r = await call('set', {
    tenantId: 'tenant1',
    changes: { 'theme.color': 'white', 'new.key': 'ok' },
    baseVersion: stale, strategy: 'theirs',
  });
  assert.ok(r.version > 0);
  const after = await call('resolve', { tenantId: 'tenant1' });
  assert.equal(after.config.theme.color, 'black'); // 冲突键未被覆盖
  assert.equal(after.config.new.key, 'ok');        // 干净键已应用
});

test('验收4 回滚正确（恢复旧版本且生成新版本，历史可审计）', async () => {
  const v0 = (await call('resolve', { tenantId: 'tenant2' })).version;
  await call('set', { tenantId: 'tenant2', changes: { 'limits.api': 999 } });
  await call('set', { tenantId: 'tenant2', changes: { 'extra.flag': true } });
  const rb = await call('rollback', { tenantId: 'tenant2', toVersion: v0, source: 'test' });
  assert.equal(rb.restoredFrom, v0);

  const r = await call('resolve', { tenantId: 'tenant2' });
  assert.equal(r.config.limits.api, 500);          // 回到 v0 时的继承值
  assert.equal(r.config.extra?.flag, undefined);   // 后续覆盖被撤销
  assert.equal(r.version, rb.version);             // 回滚产生新版本而非篡改历史

  const hist = await call('history', { tenantId: 'tenant2' });
  assert.ok(hist.some(h => h.label === `rollback-to-v${v0}`));
});

test('优先级：高 priority 覆盖可压过子层默认值', async () => {
  await call('set', { tenantId: 'groupA', changes: { 'theme.font': 'serif' }, priority: 100 });
  await call('set', { tenantId: 'tenant1', changes: { 'theme.font': 'sans' } });
  const r = await call('resolve', { tenantId: 'tenant1' });
  assert.equal(r.config.theme.font, 'serif');
  assert.equal(r.sources['theme.font'].tenantId, 'groupA');
});
