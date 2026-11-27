# 错题本 v1 DDL — 交付说明

> 状态：**v1 冻结候选，已在 wrongbook 库实测通过**
> 完成日期：2026-11-26
> 契约：`PLAN_v1.md`（planner 产出）｜ 设计：`../DESIGN.md` 第 6/8/9/10/11/12 节

---

## 1. 交付物

| 文件 | 行数 | 用途 |
|---|---|---|
| `PLAN_v1.md` | 200 | 冻结的设计契约：7 张表、状态机、约束、索引、24 条验收断言 |
| `001_schema_v1.sql` | 656 | 建表 DDL：7 张业务表 + 7 触发器函数 + 24 索引 |
| `002_seed_v1.sql` | 45 | 参考数据：5 个科目 + 3 个学期，幂等 |
| `003_test_v1.sql` | 1629 | 40 条约束/状态机断言，psql 直接执行 |
| `../tests/run_ddl_validation.sh` | 62 | 一键验证脚本（建 schema → 建表 → 种子 → 测试 → 清理） |

安装方式（schema 由执行方 search_path 决定，SQL 内不含任何 schema 硬编码）：

```bash
PGOPTIONS="-c search_path=wb_ddl_v1,public" psql -v ON_ERROR_STOP=1 -d wrongbook -f sql/001_schema_v1.sql
```

---

## 2. 数据模型

```
subjects ──┐
terms ─────┼──> documents ──> pages ──┬──> captures ──┬──> image_assets
           │                          │               │
           │                          └──> page_transforms ──┘
```

7 张表，全部 `id uuid DEFAULT uuidv7()`（PG18 内置，时间有序，无扩展依赖）。

| 表 | 关键约束 |
|---|---|
| `subjects` | code 唯一、directory_name 唯一（防两科目写同一目录） |
| `terms` | code 唯一、grade/term_number 成对可空、目录名唯一 |
| `documents` | subject/term 外键 RESTRICT，source_type CHECK |
| `pages` | `preferred_capture_id` 复合外键 `(preferred_capture_id,id)→captures(id,page_id)` |
| `captures` | **sha256 全局唯一**（不带科目学期维度）、original_path 唯一、相对路径 CHECK、registered 元数据完整 CHECK |
| `page_transforms` | `(page_id,version)` 唯一、来源 capture 复合外键同页 |
| `image_assets` | `(transform_id,kind)` 唯一、ready 时六字段完整、来源 capture+version 复合外键一致 |

---

## 3. 三个核心机制

### 3.1 哈希唯一与并发预留

```sql
INSERT INTO captures(sha256, original_path, original_filename, status)
VALUES ($1, $2, $3, 'reserved')
ON CONFLICT (sha256) DO NOTHING
RETURNING id;
```

- 有 RETURNING → 本会话持有预留，去复制文件；
- 无 RETURNING → `SELECT ... WHERE sha256=$1` 按已有 status 恢复/等待，**不得**当作成功。

唯一索引本身就是并发仲裁点，不依赖「先查后插」的应用时序。实测 4 会话并发，仅 1 个拿到 id，表内 1 行。

### 3.2 失败恢复状态机（不建 import_batches）

Capture：`reserved → copied → registered`（只前进，registered 不得倒退）
Asset：`generating → ready | failed`，`failed → generating`；ready 是终态
Page：`pending ↔ organized`，转 organized 必须有 ready standardized asset

DESIGN 10.5 四类中断状态判定：

| 中断点 | 判定条件 |
|---|---|
| 仅复制成功 | `captures.status='copied'` |
| Capture 已登记 | `registered AND page_id IS NULL` |
| 页面已建立 | `registered AND page_id IS NOT NULL AND pages.status='pending'` |
| 标准化完成 | `pages.status='organized'` 且有 ready standardized asset |

### 3.3 原件不可变

所有 9 个外键**一律 ON DELETE RESTRICT，无 CASCADE**。删除被引用的科目/学期/资料/页面/拍摄/变换都会被拒绝，证据链不会静默消失。

---

## 4. 实测结果

### 4.1 结构

```
7 张业务表（无 import_batches）
7 主键 / 11 唯一 / 9 外键 / 37 CHECK / 44 NOT NULL / 24 索引
```

### 4.2 约束测试：40 条断言全部 PASS

`S00-S03` 结构 · `F01-F10` 正例 · `N01-N27` 反例 · `M01` 合并 · `T01-T03` 时间戳与恢复分类

### 4.3 真实业务链路

documents → pages → captures → page_transforms → image_assets(ready) → pages.status=organized ✅

### 4.4 并发预留

4 个独立 psql 会话同时抢同一 sha256：**仅 1 个会话拿到 id，表内 1 行** ✅

### 4.5 反例实测（14 条全部被拒）

| 反例 | 拒绝来源 |
|---|---|
| 同文件换学期再导入 | `uq_captures_sha256` |
| 路径填 Windows 盘符 | `chk_captures_relative_path` |
| 路径用 `../` 穿越 | `chk_captures_relative_path` |
| 路径尾斜杠 | `chk_captures_relative_path` |
| sha256 长度 31 字节 | `chk_captures_sha256_length` |
| registered 缺媒体元数据 | `chk_captures_registered_complete` |
| 非法 status 值 | `chk_captures_status` |
| 首选照片指向别的 page | `fk_pages_preferred_capture_id` |
| 无 ready asset 转 organized | `trig_pages_status_transition` |
| 删仍有 capture 的 page | RESTRICT |
| 删被资料引用的科目 | RESTRICT |
| 状态倒退 registered→reserved | `trig_captures_status_transition` |
| 删仍有 asset 的 transform | RESTRICT |
| 同 page 重复 transform 版本 | `uq_page_transforms_page_id_version` |

---

## 5. 三模型流水线记录

| 角色 | 模型 | 结果 |
|---|---|---|
| planner | `workbuddy/kimi-k3.1-pro` | 8 步实施计划、17 条建模决策、14 条风险、24 条验收断言、0 阻塞 |
| coder | `workbuddy/deepseek-v4.1-flash` | 3 个 SQL 文件（2330 行） |
| reviewer | `workbuddy/glm-5.3` | **PASS**，3 条 minor 问题 |

### 执行过程中发现并修正的问题

1. **测试脚本 SQLSTATE 期望值错误**（Lead 实测发现）：`ON DELETE RESTRICT` 抛 `23001 restrict_violation`，脚本期望 `23503 foreign_key_violation`。N13-N16 已改为接受两者。约束本身正确，是测试写错。
2. **约束命名偏离契约**（reviewer 发现）：`chk_captures_registered_metadata` → `chk_captures_registered_complete`；宽高两条 CHECK 合并为 `chk_captures_dimensions`。
3. **测试覆盖缺口**（reviewer 发现）：N04 从 4 种非法路径扩到 8 种；N05 从「缺 sha256」扩到六个必填分量各测一次；新增 S03 索引存在性 + 重复索引断言。

---

## 6. 已知缺口（第一轮不修）

### 6.1 organized 不变量的删除侧无守卫 ⚠️

`organized ⇒ 首选 Capture 有 ready standardized asset` 这个不变量**只在状态迁移时校验**。

- **问题**：`image_assets` 上的 DELETE 没有触发器守卫。删掉那条 ready asset 后，page 会**继续停在 `organized`**，而守卫条件已不成立。
- **影响面**：外键 RESTRICT 只挡「asset 仍被别的行引用」这个方向，不挡删 asset 本身；所以这是真实缺口，不是误报。
- **为什么第一轮不修**：DESIGN 9.8 未明文要求删除守卫；且 `idx_pages_status_id` 支撑的恢复扫描能重新发现不一致，不会静默丢数据。
- **第二轮修法**：给 `image_assets` 加 BEFORE DELETE 触发器——发现 `OLD.status='ready'` 且 `EXISTS (SELECT 1 FROM pages WHERE preferred_capture_id = OLD.capture_id AND status='organized')` 时 RAISE。
- **当前缓解**：业务服务层第一轮不提供 asset 删除入口。

### 6.2 并发测试不在 003 内

需要两个独立连接，无法在单会话 psql 脚本里自测。已由 Lead 用 4 个独立 psql 会话实测：仅 1 个拿到 id，表内 1 行。`003_test_v1.sql` 内已在注释标注，未写假测试。

### 6.3 文件系统层不可由 DDL 保护

原件的原子复制、禁止覆盖、符号链接逃逸必须由业务服务层保证。DDL 只能约束数据库里的字符串（相对路径、禁止 `..` 穿越等），管不到磁盘上实际发生了什么。

---

## 7. 已修复问题（验证阶段发现）

### 7.1 触发器 search_path 隐患（2026-11-26 实测发现并修复）⚠️ 重要

**问题**：7 个触发器函数原本不写 `SET search_path`，靠调用方 search_path 解析表名。实测装到非 public schema 后：

```
默认 search_path=public 时 UPDATE wb_probe.pages SET status='organized'
→ ERROR: relation "captures" does not exist
  CONTEXT: PL/pgSQL function trig_pages_status_transition() line 20 at PERFORM
```

即**业务连接只要没设对 search_path，状态机触发器就会在运行时炸掉**——而且是在 UPDATE 时才炸，建表和测试阶段完全看不出来。这是 DDL 不写死 schema 的隐性代价。

**修复**：给全部 7 个触发器函数加 `SET search_path FROM CURRENT`：

```sql
CREATE OR REPLACE FUNCTION trig_pages_status_transition() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$ ... $$;
```

**原理**：`FROM CURRENT` 在 `CREATE FUNCTION` 时把**当时的 search_path 冻结进函数定义**（存于 `pg_proc.proconfig`），运行期不再依赖调用方。实测装进 `wb_sp` 后：

```
trig_pages_status_transition | {"search_path=wb_sp,public"}
```

同一份 SQL 源码装进不同 schema，proconfig 自动跟着变——**源码仍然不含任何硬编码 schema 名**。

**安装约定（新增）**：安装时 search_path 必须是 `<目标schema>,public` 这种干净形式，不要带临时 schema，否则会被一起冻结进 proconfig。

### 7.2 测试脚本 SQLSTATE 期望值错误

`ON DELETE RESTRICT` 抛 `23001 restrict_violation`，不是 `23503 foreign_key_violation`。N13-N16 已改为接受两者。约束本身正确，是测试写错。

### 7.3 约束命名偏离契约

`chk_captures_registered_metadata` → `chk_captures_registered_complete`；宽高两条 CHECK 合并为 `chk_captures_dimensions`。

### 7.4 测试覆盖缺口

N04 从 4 种非法路径扩到 8 种；N05 从「缺 sha256」扩到六个必填分量各测一次；新增 S03 索引存在性 + 重复索引断言。

---

## 8. 后续变更约定

`001/002/003` 冻结后**不再修改**。任何 schema 变更走新增版本文件 `004_xxx.sql`，并同步更新 `PLAN_v1.md` 或新增 `PLAN_v2.md`。
