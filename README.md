# TraceLink · 交易关系调查台

账户、设备、商户和交易组成的可追溯关系图。零依赖（仅 Node 内置 `node:sqlite` / `node:test` / `node:crypto`），无构建步骤，深色前端由原生 ES Module 直接加载。

```bash
npm start                     # http://127.0.0.1:4173（首次自动播种演示数据）
npm run reset                 # 清空并重新播种
npm test                      # 38 个测试：图引擎 + 端到端 API
```

演示账号（密码同用户名加 `demo-` 前缀）：

| 用户 | 角色 | 可见字段 | 能力 |
|---|---|---|---|
| `admin` / `demo-admin` | 管理员 | 全部 | 查看、标记、合并、撤销、导出、图导出、审计、复核、导入、重置 |
| `analyst` / `demo-analyst` | 分析员 | 全部 | 查看、标记、合并、撤销、导出、图导出、导入 |
| `auditor` / `demo-auditor` | 审计员 | 金额/设备/商户/时间，账户化名 | 查看、导出、审计、复核 |
| `viewer` / `demo-viewer` | 访客 | 金额/时间，实体全部化名 | 查看 |

## 核心设计

**日桶关系边。** 每个关系键是 `(关系类型, 端点组合)`，按发生日切片存储（`graph_edges.rel_key + day`）。边不是对全量交易的聚合，而是可回溯的证据索引：`edge_transactions(edge_id, txn_ref)` 把每条边钉到具体交易行。

**四条关系类型。** `shared_device`、`merchant_link`、`amount_flow`、`ip_overlap`（同一 IP 同一天内的账户两两配对）。边类型用线型区分而非第四种色相，分类色板只保留账户/设备/商户三色，并已用 dataviz 校验器全配对验证。

**增量重算。** `applyGraphDelta` 先比较变更前后两版交易行各自产生的关系键集合，只有成员发生变化的 `(rel_key, day)` 桶才进入重算队列；IP 组因为组内两两传递，按 `(ip, day)` 整组重算。合并/撤销/迟到数据/重复投递都走同一条路径。`rebuildAll` 是全量重建实现，测试把它当作预言机，断言“增量结果 == 全量重建结果”，这是防止增量逻辑悄悄漂移的核心不变量。

**合并与撤销。** `entity_aliases` 维护 源→规范 映射，交易行的 `canon_*` 列物化当前规范端点。合并写入 `merges` 记录、图版本和审计；撤销删除别名、重新规范化、只修复受影响的桶，图版本继续前进而不是回退——历史可回放，不会被抹掉。

**重复与迟到。** 指纹覆盖交易全部业务字段。重放（同 `txn_id` 同指纹）记为 `is_duplicate=1`：计入 `duplicate_count` 以便对账，但不进入金额、笔数和证据，也不会被当成后续更正的原版本（副本与原件同版本号且未被 supersede，所以“当前有效版本”的查询必须显式排除副本）。更正（同 `txn_id` 不同指纹）新建版本并让旧版 `superseded_by_id` 指向新版，旧版立刻退出证据集。迟到按 `received_at - occurred_at > 30min` 判定，折叠进**发生日**的桶并提高不确定性系数（`lateMultiplier`）。

**权限不可由导出绕过。** 三层防线，UI 与 API 共用同一套：

1. 能力表 `ROLE_CAPS` 对每个端点做 `requireCap`；导出本身也需要 `export`/`export.graph`。
2. 字段级投影 `redact.js` 按角色白名单裁剪字段，账户/设备/商户按角色决定给原始 id 还是 HMAC 化名。客户端传来的 `fields` 参数被忽略。
3. 整响应清洗器 `createIdMapper().scrub` 兜底：任何漏投影的原始 id，包括嵌在 `agg_key`、审计 detail 等复合字符串里的，都会被改写；CSV 和 JSON 导出走同一个 `sendExport` 清洗路径。CSV 额外做公式注入转义（`= + - @ \t \r` 前缀加 `'`）。

受限角色的反向映射按 `(类型, 化名)` 分键，因此一个设备的化名不能拿去当账户 id 查询；搜索只匹配该角色已持有的化名，用原始 id、姓名或账号片段搜索返回空——不构成存在性预言机。

**复核。** 标记与合并都带 `review_state`，`reviewObject` 强制四眼原则（复核人不能是提交人），复核结果写 `reviews` 与审计。

## 页面

左栏是指标、筛选、高风险节点、合并建议与批次；中间是力导向 SVG 关系图（支持平移缩放、按强度阈值过滤、悬停查看边证据）；右栏检查器分“概览 / 关系证据 / 交易 / 标记 / 合并历史”，任一关系都可下钻到日桶、贡献系数和原始交易行；底部停靠栏提供路径分析、数据导入（含去重/更正/迟到回执）、导出、复核队列、版本与审计。

## 目录

```
server/db.js         schema、事务、图版本与审计
server/engine.js     关系规约、增量 delta、节点风险
server/ingest.js     校验、指纹、去重/更正/迟到、批次落库
server/graph.js      时间窗口、证据、BFS 路径、窗口汇总
server/mutations.js  合并、撤销、标记、复核
server/redact.js     角色策略、投影、整响应清洗、CSV
server/app.js        HTTP 路由、会话、静态资源与 CSP
server/seed.js       演示数据（含重复投递、更正、迟到批次）
public/              前端控制台
test/                图引擎不变量 + HTTP 端到端权限测试
```
