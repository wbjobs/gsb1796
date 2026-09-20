# 多租户配置中心（纯前端）

无后端的多租户配置管理：隔离、继承、覆盖、热更新、回滚、冲突检测。
技术栈：**IndexedDB（持久化）+ BroadcastChannel（跨标签页热更新）+ Web Worker（唯一写入口）**。

## 运行

```bash
npm run serve   # http://localhost:8080
npm test        # 合并/继承/冲突/回滚核心逻辑单测（Node，无需浏览器）
```

再开一个标签页访问同一地址，即可验证跨页热更新。

## 架构

```
index.html / app.js            演示 UI（生效配置、来源标注、补丁编辑、历史回滚、事件日志）
src/configClient.js            主线程 RPC 客户端 + BroadcastChannel 热更新事件
src/worker.js                  Web Worker：唯一写入口，串行处理写请求，写后广播
src/db.js                      IndexedDB 持久层（tenants / configs / history 三个 store）
src/merge.js                   纯函数核心：深合并、继承链解析、来源追踪、冲突检测（Node 可测）
test/merge.test.mjs            核心逻辑单测
```

## 核心设计

**数据模型**
- `tenants`：租户树，`parentId` 构成继承链（如 `global → region-cn → tenant-a`）
- `configs`：每个租户只存自己的 **overrides**（差量），`version` 单调递增
- `history`：每次写入（含回滚）追加一条不可变快照，回滚 = 把历史快照写为新版本

**合并与优先级**
- 生效配置 = 沿继承链从根到叶子依次 `deepMerge`，叶子优先级最高
- 约定：补丁中 `null` 表示删除键；数组整体替换；对象递归合并
- 每个叶子键记录来源租户（`sources`），UI 中逐键标注

**冲突检测（两类）**
- 版本冲突（乐观并发）：写入携带 `baseVersion`，与当前版本不一致即拒绝，可强制覆盖
- 遮蔽冲突：父级写入的键若被子孙租户 override，返回警告——改动对这些子孙不生效

**热更新**
- Worker 是唯一写入口，写入成功后通过 `BroadcastChannel('tenant-config-bus')` 广播
- 所有标签页的 client 监听广播，立即重新解析生效配置（同页与跨页均即时生效）

**一致性**
- config 与 history 在同一 IndexedDB 事务中写入，失败一起回滚
- 继承链解析时检测环与断链，直接报错而非静默产生错误配置

## 验收对照

| 标准 | 实现 | 验证 |
|---|---|---|
| 租户覆盖生效 | 叶子 overrides 深合并覆盖父级 | 单测「覆盖优先级」+ UI 来源标注 |
| 热更新即时 | Worker 写后 BroadcastChannel 广播，client 即时重解析 | 开两个标签页，一边写入另一边事件日志即时刷新 |
| 继承链正确 | `buildChain` 根→叶解析，环/断链报错 | 单测「继承链顺序」「环检测」 |
| 回滚正确 | 历史快照不可变，回滚生成新版本 | UI 历史列表一键回滚 + 单测「回滚语义」 |
| 冲突可检测 | 版本冲突（乐观锁）+ 遮蔽冲突（子孙覆盖警告） | 单测「版本冲突」「遮蔽检测」+ UI 冲突提示 |
