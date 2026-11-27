# 错题本 DSH 插件 — 骨架说明（v0.1.0）

> 状态：**已安装并生效**（`application: applied`），第一轮纵切面已打通
> 日期：2026-11-26

---

## 1. 这一版做了什么

按 DESIGN.md 第 15 节第 3 步「最小插件骨架」，只做一件事：

> **点一下按钮 → Host 业务服务连 PostgreSQL → 返回真实库信息 → 显示在 React 页面上。**

不做导入、不做图片处理、不做归档——那些是第 4 步及以后。

## 2. 文件结构

```
plugin/wrongbook/
├── package.json          插件清单（dsh.bundle.patch + dsh.client）
├── cordis.patch.yml      Loader 补丁：插入一个 Host 插件行
├── index.js              Host 半边：pg 连接池 + 业务方法 + HTTP 路由
├── client.js             浏览器半边：React 页面（不是 iframe）
├── locale/zh.json        中文标题与描述
├── locale/en.json        英文标题与描述
└── icon.svg              图标（自绘：翻开的作业本 + 红勾）
```

## 3. 环境约定（本次已实际创建）

| 项 | 值 |
|---|---|
| 数据库 | `wrongbook`（PostgreSQL 18.6） |
| Schema | **`app`**（本次新建，属主 `zch`） |
| 业务表 | 7 张（由 `sql/001_schema_v1.sql` 装入 `app`） |
| 种子数据 | 5 个科目 + 3 个学期（`sql/002_seed_v1.sql`） |
| 归档目录 | `/mnt/c/Users/Think/Pictures/错题本照片/`（21 个目录，本次新建） |
| 连接方式 | Unix socket `/var/run/postgresql`，peer 认证，无密码 |

归档目录结构：

```
错题本照片/
├── 数学/ 语文/ 英语/ 其他/ 未分类/
│   └── 一年级上/ 一年级下/ 未分类/
```

## 4. Host 半边（index.js）

**连接池配置**（可用插件 Config 覆盖）：

```js
{
  host: '/var/run/postgresql',
  database: 'wrongbook',
  user: 'zch',
  schema: 'app',
  options: '-c search_path=app,public',   // 关键
}
```

`options` 的作用：在连接启动参数里设 `search_path`，让业务 SQL 里的非限定表名直接落在 `app`，同时避免 `pool.on('connect')` 里再发 query 触发 pg 8 的弃用警告。

**业务方法**：

| 方法 | 作用 |
|---|---|
| `health()` | 连库、读 `version()`、统计 7 张表行数、返回往返耗时 |
| `dictionaries()` | 读科目和学期字典，供导入页下拉框使用 |

两者都通过 `ctx.provide('wrongbook', {...})` 暴露给同进程其他插件，并用 `ctx.effect` 持有 disposer。

**HTTP 路由**（供 Client 页面 fetch）：

| 路由 | 返回 |
|---|---|
| `GET /wrongbook/health` | `{ ok, database, schema, serverVersion, tableCount, rowCounts, elapsedMs }` |
| `GET /wrongbook/dictionaries` | `{ subjects: [...], terms: [...] }` |

**生命周期**：`ctx.effect` 注册连接池关闭，插件卸载时 `pool.end()`。

## 5. Client 半边（client.js）

- 侧栏图标：`sidebar.panellist`，`id: wrongbook`，`order: 8`，label「错题本」
- 主区域页面：`main` slot，`key: wrongbook`
- 两个卡片：**数据库连接**（点按钮 → 显示版本/表数/行数/耗时）、**科目与学期**（点按钮 → 显示字典映射）
- 用 `window.__ModuleLoader__.load` + `require('react')`，与静态 client 模块机制一致
- 样式用组件内 `<style>` React 元素渲染，随卸载自动移除；**不直接操作 document.head**
- 颜色全部用 `--dsw-alias-*` 主题 token（**经审查修正**：初版 token 名全错，详见第 8.2 节），明暗主题自动跟随
- **不写 `var()` 第二参 fallback**：内嵌色值等于把浅色主题的观感固化成默认值，暗色主题下必然错

用到的 10 个 token（已逐个对照 `@deepseek-ai/dsh-client-ui-theme` 的 `lib/client.js`，每个都在 `body` 与 `body[data-ds-dark-theme]` 两套作用域里各定义一次）：

| 用途 | token |
|---|---|
| 主要文字 | `--dsw-alias-label-primary` |
| 次要文字（副标题、键名、注释） | `--dsw-alias-label-tertiary` |
| 卡片背景 | `--dsw-alias-bg-layer-2` |
| 按钮底色 | `--dsw-alias-button-elevated-fill` |
| 按钮 hover | `--dsw-alias-interactive-bg-hover` |
| 卡片边框 | `--dsw-alias-border-l2` |
| 按钮边框 | `--dsw-alias-border-l3` |
| 行分隔线 | `--dsw-alias-border-l1` |
| 成功状态文字 | `--dsw-alias-state-success-primary` |
| 失败状态文字 | `--dsw-alias-state-error-primary` |

## 6. 实测结果

### 6.1 Host 路由

```bash
$ curl -s http://127.0.0.1:3080/wrongbook/health
{"ok":true,"database":"wrongbook","schema":"app",
 "serverVersion":"PostgreSQL 18.6 (Ubuntu 18.6-0ubuntu0.26.04.1)...",
 "tableCount":7,
 "rowCounts":{"subjects":5,"terms":3,"documents":0,"pages":0,
              "captures":0,"page_transforms":0,"image_assets":0},
 "elapsedMs":2}
```

```bash
$ curl -s http://127.0.0.1:3080/wrongbook/dictionaries
{"subjects":[{"code":"math","display_name":"数学","directory_name":"数学",...}], ...}
```

### 6.2 Client slot 注册（cordis_inspect_query 实证）

`main` slot occupants 包含：
```json
{ "registrant": "tk", "key": "wrongbook", "priority": 0, "active": true }
```

`sidebar.panellist` occupants 包含：
```json
{ "registrant": "tk", "id": "wrongbook", "order": 8, "priority": 0, "active": true }
```

### 6.3 静态检查

- `node --check index.js` / `client.js` ✅
- `package.json`、`locale/*.json` JSON 解析 ✅
- `icon.svg` XML 解析 ✅
- 未 require 任何 Harness Client 包（如 `@deepseek-ai/dsh-client-ui-primitives`）✅

## 7. 验证边界（必须说明）

**已验证**：Host 插件加载、HTTP 路由返回真实数据库数据、两个 slot 注册成功且 `active: true`、所有文件语法合法。

**样式 token 已静态核实**（本轮修订）：`client.js` 引用的 10 个 `--dsw-alias-*` 逐个在 `@deepseek-ai/dsh-client-ui-theme@0.2.2-rc.1` 的 `lib/client.js` → `design_platform_css_default` 里命中，每个都在 `body`（浅色）和 `body[data-ds-dark-theme]`（暗色）各定义一次，例如：

```
--dsw-alias-label-primary:  body → var(--dsw-static-neutral-bluish-1000)  |  dark → ...-50
--dsw-alias-bg-layer-2:     body → var(--dsw-static-neutral-bluish-00)    |  dark → ...-850
--dsw-alias-border-l2:      body → #0000001a                             |  dark → #ffffff1f
```

同时已确认 `client.js` 里**没有**任何 `var(..., fallback)` 第二参、也没有任何十六进制字面色值。

**未验证**：浏览器里的**实际渲染效果**（含明暗两套主题的目视结果）。原因：
- `curl` 直连需要认证 cookie，拿不到 boot payload
- 本会话没有浏览器控制通道（CDP/screenshot）；`cordis_inspect_query` 的 client 侧查询（Theme.listTokens / Service.listService）连续超时，说明当前没有活动页面可应答

因此「页面长什么样、按钮点下去视觉上如何、暗色主题下对比度是否舒服」需要你**刷新页面后在明暗两种主题下各看一眼**。如果侧栏出现「错题本」图标、点进去有两个卡片、按钮能显示出数据库版本，并且**切到暗色主题后卡片是深底浅字而不是白底黑字**，就说明本轮修复生效。

## 8. 三模型审查记录（补做）

**说明**：插件骨架初版由 Lead 直接编写，**没有走 AGENTS.md 第 2 节要求的三模型流水线**——这是流程疏漏。安装完成后补做了 reviewer 环节（GLM-5.3 白盒审查），planner 环节因工作已完成无法补做。

### 8.1 审查结果

| 轮次 | 结论 | 问题 |
|---|---|---|
| 第 1 轮 | **FAIL** | 1 条 major + 5 条 minor |
| 返工后第 2 轮 | **PASS** | 1 条 major 已修，5 条 minor 保留 |

### 8.2 第 1 轮 major 问题（已修）

**CSS 主题 token 名字全是错的**。

我写的 8 个 token（`--dsw-alias-text-primary`、`--dsw-alias-bg-elevated`、`--dsw-alias-border-default`、`--dsw-alias-text-success` 等）**在已安装主题里根本不存在**。真实词表是 `label-primary` / `bg-layer-1..3` / `border-l1..l4` / `state-success-primary` / `state-error-primary` / `button-elevated-fill` / `interactive-bg-hover`。

更糟的是我给每个 `var()` 都加了硬编码 fallback 色值，于是：

- 浅色主题：fallback 碰巧接近，看起来正常
- **暗色主题：页面仍是白底黑字**，文字对比和边框全错

也就是说 README 原来写的「明暗主题自动跟随」**根本不成立**，而这个问题只有在暗色主题下才会暴露——我用 curl 验证 Host 路由永远发现不了。

已修正：10 个 token 全部换成真实词表，并**删掉所有硬编码 fallback**（规范要求组件样式不得内嵌色值）。

我事后独立核实了 10 个 token 确实存在于 `dsh-client-ui-theme` 包中，全部 ✅。

### 8.3 第 2 轮保留的 minor（Lead 已自行修掉 3 条）

reviewer 判定可缓，但我认为成本低、价值明确，直接修了：

| 问题 | 处置 |
|---|---|
| pool 创建与 effect 注册之间有泄漏窗口 | ✅ 已把 `ctx.effect` 紧跟 `new pg.Pool` 注册 |
| 无语句级超时，查询挂死会占住连接 | ✅ 已加 `-c statement_timeout=5000`，实测 `pg_sleep(8)` 被 57014 拦下 |
| health() 7 次串行 count，耗时虚高 | ✅ 已合并成单条 UNION ALL，耗时 13ms → 2ms |
| 「往返耗时」文案不准确 | ✅ 改为「查询总耗时」 |

仍保留、留待后续：

| 问题 | 为何本轮不修 |
|---|---|
| 约 30 处可见文本硬编码中文，未走 `ctx.locale` | 第 3 步验收不含 locale；改法需 `inject: ['slots','locale']`，而 locale 是可选服务，声明后若 profile 无该插件会导致整插件不激活，需连同第 4 步 UI 一起做 |
| 无 `export const Config`，UI 改不了连接参数 | 默认值即实测环境真实值；第 4 步引入 `originals_root` 等存储根目录时一起补 |
| HTTP 路由无插件自身认证 | 框架命名路由不经 cookie 校验（已核实源码），本机任意进程可读。本轮只读、低敏、绑 127.0.0.1，与参考插件一致；**第 4 步加写操作路由前必须处理** |
| schema 正则 `/^...$/i` 未用 `\A...\z` | 输入来自受信 profile 层，风险低 |

### 8.4 这次疏漏的教训

三模型流水线的价值在这次补审里体现得很直接：**我自己写的代码，我自己验证不出来**。我验证了 Host 路由 200、slot 注册 active、语法全过——全是「能跑」的证据，但 CSS token 全错这种「跑起来是坏的」问题，只有换一个模型白盒读代码才发现。

按 AGENTS.md，后续每一步（导入纵切面、批量导入、视觉归组、标准化）都应完整走 planner → coder → reviewer，不能跳。

---

## 9. 单文件导入纵切面（第 4 步）

> 完成日期：2026-11-27｜状态：**已通过真实链路验证**（用户浏览器实导 2 张手机照片）+ 112 条断言全 PASS

### 10.1 新增模块

| 文件 | 字节 | 职责 |
|---|---|---|
| `config.js` | 4181 | `export const Config`（zod 4 schema），9 个字段含 `originals_root` |
| `archive-store.js` | 17390 | 路径解析 / staging / 原子发布 / 流式哈希 |
| `image-probe.js` | 5554 | identify 探测，白名单 JPEG/PNG |
| `import-service.js` | 35974 | `importOne` / `listCaptures` / `ImportError` |
| `index.js` | 16343 | 5 条路由 + 鉴权 + 组装 |
| `client.js` | 29157 | 导入表单 + 图库列表 + `SafeImage` |

### 10.2 五条路由（全部鉴权）

| 路由 | 方法 | 说明 |
|---|---|---|
| `/wrongbook/health` | GET | 库连接与行数 |
| `/wrongbook/dictionaries` | GET | 科目/学期字典 |
| `/wrongbook/import` | POST | raw body 上传导入 |
| `/wrongbook/captures` | GET | 图库列表 |
| `/wrongbook/originals/*` | GET | 读原件字节 |

**鉴权缺口已修复**：原先无 cookie 访问 `/health` 返回 200，现在四条全部返回 401，与框架首页行为一致。

### 10.3 实测结果

三套脚本合计 **112 条断言，全部 PASS**（均不连真实数据库、不写归档目录）：

| 脚本 | 断言数 | 覆盖 |
|---|---|---|
| `tests/verify_e2e_mock.mjs` | 66 | `importOne` 全链路（真实文件系统 + mock DB） |
| `tests/verify_paths_and_probe.mjs` | 29 | 路径安全矩阵 + identify 探测矩阵 |
| `tests/verify_import_service.mjs` | 17 | 错误归因、`last_error` 卫生、状态恢复 |

**`verify_e2e_mock.mjs` 覆盖的关键路径**：

- 首次导入 → `imported`，状态 `registered`，`pageId` 为 null
- 宽高 800x600、`byteSize` 正确、`mediaType` 由 identify 决定（非扩展名）
- 归档文件真实落盘、SHA-256 与源一致、大小一致
- 相对路径符合命名规则 `数学/一年级上/YYYYMMDD-HHMMSS.<12hex>-<32hex>.png`
- 同文件换科目再导入 → `duplicate`，返回同一 capture
- 声明超限 → `PAYLOAD_TOO_LARGE`（读流之前就拒绝）
- 实际字节超限（Content-Length 撒谎）→ 流式累计时拦住
- **`reserved` / `copied` 恢复分支**（文件完好 → 推进到 registered；文件缺失/被替换 → 409）
- **`markCopied` 幂等冲突**（`rowCount=0` → `CAPTURE_RECOVERY_REQUIRED`，可重试）
- 各错误码：`INVALID_SUBJECT_CODE` / `INVALID_TERM_CODE` / `EMPTY_UPLOAD` /
  `INVALID_FILENAME` / `UNSUPPORTED_MEDIA_TYPE` / `IMAGE_PROBE_FAILED`
- 全局断言：所有写库 SQL 都不触碰 `page_id`；预留语句必须带
  `ON CONFLICT (sha256) DO NOTHING`

**`verify_paths_and_probe.mjs`**：绝对路径、盘符、`../`、`//`、尾斜杠、反斜杠全部被
`isSafeRelativePath` 拒绝；identify 对真实 PNG/JPEG、非图片文本、截断 PNG、BMP、
单帧/多帧 GIF 分别给出正确结果。

### 10.3b 真实链路验证（2026-11-27 07:31–07:32，用户浏览器实导）

用户刷新页面后在浏览器里实际导入 **2 张真实手机照片**，走完整链路。逐项核验：

| 检查项 | 结果 |
|---|---|
| 归档文件存在 | ✅ 2 个，路径 `数学/一年级上/` |
| 数据库记录 | ✅ 2 条 `registered`，`page_id` 均为 NULL |
| SHA-256（DB vs 磁盘复算） | ✅ 两条全部一致 |
| byte_size（DB vs stat） | ✅ 107335 / 3303894 全部一致 |
| 宽高（DB vs identify） | ✅ 656x841 / 4000x1800 全部一致 |
| media_type | ✅ 均为 `image/jpeg` |
| 命名规则 | ✅ 两条均符合 `YYYYMMDD-HHMMSS.<12hex>-<32hex>.jpg` |
| 短哈希与 SHA 前 12 位对应 | ✅ 两条全部匹配 |
| 科目/学期 join 映射 | ✅ 正确解析为「数学 / 一年级上学期」 |
| 唯一约束挡重复 | ✅ 用现有哈希插入被 `uq_captures_sha256` 拒绝，回滚无残留 |

**这意味着「选择文件 → SHA-256 → 复制原件 → 数据库记录 → 图库看到原件」这条纵切面已在真实链路上跑通**，此前 README 里标注的「待浏览器终验」已完成。

### 10.4 三模型流水线

| 轮次 | 结论 | 关键问题 |
|---|---|---|
| planner (Kimi) | **blocked** | 4 条 blockers（写权限、插件更新授权、恢复规则、cookie） |
| coder (DeepSeek) | 完成 | 5 个模块 |
| reviewer (GLM) 第 1 轮 | **FAIL** | **blocker：coder 越界写数据库**，留下指向不存在文件的坏记录 |
| coder 返工 | 完成 | 补文件存在性校验 + `SafeImage` |
| reviewer 第 2 轮 | **PASS** | 2 条 minor |

### 10.5 本次发现并处理的问题

**① coder 越界写数据库（blocker）**

reviewer 查出 coder 用真实 pg 连接验证路由，在 `app.captures` 留下一条 `registered` 行，而对应归档文件已被删除。

后果：再次导入同一文件时 `resolveExisting` 对 `registered` 行直接返回 `duplicate`，UI 显示「已存在」但图片 404——违反 DESIGN §10.2「不得显示为成功导入」。

处置：
- 核实该行无子引用（transforms/assets/preferred 全为 0），文件确实不存在
- **已 DELETE**（经用户授权后执行）
- 代码修复：`resolveExisting` 的 `registered` 分支补上文件存在性 + 哈希校验，不通过返回 `CAPTURE_RECOVERY_REQUIRED(409)`
- UI 修复：新增 `SafeImage`，图片加载失败时显示明确错误而非空白框

**② `cordis.patch.yml` 缺 `config: {}`**

插件导出 `Config` 后，Cordis 用它对 config 行做校验。patch 里没写 `config` 字段导致传入 `undefined`，报 `expected object, received undefined`，整行不激活。

已补 `config: {}`，所有字段走 schema 的 `.default()`。

**③ `Config.listConfigs` 显示 `unsupported`**

因为 `index.js` 用 `export { Config }` 从 `config.js` 转发，Cordis 的静态扫描没识别到。**不影响运行时**——插件实际正常加载（`/health` 返回 401 而非 404 可证）。这是静态扫描的局限，不是缺陷。

### 10.6 验证边界（重要）

**已验证**：112 条断言（66 + 29 + 17）全 PASS、鉴权 4 条路由全部 401、插件实际加载。

**未验证**：浏览器端真实上传一次图片。原因：HTTP 路由需要已登录 DSH 的浏览器 cookie，本会话没有浏览器控制通道，无法取得 cookie。

**因此「页面能看到这张图」这个验收点尚未在真实链路上成立。** 需要刷新页面后手动导入一次确认。

### 10.7 当前数据状态

```
app.captures = 0 行
归档目录 = 0 个文件
```

干净状态，等首次真实导入。

---

## 10. 已知限制

1. **Client 改动需刷新页面**：`client.js` 修改后要刷新浏览器才能加载新版本。当前没有 `pnpm run dev:web` watcher 在跑。
2. **重新安装同一版本会报 `already-installed`**：要更新需先 `remove_bundle` 再 `install_bundle`。
3. **`Config.listConfigs` 显示 `unsupported`**：见 10.5 ③，静态扫描局限，不影响运行。
4. **连接身份固定为 `zch`**：peer 认证下依赖运行 DSH 的系统用户。将来若 DSH 以别的用户运行，需要改 `user` 或改用密码认证。
5. **只支持 JPEG/PNG**：HEIC/HEIF 未实测，手机若默认拍 HEIC 会拿到 415。
6. **`page_id` 全程 NULL**：视觉归组是下一步，本轮图库是「Capture 列表」而非 Page 图库。
7. **无缩略图**：图库直接加载原件，多张时较慢。
8. **批量只能在真实浏览器里最终验收**：逻辑层已由 33 条 UI 断言覆盖（含真实执行批量循环验证串行度），但样式、布局、真实交互时序、大文件下的进度手感只能人工确认。真实 PostgreSQL 上的并发也仍是文件系统池模拟（见 11.6）。
9. **页面文本是中文硬编码**：约 30 处可见文本直接写中文，没有走 Client 的 `locale` 服务。侧栏 `label` 用了 thunk 形式但返回死中文。
10. **批量的「批次」不持久化**：刷新页面即丢失当前批次的进度与结果清单（零 DDL 决策的必然结果，`PLAN_v1.md` 明确不建 `import_batches`）。已归档的原件与记录不受影响。

---

## 11. 批量与重复导入（第 5 步）

> 完成日期：2026-11-27｜状态：**260 条断言全 PASS**（112 既有 + 148 新增）

### 11.1 五个设计决策（以及为什么）

| 决策 | 结论 | 理由 |
|---|---|---|
| 上传并发度 | **前端串行**，一次一个文件 | 32 MiB × N 并发会打满带宽和 pg 连接池（`maxConnections=4`）；进度反馈只有在「同一时刻只有一个在跑」时才有意义 |
| 批量接口 | **复用** `POST /wrongbook/import`，不引入 multipart | 该协议已过 112 条断言；multipart 要处理 boundary、部分失败、临时文件，收益为零、风险为正 |
| HTTP 层批量端点 | **不暴露** | `importBatch` 只挂成 `ctx.provide('wrongbook').importBatch` 业务方法，供同进程其他 Host 插件/工具复用 |
| 单文件失败 | **隔离**，继续后续文件，绝不整体回滚 | 整体回滚要删除已发布进归档树的原件，而「原件不可变」禁止这个动作（DESIGN §5.2-6 / §14.4-19） |
| 数据库 schema | **零改动**，不建 `import_batches` | 批次只是 UI 层临时状态。`PLAN_v1.md` 明确不建该表 |

`importBatch` 与 `importOne` 的失败语义边界：

- **整批失败** → `ImportBatchError`（继承 `ImportError`，路由层只需认识一种类型）。只在「一个文件都还没机会开始」时用：文件列表为空、科目/学期代码非法。
- **单文件失败** → 该条 `outcome='failed'` + `error:{code,message,retryable,status}`，`importBatch` 照常收集并继续。**不抛错**。

### 11.2 改动清单

| 文件 | 改动 |
|---|---|
| `import-service.js` | 新增 `ImportBatchError`、`ERROR_TABLE.INVALID_BATCH`、`ImportService#importBatch` / `emitProgress` |
| `index.js` | `ctx.provide('wrongbook')` 增加 `importBatch`（**未新增任何 HTTP 路由**） |
| `client.js` | 文件选择器 `multiple`、待导入队列、串行循环、进度条、逐条结果、取消剩余、单条重试、**单个超限文件不拖垮整批**（见 11.5 ③） |

### 11.3 新增测试（148 条）

| 脚本 | 断言数 | 覆盖 |
|---|---|---|
| `tests/verify_batch_import.mjs` | 50 | `importBatch` 契约：串行有序、失败隔离、判重、汇总、取消、整批失败 |
| `tests/verify_batch_ui.mjs` | 44 | UI 渲染文案 + **真实执行批量循环**（串行度、顺序、失败隔离、超限隔离、逐条增量更新、分类锁定、图库自动刷新） |
| `tests/verify_concurrent_import.mjs` | 14 | 4 个独立**子进程**真并发导入同一文件 → 最终 1 行 / 1 文件 |
| `tests/verify_recovery.mjs` | 40 | A1/A2 中断恢复、B 文件被替换、C 文件补回、D 换科目、E 残留检查 |

共用 `tests/lib/strict-mock.mjs`（严格 mock：复刻唯一约束、状态机触发器、`WHERE status=` 幂等保护，未预期 SQL 直接抛错）与 `tests/lib/file-backed-pool.mjs`（用 `open(...,'wx')` 的内核 `O_EXCL` 复刻 `ON CONFLICT DO NOTHING`，让真并发竞态可复现）。

**为什么并发测试用子进程而不是 `worker_threads`**：`worker_threads` 共享进程内存，mock 的 `Map` 会被共享，等于用一个共享对象「假装」数据库，反而掩盖「先 SELECT 再 INSERT」的竞态。独立子进程 + 文件系统 `O_EXCL` 才是真仲裁。

### 11.4 变异验证（证明测试不是空转）

「测试通过」只说明代码符合写测试者的理解。所以对每个新测试都做了**故意破坏实现 → 确认变红 → 恢复**：

| 变异 | 结果 |
|---|---|
| 单文件失败改为 `throw`（破坏隔离） | `verify_batch_import.mjs` 崩溃退出，RC=1 |
| `totals.imported += 1` → `+= 2` | 3 条汇总断言 FAIL |
| 失败后 `continue` 提前跳出 | 「失败之后仍然继续处理第 3 个」FAIL |
| 重复徽标文案改为「已存在」 | **初次未变红** → 见 11.5 ①，加固后 2 条 FAIL |
| 前端串行循环改为 `Promise.all` | **初次未变红** → 见 11.5 ②，加固后 2 条 FAIL（`maxInFlight=3`） |
| 删掉文件缺失时的 409 分支 | `verify_recovery.mjs` 4 条 FAIL |
| 预留语句去掉 `ON CONFLICT` | `verify_concurrent_import.mjs` 9 条 FAIL |
| 超限预检退回「任一超限即整批拒绝」 | 2 条 FAIL（正常文件一个都没上传） |
| 超限文件仍然发请求 | 3 条 FAIL（`huge.jpg` 出现在上传序列里） |
| 取消 `setBatchResults` 的逐条更新 | 3 条 FAIL（结果始终 0 条） |
| 去掉下拉框的 `importing` 禁用条件 | 1 条 FAIL（`[false,true]`） |
| 删掉批量结束后的 `loadCaptures()` | 1 条 FAIL（`captureReads=0`） |
| 改成无条件 `loadCaptures()` | 1 条 FAIL（全失败时也刷了 1 次） |

### 11.5 变异暴露的三个真实缺陷（已修）

**① 重复徽标的断言是空的**

原写法 `text.includes('已存在（未复制）')` —— 但页面底部说明文字里本身就写着「以前导入过的显示『已存在（未复制）』」。把徽标文案改成「已存在」，`verify_batch_ui.mjs` 依然 24/24 全绿。

修法：新增 `badgesOf()`，只收集 `className` 含 `wb-badge` 的元素的文本；并补一条「重复徽标不能只是『已存在』」——「未复制」是必须传达的事实（DESIGN §14.1-3）。

**② 「前端串行」这个最关键决策，此前没有任何测试覆盖**

`verify_batch_ui.mjs` 的 1–5 节全是**静态渲染**断言：只证明「给定状态能渲染出正确文案」，从不执行 `startImport` 里的循环。把串行 `for` 换成 `Promise.all`，24 条一条都不会红。

修法：新增第 6 节，真的调用导入按钮的 `onClick`，用一个记录「同时在途请求数」的 `fetch` 替身观察实际并发度，断言 `maxInFlight === 1`、上传顺序等于队列顺序、中间文件失败后第 3 个仍然上传。变异后精确报出 `maxInFlight=3`。

**③ 单个超限文件会拖垮整批（实现缺陷，非测试缺陷）**

`startImport` 的客户端预检原为 `if (oversized.length > 0) return` —— 9 张正常图 + 1 张 40 MiB 误选 = 整批一个都不传。

这是实打实的行为缺陷，而且两层语义不一致：Host 的 `importBatch` 对超限文件是「该条 `failed`、其余继续」（`verify_batch_import.mjs` 用例 7），UI 却把整批挡下来。

修法：预检只保留「**全批都超限**」这个确实无法开始的情况；循环里对单个超限文件**不发请求**、直接记为该条 `failed`，错误码用与 Host 同名的 `PAYLOAD_TOO_LARGE`，其余文件照常串行上传。

### 11.5a Lead 独立复现变异（交叉验证）

coder 声称做了 13 项变异验证。Lead 独立复现其中最关键的一项，确认测试不是空转：

**变异**：把 `importBatch` 的 catch 块改成 `throw error`（破坏失败隔离）

**结果**：`verify_batch_import.mjs` 崩溃退出，抛出 `ImportError`（status 422）

**恢复后**：`50/50 通过`

**结论**：测试确实能捕获失败隔离被破坏。这条交叉验证比单看 coder 的自述更可靠——**测试的价值不在于它通过，而在于它在该失败的时候失败**。

### 11.5b 真实 PostgreSQL 并发验证（Lead 补做，2026-11-27）

reviewer 指出 `verify_concurrent_import.mjs` 用的是文件系统池模拟，不是真实 `uq_captures_sha256`。Lead 补做了真实库验证：

**方法**：4 个独立 psql 会话，会话 A 先插入并**持锁 2 秒后提交**，B/C/D 在 A 持锁期间并发尝试插入同一 sha256。

**结果**：

```
会话 A: WON（抢到预留）
会话 B: DO NOTHING ✅
会话 C: DO NOTHING ✅
会话 D: DO NOTHING ✅

该哈希记录数: 1（期望 1）
```

**结论**：真实 PostgreSQL 的 `ON CONFLICT (sha256) DO NOTHING RETURNING` 并发仲裁确实成立——只有一个会话拿到预留，其余走 DO NOTHING 分支，最终只有一条记录。

**过程中修正的一个测试方法错误**：最初我把「插入后立即 ROLLBACK」当作并发测试，结果 4 个会话全部 WON。原因是回滚撤销了插入，后续会话依次拿到锁后没有冲突。**必须让先到者 COMMIT 才能制造真实竞争**。测试数据用后即删，真实数据保持 2 条不变。

### 11.6 仍然未验证的部分

- **真实浏览器里的批量选择与进度条**：需要登录 cookie 的浏览器控制通道，本会话没有。`verify_batch_ui.mjs` 用 React 替身在 vm 里渲染，不验证样式、布局和真实交互时序。
- **真实 PostgreSQL 上的并发**：✅ 已由 Lead 补做验证，见 11.5b。`verify_concurrent_import.mjs` 仍用文件系统池（作为可重复的自动化回归），真实库验证是一次性人工确认。

---

## 12. 附：WorkBuddy 扣费观察（结论：机制不明，不再排查）

2026-11-27 排查 reviewer 成本时发现国际区余额异常下降（249.28 → 233.65），逐项排除后无法归因。

**已排除**：

| 假设 | 验证 | 结果 |
|---|---|---|
| 本会话调用扣费 | 查 provider/model | 全是 `deepseek-v4.1-flash`，`creditMultiplier: 0` |
| `glm-5.3` 单次调用 | 调用前后对比余额 | 27800 in + 85 out + 320 cache，余额零变化 |
| 其他会话在跑 | 全机器查 5 分钟内写日志的会话 | 只有本会话 |
| 国内区在扣 | 读国内区余额 | 1132.18，完全未动 |
| `session-fae5` 扣费 | 查事件类型 | 11-27 只有 `job/settled`（moli serve bash 任务结束）和 `session/end-seed`，无模型调用 |

**决定性测试**：90 秒内只跑 bash、不做任何模型调用，余额仍以约 **0.19/分钟**稳定下降。

**结论（用户 2026-11-27 决定）**：WorkBuddy 扣费机制存在随机性，本地数据无法定位，**不再投入时间排查**。后续成本估算只作参考，以实际余额为准。

**顺带修掉的两个测量 bug**（避免后人重踩）：

1. `dsh-connect-workbuddy` 的 `status --json` 有约 2/10 概率返回 `credits: 0` 瞬时错误——不要据此判断余额归零，连续读 3 次取一致值，或改用纯文本输出。
2. 解析纯文本余额不要「取最后一个数字」，会误匹配访问令牌过期年份（`2027`）。正确写法：正则匹配 `Global:.*?Remaining credit: ([\d.]+)`。

---

## 13. 下一步

DESIGN 第 15 节第 6 步：**视觉候选与人工归组**

- 同参考试卷的视觉相似度 → 推荐 Page 候选
- 相似度**只用于推荐**，不擅自合并（必须用户确认）
- `captures.page_id` 开始被真正写入
