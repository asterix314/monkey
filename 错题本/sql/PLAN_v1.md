# 错题本 v1 DDL — planner 冻结决策（kimi-k3.1-pro 产出，Lead 记录）

> 本文件是 coder / reviewer 的共同契约。所有条目均为已定决策，实现与审查都必须遵守。
> 交付文件名固定为：`sql/001_schema_v1.sql`、`sql/002_seed_v1.sql`、`sql/003_test_v1.sql`（planner 原提的 v1_schema/v1_seed/v1_constraints_test 名称作废，改用这三个）。

## 0. 环境与硬约束

- PostgreSQL 18.6；`uuidv7()` 与 `gen_random_uuid()` 为内置，**不得安装任何扩展**。
- 三个 SQL 文件**禁止**出现：`CREATE/DROP SCHEMA`、`SET search_path`、任何 `public.` / `wb_ddl_v1.` 表名前缀、`CREATE EXTENSION`、`CREATE/DROP DATABASE`、`CREATE ROLE`。
- 安装方式由执行方控制：`PGOPTIONS="-c search_path=wb_ddl_v1,public"`。
- 001 不含 `BEGIN/COMMIT`；语句顺序必须一次性执行成功（循环外键用 `ALTER TABLE ADD CONSTRAINT` 后补）。
- 命名：主键/唯一 `uq_表名_列`，检查 `chk_表名_含义`，索引 `idx_表名_列`，外键 `fk_表名_列`，触发器函数 `trig_表名_动作`。
- 表级必须有 `COMMENT ON TABLE`。
- 状态/类型代码统一小写 snake_case；中文只在 display_name 与 UI。

## 1. 七张表

主键统一 `id uuid NOT NULL DEFAULT uuidv7()`，约束名 `uq_表名_id`；所有外键列 uuid。
**不建 `import_batches` 表。**

### 1.1 subjects
`id uuid PK`；`code text NOT NULL`；`display_name text NOT NULL`；`directory_name text NOT NULL`；`sort_order integer NOT NULL DEFAULT 0`；`enabled boolean NOT NULL DEFAULT true`。
- `uq_subjects_code(code)`、`uq_subjects_directory_name(directory_name)`
- `chk_subjects_code_nonempty`、`chk_subjects_directory_name_safe`（非空、单路径段、不含 `/`、`\`、`.`、`..`）

### 1.2 terms
`id uuid PK`；`code text NOT NULL`；`grade smallint NULL`；`term_number smallint NULL`；`display_name text NOT NULL`；`directory_name text NOT NULL`；`sort_order integer NOT NULL DEFAULT 0`。
- `uq_terms_code(code)`、`uq_terms_directory_name(directory_name)`
- `chk_terms_grade_range`（NULL 或 1–12）、`chk_terms_number`（NULL 或 1/2）、`chk_terms_grade_number_pair`（grade 与 term_number 同时 NULL 或同时非 NULL）、`chk_terms_directory_name_safe`
- 种子：g1t1 directory_name=`一年级上` display_name=`一年级上学期`；g1t2 同理；unclassified 两者均 NULL

### 1.3 documents
`id uuid PK`；`subject_id uuid NOT NULL`；`term_id uuid NOT NULL`；`source_type text NOT NULL DEFAULT 'other'`（exam_paper/textbook_exercise/workbook/homework/other）；`title text NULL`；`document_date date NULL`；`created_at`/`updated_at timestamptz NOT NULL DEFAULT now()`。
- `fk_documents_subject_id`→subjects(id) ON DELETE RESTRICT；`fk_documents_term_id`→terms(id) ON DELETE RESTRICT
- `chk_documents_source_type`
- `idx_documents_term_subject_id(term_id, subject_id, id)`

### 1.4 pages
`id uuid PK`；`document_id uuid NOT NULL`；`page_number integer NULL`（`chk_pages_page_number` > 0）；`preferred_capture_id uuid NULL`；`status text NOT NULL DEFAULT 'pending'`（pending/organized）；`notes text NULL`；created_at/updated_at。
- `fk_pages_document_id`→documents(id) ON DELETE RESTRICT
- captures 建好后补：`fk_pages_preferred_capture_id(preferred_capture_id,id)` → `captures(id,page_id)` ON DELETE RESTRICT，DEFERRABLE INITIALLY IMMEDIATE（MATCH SIMPLE：preferred 为 NULL 自动通过）
- `idx_pages_document_id_page_number(document_id, page_number, id)`、`idx_pages_status_id(status, id)`
- 状态迁移 pending↔organized 都允许；转 organized 必须有 preferred_capture_id 且该 Capture 在该 Page 下有 ready standardized asset，否则触发器拒绝

### 1.5 captures
`id uuid PK`；`page_id uuid NULL`；`sha256 bytea NOT NULL`；`original_path text NOT NULL`；`original_filename text NOT NULL`；`source_metadata_json jsonb NOT NULL DEFAULT '{}'`；`media_type text NULL`；`byte_size bigint NULL`；`width integer NULL`；`height integer NULL`；`visual_fingerprint bytea NULL`；`visual_fingerprint_method text NULL`；`status text NOT NULL DEFAULT 'reserved'`（reserved/copied/registered）；`last_error text NULL`；created_at/updated_at。
- `uq_captures_sha256(sha256)` —— **全局唯一，不带 subject/term 维度**
- `uq_captures_original_path(original_path)`
- `uq_captures_id_page_id(id,page_id)` —— 供复合外键使用（逻辑冗余但必需）
- chk：`chk_captures_sha256_length`（octet_length=32）、`chk_captures_byte_size`（>0）、`chk_captures_dimensions`（宽高>0）、`chk_captures_media_type`（`image/` 开头）、`chk_captures_source_metadata_object`、`chk_captures_relative_path`、`chk_captures_fingerprint_pair`（指纹与方法同时 NULL 或同时非 NULL）、`chk_captures_registered_complete`（status='registered' 时 media_type/byte_size/width/height 全非 NULL）
- `fk_captures_page_id`→pages(id) ON DELETE RESTRICT
- `idx_captures_page_id_created_at(page_id, created_at, id)`、`idx_captures_status_created_at(status, created_at, id)`

### 1.6 page_transforms
`id uuid PK`；`page_id uuid NOT NULL`；`source_capture_id uuid NOT NULL`；`version integer NOT NULL`；`operations_json jsonb NOT NULL`；`created_at`。
- `fk_page_transforms_page_id`→pages(id) ON DELETE RESTRICT
- `fk_page_transforms_source_capture_id(source_capture_id,page_id)`→`captures(id,page_id)` ON DELETE RESTRICT，DEFERRABLE INITIALLY IMMEDIATE
- `uq_page_transforms_page_id_version(page_id, version)`、`uq_page_transforms_id_version_source(id, version, source_capture_id)`
- chk：version>0、operations_json 为 object

### 1.7 image_assets
`id uuid PK`；`capture_id uuid NOT NULL`；`transform_id uuid NOT NULL`；`kind text NOT NULL`（standardized/thumbnail）；`status text NOT NULL DEFAULT 'generating'`（generating/ready/failed）；`storage_path text NULL`；`media_type text NULL`；`byte_size bigint NULL`；`width/height integer NULL`；`sha256 bytea NULL`；`version integer NOT NULL`；`last_error text NULL`；created_at/updated_at。
- `fk_image_assets_capture_id`→captures(id) ON DELETE RESTRICT
- `fk_image_assets_transform_id(transform_id,version,capture_id)`→`page_transforms(id,version,source_capture_id)` ON DELETE RESTRICT
- `uq_image_assets_transform_id_kind(transform_id, kind)`
- ready 时非 NULL 的唯一：`uq_image_assets_storage_path(storage_path)`
- chk：ready 时 storage_path/media_type/byte_size/width/height/sha256 完整；storage_path 相对路径安全；sha256 长度 32；宽高/byte_size >0
- `idx_image_assets_capture_id_kind_status(capture_id, kind, status)`

## 2. 关键机制

**sha256 与并发（问题 a）**：bytea + `chk_captures_sha256_length`；全局唯一约束即并发仲裁点。预留用单条
`INSERT INTO captures(sha256, original_path, original_filename, status) VALUES($1,$2,$3,'reserved') ON CONFLICT(sha256) DO NOTHING RETURNING id;`
无返回行则 `SELECT id,status,original_path,page_id FROM captures WHERE sha256=$1`，按已有状态恢复/等待；只有拿到 RETURNING 的预留者复制文件。

**失败恢复（问题 b）**：不建 import_batches。四类中断状态判定：
- 仅复制成功 → `captures.status='copied'`
- Capture 已登记 → `registered AND page_id IS NULL`
- 页面已建立 → `registered AND page_id IS NOT NULL AND pages.status='pending'`
- 标准化完成 → `pages.status='organized'` 且首选 Capture 有 ready standardized asset

Capture 迁移：reserved→copied、reserved→registered、copied→registered 允许；registered 不得倒退。同状态更新（补 page_id/last_error/指纹）允许。

**状态机执行方式**：BEFORE UPDATE 触发器落实白名单迁移（captures、image_assets、pages）；image_assets 允许 generating→ready、generating→failed、failed→generating，禁止 ready 倒退；pages 转 organized 时校验首选 Capture 与 ready standardized asset。触发器只抛可读错误，不做文件操作、不删数据。

**时间戳**：全 timestamptz + now()；documents/pages/captures/image_assets 的 updated_at 由共用 BEFORE UPDATE 触发器设为 now()（显式写旧值也被覆盖），created_at 不改；subjects/terms 无 updated_at。

**相对路径 CHECK（captures.original_path、image_assets.storage_path）**：非空、去首尾空白不变、不以 `/` 开头、不匹配 `^[A-Za-z]:`、不含反斜杠、不含 `//`、不以 `/` 结尾、不含 `.`/`..` 路径段、不含控制字符。合法例：`数学/一年级上/20261126-<uuid>.jpg`。

**外键删除语义**：全部 ON DELETE RESTRICT，不用 CASCADE。空 Document 可删；有 Page 的不可删。只有无 Capture、无 Transform 的空 Page 可删。被首选/变换/Asset 引用的 Capture 不可删。

**视觉指纹**：同表可空列 + method，成对约束；**绝不 UNIQUE**，绝不作为自动归组依据。

**枚举**：text + 命名 CHECK，不用 PG enum，不建类型字典表（subjects/terms 本身是字典表）。

## 3. 验收断言（003 测试脚本必须覆盖）

1. 静态：三文件无 schema 管理语句、无表名前缀、无扩展。
2. 全新 schema 建表 → 只有七张业务表，无 import_batches。
3. 种子跑两次幂等；g1t1 目录名/显示名映射正确。
4. 合法 Capture（sha256=decode(64 hex,'hex')、original_path='数学/一年级上/a.jpg'）成功；31/33 字节 sha256 被 `chk_captures_sha256_length` 拒。
5. 不同 subject/term 语境插入相同 sha256 → 被 `uq_captures_sha256` 拒，表内该哈希仅一行。
6. 并发预留（两个会话）→ 最终仅一行，仅一个会话拿到新 id；另一会话 SELECT 到既有行。
7. original_path 为 `/tmp/a.jpg`、`C:/a.jpg`、`C:\a.jpg`、`../a.jpg`、`数学/../a.jpg`、`数学//a.jpg`、`数学/a.jpg/`、含反斜杠 → 全部被拒；合法中文相对路径成功。
8. image_assets.storage_path 同样测试全拒；ready Asset 缺 storage_path/sha256/宽高/byte_size → 拒。
9. Page A / Page B 各有 Capture → A.preferred 指向 Capture B 被复合外键拒；指向自己的 Capture 成功；切到同 Page 另一 Capture 成功且 captures 行数不变。
10. preferred 为 NULL 成功；指向 page_id 为 NULL 或他页 Capture → 拒。
11. 删除被引用的 Subject/Term/Document/Page/Capture/Transform → 全部 RESTRICT 失败，子行仍在。
12. 两 Capture 在同一事务从旧 Page 重挂到目标 Page → 提交后都保留；旧 Page 无引用时才可删。
13. reserved Capture 允许后补文件信息；把 copied/registered 行的 media_type/byte_size/width/height 留空转 registered → 被 `chk_captures_registered_complete` 拒。
14. 构造四类中断状态 → 可唯一区分；取消视觉确认后仍是 registered/page_id NULL。
15. registered→copied / registered→reserved 被状态触发器拒；reserved→copied、copied→registered 成功；同状态仅更新 page_id/last_error 不被误拒。
16. Page pending 且无 ready standardized asset 时转 organized → 拒；建立匹配的 ready asset 后 → 成功。
17. organized Page 切到无 ready asset 的另一首选且仍保持 organized → 拒；同一 UPDATE 同时改 pending → 成功，其他 Captures 不删。
18. image_assets generating→ready / generating→failed / failed→generating 允许；ready→failed / ready→generating 拒；非法状态文本被 CHECK 拒。
19. Asset 的 capture_id 与 Transform 的 source_capture_id 不一致 → 复合外键拒；version 不一致 → 拒；一致时成功且可经 Transform 追溯到 Page 与 Capture。
20. page_transforms.source_capture_id 指向另一 Page 的 Capture → 拒；同 Page 重复 version → 拒。
21. 指纹与 method 不成对 → 拒；同一指纹写多个 Capture → 不冲突，page_id 不被自动改。
22. 更新 documents/pages/captures/image_assets 业务列 → updated_at 变、created_at 不变；显式写旧 updated_at 也被覆盖。
23. pg_indexes 核对：term+subject 浏览、Page 取 Capture、sha256 查找索引存在且无重复索引。
24. 测试脚本整体执行后不残留测试数据（种子保留）；任何预期失败语句若意外成功必须 RAISE 使脚本非零退出。
