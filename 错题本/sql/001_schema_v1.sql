-- =====================================================================
-- 错题本 DSH 插件 / 数据库 wrongbook — v1 结构 DDL
-- 文件        : sql/001_schema_v1.sql
-- 目标版本    : v1（第一轮冻结候选，契约见 sql/README_v1.md）
-- 数据库依赖  : PostgreSQL 18+（使用内置 uuidv7()/gen_random_uuid()，不加载任何扩展）
-- 安装方式    : 执行方先用环境变量把目标 schema 放进 search_path，再执行本文件，例如
--               PGOPTIONS="-c search_path=<目标schema>" psql -v ON_ERROR_STOP=1 -f sql/001_schema_v1.sql
--               本文件自身不含 schema 管理语句、不含 schema 前缀、不含 search_path
--               设置语句、不含扩展加载语句；建表位置完全由执行方的 search_path 决定。
-- 事务边界    : 本文件不含事务控制语句，是否包裹事务由执行方决定。
-- 运行期前提  : 触发器函数一律 `SET search_path FROM CURRENT`，在 CREATE FUNCTION 时
--               把当时的 search_path 冻结进函数定义（见 pg_proc.proconfig）。这样：
--                 · SQL 源码里不写死任何 schema 名，同一份文件可装进任意 schema；
--                 · 运行期不依赖调用方 search_path，业务连接用默认 public 也能正确
--                   解析函数体内引用的表。
--               注意：proconfig 会记录安装时的 search_path 全量内容，因此安装时应使用
--               `search_path=<目标schema>,public` 这种干净形式，不要带临时 schema。
-- 设计对应    : DESIGN.md §6.1/§6.2（存储布局、相对路径与两个可配置根目录）、
--               §8（Document→Page→Capture→Asset 领域模型）、§9.1–§9.8（数据模型与完整性）、
--               §10.2（哈希检查、原子预留与原件复制契约）、§10.5（四类中断状态可区分）、
--               §11.1–§11.3（文件级去重 vs 页面级归组、多拍摄证据保留）、
--               §12（变换版本与标准化产物）、§14.4（异常与数据完整性）、§15.2（冻结最小 DDL）
-- 对象命名    : 主键 uq_<表>_id / 唯一 uq_<表>_<列...> / 检查 chk_<表>_<语义> /
--               外键 fk_<表>_<列> / 索引 idx_<表>_<列...> / 触发器与触发器函数 trig_<表>_<动作>
-- 表数量      : 7 张业务表；不建立 import_batches（恢复事实按 §10.5 落在 captures/pages/
--               image_assets 上，批次表只会制造第二份进度真相）
-- =====================================================================


-- =====================================================================
-- 1. subjects — 科目字典
-- =====================================================================
CREATE TABLE subjects (
    id             uuid        NOT NULL DEFAULT uuidv7(),
    code           text        NOT NULL,
    display_name   text        NOT NULL,
    directory_name text        NOT NULL,
    sort_order     integer     NOT NULL DEFAULT 0,
    enabled        boolean     NOT NULL DEFAULT true,

    CONSTRAINT uq_subjects_id PRIMARY KEY (id),
    CONSTRAINT uq_subjects_code UNIQUE (code),
    -- 归档目录名必须唯一，避免两个科目写进同一个 Pictures 子目录
    CONSTRAINT uq_subjects_directory_name UNIQUE (directory_name),

    CONSTRAINT chk_subjects_code_nonempty
        CHECK (code <> '' AND code = btrim(code)),
    CONSTRAINT chk_subjects_display_name_nonempty
        CHECK (display_name <> '' AND display_name = btrim(display_name)),
    -- 单路径段安全：非空、无首尾空白、不含 / 或 \、不是 . 或 ..、不含控制字符
    CONSTRAINT chk_subjects_directory_name_safe
        CHECK (directory_name <> ''
               AND directory_name = btrim(directory_name)
               AND strpos(directory_name, '/') = 0
               AND strpos(directory_name, E'\\') = 0
               AND directory_name <> '.'
               AND directory_name <> '..'
               AND directory_name !~ '[[:cntrl:]]')
);

COMMENT ON TABLE subjects IS '科目字典。code 为跨版本稳定标识，display_name 供 UI 显示，directory_name 为 Windows 原件归档目录名（DESIGN §6.1/§9.1）。';
COMMENT ON COLUMN subjects.id IS '主键，uuidv7() 生成，时间有序，改善 B-tree 插入局部性。';
COMMENT ON COLUMN subjects.code IS '稳定业务标识，小写 snake_case，如 math/chinese/english/other/unclassified；不随显示名变化。';
COMMENT ON COLUMN subjects.display_name IS 'UI 显示名，如「数学」；可修改而不影响归档路径。';
COMMENT ON COLUMN subjects.directory_name IS '原件归档目录名，如「数学」；显式映射，禁止从 display_name 隐式推导。';
COMMENT ON COLUMN subjects.sort_order IS '下拉框与筛选器排序，数值小的在前。';
COMMENT ON COLUMN subjects.enabled IS '是否允许在新导入中选用；停用不删除历史引用。';


-- =====================================================================
-- 2. terms — 学期字典（含「未分类」兜底项）
-- =====================================================================
CREATE TABLE terms (
    id             uuid        NOT NULL DEFAULT uuidv7(),
    code           text        NOT NULL,
    grade          smallint,
    term_number    smallint,
    display_name   text        NOT NULL,
    directory_name text        NOT NULL,
    sort_order     integer     NOT NULL DEFAULT 0,

    CONSTRAINT uq_terms_id PRIMARY KEY (id),
    CONSTRAINT uq_terms_code UNIQUE (code),
    CONSTRAINT uq_terms_directory_name UNIQUE (directory_name),

    CONSTRAINT chk_terms_code_nonempty
        CHECK (code <> '' AND code = btrim(code)),
    CONSTRAINT chk_terms_display_name_nonempty
        CHECK (display_name <> '' AND display_name = btrim(display_name)),
    CONSTRAINT chk_terms_grade_range
        CHECK (grade IS NULL OR grade BETWEEN 1 AND 12),
    CONSTRAINT chk_terms_number
        CHECK (term_number IS NULL OR term_number IN (1, 2)),
    -- 成对可空：要么都是未分类（NULL），要么年级与学期号同时有值，避免半完整记录
    CONSTRAINT chk_terms_grade_number_pair
        CHECK ((grade IS NULL) = (term_number IS NULL)),
    CONSTRAINT chk_terms_directory_name_safe
        CHECK (directory_name <> ''
               AND directory_name = btrim(directory_name)
               AND strpos(directory_name, '/') = 0
               AND strpos(directory_name, E'\\') = 0
               AND directory_name <> '.'
               AND directory_name <> '..'
               AND directory_name !~ '[[:cntrl:]]')
);

COMMENT ON TABLE terms IS '学期字典。directory_name 保存归档目录名（一年级上），display_name 保存完整显示名（一年级上学期），二者显式映射（DESIGN §9.2）。';
COMMENT ON COLUMN terms.id IS '主键，uuidv7() 生成。';
COMMENT ON COLUMN terms.code IS '稳定业务标识，如 g1t1/g1t2/unclassified。';
COMMENT ON COLUMN terms.grade IS '年级 1–12；未分类项为 NULL。与 term_number 必须同时 NULL 或同时非 NULL。';
COMMENT ON COLUMN terms.term_number IS '学期号 1=上学期、2=下学期；未分类项为 NULL。';
COMMENT ON COLUMN terms.display_name IS '完整显示名，如「一年级上学期」。';
COMMENT ON COLUMN terms.directory_name IS '原件归档目录名，如「一年级上」；与 display_name 的差异在此显式保存。';
COMMENT ON COLUMN terms.sort_order IS '下拉框与筛选器排序。';


-- =====================================================================
-- 3. documents — 资料（一张试卷 / 一组练习）
-- =====================================================================
CREATE TABLE documents (
    id            uuid        NOT NULL DEFAULT uuidv7(),
    subject_id    uuid        NOT NULL,
    term_id       uuid        NOT NULL,
    source_type   text        NOT NULL DEFAULT 'other',
    title         text,
    document_date date,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_documents_id PRIMARY KEY (id),
    CONSTRAINT fk_documents_subject_id
        FOREIGN KEY (subject_id) REFERENCES subjects (id) ON DELETE RESTRICT,
    CONSTRAINT fk_documents_term_id
        FOREIGN KEY (term_id) REFERENCES terms (id) ON DELETE RESTRICT,

    CONSTRAINT chk_documents_source_type
        CHECK (source_type IN ('exam_paper', 'textbook_exercise', 'workbook', 'homework', 'other')),
    CONSTRAINT chk_documents_title
        CHECK (title IS NULL OR (title <> '' AND title = btrim(title)))
);

CREATE INDEX idx_documents_term_subject_id ON documents (term_id, subject_id, id);

COMMENT ON TABLE documents IS '资料。分类（科目+学期）放在 Document 层，Page 通过 document_id 继承当前分类，改分类不需要移动或改写任何 Capture 原件（DESIGN §9.3）。';
COMMENT ON COLUMN documents.id IS '主键，uuidv7() 生成。';
COMMENT ON COLUMN documents.subject_id IS '所属科目，删除受 ON DELETE RESTRICT 保护。';
COMMENT ON COLUMN documents.term_id IS '所属学期，删除受 ON DELETE RESTRICT 保护。';
COMMENT ON COLUMN documents.source_type IS '来源类型代码：exam_paper/textbook_exercise/workbook/homework/other；中文仅在 UI 显示。';
COMMENT ON COLUMN documents.title IS '可选标题，非空时不得为空白字符串。';
COMMENT ON COLUMN documents.document_date IS '资料业务日期（date，无时区），与审计时间戳 created_at/updated_at 分离。';
COMMENT ON COLUMN documents.created_at IS '创建时刻，timestamptz，默认 now()，不由触发器改写。';
COMMENT ON COLUMN documents.updated_at IS '最后修改时刻，由 BEFORE UPDATE 触发器统一维护（手工 SQL 也无法漏更新）。';
COMMENT ON INDEX idx_documents_term_subject_id IS '支撑「按学期+科目浏览」：先定位 Documents，再按 pages(document_id, page_number) 取页。';


-- =====================================================================
-- 4. pages — 逻辑纸张页面
--    先建表，preferred_capture_id 的复合外键在 captures 建好后补（循环外键）
-- =====================================================================
CREATE TABLE pages (
    id                   uuid        NOT NULL DEFAULT uuidv7(),
    document_id          uuid        NOT NULL,
    page_number          integer,
    preferred_capture_id uuid,
    status               text        NOT NULL DEFAULT 'pending',
    notes                text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_pages_id PRIMARY KEY (id),
    CONSTRAINT fk_pages_document_id
        FOREIGN KEY (document_id) REFERENCES documents (id) ON DELETE RESTRICT,

    CONSTRAINT chk_pages_status
        CHECK (status IN ('pending', 'organized')),
    CONSTRAINT chk_pages_page_number
        CHECK (page_number IS NULL OR page_number > 0),
    CONSTRAINT chk_pages_notes
        CHECK (notes IS NULL OR btrim(notes) <> '')
);

CREATE INDEX idx_pages_document_id_page_number ON pages (document_id, page_number, id);
CREATE INDEX idx_pages_status_id ON pages (status, id);

COMMENT ON TABLE pages IS '逻辑纸张页面：图库展示、视觉归组与后续题目切分的基本单位。status 由数据库状态机守卫（pending↔organized），organized 必须有本页首选 Capture 且该 Capture 有 ready 的 standardized Asset（DESIGN §9.4/§10.5）。';
COMMENT ON COLUMN pages.id IS '主键，uuidv7() 生成。';
COMMENT ON COLUMN pages.document_id IS '所属资料，删除受 ON DELETE RESTRICT 保护：有 Page 的 Document 不可删。';
COMMENT ON COLUMN pages.page_number IS '资料内页码，可空（视觉确认前可能未知）；非空时必须 > 0。';
COMMENT ON COLUMN pages.preferred_capture_id IS '首选拍摄。复合外键 (preferred_capture_id, id)→captures(id, page_id) 保证首选照片必属于本页；为 NULL 表示尚未选定。切换首选只改此列，绝不删除其他 Capture。';
COMMENT ON COLUMN pages.status IS 'pending=页面已建立但标准化未完成；organized=已整理（触发器强制其首选 Capture 存在 ready standardized Asset）。';
COMMENT ON COLUMN pages.notes IS '人工备注，非空时不得为空白字符串。';
COMMENT ON COLUMN pages.created_at IS '创建时刻，timestamptz。';
COMMENT ON COLUMN pages.updated_at IS '最后修改时刻，由触发器维护。';
COMMENT ON INDEX idx_pages_document_id_page_number IS '支撑按资料顺序取页与翻页。';
COMMENT ON INDEX idx_pages_status_id IS '支撑「待整理」任务列表与恢复扫描。';


-- =====================================================================
-- 5. captures — 一次拍摄及其不可变原件
-- =====================================================================
CREATE TABLE captures (
    id                        uuid        NOT NULL DEFAULT uuidv7(),
    page_id                   uuid,
    sha256                    bytea       NOT NULL,
    original_path             text        NOT NULL,
    original_filename         text        NOT NULL,
    source_metadata_json      jsonb       NOT NULL DEFAULT '{}'::jsonb,
    media_type                text,
    byte_size                 bigint,
    width                     integer,
    height                    integer,
    visual_fingerprint        bytea,
    visual_fingerprint_method text,
    status                    text        NOT NULL DEFAULT 'reserved',
    last_error                text,
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_captures_id PRIMARY KEY (id),
    -- 哈希唯一不带科目/学期维度：同一文件换分类也不能再复制（DESIGN §9.5/§11.1）
    CONSTRAINT uq_captures_sha256 UNIQUE (sha256),
    -- 一个归档文件只能被一个 Capture 记录引用
    CONSTRAINT uq_captures_original_path UNIQUE (original_path),
    -- 供 pages.preferred_capture_id 与 page_transforms 的复合外键引用（必须非延迟）
    CONSTRAINT uq_captures_id_page_id UNIQUE (id, page_id),

    CONSTRAINT fk_captures_page_id
        FOREIGN KEY (page_id) REFERENCES pages (id) ON DELETE RESTRICT,

    CONSTRAINT chk_captures_sha256_length
        CHECK (octet_length(sha256) = 32),
    -- 相对路径安全：POSIX 相对、无盘符、无反斜杠、无空段、无 . / ..、无尾斜杠（DESIGN §6.2）
    CONSTRAINT chk_captures_relative_path
        CHECK (original_path <> ''
               AND original_path = btrim(original_path)
               AND left(original_path, 1) <> '/'
               AND original_path !~ '^[A-Za-z]:'
               AND strpos(original_path, E'\\') = 0
               AND strpos(original_path, '//') = 0
               AND right(original_path, 1) <> '/'
               AND original_path !~ '(^|/)\.(/|$)'
               AND original_path !~ '(^|/)\.\.(/|$)'
               AND original_path !~ '[[:cntrl:]]'),
    CONSTRAINT chk_captures_original_filename
        CHECK (original_filename <> ''
               AND original_filename = btrim(original_filename)
               AND strpos(original_filename, '/') = 0
               AND strpos(original_filename, E'\\') = 0
               AND original_filename <> '.'
               AND original_filename <> '..'),
    CONSTRAINT chk_captures_byte_size
        CHECK (byte_size IS NULL OR byte_size > 0),
    -- 宽高成对校验，语义等价于 PLAN §1.5 的单条 chk_captures_dimensions
    CONSTRAINT chk_captures_dimensions
        CHECK ((width IS NULL OR width > 0)
               AND (height IS NULL OR height > 0)),
    CONSTRAINT chk_captures_media_type
        CHECK (media_type IS NULL OR media_type ~ '^image/'),
    CONSTRAINT chk_captures_source_metadata_object
        CHECK (jsonb_typeof(source_metadata_json) = 'object'),
    -- 指纹与算法成对出现，禁止只写其一造成跨算法误比较（DESIGN §11.2 只用于召回候选）
    CONSTRAINT chk_captures_fingerprint_pair
        CHECK ((visual_fingerprint IS NULL) = (visual_fingerprint_method IS NULL)),
    CONSTRAINT chk_captures_fingerprint_length
        CHECK (visual_fingerprint IS NULL
               OR visual_fingerprint_method <> 'phash64'
               OR octet_length(visual_fingerprint) = 8),
    CONSTRAINT chk_captures_status
        CHECK (status IN ('reserved', 'copied', 'registered')),
    -- registered 表示元数据已登记，媒体信息必须完整（DESIGN §10.5 恢复判据）
    CONSTRAINT chk_captures_registered_complete
        CHECK (status <> 'registered'
               OR (media_type IS NOT NULL
                   AND media_type ~ '^image/'
                   AND byte_size IS NOT NULL
                   AND byte_size > 0
                   AND width IS NOT NULL
                   AND width > 0
                   AND height IS NOT NULL
                   AND height > 0))
);

CREATE INDEX idx_captures_page_id_created_at ON captures (page_id, created_at, id);
CREATE INDEX idx_captures_status_created_at ON captures (status, created_at, id);

COMMENT ON TABLE captures IS '一次具体拍摄及其不可变原件。page_id 可空使「取消视觉确认」后仍保留已登记 Capture；original_path 在预留时即生成，只有预留拥有者按该路径复制（DESIGN §9.5/§10.2/§10.5）。';
COMMENT ON COLUMN captures.id IS '主键，uuidv7() 生成。';
COMMENT ON COLUMN captures.page_id IS '所属逻辑页面；NULL 表示已登记但尚未归组（取消确认后的合法状态）。删除 Page 受 ON DELETE RESTRICT 保护。';
COMMENT ON COLUMN captures.sha256 IS '原件 SHA-256，32 字节 bytea（应用以 decode($hex,''hex'') 或驱动 bytea 写入）。全库唯一，是并发预留的仲裁点。';
COMMENT ON COLUMN captures.original_path IS '相对原件根目录的 POSIX 路径，如 数学/一年级上/20261126-<uuid>.jpg；不保存绝对路径，根目录由配置提供。';
COMMENT ON COLUMN captures.original_filename IS '手机原文件名，仅作元数据保留；不用于存储文件名（碰撞不安全）。';
COMMENT ON COLUMN captures.source_metadata_json IS '导入时的源文件附加信息（jsonb object），便于追溯来源与设备差异。';
COMMENT ON COLUMN captures.media_type IS '原件 MIME 类型，非空时必须以 image/ 开头。';
COMMENT ON COLUMN captures.byte_size IS '原件字节数，非空时必须 > 0。';
COMMENT ON COLUMN captures.width IS '原件像素宽，非空时必须 > 0。';
COMMENT ON COLUMN captures.height IS '原件像素高，非空时必须 > 0。';
COMMENT ON COLUMN captures.visual_fingerprint IS '视觉指纹（感知哈希）字节，仅用于推荐候选；永不 UNIQUE，也永不作为自动归组依据（DESIGN §11.2）。';
COMMENT ON COLUMN captures.visual_fingerprint_method IS '指纹算法标识，如 phash64；与 visual_fingerprint 必须同时 NULL 或同时非 NULL。';
COMMENT ON COLUMN captures.status IS 'reserved=哈希已预留、复制/校验未完成；copied=原件已复制且复算哈希一致、Capture 未登记；registered=Capture 元数据已登记。只允许向前推进。';
COMMENT ON COLUMN captures.last_error IS '最近一次失败原因，供恢复界面展示；不改变状态机语义。';
COMMENT ON COLUMN captures.created_at IS '创建时刻，timestamptz。';
COMMENT ON COLUMN captures.updated_at IS '最后修改时刻，由触发器维护。';
COMMENT ON INDEX idx_captures_page_id_created_at IS '支撑「按 Page 取所有拍摄」与同页多拍摄的时间排序。';
COMMENT ON INDEX idx_captures_status_created_at IS '支撑中断恢复扫描（reserved/copied 遗留行）与待确认列表。';
COMMENT ON CONSTRAINT uq_captures_sha256 ON captures IS '全库文件级去重：同一文件改名、移动、换科目/学期再导入都不会产生第二个 Capture（DESIGN §11.1/§14.1）。';
COMMENT ON CONSTRAINT uq_captures_original_path ON captures IS '第二道并发防线：两个进程即使抢到不同哈希，也不能把两个记录指向同一个归档文件。';
COMMENT ON CONSTRAINT uq_captures_id_page_id ON captures IS '供 pages.preferred_capture_id 复合外键引用；逻辑上被主键蕴含，但复合外键的引用目标必须是显式唯一约束。';


-- =====================================================================
-- 6. page_transforms — 页面变换版本（旋转/裁剪/缩放指令）
-- =====================================================================
CREATE TABLE page_transforms (
    id                uuid        NOT NULL DEFAULT uuidv7(),
    page_id           uuid        NOT NULL,
    source_capture_id uuid        NOT NULL,
    version           integer     NOT NULL,
    operations_json   jsonb       NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_page_transforms_id PRIMARY KEY (id),
    CONSTRAINT fk_page_transforms_page_id
        FOREIGN KEY (page_id) REFERENCES pages (id) ON DELETE RESTRICT,
    -- 复合外键：变换来源 Capture 必须属于同一个 Page（DESIGN §9.7）
    CONSTRAINT fk_page_transforms_source_capture_id
        FOREIGN KEY (source_capture_id, page_id) REFERENCES captures (id, page_id)
        ON DELETE RESTRICT
        DEFERRABLE INITIALLY IMMEDIATE,
    CONSTRAINT uq_page_transforms_page_id_version UNIQUE (page_id, version),
    -- 供 image_assets 精确追溯「哪个版本、哪张来源照片」
    CONSTRAINT uq_page_transforms_id_version_source UNIQUE (id, version, source_capture_id),

    CONSTRAINT chk_page_transforms_version
        CHECK (version > 0),
    CONSTRAINT chk_page_transforms_operations_object
        CHECK (jsonb_typeof(operations_json) = 'object')
);

COMMENT ON TABLE page_transforms IS '页面变换版本：每次旋转/裁剪/缩放的调整形成页内递增版本，保存可重建指令而不改原件（DESIGN §9.7/§12）。重做处理新增版本，不覆盖历史。';
COMMENT ON COLUMN page_transforms.id IS '主键，uuidv7() 生成。';
COMMENT ON COLUMN page_transforms.page_id IS '所属页面，删除受 ON DELETE RESTRICT 保护。';
COMMENT ON COLUMN page_transforms.source_capture_id IS '变换来源拍摄；复合外键保证其 page_id 与本行 page_id 一致。';
COMMENT ON COLUMN page_transforms.version IS '页内递增版本号，> 0；(page_id, version) 唯一，保证历史可追溯。';
COMMENT ON COLUMN page_transforms.operations_json IS '变换指令（jsonb object）：旋转、裁剪、缩放等；详细 schema 由实现阶段补充，DDL 不过度建模。';
COMMENT ON COLUMN page_transforms.created_at IS '创建时刻，timestamptz；版本历史只追加不修改。';
COMMENT ON INDEX uq_page_transforms_page_id_version IS '同时承担「某页的最新版本」查询，不再重复建索引。';


-- =====================================================================
-- 7. image_assets — 标准化图 / 缩略图
-- =====================================================================
CREATE TABLE image_assets (
    id           uuid        NOT NULL DEFAULT uuidv7(),
    capture_id   uuid        NOT NULL,
    transform_id uuid        NOT NULL,
    kind         text        NOT NULL,
    status       text        NOT NULL DEFAULT 'generating',
    storage_path text,
    media_type   text,
    byte_size    bigint,
    width        integer,
    height       integer,
    sha256       bytea,
    version      integer     NOT NULL,
    last_error   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_image_assets_id PRIMARY KEY (id),
    CONSTRAINT fk_image_assets_capture_id
        FOREIGN KEY (capture_id) REFERENCES captures (id) ON DELETE RESTRICT,
    -- 复合外键：asset 的 capture 与 transform 来源必须一致，且版本必须对得上
    CONSTRAINT fk_image_assets_transform_id
        FOREIGN KEY (transform_id, version, capture_id)
        REFERENCES page_transforms (id, version, source_capture_id)
        ON DELETE RESTRICT,

    -- 同一变换版本的同一 kind 只有一份
    CONSTRAINT uq_image_assets_transform_id_kind UNIQUE (transform_id, kind),
    -- 派生文件路径唯一；NULL 不参与唯一性，所以只有 ready 的 asset 受此约束
    CONSTRAINT uq_image_assets_storage_path UNIQUE (storage_path),

    CONSTRAINT chk_image_assets_kind
        CHECK (kind IN ('standardized', 'thumbnail')),
    CONSTRAINT chk_image_assets_status
        CHECK (status IN ('generating', 'ready', 'failed')),
    CONSTRAINT chk_image_assets_version
        CHECK (version > 0),
    CONSTRAINT chk_image_assets_relative_path
        CHECK (storage_path IS NULL
               OR (storage_path <> ''
                   AND storage_path = btrim(storage_path)
                   AND left(storage_path, 1) <> '/'
                   AND storage_path !~ '^[A-Za-z]:'
                   AND strpos(storage_path, E'\\') = 0
                   AND strpos(storage_path, '//') = 0
                   AND right(storage_path, 1) <> '/'
                   AND storage_path !~ '(^|/)\.(/|$)'
                   AND storage_path !~ '(^|/)\.\.(/|$)'
                   AND storage_path !~ '[[:cntrl:]]')),
    CONSTRAINT chk_image_assets_media_type
        CHECK (media_type IS NULL OR media_type ~ '^image/'),
    CONSTRAINT chk_image_assets_byte_size
        CHECK (byte_size IS NULL OR byte_size > 0),
    CONSTRAINT chk_image_assets_width
        CHECK (width IS NULL OR width > 0),
    CONSTRAINT chk_image_assets_height
        CHECK (height IS NULL OR height > 0),
    CONSTRAINT chk_image_assets_sha256_length
        CHECK (sha256 IS NULL OR octet_length(sha256) = 32),
    -- ready 必须完整；generating/failed 允许缺列，便于失败恢复
    CONSTRAINT chk_image_assets_ready_complete
        CHECK (status <> 'ready'
               OR (storage_path IS NOT NULL
                   AND media_type IS NOT NULL
                   AND media_type ~ '^image/'
                   AND byte_size IS NOT NULL
                   AND byte_size > 0
                   AND width IS NOT NULL
                   AND width > 0
                   AND height IS NOT NULL
                   AND height > 0
                   AND sha256 IS NOT NULL
                   AND octet_length(sha256) = 32))
);

CREATE INDEX idx_image_assets_capture_id_kind_status ON image_assets (capture_id, kind, status);

COMMENT ON TABLE image_assets IS '派生图片（标准化图、缩略图）。记录来源 Capture、变换版本与生成状态；派生文件可重建，但历史不级联删除，便于审计与失败恢复（DESIGN §8.4/§12）。';
COMMENT ON COLUMN image_assets.id IS '主键，uuidv7() 生成。';
COMMENT ON COLUMN image_assets.capture_id IS '派生来源拍摄，删除受 ON DELETE RESTRICT 保护。';
COMMENT ON COLUMN image_assets.transform_id IS '对应 page_transforms 版本；复合外键同时校验 version 与来源 Capture 一致。';
COMMENT ON COLUMN image_assets.kind IS 'standardized（标准化大图）或 thumbnail（缩略图）。';
COMMENT ON COLUMN image_assets.status IS 'generating→ready / generating→failed / failed→generating；ready 不得回退（重新处理应新增 transform 版本）。';
COMMENT ON COLUMN image_assets.storage_path IS '相对处理文件根目录（processed_root）的 POSIX 路径；ready 时必须非空。';
COMMENT ON COLUMN image_assets.media_type IS '派生文件 MIME 类型，非空时必须以 image/ 开头。';
COMMENT ON COLUMN image_assets.byte_size IS '派生文件字节数，非空时必须 > 0。';
COMMENT ON COLUMN image_assets.width IS '派生图像素宽，非空时必须 > 0。';
COMMENT ON COLUMN image_assets.height IS '派生图像素高，非空时必须 > 0。';
COMMENT ON COLUMN image_assets.sha256 IS '派生文件 SHA-256（32 字节），用于核对文件与数据库记录。';
COMMENT ON COLUMN image_assets.version IS '所属变换版本号，必须与 page_transforms.version 一致（由复合外键保证）。';
COMMENT ON COLUMN image_assets.last_error IS '最近一次生成失败原因，供恢复界面展示。';
COMMENT ON COLUMN image_assets.created_at IS '创建时刻，timestamptz。';
COMMENT ON COLUMN image_assets.updated_at IS '最后修改时刻，由触发器维护。';
COMMENT ON INDEX idx_image_assets_capture_id_kind_status IS '支撑「某张拍摄有哪些派生图、是否已就绪」。';


-- =====================================================================
-- 8. 循环外键：pages.preferred_capture_id → captures(id, page_id)
--    必须等 captures 与 uq_captures_id_page_id 存在后再补
-- =====================================================================
ALTER TABLE pages
    ADD CONSTRAINT fk_pages_preferred_capture_id
    FOREIGN KEY (preferred_capture_id, id) REFERENCES captures (id, page_id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE;

COMMENT ON CONSTRAINT fk_pages_preferred_capture_id ON pages IS '首选拍摄必须属于本页（MATCH SIMPLE：NULL 直接通过）。声明式约束对应用、脚本和手工 SQL 一律生效；它本身不含删除其他照片的动作，多 Capture 证据因此完整保留（DESIGN §9.4/§11.3）。';


-- =====================================================================
-- 9. updated_at 维护函数与触发器
--    说明：函数体不设置 search_path，引用未限定表名，由调用方 search_path 解析；
--          四个表各一个函数，符合 trig_<表>_<动作> 命名约定。
-- =====================================================================
CREATE OR REPLACE FUNCTION trig_documents_set_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION trig_pages_set_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION trig_captures_set_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION trig_image_assets_set_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trig_documents_set_updated_at
    BEFORE UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION trig_documents_set_updated_at();

CREATE TRIGGER trig_pages_set_updated_at
    BEFORE UPDATE ON pages
    FOR EACH ROW EXECUTE FUNCTION trig_pages_set_updated_at();

CREATE TRIGGER trig_captures_set_updated_at
    BEFORE UPDATE ON captures
    FOR EACH ROW EXECUTE FUNCTION trig_captures_set_updated_at();

CREATE TRIGGER trig_image_assets_set_updated_at
    BEFORE UPDATE ON image_assets
    FOR EACH ROW EXECUTE FUNCTION trig_image_assets_set_updated_at();

COMMENT ON FUNCTION trig_documents_set_updated_at() IS 'documents.updated_at 维护：任何 UPDATE 都把 updated_at 置为 now()，显式写入旧值也会被覆盖。';
COMMENT ON FUNCTION trig_pages_set_updated_at() IS 'pages.updated_at 维护：任何 UPDATE 都把 updated_at 置为 now()。';
COMMENT ON FUNCTION trig_captures_set_updated_at() IS 'captures.updated_at 维护：任何 UPDATE 都把 updated_at 置为 now()。';
COMMENT ON FUNCTION trig_image_assets_set_updated_at() IS 'image_assets.updated_at 维护：任何 UPDATE 都把 updated_at 置为 now()。';

COMMENT ON TRIGGER trig_documents_set_updated_at ON documents IS '时间戳触发器，见 trig_documents_set_updated_at()。';
COMMENT ON TRIGGER trig_pages_set_updated_at ON pages IS '时间戳触发器，见 trig_pages_set_updated_at()。';
COMMENT ON TRIGGER trig_captures_set_updated_at ON captures IS '时间戳触发器，见 trig_captures_set_updated_at()。';
COMMENT ON TRIGGER trig_image_assets_set_updated_at ON image_assets IS '时间戳触发器，见 trig_image_assets_set_updated_at()。';


-- =====================================================================
-- 10. captures 状态机触发器
--     允许：reserved→copied、reserved→registered（恢复时已核验文件）、copied→registered
--     允许：同状态更新（补 page_id / last_error / 指纹 / 媒体信息）
--     禁止：registered→copied、registered→reserved、copied→reserved 等一切回退
-- =====================================================================
CREATE OR REPLACE FUNCTION trig_captures_status_transition() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT ((OLD.status = 'reserved' AND NEW.status IN ('copied', 'registered'))
                OR (OLD.status = 'copied' AND NEW.status = 'registered')) THEN
            RAISE EXCEPTION 'illegal capture status transition: % -> % (capture %)',
                OLD.status, NEW.status, OLD.id
                USING ERRCODE = 'raise_exception',
                      HINT = 'Capture 状态只能向前推进：reserved→copied/registered、copied→registered；registered 不得回退。';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trig_captures_status_transition
    BEFORE UPDATE ON captures
    FOR EACH ROW EXECUTE FUNCTION trig_captures_status_transition();

COMMENT ON FUNCTION trig_captures_status_transition() IS 'captures 状态机：只允许 reserved→copied、reserved→registered、copied→registered 及同状态更新，禁止任何回退（DESIGN §10.5）。';
COMMENT ON TRIGGER trig_captures_status_transition ON captures IS '把 Capture 状态机落实到数据库，手工 SQL 与并发任务也不能把已完成工作倒退。';


-- =====================================================================
-- 11. pages 状态机与「已整理」守卫触发器
--     pending↔organized 双向允许（重做/切换首选可回到 pending）；
--     status='organized' 时必须有本页首选 Capture，且该 Capture 有 ready 的 standardized Asset。
--     INSERT 也检查（避免直接以 organized 建页绕过守卫）。
-- =====================================================================
CREATE OR REPLACE FUNCTION trig_pages_status_transition() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT ((OLD.status = 'pending' AND NEW.status = 'organized')
                OR (OLD.status = 'organized' AND NEW.status = 'pending')) THEN
            RAISE EXCEPTION 'illegal page status transition: % -> % (page %)',
                OLD.status, NEW.status, OLD.id
                USING ERRCODE = 'raise_exception',
                      HINT = 'Page 状态只允许 pending↔organized。';
        END IF;
    END IF;

    IF NEW.status = 'organized' THEN
        IF NEW.preferred_capture_id IS NULL THEN
            RAISE EXCEPTION 'page % cannot be organized without a preferred capture', NEW.id
                USING ERRCODE = 'raise_exception',
                      HINT = '先把 preferred_capture_id 指向本页的某张 Capture，并生成 ready 的 standardized Asset。';
        END IF;

        PERFORM 1
           FROM captures c
          WHERE c.id = NEW.preferred_capture_id
            AND c.page_id = NEW.id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'page % cannot be organized: preferred capture % is not a capture of this page',
                NEW.id, NEW.preferred_capture_id
                USING ERRCODE = 'raise_exception';
        END IF;

        PERFORM 1
           FROM image_assets a
          WHERE a.capture_id = NEW.preferred_capture_id
            AND a.kind = 'standardized'
            AND a.status = 'ready';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'page % cannot be organized: preferred capture % has no ready standardized asset',
                NEW.id, NEW.preferred_capture_id
                USING ERRCODE = 'raise_exception',
                      HINT = '先生成 standardized Asset 并推进到 ready，再标记页面已整理。';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trig_pages_status_transition
    BEFORE UPDATE ON pages
    FOR EACH ROW EXECUTE FUNCTION trig_pages_status_transition();

CREATE TRIGGER trig_pages_status_transition_insert
    BEFORE INSERT ON pages
    FOR EACH ROW EXECUTE FUNCTION trig_pages_status_transition();

COMMENT ON FUNCTION trig_pages_status_transition() IS 'pages 状态机：pending↔organized 双向迁移；organized 必须具备本页首选 Capture 且有 ready 的 standardized Asset，防止虚报完成（DESIGN §10.5/§12）。';
COMMENT ON TRIGGER trig_pages_status_transition ON pages IS 'UPDATE 时执行 pages 状态机与已整理守卫。';
COMMENT ON TRIGGER trig_pages_status_transition_insert ON pages IS 'INSERT 时同样执行守卫，防止直接以 organized 建页绕过检查。';


-- =====================================================================
-- 12. image_assets 状态机触发器
--     允许：generating→ready、generating→failed、failed→generating 及同状态更新
--     禁止：ready→failed、ready→generating（重新处理应新增 transform 版本）
-- =====================================================================
CREATE OR REPLACE FUNCTION trig_image_assets_status_transition() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT ((OLD.status = 'generating' AND NEW.status IN ('ready', 'failed'))
                OR (OLD.status = 'failed' AND NEW.status = 'generating')) THEN
            RAISE EXCEPTION 'illegal image asset status transition: % -> % (asset %)',
                OLD.status, NEW.status, OLD.id
                USING ERRCODE = 'raise_exception',
                      HINT = 'ready 是终态；重新处理请创建新的 page_transforms 版本与新的 Asset。';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trig_image_assets_status_transition
    BEFORE UPDATE ON image_assets
    FOR EACH ROW EXECUTE FUNCTION trig_image_assets_status_transition();

COMMENT ON FUNCTION trig_image_assets_status_transition() IS 'image_assets 状态机：generating→ready/failed、failed→generating；ready 不得回退，避免把已完成工作误报为未完成（DESIGN §8.4/§12）。';
COMMENT ON TRIGGER trig_image_assets_status_transition ON image_assets IS '把派生图生成状态机落实到数据库。';


-- =====================================================================
-- v1 结构 DDL 结束
-- 校验入口：sql/003_test_v1.sql（正例 PASS / 反例按 SQLSTATE 断言）
-- =====================================================================
