# 错题本 · 会话交接（2026-11-27 15:30）

> 用途：新会话开场直接粘贴第 1 节。详细状态见后续各节。
> 上一会话：`session-fa85296d`（526 步、上下文 49 万，因膨胀而换会话）

---

## 1. 开场提示词（直接粘贴）

```
继续开发「错题本」DSH 插件，工作目录 /home/zch/work/monkey/错题本。

先完整读 AGENTS.md（210 行，含三模型流水线约定、门槛规则、成本优化）
和 DESIGN.md（562 行，唯一权威设计文档），再读 plugin/README.md 了解已交付内容。

当前进度：DESIGN 第 15 节前 5 步已完成（环境核实 / DDL 冻结 / 插件骨架 /
单文件导入 / 批量导入），下一步是第 6 步「视觉候选与人工归组」。

重要约定：
- 三模型流水线强制：planner=kimi-k3.1-pro(workbuddy)、
  coder=deepseek-v4.1-flash(workbuddy-global,零成本)、reviewer=glm-5.3(workbuddy)
- reviewer prompt 必须只列改动文件+函数行号，不通读全文（AGENTS.md 2.3 节）
- 产品代码必须走 coder+reviewer；测试和配置 Lead 可写但必须 reviewer 复核

下一步要做的是「视觉候选与人工归组」，请先出规划，不要直接写代码。
```

---

## 2. 当前状态（2026-11-27 15:30 核实）

### 2.1 Git

```
仓库：/home/zch/work/monkey（远程 github.com/asterix314/monkey）
分支：wrongbook（已 push 到 origin/wrongbook）
提交：7a584d7「错题本：DDL 冻结 + 插件骨架 + 单文件导入 + 批量导入」
      36 文件 / 11889 行
状态：working tree clean
```

`.gitignore` 已配置，排除 `node_modules/`、`.npm-cache/`、`.dsh-tmp/`、`tests/logs/`、`*.png`。

### 2.2 数据库

```
PostgreSQL 18.6，库 wrongbook，schema app
7 张业务表 + 种子（5 科目 / 3 学期）
当前 captures = 8 行（全部 status=registered、page_id=NULL）
```

8 条记录已逐条核验：SHA-256 与磁盘一致、byte_size 一致、命名符合规则。

### 2.3 归档目录

```
/mnt/c/Users/Think/Pictures/错题本照片/
├── 数学/语文/英语/其他/未分类/
│   └── 一年级上/一年级下/未分类/
当前 8 个文件，全在 数学/一年级上/
```

### 2.4 插件

```
包名：dsh-wrongbook（源码 plugin/wrongbook/）
状态：已安装生效
5 条路由（全部经 connection.requestRejection 鉴权）：
  GET  /wrongbook/health          → 无 cookie 401
  GET  /wrongbook/dictionaries    → 无 cookie 401
  POST /wrongbook/import          → 无 cookie 401
  GET  /wrongbook/captures        → 无 cookie 401
  GET  /wrongbook/originals/*     → 无 cookie 401
未注册路由返回 404（可用于确认插件在跑）
```

模块行数：`archive-store.js` 416 / `client.js` 968 / `config.js` 84 /
`image-probe.js` 124 / `import-service.js` 1025 / `index.js` 418

### 2.5 测试

```
8 套脚本，260 条断言，全部 PASS：
  verify_batch_import.mjs       50
  verify_batch_ui.mjs           44
  verify_concurrent_import.mjs  14
  verify_e2e_mock.mjs           66
  verify_import_service.mjs     17
  verify_paths_and_probe.mjs    29
  verify_recovery.mjs           40
```

全部用 mock pool + 真实文件系统（临时目录），不碰真实数据库和归档目录。

### 2.6 子代理白名单

```
已含 workbuddy-global 的 deepseek-v4.1-flash 和 deepseek-v4.1-flash-sg（2026-11-27 配置）
已验证：本会话创建的 probe 子代理确实走了 workbuddy-global
注意：新会话的 list_subagent_models 才会正确显示，旧会话不追溯
```

---

## 3. 已完成的工作（DESIGN 第 15 节前 5 步）

| 步 | 内容 | 交付物 | 验证 |
|---|---|---|---|
| 1 | 环境核实 | — | PostgreSQL/路径/ImageMagick 均确认 |
| 2 | 冻结 DDL 与状态机 | `sql/` 5 个文件 | 40 条断言 PASS |
| 3 | 最小插件骨架 | `plugin/wrongbook/` | 连库 + React 页面，已生效 |
| 4 | 单文件导入纵切面 | 5 个新模块 | 112 条断言 + 真实链路 |
| 5 | 批量与重复导入 | `importBatch` | 260 条断言 + 真实使用 |

### 关键设计决策（勿推翻）

- **不建 `import_batches` 表**：批量是 UI 层临时状态，恢复事实落在 `captures`/`pages`/`image_assets`
- **`ON CONFLICT (sha256) DO NOTHING` 是唯一并发仲裁点**：不先查后插
- **`page_id` 全程 NULL**：视觉归组是下一步才写入
- **前端串行调单文件接口**：不引入 multipart 批量端点
- **所有外键 ON DELETE RESTRICT**：无 CASCADE，保护证据链
- **触发器函数 `SET search_path FROM CURRENT`**：冻结进 `proconfig`，运行期不依赖调用方

---

## 4. 下一步：视觉候选与人工归组

### 4.1 DESIGN 要求（第 11 节）

> 同一纸张的两次拍摄有不同字节、光线、角度，SHA-256 判断不了。
> 两张照片都应归档，但可属于同一个 Page。

**硬约束**：

1. **相似度只用于推荐候选，不擅自合并**——必须用户确认
2. **不能仅凭感知哈希自动合并**——不同算术练习页可能版式高度相似，却题目/手写/批改都不同
3. **同一 Page 可有多张 Capture**，图库默认只显示一个 Page
4. **更换首选照片不删除其他 Capture**（DESIGN 11.3 证据保留）

### 4.2 要解决的问题

- 视觉指纹怎么算（感知哈希？ImageMagick 能做吗？需要额外依赖吗？）
- 候选怎么召回和排序
- 并排比较的 UI 怎么做（React slot）
- 「同一页，添加为另一张照片」和「不同页，创建新页面」两个动作怎么落库
- `pages.preferred_capture_id` 的复合外键约束怎么满足（必须指向同 page 的 capture）

### 4.3 可用的真实测试数据

现有 8 张照片全在「数学/一年级上」。**但 Lead 无法判断哪几张是同一页**——需要用户指认，或等实现后让 UI 推荐候选、用户确认。

---

## 5. 已知的坑（前人踩过，别再踩）

### 5.1 DSH 插件开发

| 坑 | 正确做法 |
|---|---|
| 主题 token 名凭直觉写 | 真实词表：`label-primary`/`bg-layer-1..3`/`border-l1..l4`/`state-success-primary` 等，见 `dsh-client-ui-theme` 包 |
| `var()` 加硬编码 fallback | 禁止，literal color 只用于 artwork |
| 导出 `Config` 后 patch 不写 `config: {}` | 必须写，否则传 `undefined` 报错、整行不激活 |
| `ctx.logger` 当属性用 | 是方法：`ctx.logger('name')` |
| `ctx.provide` 不套 `ctx.effect` | 返回 disposer，必须持有 |
| 命名路由以为有鉴权 | **完全无鉴权**，必须自己调 `connection.requestRejection` |
| 用 iframe 嵌页面 | 禁止，用 slot + React |

### 5.2 测试

| 坑 | 教训 |
|---|---|
| 测试依赖版本库里的二进制 fixture | 现场生成（`convert` / `writeFileSync`） |
| 恒真断言（mock 从不产生非 null 值） | 断言要验证实现行为，不是 mock 记忆 |
| 照着实现反推写测试 | 只能证明「符合写测试者的理解」，必须做**变异测试**（故意破坏实现看是否变红） |
| 并发测试用「插入后立即 ROLLBACK」 | 4 个会话会全部成功（回滚撤销了插入），必须让先到者 COMMIT |

### 5.3 SQL / 数据库

| 坑 | 正确做法 |
|---|---|
| `ON DELETE RESTRICT` 期望 `23503` | 实际抛 **`23001`**（restrict_violation），测试要接受两者 |
| 触发器函数不写 `SET search_path` | 装到非 public schema 后运行期报 `relation does not exist` |
| `.gitignore` 写在子目录却带子目录前缀 | 规则相对自身，不能写 `错题本/xxx` |

### 5.4 流程

| 坑 | 教训 |
|---|---|
| 跳过 tri-model 自己写产品代码 | 被用户抓到 2 次。产品代码必须走 coder+reviewer |
| 子代理越权改文档 | 已加约束：子代理不得改 `AGENTS.md`/`README.md`/`PLAN_*.md` |
| 相信 `workflow` 的结构化返回 | 出现 4 次返回 `null` 但文件实际已写盘——**以磁盘文件为准** |

---

## 6. WorkBuddy 成本参考（仅供参考，不准确）

全流程 1383 步实测：

| 角色 | 模型 | 加权 token | 成本 |
|---|---|---|---|
| Lead | deepseek-v4.1-flash | 88M | 0 |
| planner | kimi-k3.1-pro | 2.7M | 2.66 |
| coder | deepseek-v4.1-flash | 77.6M | 0 |
| reviewer | glm-5.3 | 23.7M | 16.34 |

**reviewer 占 86%**，因为每轮通读 6323 行代码库，cacheRead 占其消耗的 91.4%。

**用户已决定**：WorkBuddy 扣费机制存在无法解释的随机性（纯 bash 步骤期间余额仍降），
**不再投入时间排查**。成本估算只作参考，以实际余额为准。

---

## 7. 用户偏好（重要）

- **操作授权边界**：删除/卸载/停服务/改配置/写系统目录，必须先说明动作和后果，得到明确同意
- **可以直接做**：读取、查询、诊断、在工作区内写代码
- **不要擅自删除**：用户曾因我直接卸载 PC Manager 明确抗议过
- **清理残留优先级**：先用程序自管理方式（如 `scoop cleanup`），最后才用 `Remove-Item`
- **改了 `.typ` 文件不要跑 `typst compile`**（本项目无关，但用户档案里有）

---

## 8. 关键文件索引

| 文件 | 用途 |
|---|---|
| `AGENTS.md` | 项目约定（210 行，新会话自动注入） |
| `DESIGN.md` | 唯一权威设计文档（562 行） |
| `sql/PLAN_v1.md` | DDL 冻结契约（表结构、状态机、约束） |
| `sql/001_schema_v1.sql` | 建表 DDL（667 行，**已冻结，不可改**） |
| `sql/README_v1.md` | DDL 交付说明 |
| `plugin/README.md` | 插件交付说明（含全部踩坑记录） |
| `plugin/wrongbook/index.js` | Host 主文件（路由 + 组装） |
| `plugin/wrongbook/import-service.js` | 导入核心（`importOne` / `importBatch`） |
| `plugin/wrongbook/client.js` | 前端 UI |

**变更约定**：`sql/001_schema_v1.sql` 已冻结，后续 schema 变更新增 `004_xxx.sql`。
