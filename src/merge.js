// 纯函数核心：配置合并、继承链解析、冲突检测。不依赖浏览器 API，可在 Node 中单测。

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// 深合并。约定：override 中值为 null 表示“删除该键”；数组整体替换；对象递归合并。
// sources（可选）记录每个叶子键路径最后由哪个 tenant 设置，用于来源追踪与冲突检测。
export function deepMerge(base, override, sources, tenantId, path = '') {
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(override || {})) {
    const keyPath = path ? `${path}.${key}` : key;
    if (value === null) {
      delete out[key];
      if (sources) sources[keyPath] = { tenantId, deleted: true };
      continue;
    }
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value, sources, tenantId, keyPath);
    } else if (isPlainObject(value)) {
      out[key] = deepMerge({}, value, sources, tenantId, keyPath);
    } else {
      out[key] = value;
      if (sources) sources[keyPath] = { tenantId, deleted: false };
    }
  }
  return out;
}

// 由 tenantId 沿 parentId 走到根，返回 [根, ..., 当前租户] 的继承链。检测环与断链。
export function buildChain(tenantsById, tenantId) {
  const chain = [];
  const seen = new Set();
  let cursor = tenantId;
  while (cursor != null) {
    if (seen.has(cursor)) {
      throw new Error(`继承链存在环: ${[...seen, cursor].join(' -> ')}`);
    }
    seen.add(cursor);
    const tenant = tenantsById.get(cursor);
    if (!tenant) throw new Error(`继承链断裂: 租户 ${cursor} 不存在`);
    chain.unshift(tenant);
    cursor = tenant.parentId;
  }
  return chain;
}

// 解析租户生效配置：从根到叶子依次合并各层 overrides。
// 返回 { config, sources, chain }，sources[path] = { tenantId, deleted }。
export function resolveChain(tenantsById, configsByTenant, tenantId) {
  const chain = buildChain(tenantsById, tenantId);
  let config = {};
  const sources = {};
  for (const tenant of chain) {
    const overrides = (configsByTenant.get(tenant.id) || {}).overrides || {};
    config = deepMerge(config, overrides, sources, tenant.id);
  }
  // 清理被删除键的 source 记录（其叶子已不存在）
  for (const [p, s] of Object.entries(sources)) {
    if (s.deleted) delete sources[p];
  }
  return { config, sources, chain: chain.map((t) => t.id) };
}

// 展开对象为叶子键路径集合：{a:{b:1}} -> ['a.b']；null 视为删除标记也计入。
export function flattenPaths(obj, prefix = '') {
  const paths = [];
  for (const [key, value] of Object.entries(obj || {})) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) paths.push(...flattenPaths(value, p));
    else paths.push(p);
  }
  return paths;
}

// 读取嵌套路径的值，路径不存在返回 undefined。
export function getPath(obj, path) {
  let cur = obj;
  for (const seg of path.split('.')) {
    if (!isPlainObject(cur) && !Array.isArray(cur)) return undefined;
    cur = cur?.[seg];
  }
  return cur;
}

// 遮蔽检测：parent 租户要写入的键，是否被其子孙租户的 override 覆盖（子孙优先，parent 改动对它们不生效）。
// 返回 [{ tenantId, paths }]。
export function detectShadows(tenantsById, configsByTenant, tenantId, patch) {
  const patchPaths = new Set(flattenPaths(patch));
  const shadows = [];
  for (const [id, tenant] of tenantsById) {
    if (id === tenantId) continue;
    // 判断 id 是否为 tenantId 的子孙
    let cur = tenant.parentId;
    let isDescendant = false;
    const seen = new Set();
    while (cur != null && !seen.has(cur)) {
      seen.add(cur);
      if (cur === tenantId) { isDescendant = true; break; }
      cur = tenantsById.get(cur)?.parentId;
    }
    if (!isDescendant) continue;
    const overrides = (configsByTenant.get(id) || {}).overrides || {};
    const hit = flattenPaths(overrides).filter((p) => patchPaths.has(p));
    if (hit.length) shadows.push({ tenantId: id, paths: hit });
  }
  return shadows;
}

// 版本冲突：乐观并发控制。调用方传入其读取时的 baseVersion，与当前版本不一致即冲突。
export function checkVersionConflict(currentVersion, baseVersion) {
  if (baseVersion == null) return null; // 未提供 baseVersion 视为强制写
  if (currentVersion !== baseVersion) {
    return {
      type: 'version-conflict',
      message: `版本冲突: 当前版本 v${currentVersion}，你的修改基于 v${baseVersion}`,
      currentVersion,
      baseVersion,
    };
  }
  return null;
}
