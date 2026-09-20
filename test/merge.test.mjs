import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROOT_TENANT, buildChain, resolveChain, expandEntries,
  diffOverrides, threeWayMerge, applyDiffs,
} from '../src/core/merge.js';

const layers = {
  [ROOT_TENANT]: {
    tenantId: ROOT_TENANT, parent: null,
    overrides: {
      'theme.color': { value: 'blue' },
      'theme.fontSize': { value: 14 },
      'feature.chat': { value: false },
      'limits.api': { value: 100 },
    },
  },
  groupA: {
    tenantId: 'groupA', parent: ROOT_TENANT,
    overrides: {
      'theme.color': { value: 'green' },
      'feature.chat': { value: true },
    },
  },
  tenant1: {
    tenantId: 'tenant1', parent: 'groupA',
    overrides: {
      'theme.color': { value: 'red' },
    },
  },
  tenant2: {
    tenantId: 'tenant2', parent: 'groupA',
    overrides: {},
  },
};

test('继承链：root -> groupA -> tenant1 顺序正确', () => {
  const chain = buildChain('tenant1', layers);
  assert.deepEqual(chain.map(l => l.tenantId), [ROOT_TENANT, 'groupA', 'tenant1']);
});

test('继承链：子租户覆盖生效，未覆盖的键沿链继承', () => {
  const { config } = resolveChain(buildChain('tenant1', layers));
  assert.equal(config.theme.color, 'red');        // tenant1 覆盖
  assert.equal(config.theme.fontSize, 14);        // root 继承
  assert.equal(config.feature.chat, true);        // groupA 继承
});

test('租户隔离：tenant2 不受 tenant1 覆盖影响', () => {
  const { config } = resolveChain(buildChain('tenant2', layers));
  assert.equal(config.theme.color, 'green');      // 只到 groupA
  assert.equal(config.limits.api, 100);
});

test('优先级：高 priority 的祖先层可压过默认优先级的后代层', () => {
  const custom = {
    ...layers,
    groupA: {
      tenantId: 'groupA', parent: ROOT_TENANT,
      overrides: { 'theme.color': { value: 'purple', priority: 10 } },
    },
  };
  const { config, sources } = resolveChain(buildChain('tenant1', custom));
  assert.equal(config.theme.color, 'purple');
  assert.equal(sources['theme.color'].tenantId, 'groupA');
});

test('墓碑删除：子层可删除祖先提供的键', () => {
  const custom = {
    ...layers,
    tenant1: {
      tenantId: 'tenant1', parent: 'groupA',
      overrides: { 'theme.fontSize': { deleted: true } },
    },
  };
  const { config } = resolveChain(buildChain('tenant1', custom));
  assert.equal(config.theme.fontSize, undefined);
});

test('环检测：继承链成环时报错', () => {
  const cyclic = {
    a: { tenantId: 'a', parent: 'b', overrides: {} },
    b: { tenantId: 'b', parent: 'a', overrides: {} },
  };
  assert.throws(() => buildChain('a', cyclic), /cycle/);
});

test('diffOverrides：added/removed/changed 分类正确', () => {
  const diffs = diffOverrides(
    { a: { value: 1 }, b: { value: 2 } },
    { b: { value: 3 }, c: { value: 4 } },
  );
  assert.deepEqual(diffs, [
    { path: 'a', type: 'removed', oldValue: 1, newValue: undefined },
    { path: 'b', type: 'changed', oldValue: 2, newValue: 3 },
    { path: 'c', type: 'added', oldValue: undefined, newValue: 4 },
  ]);
});

test('三方合并：无冲突修改干净应用，双方改同一键检测为冲突', () => {
  const base = { 'x.a': { value: 1 }, 'x.b': { value: 2 } };
  const current = { 'x.a': { value: 10 }, 'x.b': { value: 2 } };   // 线上改了 a
  const incoming = { 'x.a': { value: 99 }, 'x.b': { value: 20 } }; // 我改了 a 和 b
  const { clean, conflicts } = threeWayMerge(base, current, incoming);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].path, 'x.a');
  assert.equal(conflicts[0].currentValue, 10);
  assert.equal(conflicts[0].incomingValue, 99);
  assert.deepEqual(clean.map(d => d.path), ['x.b']);               // b 可干净应用
});

test('三方合并：双方改成相同值不算冲突（幂等）', () => {
  const base = { a: { value: 1 } };
  const current = { a: { value: 5 } };
  const incoming = { a: { value: 5 } };
  const { clean, conflicts } = threeWayMerge(base, current, incoming);
  assert.equal(conflicts.length, 0);
  assert.equal(clean.length, 0);
});

test('applyDiffs：应用差异并支持墓碑', () => {
  const out = applyDiffs({ a: { value: 1 } }, [
    { path: 'a', type: 'changed', newValue: 2 },
    { path: 'b.c', type: 'added', newValue: 'x' },
    { path: 'a', type: 'removed' },
  ]);
  assert.equal(out.a.deleted, true);
  assert.equal(out['b.c'].value, 'x');
});

test('expandEntries：扁平路径展开为嵌套对象且拒绝危险路径', () => {
  const obj = expandEntries({ 'a.b.c': { value: 1 }, 'a.d': { value: 2 } });
  assert.deepEqual(obj, { a: { b: { c: 1 }, d: 2 } });
  assert.throws(() => expandEntries({ '__proto__.x': { value: 1 } }), /invalid/);
});
