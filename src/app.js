import { ConfigClient } from './configClient.js';

const client = new ConfigClient();
const $ = (sel) => document.querySelector(sel);

let tenants = [];
let currentTenantId = null;
let currentVersion = 0; // 当前租户 overrides 版本，作为写入的 baseVersion（乐观锁）
let lastPatch = null;

function logEvent(text) {
  const div = document.createElement('div');
  div.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  $('#event-log').prepend(div);
}

function renderTenants() {
  const box = $('#tenant-list');
  box.innerHTML = '';
  for (const t of tenants) {
    const item = document.createElement('div');
    item.className = 'tenant-item' + (t.id === currentTenantId ? ' active' : '');
    const parent = tenants.find((p) => p.id === t.parentId);
    item.innerHTML = `<div>${t.name} <span class="meta">(${t.id})</span></div>
      <div class="meta">继承自: ${parent ? parent.name : '—（根）'}</div>`;
    item.onclick = () => { currentTenantId = t.id; refresh(); };
    box.appendChild(item);
  }
}

function renderChain(chain) {
  $('#chain-view').innerHTML = '继承链（优先级递增）: ' +
    chain.map((id, i) => {
      const t = tenants.find((x) => x.id === id);
      const label = i === chain.length - 1 ? `<b>${t?.name ?? id}</b>` : (t?.name ?? id);
      return label;
    }).join(' → ');
}

// 渲染生效配置，逐键标注来源租户
function renderEffective(config, sources, chain) {
  const box = $('#effective-config');
  box.innerHTML = '';
  const walk = (obj, prefix, indent) => {
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const row = document.createElement('div');
      row.className = 'kv';
      row.style.paddingLeft = `${indent * 16}px`;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        row.innerHTML = `<span class="key">${key}:</span>`;
        box.appendChild(row);
        walk(value, path, indent + 1);
      } else {
        const src = sources[path];
        const srcId = src?.tenantId ?? '?';
        const cls = srcId === currentTenantId ? 'self' : (srcId === 'global' ? '' : 'mid');
        const t = tenants.find((x) => x.id === srcId);
        row.innerHTML = `<span class="key">${key}:</span> ${JSON.stringify(value)}` +
          `<span class="src ${cls}">${t?.name ?? srcId}</span>`;
        box.appendChild(row);
      }
    }
  };
  walk(config, '', 0);
}

async function refresh() {
  renderTenants();
  const eff = await client.getEffective(currentTenantId);
  currentVersion = eff.version;
  renderChain(eff.chain);
  renderEffective(eff.config, eff.sources, eff.chain);
  $('#effective-version').textContent = `resolved @ v${eff.version}`;
  $('#override-version').textContent = `v${eff.version}`;
  $('#override-view').textContent = JSON.stringify(eff.overrides, null, 2);
  await renderHistory();
}

async function renderHistory() {
  const history = await client.getHistory(currentTenantId);
  const box = $('#history-list');
  box.innerHTML = '';
  for (const h of history) {
    const row = document.createElement('div');
    row.className = 'history-item';
    row.innerHTML = `<b>v${h.version}</b>
      <span class="grow">${new Date(h.updatedAt).toLocaleString()} · ${h.updatedBy} · ${h.reason}</span>`;
    if (h.version !== currentVersion) {
      const btn = document.createElement('button');
      btn.className = 'small';
      btn.textContent = '回滚到此版本';
      btn.onclick = async () => {
        const r = await client.rollback(currentTenantId, h.version, 'demo-user');
        logEvent(`回滚 ${currentTenantId} -> v${h.version}（生成新版本 v${r.version}）`);
        refresh();
      };
      row.appendChild(btn);
    } else {
      const tag = document.createElement('span');
      tag.className = 'badge';
      tag.textContent = '当前';
      row.appendChild(tag);
    }
    box.appendChild(row);
  }
}

function showResult(type, html) {
  $('#write-result').innerHTML = `<div class="notice ${type}">${html}</div>`;
}

async function applyPatch(force) {
  let patch;
  try {
    patch = JSON.parse($('#patch-editor').value);
  } catch {
    showResult('err', '补丁不是合法 JSON');
    return;
  }
  lastPatch = patch;
  const r = await client.setConfig({
    tenantId: currentTenantId,
    patch,
    baseVersion: currentVersion,
    updatedBy: 'demo-user',
    force,
  });
  if (!r.ok && r.conflict) {
    // 版本冲突：提示并允许强制覆盖
    showResult('err', `⚠️ ${r.conflict.message}。可刷新后重试，或点击「强制覆盖写入」。`);
    $('#force-btn').disabled = false;
    return;
  }
  $('#force-btn').disabled = true;
  let html = `✅ 写入成功，新版本 v${r.version}`;
  if (r.shadows?.length) {
    // 遮蔽冲突：父级改动被子孙 override 挡住
    html += '<br>⚠️ 遮蔽警告：以下子孙租户已覆盖这些键，你的改动对它们不生效：<br>' +
      r.shadows.map((s) => `· ${s.tenantId}: ${s.paths.join(', ')}`).join('<br>');
    showResult('warn', html);
  } else {
    showResult('ok', html);
  }
  refresh();
}

$('#apply-btn').onclick = () => applyPatch(false);
$('#force-btn').onclick = () => applyPatch(true);

// 热更新：任何标签页的写入都会触发，立即刷新生效配置
client.onChange((e) => {
  logEvent(`热更新: ${e.tenantId} 变更到 v${e.version}（by ${e.updatedBy}${e.rollback ? '，回滚' : ''}）`);
  refresh();
});

await client.ready;
tenants = await client.listTenants();
currentTenantId = 'tenant-a';
await refresh();
logEvent('初始化完成，已加载种子数据');
