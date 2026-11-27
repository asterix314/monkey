# 错题本 DSH 插件 — 项目约定

> 本文件被 DSH 自动注入每个在此目录下的新会话。开工前必读。

---

## 1. 项目是什么

一个 **DSH Web UI 插件**形态的小学生错题本应用，第一轮目标：**把手机拍摄的试卷/课本练习图片可靠归档到本地，生成清晰的标准化图片，支持按学期、科目浏览。**

**唯一权威设计文档：`DESIGN.md`**（562 行，已定稿）。开工前完整读一遍，不要凭想象补设计。

第一轮**不做**：OCR、题目切分、错题复习、SRS、多用户、云同步、自动透视矫正。

---

## 2. 多模型流水线（本项目强制约定）

### 2.1 角色与模型

| 层级 | 模型 | Provider | 倍率 | 职责 |
|---|---|---|---|---|
| **planner** | `kimi-k3.1-pro` | `workbuddy` | ×0.97 | 拆解任务、指出风险与验收标准，不写成品 |
| **coder** | `deepseek-v4.1-flash` | `workbuddy-global` | **×0.00** | 按规划写完整代码/SQL |
| **reviewer** | `glm-5.3` | `workbuddy` | ×0.69 | 只挑真正的问题，输出 PASS/FAIL + 问题清单 |

**Provider 是两个独立的区，倍率不同**：

- `workbuddy` = 国内区（cn）
- `workbuddy-global` = 国际区（global）

`deepseek-v4.1-flash` 在两区倍率不同（国内 ×0.11、国际 ×0.00），其余模型两区一致。
**coder 必须用 `workbuddy-global` 才是零成本。** 权威数据源是
`~/.dsh/profiles/web/cordis.patch.yml` 里各模型的 `creditMultiplier` 字段。

子代理白名单（`subagent-model-selection-settings.allowedModels`）**已含**
`workbuddy-global` 的 `deepseek-v4.1-flash`（2026-11-27 配置）。
若新会话仍报 `child LLM route ... is not allowed`，检查该配置是否被回退。

### 2.2 编排方式

用 `workflow` 工具，脚本里显式指定每个子代理的 provider/model：

```js
const plan = await agent(plannerPrompt, {
  label: 'planner', phase: '规划',
  provider: 'workbuddy', model: 'kimi-k3.1-pro'
});
const code = await agent(coderPrompt, {
  label: 'coder', phase: '执行',
  provider: 'workbuddy-global', model: 'deepseek-v4.1-flash'   // 国际区，×0.00
});
const review = await agent(reviewerPrompt, {
  label: 'reviewer', phase: '审查',
  provider: 'workbuddy', model: 'glm-5.3'
});
```

### 2.3 成本原则

**实测成本结构**（本项目全流程 1383 步）：reviewer 占 86%，planner 14%，coder 0%。

reviewer 的消耗构成里 **cacheRead 占 91.4%**——不是它想得多，是它**反复重读同一批大文件**。
当前代码库 6323 行，每轮通读一遍就会产生巨量 cacheRead。

**因此 reviewer 的 prompt 必须遵守**：

1. **只列本次改动的文件路径**，不要写「完整读取所有文件」
2. **只读改动的函数/段落**，用 `read` 的 `offset`/`limit` 定位
3. **未改动的文件一律不读**；需要上下文就在 prompt 里贴关键片段
4. **冻结文件**（`sql/001_schema_v1.sql`）只在首次审查时读，后续不复读

推荐写法：

```
本次改动（只看这些）：
- plugin/wrongbook/import-service.js 的 importBatch 方法（约 180 行）
- plugin/wrongbook/client.js 的 startImport 函数（约 120 行）

不要读取：archive-store.js / image-probe.js / config.js / index.js / 所有 tests/
这些文件本次未改动。相关契约见下方摘要：……
```

**例外（仍需通读）**：首次审查新模块、改动跨 3 个以上文件且相互耦合、
reviewer 主动要求看未改动文件（说明 prompt 上下文不足，应补摘要而非放开通读）。

**reviewer 模型不换**：保持 `glm-5.3`。不换成 deepseek 的原因——它与 coder 同模型，
存在自证风险，且从未验证过其审查能力。省成本只靠缩小输入，不降模型质量。

### 2.4 门槛规则（用户 2026-11-27 明确）

| 改动类型 | 谁做 | 是否必须 reviewer 复核 |
|---|---|---|
| **产品代码**（`index.js`、`client.js`、`config.js`、`archive-store.js`、`image-probe.js`、`import-service.js`、`*.sql`） | 必须 coder | 必须 |
| **测试脚本**（`tests/*.mjs`、`*.sh`） | Lead 可做 | **必须** |
| **配置文件**（`cordis.patch.yml`、`package.json`、`locale/*.json`） | Lead 可做 | **必须** |
| **文档**（`README.md`、`AGENTS.md`、`PLAN_*.md`） | Lead 可做 | 不需要 |

**核心原则**：Lead 可以跳过 planner 和 coder，但**不能跳过 reviewer**。
自己写的测试和配置，自己审查等于没审——尤其测试是「照着实现反推写的」时，
它只能证明代码符合写测试者的理解，不能证明符合规划。

**子代理权限约束**：planner / coder / reviewer 子代理**一律不得修改**
`AGENTS.md`、`plugin/README.md`、`sql/PLAN_*.md` 等文档，也不得修改
`sql/001_schema_v1.sql` 等已冻结文件。文档更新只能由 Lead 在核实内容属实后执行。

> 背景：批量导入那一轮的 coder 子代理越权改了 `AGENTS.md` 和 `plugin/README.md`。
> Lead 事后逐条核实内容属实，但流程违规——「谁交付谁声明」是责任链的一部分。

---

## 3. 阻塞与上报

用户要求：**planner 遇到问题/阻塞时，通过结构化返回上报，由主会话转述给用户。**

- **不要**自行猜测后硬做下去
- 在 workflow 的返回值里用结构化字段（如 `blockers: string[]`）明确列出阻塞点
- 主会话拿到结果后，**立即把 blockers 转述给用户**，等用户决定
- 典型阻塞：设计文档有歧义、缺少必要信息、需要用户授权才能执行的操作、技术假设不成立

---

## 4. 工作纪律

### 4.1 先核实，再动手

DESIGN.md 第 15 节规定了实施顺序，**每步先写验收测试或检查清单，再进入下一步**。不要一次性实现完整 UI。

当前环境事实（已核实，勿重复探测）：

| 项 | 值 |
|---|---|
| PostgreSQL | 18.6，集群 `18/main` **online**，Unix socket `/var/run/postgresql`，peer 认证（无密码） |
| 数据库 | `wrongbook`（属主 `zch`） |
| 角色 | `zch`（登录角色，**无 CREATEDB 权限**） |
| Windows Pictures | `/mnt/c/Users/Think/Pictures` |
| ImageMagick | 7.1.2-18（`convert` / `magick` / `identify` 可用） |
| Pillow | 12.1.1 |
| node sharp | **未安装**，第一轮用 ImageMagick 替代 |
| 工作区磁盘 | 193G 可用；C 盘 496G 可用 |

### 4.2 授权边界（重要）

以下操作**必须先说明动作和后果，获得用户明确同意后才能执行**：

- 删除、卸载、停止服务
- 创建/修改数据库、角色、服务配置
- 修改 DSH profile 配置（`~/.dsh/` 下）
- 写系统目录

**可以直接做**：读取、查询、诊断、在工作区内写代码。

### 4.3 沙箱限制

- DSH 的 bash 在 bwrap 沙箱内，`sudo` 会报 "no new privileges"——系统级操作需用户在宿主侧执行
- `~/.dsh` 对沙箱只读，改配置需提权
- 文件策略是 `workspace-write`：只能写工作区

### 4.4 插件开发规范

- 用 `plugin_manager install_bundle` 安装工作区 bundle，**不要**直接改 profile 的 `package.json` 或 `cordis.patch.yml`
- 参考现有插件结构：`dsh-tutorabc-lesson`（纯工具 + 自带 web 页）
- 页面用 DSH 当前支持的 React / slot / 主题 / locale 机制，不通过 iframe 嵌入

---

## 5. 关键设计约束（从 DESIGN.md 摘录，实现时勿违反）

1. **原件不可变**——任何处理都不覆盖原图
2. **文件哈希负责"是否见过这个文件"，视觉比较负责"是否属于同一逻辑页面"**——两者不能混用
3. **SHA-256 唯一约束覆盖所有科目和学期**——同一文件换分类不能再复制
4. **同一逻辑页面可有多张 Capture**，图库默认只显示一个 Page
5. **相似度只用于推荐候选，不擅自合并**——必须用户确认
6. **业务服务统一负责数据库与文件操作**，UI 不直接写 SQL
7. **任何失败或取消都不得破坏已归档原件**
8. **数据库记录保存相对路径**，不硬编码绝对路径
9. **数据库不做图片 BLOB 存储**——图片存文件系统，库里存引用

领域模型：`Document（资料）→ Page（逻辑页面）→ Capture（一次拍摄）→ StandardizedView（派生图）`

---

## 6. 当前阶段

- [x] 环境核实（PostgreSQL / 路径 / 图片库 / 磁盘）
- [x] 冻结最小 DDL 与状态机（`sql/`，40 条断言全 PASS，已装入 `app` schema）
- [x] 最小插件骨架（`plugin/wrongbook/`，Host 连库 + React 页面，已安装生效）
- [x] 单文件导入纵切面（`plugin/wrongbook/` 5 个新模块，112 条断言全 PASS，**已通过真实链路验证**）
- [x] 批量与重复导入（前端串行 + Host `importBatch`，260 条断言全 PASS，零 DDL 改动）
- [ ] **视觉候选与人工归组** ← 当前在这里
- [ ] 标准化与查看器
- [ ] 完整验收与备份检查

### 已核实的运行环境（2026-11-27）

| 项 | 值 |
|---|---|
| PostgreSQL | 18.6，库 `wrongbook`，专用 schema **`app`** |
| 连接方式 | Unix socket `/var/run/postgresql`，peer 认证，系统用户 `zch` |
| 业务表 | 7 张（`subjects`/`terms`/`documents`/`pages`/`captures`/`page_transforms`/`image_assets`） |
| 种子数据 | 5 科目 + 3 学期 |
| 归档目录 | `/mnt/c/Users/Think/Pictures/错题本照片/<科目>/<学期>/`（已创建） |
| 插件包 | `dsh-wrongbook`，源码在 `plugin/wrongbook/` |
| 插件路由 | 5 条：`GET /wrongbook/health`、`GET /wrongbook/dictionaries`、`POST /wrongbook/import`、`GET /wrongbook/captures`、`GET /wrongbook/originals/*`（全部经 `connection.requestRejection` 鉴权）。批量导入**不新增路由**，由前端串行循环调用 `POST /wrongbook/import` |

**变更约定**：`sql/001_schema_v1.sql` 已冻结，后续 schema 变更新增 `004_xxx.sql`，不改 001。

DDL 设计要满足 DESIGN.md 9.8 的完整性要求：哈希唯一、并发保护、失败恢复、引用可追溯。

---
