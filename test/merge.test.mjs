import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deepMerge, buildChain, resolveChain, flattenPaths,
  detectShadows, checkVersionConflict,
} from '../src/merge.js';

const tenants = new Map([
  ['global', { id: 'global', parentId: null }],
  ['region', { id: 'region', parentId: 'global' }],
  ['tenant-a', { id: 'tenant-a', parentId: 'region' }],
  ['tenant-b', { id: 'tenant-b', parentId: 'region' }],
]);

function makeConfigs(overrides) {
  return new Map(Object.entries(overrides).map(([k, o]) => [k, { tenantId: k, overrides: o }]));
}

test('深合并：对象递归、数组替换、null 删除', () => {
  const base = { a: { b: 1, c: 2 }, arr: [1, 2], gone: 'x' };
  const out = deepMerge(base, { a: { c: 3 }, arr: [9], gone: null });
  assert.deepEqual(out, { a: { b: 1, c: 3 }, arr: [9] });
});

test('继承链顺序正确：根 -> 父 -> 当前', () => {
  const chain = buildChain(tenants, 'tenant-a');
  assert.deepEqual(chain.map((t) => t.id), ['global', 'region', 'tenant-a']);
});

test('继承链环检测', () => {
  const cyclic = new Map([
    ['x', { id: 'x', parentId: 'y' }],
    ['y', { id: 'y', parentId: 'x' }],
  ]);
  assert.throws(() => buildChain(cyclic, 'x'), /环/);
});

test('覆盖优先级：叶子 > 父级 > 全局，且来源标注正确', () => {
  const configs = makeConfigs({
    global: { theme: { color: 'blue', dark: false }, limit: 100 },
    region: { theme: { color: 'green' }, limit: 500 },
    'tenant-a': { theme: { color: 'red' } },
  });
  const { config, sources } = resolveChain(tenants, configs, 'tenant-a');
  assert.equal(config.theme.color, 'red');      // 租户覆盖生效
  assert.equal(config.theme.dark, false);       // 全局继承
  assert.equal(config.limit, 500);              // 父级覆盖全局
  assert.equal(sources['theme.color'].tenantId, 'tenant-a');
  assert.equal(sources['theme.dark'].tenantId, 'global');
  assert.equal(sources['limit'].tenantId, 'region');
});

test('租户隔离：tenant-a 的覆盖不影响 tenant-b', () => {
  const configs = makeConfigs({
    global: { limit: 100 },
    'tenant-a': { limit: 999 },
  });
  const b = resolveChain(tenants, configs, 'tenant-b');
  assert.equal(b.config.limit, 100);
});

test('null 删除沿继承链生效', () => {
  const configs = makeConfigs({
    global: { feature: { x: true, y: true } },
    'tenant-a': { feature: { x: null } },
  });
  const { config } = resolveChain(tenants, configs, 'tenant-a');
  assert.deepEqual(config.feature, { y: true });
});

test('遮蔽冲突检测：父级写入被子孙覆盖的键', () => {
  const configs = makeConfigs({
    region: {},
    'tenant-a': { theme: { color: 'red' } },
    'tenant-b': { limit: 1 },
  });
  const shadows = detectShadows(tenants, configs, 'region', { theme: { color: 'black' }, limit: 10 });
  const a = shadows.find((s) => s.tenantId === 'tenant-a');
  const b = shadows.find((s) => s.tenantId === 'tenant-b');
  assert.deepEqual(a.paths, ['theme.color']);
  assert.deepEqual(b.paths, ['limit']);
});

test('版本冲突检测（乐观并发）', () => {
  assert.equal(checkVersionConflict(3, 3), null);
  const c = checkVersionConflict(5, 3);
  assert.equal(c.type, 'version-conflict');
  assert.equal(c.currentVersion, 5);
  assert.equal(checkVersionConflict(7, null), null); // 强制写不校验
});

test('flattenPaths 展开叶子路径', () => {
  assert.deepEqual(flattenPaths({ a: { b: 1, c: { d: 2 } }, e: 3 }), ['a.b', 'a.c.d', 'e']);
});

test('回滚语义：历史版本快照可还原为新的当前配置', () => {
  // 模拟 worker 的 rollback：取历史 v1 的 overrides 覆盖当前
  const history = [
    { version: 1, overrides: { a: 1 } },
    { version: 2, overrides: { a: 2, b: 2 } },
  ];
  const target = history.find((h) => h.version === 1);
  const rolledBack = structuredClone(target.overrides);
  assert.deepEqual(rolledBack, { a: 1 });
  const configs = makeConfigs({ global: {}, 'tenant-a': rolledBack });
  const { config } = resolveChain(tenants, configs, 'tenant-a');
  assert.deepEqual(config, { a: 1 });
});
