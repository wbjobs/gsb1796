# 多租户配置中心（纯前端，无后端）

多租户配置的**隔离、继承、覆盖、热更新、回滚、冲突检测**，全部在浏览器内完成。

## 技术栈与架构

```
┌─ 标签页 A ─┐  ┌─ 标签页 B ─┐
│ TenantConfigClient (主线程门面) │   ← 缓存 + watch 订阅 + 热更新推送
└─────┬──────┘  └─────┬──────┘
      │ postMessage    │  ▲
      ▼                │  │ BroadcastChannel('tenant-config')
┌─────────────────────┴──────────┐
│ Web Worker (src/worker.js)      │  ← 写操作串行化、三方冲突检测、版本管理
│  └─ src/core/merge.js  纯逻辑   │     继承链解析 / 优先级仲裁 / 深合并
│  └─ src/core/store.js  IndexedDB│     layers（当前层）+ history（全量快照）
└─────────────────────────────────┘
```

- **IndexedDB**：`layers` 存每租户当前覆盖层（含 version），`history` 存每次提交的完整快照（回滚数据源），两者同事务提交保证一致性。
- **Web Worker**：独占写入，promise 队列串行化所有写操作，版本号单调递增。
- **BroadcastChannel**：提交成功后广播 `{tenantId, version, changedKeys, affected}`，`affected` 含所有继承下游租户；各标签页门面收到后增量刷新缓存并触发 `watch` 回调——热更新即时生效。

## 核心语义

- **隔离**：每租户独立 override 层，互不可见。
- **继承链**：`__root__ → 分组 → 租户`，沿链解析，环检测。子层未覆盖的键自动继承祖先。
- **覆盖优先级**：条目级 `priority` 数值，高者胜；同级时继承链越深（越具体）越胜。删除用墓碑（`null`）。
- **冲突检测**：提交携带 `baseVersion`，与线上版本不一致时做**三方合并**（base / current / incoming）：
  - `manual`（默认）：有冲突抛 `CONFLICT`，携带冲突明细（path / 基线值 / 线上值 / 提交值）
  - `theirs`：仅应用无冲突的键
  - `mine`：强制全量覆盖
- **回滚**：`rollback(tenantId, toVersion)` 从历史快照恢复，**生成新版本**（不篡改历史），并广播热更新。

## 运行

```bash
npm test            # node --test：纯逻辑单测 + 端到端集成测试（内存 IndexedDB shim）
npm run serve       # http://localhost:8080 打开 demo
```

Demo 验证方式：多开几个标签页，在任一标签页提交覆盖，其余标签页即时收到热更新；「模拟冲突提交」按钮演示过期 baseVersion 的冲突检测。

## API 速览

```js
import { createConfigClient } from './src/tenant-config.js';
const client = createConfigClient();
await client.init(seed);                                  // seed 定义租户层级与初始覆盖

await client.resolve('tenant1');                          // { config, chain, version, sources }
await client.get('tenant1', 'theme.color');
await client.set('tenant1', { 'theme.color': 'red', 'old.key': null },
                 { priority: 0, baseVersion: 3, strategy: 'manual' });
await client.rollback('tenant1', 2);
await client.history('tenant1');
const unwatch = await client.watch('tenant1', (resolved, diff, msg) => { ... });
```

## 验收标准对照

| 标准 | 实现 | 测试 |
|---|---|---|
| 租户覆盖生效 | 继承链解析 + 条目级优先级 | `验收1` / merge.test |
| 热更新即时 | 提交后 BroadcastChannel 广播，含下游 affected | `验收2` |
| 继承链正确 | `buildChain` 环检测 + 逐层合并 | `验收1` / merge.test |
| 回滚正确 | 历史快照恢复为新版本 | `验收4` |
| 冲突可检测 | baseVersion 乐观锁 + 三方合并 | `验收3` / merge.test |
