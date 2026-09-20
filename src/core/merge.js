/**
 * 纯逻辑层：配置合并 / 继承链解析 / 优先级仲裁 / 三方冲突检测。
 * 不依赖 DOM / IndexedDB，可在 Web Worker 与 Node 测试中共用。
 *
 * 数据模型：
 * - 每个租户一层 override，扁平点路径 key -> 条目 { value, priority?, deleted? }
 * - deleted: true 为墓碑，表示显式删除祖先层提供的 key
 * - priority 数值越大优先级越高；相同优先级时，继承链中越具体（越靠近叶子租户）的层胜出
 */

export const ROOT_TENANT = '__root__';

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 深冻结克隆（结构化克隆的纯 JS 兜底，用于测试与防御性拷贝） */
export function deepClone(v) {
  if (typeof structuredClone === 'function') return structuredClone(v);
  return JSON.parse(JSON.stringify(v));
}

/** 校验点路径 key 合法性：a.b.c，段非空且不含 __proto__ 等危险段 */
export function assertValidPath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(`invalid config path: ${String(path)}`);
  }
  const segs = path.split('.');
  for (const s of segs) {
    if (!s || s === '__proto__' || s === 'constructor' || s === 'prototype') {
      throw new Error(`invalid config path segment in: ${path}`);
    }
  }
  return path;
}

/** 把扁平点路径条目展开成嵌套对象（跳过墓碑） */
export function expandEntries(entries) {
  const out = {};
  for (const [path, entry] of Object.entries(entries)) {
    if (!entry || entry.deleted) continue;
    assertValidPath(path);
    const segs = path.split('.');
    let node = out;
    for (let i = 0; i < segs.length - 1; i++) {
      if (!isPlainObject(node[segs[i]])) node[segs[i]] = {};
      node = node[segs[i]];
    }
    node[segs[segs.length - 1]] = deepClone(entry.value);
  }
  return out;
}

/**
 * 沿继承链解析生效配置。
 * @param {Array<{tenantId:string, overrides:Object}>} chain 从根到目标租户有序排列
 * @returns {{config:Object, sources:Object}} sources[path] = { tenantId, priority } 便于审计
 */
export function resolveChain(chain) {
  const winners = new Map(); // path -> { entry, depth, tenantId }
  chain.forEach((layer, depth) => {
    const overrides = layer?.overrides || {};
    for (const [path, entry] of Object.entries(overrides)) {
      if (!entry) continue;
      const priority = Number(entry.priority) || 0;
      const cur = winners.get(path);
      // 优先级高者胜；平级时深度大（更具体的租户）胜
      if (!cur || priority > cur.priority || (priority === cur.priority && depth >= cur.depth)) {
        winners.set(path, { entry, depth, tenantId: layer.tenantId, priority });
      }
    }
  });
  const effective = {};
  const sources = {};
  for (const [path, w] of winners) {
    effective[path] = w.entry;
    sources[path] = { tenantId: w.tenantId, priority: w.priority, deleted: !!w.entry.deleted };
  }
  return { config: expandEntries(effective), flat: effective, sources };
}

/**
 * 计算两组扁平 override 的差异。
 * @returns {Array<{path, type:'added'|'removed'|'changed', oldValue, newValue}>}
 */
export function diffOverrides(base, next) {
  const diffs = [];
  const keys = new Set([...Object.keys(base || {}), ...Object.keys(next || {})]);
  for (const path of keys) {
    const a = base?.[path];
    const b = next?.[path];
    const aVal = a && !a.deleted ? a.value : undefined;
    const bVal = b && !b.deleted ? b.value : undefined;
    const aHas = a !== undefined && !a.deleted;
    const bHas = b !== undefined && !b.deleted;
    if (!aHas && bHas) diffs.push({ path, type: 'added', oldValue: undefined, newValue: bVal });
    else if (aHas && !bHas) diffs.push({ path, type: 'removed', oldValue: aVal, newValue: undefined });
    else if (aHas && bHas && JSON.stringify(aVal) !== JSON.stringify(bVal)) {
      diffs.push({ path, type: 'changed', oldValue: aVal, newValue: bVal });
    }
  }
  return diffs.sort((x, y) => (x.path < y.path ? -1 : 1));
}

/**
 * 三方冲突检测：base（共同祖先）/ current（当前线上）/ incoming（待提交）。
 * @returns {{clean:Object, conflicts:Array<{path, baseValue, currentValue, incomingValue}>}}
 *   clean 为可安全应用的差量子集；conflicts 为双方都改且结果不一致的 key。
 */
export function threeWayMerge(base, current, incoming) {
  const toCurrent = diffOverrides(base, current);
  const toIncoming = diffOverrides(base, incoming);
  const currentByPath = new Map(toCurrent.map(d => [d.path, d]));
  const conflicts = [];
  const clean = [];
  for (const d of toIncoming) {
    const c = currentByPath.get(d.path);
    if (!c) { clean.push(d); continue; }
    const same = JSON.stringify(c.newValue) === JSON.stringify(d.newValue) &&
                 JSON.stringify(c.oldValue) === JSON.stringify(d.oldValue);
    if (!same) {
      conflicts.push({
        path: d.path,
        baseValue: d.oldValue,
        currentValue: c.newValue,
        incomingValue: d.newValue,
      });
    }
    // 双方改成一样：幂等，无需应用
  }
  return { clean, conflicts };
}

/** 把差异集应用到扁平 overrides 上，返回新对象 */
export function applyDiffs(overrides, diffs, priority = 0) {
  const out = deepClone(overrides || {});
  for (const d of diffs) {
    assertValidPath(d.path);
    if (d.type === 'removed') out[d.path] = { deleted: true, priority };
    else out[d.path] = { value: deepClone(d.newValue), priority };
  }
  return out;
}

/** 构建从 root 到目标租户的继承链（含环检测） */
export function buildChain(tenantId, layers) {
  const chain = [];
  const seen = new Set();
  let cur = tenantId;
  while (cur && cur !== ROOT_TENANT) {
    if (seen.has(cur)) throw new Error(`inheritance cycle detected at tenant: ${cur}`);
    seen.add(cur);
    const layer = layers[cur];
    if (!layer) throw new Error(`tenant not found in chain: ${cur}`);
    chain.unshift(layer);
    cur = layer.parent;
  }
  const root = layers[ROOT_TENANT];
  if (root) chain.unshift(root);
  return chain;
}
