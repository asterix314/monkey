\set ON_ERROR_STOP on
-- =====================================================================
-- 错题本 DSH 插件 / 数据库 wrongbook — v1 约束与状态机测试
-- 文件        : sql/003_test_v1.sql
-- 目标版本    : v1（依赖 sql/001_schema_v1.sql；建议先执行 sql/002_seed_v1.sql）
-- 数据库依赖  : PostgreSQL 18+
-- 执行方式    : PGOPTIONS="-c search_path=<目标schema>" psql -v ON_ERROR_STOP=1 -f sql/003_test_v1.sql
--               首行已 \set ON_ERROR_STOP on。
--               本文件不含 schema 管理语句、不含 schema 前缀、不设 search_path。
-- 事务模型    : 一个 BEGIN → 全部断言 → ROLLBACK。
--               测试数据全部不落库；临时夹具表 wb_test_ids 也随 ROLLBACK 一并消失。
--               每条反例都在 plpgsql 的 BEGIN ... EXCEPTION 子事务中执行，
--               失败语句不会留下半行数据，也不会污染后续断言。
-- 断言约定    : 反例 =「捕获 SQLSTATE」：
--                 期望失败且确实失败 → RAISE NOTICE 'PASS ...'；
--                 竟然成功           → RAISE EXCEPTION 'FAIL ...'（脚本非零退出）；
--                 SQLSTATE 不符      → RAISE EXCEPTION 'FAIL ... 期望 X 实得 Y'。
--               正例直接执行并断言结果，成功即 PASS。
-- 种子断言    : 检测到种子科目时严格校验目录名→显示名映射；检测不到时 RAISE WARNING（SKIP），
--               便于「先结构、后种子」分步执行。
-- 设计对应    : DESIGN.md §9.8（完整性）、§10.2/§10.5（并发预留、四类中断状态）、
--               §11.1–§11.3（文件级去重 / 页面级归组 / 多拍摄证据保留）、
--               §12（变换版本与派生图）、§14.1/§14.2/§14.4（验收）
-- 用例编号    : S=结构与种子  F=正例  N=反例  M=合并  T=时间戳与恢复分类
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- S00. 结构前置：7 张业务表存在，import_batches 不得存在
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_missing text := '';
    v_name    text;
BEGIN
    FOREACH v_name IN ARRAY ARRAY['subjects', 'terms', 'documents', 'pages',
                                  'captures', 'page_transforms', 'image_assets']
    LOOP
        IF to_regclass(v_name) IS NULL THEN
            v_missing := v_missing || ' ' || v_name;
        END IF;
    END LOOP;

    IF v_missing <> '' THEN
        RAISE EXCEPTION 'FAIL S00 : 缺少表%s（是否未执行 001_schema_v1.sql，或 search_path 未指向安装 schema）', v_missing;
    END IF;
    IF to_regclass('import_batches') IS NOT NULL THEN
        RAISE EXCEPTION 'FAIL S00 : v1 不应存在 import_batches（恢复事实按 DESIGN 10.5 落在 captures/pages/image_assets）';
    END IF;

    RAISE NOTICE 'PASS S00 : 7 张业务表存在，且不存在 import_batches';
END $$;

-- ---------------------------------------------------------------------
-- S01. 种子参考数据与目录名→显示名映射（种子缺失时降级为 SKIP）
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_cnt  integer;
    v_dir  text;
    v_disp text;
BEGIN
    SELECT count(*) INTO v_cnt
      FROM subjects
     WHERE code IN ('math', 'chinese', 'english', 'other', 'unclassified');

    IF v_cnt = 0 THEN
        RAISE WARNING 'SKIP S01 : 未检测到种子科目，请先执行 002_seed_v1.sql；跳过种子映射断言';
    ELSE
        IF v_cnt <> 5 THEN
            RAISE EXCEPTION 'FAIL S01 : 期望 5 个种子科目（math/chinese/english/other/unclassified），实得 %', v_cnt;
        END IF;

        SELECT directory_name, display_name INTO v_dir, v_disp FROM terms WHERE code = 'g1t1';
        IF v_dir IS DISTINCT FROM '一年级上' OR v_disp IS DISTINCT FROM '一年级上学期' THEN
            RAISE EXCEPTION 'FAIL S01 : g1t1 映射错误，期望 一年级上 / 一年级上学期，实得 % / %',
                coalesce(v_dir, '<缺失>'), coalesce(v_disp, '<缺失>');
        END IF;

        SELECT directory_name, display_name INTO v_dir, v_disp FROM terms WHERE code = 'g1t2';
        IF v_dir IS DISTINCT FROM '一年级下' OR v_disp IS DISTINCT FROM '一年级下学期' THEN
            RAISE EXCEPTION 'FAIL S01 : g1t2 映射错误，期望 一年级下 / 一年级下学期，实得 % / %',
                coalesce(v_dir, '<缺失>'), coalesce(v_disp, '<缺失>');
        END IF;

        IF EXISTS (SELECT 1 FROM terms WHERE code = 'unclassified'
                    AND (grade IS NOT NULL OR term_number IS NOT NULL)) THEN
            RAISE EXCEPTION 'FAIL S01 : 学期 unclassified 的 grade/term_number 必须同时为 NULL';
        END IF;

        RAISE NOTICE 'PASS S01 : 种子科目齐全，g1t1/g1t2 的目录名与显示名映射正确，unclassified 成对为空';
    END IF;
END $$;

-- ---------------------------------------------------------------------
-- S02. 会话级夹具登记表（随 ROLLBACK 消失，不污染安装 schema）
-- ---------------------------------------------------------------------
DO $$
BEGIN
    EXECUTE 'CREATE TEMP TABLE wb_test_ids (name text PRIMARY KEY, id uuid NOT NULL)';
    RAISE NOTICE 'PASS S02 : 测试夹具登记表就绪（临时表，随最终 ROLLBACK 消失）';
END $$;

-- ---------------------------------------------------------------------
-- S03. 索引核对（PLAN §3 验收 #23）
--      term+subject 浏览、Page 取 Capture、sha256 查找三类访问路径必须有对应索引，
--      且同一列集合不得出现重复索引（唯一约束自带的 backing index 计入）。
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_missing text[] := ARRAY[]::text[];
    v_name    text;
    v_dup     text[] := ARRAY[]::text[];
    v_bad     integer := 0;
BEGIN
    -- ① 必需索引逐项存在性检查
    FOREACH v_name IN ARRAY ARRAY[
        'idx_documents_term_subject_id',
        'idx_pages_document_id_page_number',
        'idx_captures_page_id_created_at',
        'idx_captures_status_created_at',
        'idx_image_assets_capture_id_kind_status',
        'uq_captures_sha256',
        'uq_page_transforms_page_id_version'
    ] LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_indexes
             WHERE schemaname = current_schema() AND indexname = v_name
        ) THEN
            v_missing := v_missing || v_name;
        END IF;
    END LOOP;

    IF array_length(v_missing, 1) > 0 THEN
        RAISE EXCEPTION 'FAIL S03 : 缺少必需索引：%', array_to_string(v_missing, ', ');
    END IF;

    -- ② 重复索引检查：同一表上索引列完全相同的不同索引名视为重复
    SELECT array_agg(tbl || ':' || cols) INTO v_dup
      FROM (
        SELECT tablename AS tbl,
               array_to_string(indkey_cols, ',') AS cols,
               count(*) AS n
          FROM (
            SELECT c.relname AS tablename,
                   (SELECT array_agg(a.attname ORDER BY k.ord)
                      FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                     WHERE k.attnum > 0) AS indkey_cols
              FROM pg_index i
              JOIN pg_class c ON c.oid = i.indrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = current_schema()
               AND c.relkind = 'r'
          ) x
         GROUP BY tablename, array_to_string(indkey_cols, ',')
        HAVING count(*) > 1
      ) y;

    IF v_dup IS NOT NULL AND array_length(v_dup, 1) > 0 THEN
        RAISE EXCEPTION 'FAIL S03 : 存在重复索引（同表同列）：%', array_to_string(v_dup, ' | ');
    END IF;

    RAISE NOTICE 'PASS S03 : 7 个必需索引全部存在，且 7 张表上无同列重复索引';
END $$;

-- ---------------------------------------------------------------------
-- F01. 测试夹具：科目、学期、资料、页面、拍摄、变换、派生图
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_subject_math    uuid;
    v_subject_chinese uuid;
    v_term_a          uuid;
    v_term_b          uuid;
    v_doc_1           uuid;
    v_doc_2           uuid;
    v_page_1          uuid;
    v_page_2          uuid;
    v_page_3          uuid;
    v_cap_1           uuid;
    v_cap_2           uuid;
    v_cap_3           uuid;
    v_cap_4           uuid;
    v_cap_5           uuid;
    v_cap_6           uuid;
    v_cap_7           uuid;
    v_tr_1            uuid;
    v_tr_2            uuid;
BEGIN
    INSERT INTO subjects (code, display_name, directory_name, sort_order)
    VALUES ('t_math', '测试数学', '测试数学', 900) RETURNING id INTO v_subject_math;

    INSERT INTO subjects (code, display_name, directory_name, sort_order)
    VALUES ('t_chinese', '测试语文', '测试语文', 901) RETURNING id INTO v_subject_chinese;

    INSERT INTO terms (code, grade, term_number, display_name, directory_name, sort_order)
    VALUES ('t_term_a', 9::smallint, 1::smallint, '测试九年级上学期', '测试九年级上', 900)
    RETURNING id INTO v_term_a;

    INSERT INTO terms (code, grade, term_number, display_name, directory_name, sort_order)
    VALUES ('t_term_b', 9::smallint, 2::smallint, '测试九年级下学期', '测试九年级下', 901)
    RETURNING id INTO v_term_b;

    INSERT INTO documents (subject_id, term_id, source_type, title)
    VALUES (v_subject_math, v_term_a, 'exam_paper', '测试资料A') RETURNING id INTO v_doc_1;

    INSERT INTO documents (subject_id, term_id, source_type, title)
    VALUES (v_subject_chinese, v_term_b, 'workbook', '测试资料B') RETURNING id INTO v_doc_2;

    INSERT INTO pages (document_id, page_number, notes)
    VALUES (v_doc_1, 1, '测试页1') RETURNING id INTO v_page_1;
    INSERT INTO pages (document_id, page_number, notes)
    VALUES (v_doc_1, 2, '测试页2') RETURNING id INTO v_page_2;
    INSERT INTO pages (document_id, page_number, notes)
    VALUES (v_doc_2, 1, '测试页3') RETURNING id INTO v_page_3;

    -- cap_1/3/4/6/7 直接以 registered 建行，顺带验证 registered 元数据完整性 CHECK
    INSERT INTO captures (page_id, sha256, original_path, original_filename,
                          source_metadata_json, media_type, byte_size, width, height, status)
    VALUES (v_page_1, decode(md5('cap-1') || md5('cap-1b'), 'hex'),
            '数学/一年级上/' || md5('cap-1') || '.jpg', 'IMG_0001.JPG',
            '{"device":"test","import":"fixture"}'::jsonb, 'image/jpeg', 2048, 1200, 1600, 'registered')
    RETURNING id INTO v_cap_1;

    INSERT INTO captures (page_id, sha256, original_path, original_filename, status)
    VALUES (v_page_1, decode(md5('cap-2') || md5('cap-2b'), 'hex'),
            '数学/一年级上/' || md5('cap-2') || '.jpg', 'IMG_0002.JPG', 'reserved')
    RETURNING id INTO v_cap_2;

    INSERT INTO captures (page_id, sha256, original_path, original_filename,
                          media_type, byte_size, width, height, status)
    VALUES (v_page_2, decode(md5('cap-3') || md5('cap-3b'), 'hex'),
            '数学/一年级上/' || md5('cap-3') || '.jpg', 'IMG_0003.JPG',
            'image/jpeg', 4096, 1600, 1200, 'registered')
    RETURNING id INTO v_cap_3;

    -- 视觉确认被取消后的合法状态：registered 且 page_id IS NULL
    INSERT INTO captures (page_id, sha256, original_path, original_filename,
                          media_type, byte_size, width, height, status)
    VALUES (NULL, decode(md5('cap-4') || md5('cap-4b'), 'hex'),
            '数学/一年级上/' || md5('cap-4') || '.jpg', 'IMG_0004.JPG',
            'image/jpeg', 1024, 1000, 1400, 'registered')
    RETURNING id INTO v_cap_4;

    INSERT INTO captures (page_id, sha256, original_path, original_filename, status)
    VALUES (NULL, decode(md5('cap-5') || md5('cap-5b'), 'hex'),
            '数学/一年级上/' || md5('cap-5') || '.jpg', 'IMG_0005.JPG', 'reserved')
    RETURNING id INTO v_cap_5;

    INSERT INTO captures (page_id, sha256, original_path, original_filename,
                          media_type, byte_size, width, height, status)
    VALUES (v_page_3, decode(md5('cap-6') || md5('cap-6b'), 'hex'),
            '语文/一年级下/' || md5('cap-6') || '.jpg', 'IMG_0006.JPG',
            'image/jpeg', 3072, 1200, 1600, 'registered')
    RETURNING id INTO v_cap_6;

    INSERT INTO captures (page_id, sha256, original_path, original_filename,
                          media_type, byte_size, width, height, status)
    VALUES (v_page_3, decode(md5('cap-7') || md5('cap-7b'), 'hex'),
            '语文/一年级下/' || md5('cap-7') || '.jpg', 'IMG_0007.JPG',
            'image/jpeg', 3073, 1200, 1600, 'registered')
    RETURNING id INTO v_cap_7;

    INSERT INTO page_transforms (page_id, source_capture_id, version, operations_json)
    VALUES (v_page_1, v_cap_1, 1, '{"rotate":90,"crop":[0,0,1200,1600]}'::jsonb) RETURNING id INTO v_tr_1;

    INSERT INTO page_transforms (page_id, source_capture_id, version, operations_json)
    VALUES (v_page_1, v_cap_2, 2, '{"rotate":0}'::jsonb) RETURNING id INTO v_tr_2;

    -- 101–112 为测试专用变换版本（来源均为 cap_1），避免唯一键互相干扰
    -- 101–108 供 N04（8 种非法 storage_path）；109–112 供 N05（ready 缺字段反例）
    INSERT INTO page_transforms (page_id, source_capture_id, version, operations_json)
    VALUES (v_page_1, v_cap_1, 101, '{}'::jsonb),
           (v_page_1, v_cap_1, 102, '{}'::jsonb),
           (v_page_1, v_cap_1, 103, '{}'::jsonb),
           (v_page_1, v_cap_1, 104, '{}'::jsonb),
           (v_page_1, v_cap_1, 105, '{}'::jsonb),
           (v_page_1, v_cap_1, 106, '{}'::jsonb),
           (v_page_1, v_cap_1, 107, '{}'::jsonb),
           (v_page_1, v_cap_1, 108, '{}'::jsonb),
           (v_page_1, v_cap_1, 109, '{}'::jsonb),
           (v_page_1, v_cap_1, 110, '{}'::jsonb),
           (v_page_1, v_cap_1, 111, '{}'::jsonb),
           (v_page_1, v_cap_1, 112, '{}'::jsonb);

    -- ready 的标准化图（也验证 ready 元数据完整性 CHECK 允许完整行）
    INSERT INTO image_assets (capture_id, transform_id, kind, status, storage_path,
                              media_type, byte_size, width, height, sha256, version)
    VALUES (v_cap_1, v_tr_1, 'standardized', 'ready',
            'standardized/' || md5('asset-1') || '.jpg', 'image/jpeg', 8192, 1600, 1200,
            decode(md5('asset-1') || md5('asset-1b'), 'hex'), 1);

    INSERT INTO wb_test_ids (name, id) VALUES
        ('subject_math', v_subject_math),
        ('subject_chinese', v_subject_chinese),
        ('term_a', v_term_a),
        ('term_b', v_term_b),
        ('doc_1', v_doc_1),
        ('doc_2', v_doc_2),
        ('page_1', v_page_1),
        ('page_2', v_page_2),
        ('page_3', v_page_3),
        ('cap_1', v_cap_1),
        ('cap_2', v_cap_2),
        ('cap_3', v_cap_3),
        ('cap_4', v_cap_4),
        ('cap_5', v_cap_5),
        ('cap_6', v_cap_6),
        ('cap_7', v_cap_7),
        ('tr_1', v_tr_1),
        ('tr_2', v_tr_2),
        ('tr_101', (SELECT id FROM page_transforms WHERE page_id = v_page_1 AND version = 101)),
        ('tr_102', (SELECT id FROM page_transforms WHERE page_id = v_page_1 AND version = 102)),
        ('tr_103', (SELECT id FROM page_transforms WHERE page_id = v_page_1 AND version = 103)),
        ('tr_104', (SELECT id FROM page_transforms WHERE page_id = v_page_1 AND version = 104)),
        ('tr_105', (SELECT id FROM page_transforms WHERE page_id = v_page_1 AND version = 105)),
        ('tr_106', (SELECT id FROM page_transforms WHERE page_id = v_page_1 AND version = 106)),
        ('tr_107', (SELECT id FROM page_transforms WHERE page_id = v_page_1 AND version = 107)),
        ('tr_108', (SELECT id FROM page_transforms WHERE page_id = v_page_1 AND version = 108)),
        ('tr_109', (SELECT id FROM page_transforms WHERE page_id = v_page_1 AND version = 109)),
        ('tr_110', (SELECT id FROM page_transforms WHERE page_id = v_page_1 AND version = 110)),
        ('tr_111', (SELECT id FROM page_transforms WHERE page_id = v_page_1 AND version = 111)),
        ('tr_112', (SELECT id FROM page_transforms WHERE page_id = v_page_1 AND version = 112));

    RAISE NOTICE 'PASS F01 : 夹具建立成功（科目/学期/资料/页面/拍摄/变换/标准化图），中文相对路径被接受';
END $$;

-- ---------------------------------------------------------------------
-- F02. uuidv7() 自动生成、版本为 7、时间戳与字节序单调
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_id_a uuid;
    v_id_b uuid;
    v_ts_a timestamptz;
    v_ts_b timestamptz;
BEGIN
    INSERT INTO subjects (code, display_name, directory_name, sort_order)
    VALUES ('t_uuid_a', 'UUID测试A', 'UUID测试A', 950) RETURNING id INTO v_id_a;

    PERFORM pg_sleep(0.01);

    INSERT INTO subjects (code, display_name, directory_name, sort_order)
    VALUES ('t_uuid_b', 'UUID测试B', 'UUID测试B', 951) RETURNING id INTO v_id_b;

    IF v_id_a IS NULL OR v_id_b IS NULL THEN
        RAISE EXCEPTION 'FAIL F02 : uuidv7() 默认值未生效（主键为 NULL）';
    END IF;
    IF uuid_extract_version(v_id_a) <> 7 OR uuid_extract_version(v_id_b) <> 7 THEN
        RAISE EXCEPTION 'FAIL F02 : 期望 uuid 版本 7，实得 % / %',
            uuid_extract_version(v_id_a), uuid_extract_version(v_id_b);
    END IF;

    v_ts_a := uuid_extract_timestamp(v_id_a);
    v_ts_b := uuid_extract_timestamp(v_id_b);
    IF v_ts_a IS NULL OR v_ts_b IS NULL THEN
        RAISE EXCEPTION 'FAIL F02 : uuid_extract_timestamp 返回 NULL';
    END IF;
    IF NOT (v_ts_b > v_ts_a) THEN
        RAISE EXCEPTION 'FAIL F02 : 后生成的 uuidv7 时间戳未前进（% vs %）', v_ts_b, v_ts_a;
    END IF;
    IF NOT (v_id_b > v_id_a) THEN
        RAISE EXCEPTION 'FAIL F02 : 时间戳更大的 uuidv7 应按字节序排在后面';
    END IF;

    RAISE NOTICE 'PASS F02 : uuidv7() 自动生成，version=7，时间戳与字节序均单调递增';
END $$;

-- ---------------------------------------------------------------------
-- N01. sha256 全库唯一：同一文件换科目/学期（不同 Document/Page）再插必须被拒
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_doc_2 uuid;
    v_page  uuid;
    v_sha   bytea;
    v_state text := '';
    v_msg   text := '';
BEGIN
    SELECT id INTO v_doc_2 FROM wb_test_ids WHERE name = 'doc_2';
    SELECT sha256 INTO v_sha FROM captures WHERE id = (SELECT id FROM wb_test_ids WHERE name = 'cap_1');

    INSERT INTO pages (document_id, page_number) VALUES (v_doc_2, 99) RETURNING id INTO v_page;

    BEGIN
        INSERT INTO captures (page_id, sha256, original_path, original_filename, status)
        VALUES (v_page, v_sha, '语文/一年级下/dup-' || md5('dup') || '.jpg', 'COPY.JPG', 'reserved');
    EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE; v_msg := SQLERRM;
    END;

    IF v_state = '' THEN
        RAISE EXCEPTION 'FAIL N01 : 相同 sha256 在另一个科目/学期下竟然插入成功（uq_captures_sha256 失效）';
    ELSIF v_state <> '23505' THEN
        RAISE EXCEPTION 'FAIL N01 : 期望 23505（unique_violation），实得 %（%）', v_state, v_msg;
    END IF;

    IF (SELECT count(*) FROM captures WHERE sha256 = v_sha) <> 1 THEN
        RAISE EXCEPTION 'FAIL N01 : 该哈希在 captures 中不止一行';
    END IF;

    RAISE NOTICE 'PASS N01 : 同一 sha256 换科目/学期再插被 uq_captures_sha256 拒绝（23505），全库仅一行';
END $$;

-- ---------------------------------------------------------------------
-- N02. sha256 长度必须是 32 字节（31 / 33 字节都被拒）
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_len   integer;
    v_hex   text;
    v_state text;
    v_msg   text;
BEGIN
    FOREACH v_len IN ARRAY ARRAY[31, 33] LOOP
        v_state := ''; v_msg := '';
        v_hex := left(repeat('ab', 40), v_len * 2);

        BEGIN
            INSERT INTO captures (sha256, original_path, original_filename, status)
            VALUES (decode(v_hex, 'hex'),
                    '数学/一年级上/len-' || v_len || '.jpg', 'LEN.JPG', 'reserved');
        EXCEPTION WHEN OTHERS THEN
            v_state := SQLSTATE; v_msg := SQLERRM;
        END;

        IF v_state = '' THEN
            RAISE EXCEPTION 'FAIL N02 : % 字节 sha256 竟然被接受', v_len;
        ELSIF v_state <> '23514' THEN
            RAISE EXCEPTION 'FAIL N02 : % 字节 sha256 期望 23514，实得 %（%）', v_len, v_state, v_msg;
        END IF;
    END LOOP;

    RAISE NOTICE 'PASS N02 : 31 / 33 字节 sha256 均被 chk_captures_sha256_length 拒绝（23514）';
END $$;

-- ---------------------------------------------------------------------
-- N03. captures.original_path 相对路径约束：
--      绝对路径、盘符（正/反斜杠）、..、空段、尾斜杠、反斜杠、./ 前缀
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_bad   text[] := ARRAY[
                '/tmp/a.jpg',
                'C:/a.jpg',
                'C:\a.jpg',
                '../a.jpg',
                '数学/../a.jpg',
                '数学//a.jpg',
                '数学/a.jpg/',
                '数学\a.jpg',
                './数学/a.jpg'
            ];
    v_path  text;
    v_i     integer := 0;
    v_state text;
    v_msg   text;
BEGIN
    FOREACH v_path IN ARRAY v_bad LOOP
        v_i := v_i + 1;
        v_state := ''; v_msg := '';

        BEGIN
            INSERT INTO captures (sha256, original_path, original_filename, status)
            VALUES (decode(md5('bad-path-' || v_i) || md5('bad-path-x'), 'hex'),
                    v_path, 'BAD.JPG', 'reserved');
        EXCEPTION WHEN OTHERS THEN
            v_state := SQLSTATE; v_msg := SQLERRM;
        END;

        IF v_state = '' THEN
            RAISE EXCEPTION 'FAIL N03.% : 非法 original_path 竟然被接受：[%]', v_i, v_path;
        ELSIF v_state <> '23514' THEN
            RAISE EXCEPTION 'FAIL N03.% : 路径 [%] 期望 23514，实得 %（%）', v_i, v_path, v_state, v_msg;
        END IF;
    END LOOP;

    RAISE NOTICE 'PASS N03 : 9 种非法 original_path 全部被 chk_captures_relative_path 拒绝（23514）';
END $$;

-- ---------------------------------------------------------------------
-- N04. image_assets.storage_path 相对路径约束（每个用例一个专用变换版本）
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_cap   uuid;
    v_lbl   text[] := ARRAY['tr_101', 'tr_102', 'tr_103', 'tr_104',
                            'tr_107', 'tr_108', 'tr_109', 'tr_110'];
    -- 8 种非法形式：POSIX 绝对、盘符、反斜杠、空段、../ 穿越、段内 ..、尾斜杠、./ 前缀
    v_bad   text[] := ARRAY['/var/data/a.jpg', 'D:/data/a.jpg', '..\a.jpg', 'standardized//a.jpg',
                            '../standardized/a.jpg', 'standardized/../a.jpg',
                            'standardized/a.jpg/', './standardized/a.jpg'];
    v_tr    uuid;
    v_path  text;
    v_i     integer := 0;
    v_state text;
    v_msg   text;
BEGIN
    SELECT id INTO v_cap FROM wb_test_ids WHERE name = 'cap_1';

    WHILE v_i < array_length(v_lbl, 1) LOOP
        v_i := v_i + 1;
        SELECT id INTO v_tr FROM wb_test_ids WHERE name = v_lbl[v_i];
        v_path := v_bad[v_i];
        v_state := ''; v_msg := '';

        BEGIN
            INSERT INTO image_assets (capture_id, transform_id, kind, status, storage_path, version)
            VALUES (v_cap, v_tr, 'standardized', 'generating', v_path, 100 + v_i);
        EXCEPTION WHEN OTHERS THEN
            v_state := SQLSTATE; v_msg := SQLERRM;
        END;

        IF v_state = '' THEN
            RAISE EXCEPTION 'FAIL N04.% : 非法 storage_path 竟然被接受：[%]', v_i, v_path;
        ELSIF v_state <> '23514' THEN
            RAISE EXCEPTION 'FAIL N04.% : storage_path [%] 期望 23514，实得 %（%）', v_i, v_path, v_state, v_msg;
        END IF;
    END LOOP;

    RAISE NOTICE 'PASS N04 : 8 种非法 storage_path 全部被 chk_image_assets_relative_path 拒绝（23514）';
END $$;

-- ---------------------------------------------------------------------
-- N05. ready 的 image_assets 必须字段完整（6 个必填分量逐个缺失各测一次）
--      每个反例用独立的 transform 版本，避免 uq_image_assets_transform_id_kind 干扰。
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_cap   uuid;
    v_lbl   text[] := ARRAY['tr_105', 'tr_109', 'tr_110', 'tr_111', 'tr_112', 'tr_106'];
    v_field text[] := ARRAY['sha256', 'storage_path', 'media_type', 'byte_size', 'width', 'height'];
    v_tr    uuid;
    v_ver   integer;
    v_i     integer := 0;
    v_state text;
    v_msg   text;
BEGIN
    SELECT id INTO v_cap FROM wb_test_ids WHERE name = 'cap_1';

    WHILE v_i < array_length(v_lbl, 1) LOOP
        v_i := v_i + 1;
        SELECT id INTO v_tr FROM wb_test_ids WHERE name = v_lbl[v_i];
        v_ver := (SELECT version FROM page_transforms WHERE id = v_tr);
        v_state := ''; v_msg := '';

        BEGIN
            IF v_field[v_i] = 'sha256' THEN
                INSERT INTO image_assets (capture_id, transform_id, kind, status, storage_path,
                                          media_type, byte_size, width, height, version)
                VALUES (v_cap, v_tr, 'standardized', 'ready',
                        'standardized/incomplete-' || v_ver || '.jpg', 'image/jpeg', 1024, 100, 100, v_ver);
            ELSIF v_field[v_i] = 'storage_path' THEN
                INSERT INTO image_assets (capture_id, transform_id, kind, status,
                                          media_type, byte_size, width, height, sha256, version)
                VALUES (v_cap, v_tr, 'standardized', 'ready',
                        'image/jpeg', 1024, 100, 100, decode(md5('a'||v_ver)||md5('b'||v_ver),'hex'), v_ver);
            ELSIF v_field[v_i] = 'media_type' THEN
                INSERT INTO image_assets (capture_id, transform_id, kind, status, storage_path,
                                          byte_size, width, height, sha256, version)
                VALUES (v_cap, v_tr, 'standardized', 'ready',
                        'standardized/incomplete-' || v_ver || '.jpg', 1024, 100, 100,
                        decode(md5('a'||v_ver)||md5('b'||v_ver),'hex'), v_ver);
            ELSIF v_field[v_i] = 'byte_size' THEN
                INSERT INTO image_assets (capture_id, transform_id, kind, status, storage_path,
                                          media_type, width, height, sha256, version)
                VALUES (v_cap, v_tr, 'standardized', 'ready',
                        'standardized/incomplete-' || v_ver || '.jpg', 'image/jpeg', 100, 100,
                        decode(md5('a'||v_ver)||md5('b'||v_ver),'hex'), v_ver);
            ELSIF v_field[v_i] = 'width' THEN
                INSERT INTO image_assets (capture_id, transform_id, kind, status, storage_path,
                                          media_type, byte_size, height, sha256, version)
                VALUES (v_cap, v_tr, 'standardized', 'ready',
                        'standardized/incomplete-' || v_ver || '.jpg', 'image/jpeg', 1024, 100,
                        decode(md5('a'||v_ver)||md5('b'||v_ver),'hex'), v_ver);
            ELSE
                INSERT INTO image_assets (capture_id, transform_id, kind, status, storage_path,
                                          media_type, byte_size, width, sha256, version)
                VALUES (v_cap, v_tr, 'standardized', 'ready',
                        'standardized/incomplete-' || v_ver || '.jpg', 'image/jpeg', 1024, 100,
                        decode(md5('a'||v_ver)||md5('b'||v_ver),'hex'), v_ver);
            END IF;
        EXCEPTION WHEN OTHERS THEN
            v_state := SQLSTATE; v_msg := SQLERRM;
        END;

        IF v_state = '' THEN
            RAISE EXCEPTION 'FAIL N05.% : ready 但缺少 % 的 asset 竟然被接受', v_i, v_field[v_i];
        ELSIF v_state <> '23514' THEN
            RAISE EXCEPTION 'FAIL N05.% : 缺 % 时期望 23514，实得 %（%）', v_i, v_field[v_i], v_state, v_msg;
        END IF;
    END LOOP;

    RAISE NOTICE 'PASS N05 : ready 缺 sha256/storage_path/media_type/byte_size/width/height 六种情况全部被 chk_image_assets_ready_complete 拒绝（23514）';
END $$;

-- ---------------------------------------------------------------------
-- N06. captures.status 非法取值被 CHECK 拒绝
--      说明：用 INSERT 而非 UPDATE，避免 BEFORE UPDATE 状态机触发器先于 CHECK 报错，
--            从而能精确断言「约束本身」的 SQLSTATE。
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_state text := '';
    v_msg   text := '';
BEGIN
    BEGIN
        INSERT INTO captures (sha256, original_path, original_filename, status)
        VALUES (decode(md5('bad-status') || md5('bad-status-x'), 'hex'),
                '数学/一年级上/bad-status.jpg', 'BAD_STATUS.JPG', 'bogus_status');
    EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE; v_msg := SQLERRM;
    END;

    IF v_state = '' THEN
        RAISE EXCEPTION 'FAIL N06 : 非法 captures.status 竟然被接受';
    ELSIF v_state <> '23514' THEN
        RAISE EXCEPTION 'FAIL N06 : 期望 23514，实得 %（%）', v_state, v_msg;
    END IF;

    RAISE NOTICE 'PASS N06 : captures.status 非法值被 chk_captures_status 拒绝（23514）';
END $$;

-- ---------------------------------------------------------------------
-- N07. image_assets.status 非法取值被 CHECK 拒绝（同样用 INSERT 精确断言 CHECK）
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_cap   uuid;
    v_tr    uuid;
    v_state text := '';
    v_msg   text := '';
BEGIN
    SELECT id INTO v_cap FROM wb_test_ids WHERE name = 'cap_1';
    SELECT id INTO v_tr  FROM wb_test_ids WHERE name = 'tr_101';

    BEGIN
        INSERT INTO image_assets (capture_id, transform_id, kind, status, version)
        VALUES (v_cap, v_tr, 'thumbnail', 'done', 101);
    EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE; v_msg := SQLERRM;
    END;

    IF v_state = '' THEN
        RAISE EXCEPTION 'FAIL N07 : 非法 image_assets.status 竟然被接受';
    ELSIF v_state <> '23514' THEN
        RAISE EXCEPTION 'FAIL N07 : 期望 23514，实得 %（%）', v_state, v_msg;
    END IF;

    RAISE NOTICE 'PASS N07 : image_assets.status 非法值被 chk_image_assets_status 拒绝（23514）';
END $$;

-- ---------------------------------------------------------------------
-- N08. registered 的 Capture 元数据必须完整（缺 media_type 时拒绝）
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_state text := '';
    v_msg   text := '';
BEGIN
    BEGIN
        INSERT INTO captures (page_id, sha256, original_path, original_filename, status)
        VALUES (NULL, decode(md5('cap-incomplete') || md5('cap-inc-x'), 'hex'),
                '数学/一年级上/incomplete.jpg', 'INC.JPG', 'registered');
    EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE; v_msg := SQLERRM;
    END;

    IF v_state = '' THEN
        RAISE EXCEPTION 'FAIL N08 : registered 但缺媒体元数据的 Capture 竟然被接受';
    ELSIF v_state <> '23514' THEN
        RAISE EXCEPTION 'FAIL N08 : 期望 23514，实得 %（%）', v_state, v_msg;
    END IF;

    RAISE NOTICE 'PASS N08 : registered 但元数据不全的 Capture 被 chk_captures_registered_complete 拒绝（23514）';
END $$;

-- ---------------------------------------------------------------------
-- N09. sha256 为 NOT NULL（缺失时 23502）
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_state text := '';
    v_msg   text := '';
BEGIN
    BEGIN
        INSERT INTO captures (original_path, original_filename)
        VALUES ('数学/一年级上/nosha.jpg', 'NOSHA.JPG');
    EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE; v_msg := SQLERRM;
    END;

    IF v_state = '' THEN
        RAISE EXCEPTION 'FAIL N09 : 缺少 sha256 的 Capture 竟然被接受';
    ELSIF v_state <> '23502' THEN
        RAISE EXCEPTION 'FAIL N09 : 期望 23502（not_null_violation），实得 %（%）', v_state, v_msg;
    END IF;

    RAISE NOTICE 'PASS N09 : 缺少 sha256 被 NOT NULL 拒绝（23502）';
END $$;

-- ---------------------------------------------------------------------
-- N10. 视觉指纹与算法必须成对（只写其一被拒）
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_cap   uuid;
    v_print bytea := decode(repeat('ab', 8), 'hex');
    v_state text;
    v_msg   text;
BEGIN
    SELECT id INTO v_cap FROM wb_test_ids WHERE name = 'cap_5';

    v_state := ''; v_msg := '';
    BEGIN
        UPDATE captures SET visual_fingerprint = v_print, visual_fingerprint_method = NULL
         WHERE id = v_cap;
    EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE; v_msg := SQLERRM;
    END;
    IF v_state = '' THEN
        RAISE EXCEPTION 'FAIL N10.1 : 只写 visual_fingerprint 竟然被接受';
    ELSIF v_state <> '23514' THEN
        RAISE EXCEPTION 'FAIL N10.1 : 期望 23514，实得 %（%）', v_state, v_msg;
    END IF;

    v_state := ''; v_msg := '';
    BEGIN
        UPDATE captures SET visual_fingerprint = NULL, visual_fingerprint_method = 'phash64'
         WHERE id = v_cap;
    EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE; v_msg := SQLERRM;
    END;
    IF v_state = '' THEN
        RAISE EXCEPTION 'FAIL N10.2 : 只写 visual_fingerprint_method 竟然被接受';
    ELSIF v_state <> '23514' THEN
        RAISE EXCEPTION 'FAIL N10.2 : 期望 23514，实得 %（%）', v_state, v_msg;
    END IF;

    RAISE NOTICE 'PASS N10 : 指纹与算法必须成对，两种单写都被 chk_captures_fingerprint_pair 拒绝（23514）';
END $$;

-- ---------------------------------------------------------------------
-- F03. 指纹相同不触发唯一冲突、也不自动改 page_id（相似度只作候选）
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_cap_5  uuid;
    v_cap_4  uuid;
    v_print  bytea := decode(repeat('cd', 8), 'hex');
    v_page_5 uuid;
BEGIN
    SELECT id INTO v_cap_5 FROM wb_test_ids WHERE name = 'cap_5';
    SELECT id INTO v_cap_4 FROM wb_test_ids WHERE name = 'cap_4';

    UPDATE captures SET visual_fingerprint = v_print, visual_fingerprint_method = 'phash64'
     WHERE id = v_cap_5;
    UPDATE captures SET visual_fingerprint = v_print, visual_fingerprint_method = 'phash64'
     WHERE id = v_cap_4;

    IF (SELECT count(*) FROM captures WHERE visual_fingerprint = v_print) <> 2 THEN
        RAISE EXCEPTION 'FAIL F03 : 相同指纹未能写入两行';
    END IF;

    SELECT page_id INTO v_page_5 FROM captures WHERE id = v_cap_5;
    IF v_page_5 IS NOT NULL THEN
        RAISE EXCEPTION 'FAIL F03 : 写入指纹竟然自动修改了 capture.page_id';
    END IF;

    RAISE NOTICE 'PASS F03 : 相同视觉指纹可并存，且未自动归组（page_id 仍为 NULL）';
END $$;

-- ---------------------------------------------------------------------
-- N11. 首选 Capture 指向别的 Page 的 Capture 必须被拒（复合外键）
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_page_1 uuid;
    v_cap_3  uuid;
    v_state  text := '';
    v_msg    text := '';
BEGIN
    SELECT id INTO v_page_1 FROM wb_test_ids WHERE name = 'page_1';
    SELECT id INTO v_cap_3  FROM wb_test_ids WHERE name = 'cap_3';

    BEGIN
        UPDATE pages SET preferred_capture_id = v_cap_3 WHERE id = v_page_1;
    EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE; v_msg := SQLERRM;
    END;

    IF v_state = '' THEN
        RAISE EXCEPTION 'FAIL N11 : 首选 Capture 指向其他 Page 的照片竟然被接受';
    ELSIF v_state <> '23503' THEN
        RAISE EXCEPTION 'FAIL N11 : 期望 23503（foreign_key_violation），实得 %（%）', v_state, v_msg;
    END IF;

    IF (SELECT preferred_capture_id FROM pages WHERE id = v_page_1) IS NOT NULL THEN
        RAISE EXCEPTION 'FAIL N11 : 失败的更新留下了 preferred_capture_id';
    END IF;

    RAISE NOTICE 'PASS N11 : 跨 Page 的首选 Capture 被 fk_pages_preferred_capture_id 拒绝（23503）';
END $$;

-- ---------------------------------------------------------------------
-- F04. 首选可置 NULL、可指向本页 Capture、切换首选不减少 Capture 行数
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_page_1 uuid;
    v_cap_1  uuid;
    v_cap_2  uuid;
    v_before integer;
    v_after  integer;
BEGIN
    SELECT id INTO v_page_1 FROM wb_test_ids WHERE name = 'page_1';
    SELECT id INTO v_cap_1  FROM wb_test_ids WHERE name = 'cap_1';
    SELECT id INTO v_cap_2  FROM wb_test_ids WHERE name = 'cap_2';

    UPDATE pages SET preferred_capture_id = NULL WHERE id = v_page_1;

    UPDATE pages SET preferred_capture_id = v_cap_1 WHERE id = v_page_1;
    IF (SELECT preferred_capture_id FROM pages WHERE id = v_page_1) <> v_cap_1 THEN
        RAISE EXCEPTION 'FAIL F04 : 首选 Capture 未按预期写入';
    END IF;

    SELECT count(*) INTO v_before FROM captures WHERE page_id = v_page_1;

    UPDATE pages SET preferred_capture_id = v_cap_2 WHERE id = v_page_1;
    IF (SELECT preferred_capture_id FROM pages WHERE id = v_page_1) <> v_cap_2 THEN
        RAISE EXCEPTION 'FAIL F04 : 切换首选 Capture 失败';
    END IF;

    SELECT count(*) INTO v_after FROM captures WHERE page_id = v_page_1;
    IF v_after <> v_before THEN
        RAISE EXCEPTION 'FAIL F04 : 切换首选后 Capture 行数由 % 变为 %（不得删除其他拍摄）', v_before, v_after;
    END IF;

    RAISE NOTICE 'PASS F04 : 首选可置 NULL、可切到同页另一张，Capture 行数不变（%）', v_after;
END $$;

-- ---------------------------------------------------------------------
-- N12. 首选 Capture 不能指向 page_id IS NULL 的 Capture
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_page_1 uuid;
    v_cap_4  uuid;
    v_state  text := '';
    v_msg    text := '';
BEGIN
    SELECT id INTO v_page_1 FROM wb_test_ids WHERE name = 'page_1';
    SELECT id INTO v_cap_4  FROM wb_test_ids WHERE name = 'cap_4';

    BEGIN
        UPDATE pages SET preferred_capture_id = v_cap_4 WHERE id = v_page_1;
    EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE; v_msg := SQLERRM;
    END;

    IF v_state = '' THEN
        RAISE EXCEPTION 'FAIL N12 : 首选 Capture 指向未归组（page_id 为 NULL）的拍摄竟然被接受';
    ELSIF v_state <> '23503' THEN
        RAISE EXCEPTION 'FAIL N12 : 期望 23503，实得 %（%）', v_state, v_msg;
    END IF;

    RAISE NOTICE 'PASS N12 : 首选 Capture 指向 page_id IS NULL 的拍摄被拒（23503）';
END $$;

-- ---------------------------------------------------------------------
-- N13. ON DELETE RESTRICT：科目 / 学期 / 资料
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_subject uuid;
    v_term    uuid;
    v_doc     uuid;
    v_state   text;
    v_msg     text;
BEGIN
    SELECT id INTO v_subject FROM wb_test_ids WHERE name = 'subject_math';
    SELECT id INTO v_term    FROM wb_test_ids WHERE name = 'term_a';
    SELECT id INTO v_doc     FROM wb_test_ids WHERE name = 'doc_1';

    v_state := ''; v_msg := '';
    BEGIN
        DELETE FROM subjects WHERE id = v_subject;
    EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE; v_msg := SQLERRM;
    END;
    IF v_state = '' THEN RAISE EXCEPTION 'FAIL N13.1 : 删除仍被 Documents 引用的 Subject 竟然成功'; END IF;
    IF v_state NOT IN ('23503','23001') THEN RAISE EXCEPTION 'FAIL N13.1 : 期望 23503/23001，实得 %（%）', v_state, v_msg; END IF;

    v_state := ''; v_msg := '';
    BEGIN
        DELETE FROM terms WHERE id = v_term;
    EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE; v_msg := SQLERRM;
    END;
    IF v_state = '' THEN RAISE EXCEPTION 'FAIL N13.2 : 删除仍被 Documents 引用的 Term 竟然成功'; END IF;
    IF v_state NOT IN ('23503','23001') THEN RAISE EXCEPTION 'FAIL N13.2 : 期望 23503/23001，实得 %（%）', v_state, v_msg; END IF;

    v_state := ''; v_msg := '';
    BEGIN
        DELETE FROM documents WHERE id = v_doc;
    EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE; v_msg := SQLERRM;
    END;
    IF v_state = '' THEN RAISE EXCEPTION 'FAIL N13.3 : 删除仍有 Pages 的 Document 竟然成功'; END IF;
    IF v_state NOT IN ('23503','23001') THEN RAISE EXCEPTION 'FAIL N13.3 : 期望 23503/23001，实得 %（%）', v_state, v_msg; END IF;

    IF NOT EXISTS (SELECT 1 FROM documents WHERE id = v_doc)
       OR NOT EXISTS (SELECT 1 FROM pages WHERE document_id = v_doc)
       OR NOT EXISTS (SELECT 1 FROM subjects WHERE id = v_subject)
       OR NOT EXISTS (SELECT 1 FROM terms WHERE id = v_term) THEN
        RAISE EXCEPTION 'FAIL N13 : 被拒的删除操作竟然删掉了行';
    END IF;

    RAISE NOTICE 'PASS N13 : 科目/学期/资料的删除均被 ON DELETE RESTRICT 拒绝（23001/23503），子行仍在';
END $$;

-- ---------------------------------------------------------------------
-- N14. ON DELETE RESTRICT：仍有 Capture 的 Page
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_page_2 uuid;
    v_state  text := '';
    v_msg    text := '';
BEGIN
    SELECT id INTO v_page_2 FROM wb_test_ids WHERE name = 'page_2';

    BEGIN
        DELETE FROM pages WHERE id = v_page_2;
    EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE; v_msg := SQLERRM;
    END;

    IF v_state = '' THEN
        RAISE EXCEPTION 'FAIL N14 : 删除仍有 Capture 的 Page 竟然成功（不得级联删除证据）';
    ELSIF v_state NOT IN ('23503','23001') THEN
        RAISE EXCEPTION 'FAIL N14 : 期望 23503/23001，实得 %（%）', v_state, v_msg;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM captures WHERE page_id = v_page_2) THEN
        RAISE EXCEPTION 'FAIL N14 : 被拒的删除竟然连带删掉了 Capture';
    END IF;

    RAISE NOTICE 'PASS N14 : 仍有 Capture 的 Page 删除被拒（23001/23503），Capture 保留';
END $$;

-- ---------------------------------------------------------------------
-- N15. ON DELETE RESTRICT：仍有派生 Asset 的 Capture（不做级联删除）
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_cap   uuid;
    v_asset integer;
    v_state text := '';
    v_msg   text := '';
BEGIN
    SELECT id INTO v_cap FROM wb_test_ids WHERE name = 'cap_1';
    SELECT count(*) INTO v_asset FROM image_assets WHERE capture_id = v_cap;

    BEGIN
        DELETE FROM captures WHERE id = v_cap;
    EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE; v_msg := SQLERRM;
    END;

    IF v_state = '' THEN
        RAISE EXCEPTION 'FAIL N15 : 删除仍被派生 Asset / Transform 引用的 Capture 竟然成功';
    ELSIF v_state NOT IN ('23503','23001') THEN
        RAISE EXCEPTION 'FAIL N15 : 期望 23503/23001，实得 %（%）', v_state, v_msg;
    END IF;

    IF (SELECT count(*) FROM image_assets WHERE capture_id = v_cap) <> v_asset THEN
        RAISE EXCEPTION 'FAIL N15 : 被拒的删除改变了派生 Asset 行数';
    END IF;

    RAISE NOTICE 'PASS N15 : 有派生 Asset 的 Capture 删除被拒（23001/23503），资产行数不变（%）', v_asset;
END $$;

-- ---------------------------------------------------------------------
-- N16. ON DELETE RESTRICT：仍有 Asset 的 Transform
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_tr    uuid;
    v_state text := '';
    v_msg   text := '';
BEGIN
    SELECT id INTO v_tr FROM wb_test_ids WHERE name = 'tr_1';

    BEGIN
        DELETE FROM page_transforms WHERE id = v_tr;
    EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE; v_msg := SQLERRM;
    END;

    IF v_state = '' THEN
        RAISE EXCEPTION 'FAIL N16 : 删除仍有 Asset 的 Transform 竟然成功';
    ELSIF v_state NOT IN ('23503','23001') THEN
        RAISE EXCEPTION 'FAIL N16 : 期望 23503/23001，实得 %（%）', v_state, v_msg;
    END IF;

    RAISE NOTICE 'PASS N16 : 仍有 Asset 的 Transform 删除被拒（23001/23503）';
END $$;

-- ---------------------------------------------------------------------
-- N17/N18. Asset 的 capture 与 transform 来源/版本必须一致（复合外键）
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_cap_1 uuid;
    v_cap_2 uuid;
    v_tr_1  uuid;
    v_state text;
    v_msg   text;
BEGIN
    SELECT id INTO v_cap_1 FROM wb_test_ids WHERE name = 'cap_1';
    SELECT id INTO v_cap_2 FROM wb_test_ids WHERE name = 'cap_2';
    SELECT id INTO v_tr_1  FROM wb_test_ids WHERE name = 'tr_1';

    -- capture 与 transform 的来源不一致
    v_state := ''; v_msg := '';
    BEGIN
        INSERT INTO image_assets (capture_id, transform_id, kind, status, version)
        VALUES (v_cap_2, v_tr_1, 'thumbnail', 'generating', 1);
    EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE; v_msg := SQLERRM;
    END;
    IF v_state = '' THEN RAISE EXCEPTION 'FAIL N17 : capture_id 与 transform 来源不一致的 Asset 竟然被接受'; END IF;
    IF v_state <> '23503' THEN RAISE EXCEPTION 'FAIL N17 : 期望 23503，实得 %（%）', v_state, v_msg; END IF;

    -- version 与 transform 版本不一致
    v_state := ''; v_msg := '';
    BEGIN
        INSERT INTO image_assets (capture_id, transform_id, kind, status, version)
        VALUES (v_cap_1, v_tr_1, 'thumbnail', 'generating', 2);
    EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE; v_msg := SQLERRM;
    END;
    IF v_state = '' THEN RAISE EXCEPTION 'FAIL N18 : version 与 transform 不一致的 Asset 竟然被接受'; END IF;
    IF v_state <> '23503' THEN RAISE EXCEPTION 'FAIL N18 : 期望 23503，实得 %（%）', v_state, v_msg; END IF;

    RAISE NOTICE 'PASS N17/N18 : Asset 的来源 Capture 不一致、版本不一致均被 fk_image_assets_transform_id 拒绝（23503）';
END $$;

-- ---------------------------------------------------------------------
-- N19. 同一 Transform 的同一 kind 只能有一个 Asset
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_cap_1 uuid;
    v_tr_1  uuid;
    v_state text := '';
    v_msg   text := '';
BEGIN
    SELECT id INTO v_cap_1 FROM wb_test_ids WHERE name = 'cap_1';
    SELECT id INTO v_tr_1  FROM wb_test_ids WHERE name = 'tr_1';

    BEGIN
        INSERT INTO image_assets (capture_id, transform_id, kind, status, storage_path,
                                  media_type, byte_size, width, height, sha256, version)
        VALUES (v_cap_1, v_tr_1, 'standardized', 'ready',
                'standardized/' || md5('asset-dup') || '.jpg', 'image/jpeg', 4096, 800, 600,
                decode(md5('asset-dup') || md5('asset-dupb'), 'hex'), 1);
    EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE; v_msg := SQLERRM;
    END;

    IF v_state = '' THEN
        RAISE EXCEPTION 'FAIL N19 : 同一 transform + kind 的第二个 standardized Asset 竟然被接受';
    ELSIF v_state <> '23505' THEN
        RAISE EXCEPTION 'FAIL N19 : 期望 23505，实得 %（%）', v_state, v_msg;
    END IF;

    RAISE NOTICE 'PASS N19 : 同一 transform 同一 kind 的重复 Asset 被 uq_image_assets_transform_id_kind 拒绝（23505）';
END $$;

-- ---------------------------------------------------------------------
-- F05. 同一 Transform 的另一 kind（thumbnail）可以共存
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_cap_1 uuid;
    v_tr_1  uuid;
    v_asset uuid;
BEGIN
    SELECT id INTO v_cap_1 FROM wb_test_ids WHERE name = 'cap_1';
    SELECT id INTO v_tr_1  FROM wb_test_ids WHERE name = 'tr_1';

    INSERT INTO image_assets (capture_id, transform_id, kind, status, storage_path,
                              media_type, byte_size, width, height, sha256, version)
    VALUES (v_cap_1, v_tr_1, 'thumbnail', 'ready',
            'thumbnails/' || md5('thumb-1') || '.jpg', 'image/jpeg', 1024, 320, 240,
            decode(md5('thumb-1') || md5('thumb-1b'), 'hex'), 1)
    RETURNING id INTO v_asset;

    IF v_asset IS NULL THEN
        RAISE EXCEPTION 'FAIL F05 : thumbnail Asset 未创建';
    END IF;

    RAISE NOTICE 'PASS F05 : 同一 transform 的 thumbnail 与大图可共存';
END $$;

-- ---------------------------------------------------------------------
-- N20. 同一 Page 的 version 必须唯一
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_page_1 uuid;
    v_cap_1  uuid;
    v_state  text := '';
    v_msg    text := '';
BEGIN
    SELECT id INTO v_page_1 FROM wb_test_ids WHERE name = 'page_1';
    SELECT id INTO v_cap_1  FROM wb_test_ids WHERE name = 'cap_1';

    BEGIN
        INSERT INTO page_transforms (page_id, source_capture_id, version, operations_json)
        VALUES (v_page_1, v_cap_1, 1, '{}'::jsonb);
    EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE; v_msg := SQLERRM;
    END;

    IF v_state = '' THEN
        RAISE EXCEPTION 'FAIL N20 : 同一 Page 重复 version 竟然被接受';
    ELSIF v_state <> '23505' THEN
        RAISE EXCEPTION 'FAIL N20 : 期望 23505，实得 %（%）', v_state, v_msg;
    END IF;

    RAISE NOTICE 'PASS N20 : 同一 Page 重复 version 被 uq_page_transforms_page_id_version 拒绝（23505）';
END $$;

-- ---------------------------------------------------------------------
-- N21. 变换的来源 Capture 必须属于同一 Page
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_page_1 uuid;
    v_cap_3  uuid;
    v_state  text := '';
    v_msg    text := '';
BEGIN
    SELECT id INTO v_page_1 FROM wb_test_ids WHERE name = 'page_1';
    SELECT id INTO v_cap_3  FROM wb_test_ids WHERE name = 'cap_3';

    BEGIN
        INSERT INTO page_transforms (page_id, source_capture_id, version, operations_json)
        VALUES (v_page_1, v_cap_3, 999, '{}'::jsonb);
    EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE; v_msg := SQLERRM;
    END;

    IF v_state = '' THEN
        RAISE EXCEPTION 'FAIL N21 : 用其他 Page 的 Capture 建立变换竟然被接受';
    ELSIF v_state <> '23503' THEN
        RAISE EXCEPTION 'FAIL N21 : 期望 23503，实得 %（%）', v_state, v_msg;
    END IF;

    RAISE NOTICE 'PASS N21 : 跨 Page 的变换来源被 fk_page_transforms_source_capture_id 拒绝（23503）';
END $$;

-- ---------------------------------------------------------------------
-- N22/N23 + F06. Capture 状态机
--     reserved→copied→registered 通过；registered 回退被拒；同状态更新允许
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_cap_2 uuid;
    v_state text;
    v_msg   text;
BEGIN
    SELECT id INTO v_cap_2 FROM wb_test_ids WHERE name = 'cap_2';

    UPDATE captures SET status = 'copied' WHERE id = v_cap_2 AND status = 'reserved';

    UPDATE captures
       SET status = 'registered', media_type = 'image/jpeg',
           byte_size = 1536, width = 1200, height = 1600
     WHERE id = v_cap_2 AND status = 'copied';

    IF (SELECT status FROM captures WHERE id = v_cap_2) <> 'registered' THEN
        RAISE EXCEPTION 'FAIL N22 : reserved→copied→registered 未能推进';
    END IF;

    v_state := ''; v_msg := '';
    BEGIN
        UPDATE captures SET status = 'copied' WHERE id = v_cap_2;
    EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE; v_msg := SQLERRM;
    END;
    IF v_state = '' THEN RAISE EXCEPTION 'FAIL N22 : registered→copied 竟然被接受'; END IF;
    IF v_state <> 'P0001' THEN RAISE EXCEPTION 'FAIL N22 : 期望 P0001（raise_exception），实得 %（%）', v_state, v_msg; END IF;

    v_state := ''; v_msg := '';
    BEGIN
        UPDATE captures SET status = 'reserved' WHERE id = v_cap_2;
    EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE; v_msg := SQLERRM;
    END;
    IF v_state = '' THEN RAISE EXCEPTION 'FAIL N23 : registered→reserved 竟然被接受'; END IF;
    IF v_state <> 'P0001' THEN RAISE EXCEPTION 'FAIL N23 : 期望 P0001，实得 %（%）', v_state, v_msg; END IF;

    -- 同状态更新（补 last_error）不应被状态机误拒
    UPDATE captures SET last_error = '测试：同状态更新允许' WHERE id = v_cap_2;
    IF (SELECT status FROM captures WHERE id = v_cap_2) <> 'registered' THEN
        RAISE EXCEPTION 'FAIL F06 : 同状态更新改变了状态';
    END IF;

    RAISE NOTICE 'PASS N22/N23/F06 : 正向推进与同状态更新通过；registered 回退被拒（P0001）';
END $$;

-- ---------------------------------------------------------------------
-- F07. reserved→registered 的恢复路径（已核验文件后合并推进）
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_cap_5 uuid;
BEGIN
    SELECT id INTO v_cap_5 FROM wb_test_ids WHERE name = 'cap_5';

    UPDATE captures
       SET status = 'registered', media_type = 'image/jpeg',
           byte_size = 777, width = 640, height = 480
     WHERE id = v_cap_5 AND status = 'reserved';

    IF (SELECT status FROM captures WHERE id = v_cap_5) <> 'registered' THEN
        RAISE EXCEPTION 'FAIL F07 : reserved→registered 未被允许';
    END IF;

    RAISE NOTICE 'PASS F07 : reserved→registered 恢复路径可用（文件已核验时合并推进）';
END $$;

-- ---------------------------------------------------------------------
-- N24. pending Page 没有 ready 标准化图时不得标记 organized
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_page_2 uuid;
    v_cap_3  uuid;
    v_state  text := '';
    v_msg    text := '';
BEGIN
    SELECT id INTO v_page_2 FROM wb_test_ids WHERE name = 'page_2';
    SELECT id INTO v_cap_3  FROM wb_test_ids WHERE name = 'cap_3';

    UPDATE pages SET preferred_capture_id = v_cap_3 WHERE id = v_page_2;

    BEGIN
        UPDATE pages SET status = 'organized' WHERE id = v_page_2;
    EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE; v_msg := SQLERRM;
    END;

    IF v_state = '' THEN
        RAISE EXCEPTION 'FAIL N24 : 没有 ready standardized Asset 的 Page 竟然可以标记 organized';
    ELSIF v_state <> 'P0001' THEN
        RAISE EXCEPTION 'FAIL N24 : 期望 P0001，实得 %（%）', v_state, v_msg;
    END IF;

    IF (SELECT status FROM pages WHERE id = v_page_2) <> 'pending' THEN
        RAISE EXCEPTION 'FAIL N24 : 被拒的更新改变了 status';
    END IF;

    RAISE NOTICE 'PASS N24 : 无 ready 标准化图的 Page 标记 organized 被 trig_pages_status_transition 拒绝（P0001）';
END $$;

-- ---------------------------------------------------------------------
-- N25. INSERT 直接以 organized 建页也应被拒
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_doc_1 uuid;
    v_state text := '';
    v_msg   text := '';
BEGIN
    SELECT id INTO v_doc_1 FROM wb_test_ids WHERE name = 'doc_1';

    BEGIN
        INSERT INTO pages (document_id, page_number, status)
        VALUES (v_doc_1, 77, 'organized');
    EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE; v_msg := SQLERRM;
    END;

    IF v_state = '' THEN
        RAISE EXCEPTION 'FAIL N25 : 直接以 organized 插入 Page 竟然成功';
    ELSIF v_state <> 'P0001' THEN
        RAISE EXCEPTION 'FAIL N25 : 期望 P0001，实得 %（%）', v_state, v_msg;
    END IF;

    RAISE NOTICE 'PASS N25 : INSERT 直接以 organized 建页被拒（P0001）';
END $$;

-- ---------------------------------------------------------------------
-- F08. 有 ready 标准化图后可 organized；
--      组织态下切到无成果的首选被拒；同一 UPDATE 改为 pending 则成功且不删 Capture
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_page_1 uuid;
    v_cap_1  uuid;
    v_cap_2  uuid;
    v_before integer;
    v_after  integer;
    v_state  text := '';
    v_msg    text := '';
BEGIN
    SELECT id INTO v_page_1 FROM wb_test_ids WHERE name = 'page_1';
    SELECT id INTO v_cap_1  FROM wb_test_ids WHERE name = 'cap_1';
    SELECT id INTO v_cap_2  FROM wb_test_ids WHERE name = 'cap_2';

    UPDATE pages SET preferred_capture_id = v_cap_1 WHERE id = v_page_1;
    UPDATE pages SET status = 'organized' WHERE id = v_page_1;

    IF (SELECT status FROM pages WHERE id = v_page_1) <> 'organized' THEN
        RAISE EXCEPTION 'FAIL F08 : 有 ready 标准化图的 Page 未能标记 organized';
    END IF;

    SELECT count(*) INTO v_before FROM captures WHERE page_id = v_page_1;

    BEGIN
        UPDATE pages SET preferred_capture_id = v_cap_2 WHERE id = v_page_1;
    EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE; v_msg := SQLERRM;
    END;
    IF v_state = '' THEN
        RAISE EXCEPTION 'FAIL F08 : 组织态下切到没有 ready 标准化图的首选竟然被接受';
    ELSIF v_state <> 'P0001' THEN
        RAISE EXCEPTION 'FAIL F08 : 期望 P0001，实得 %（%）', v_state, v_msg;
    END IF;

    UPDATE pages SET status = 'pending', preferred_capture_id = v_cap_2 WHERE id = v_page_1;

    IF (SELECT status FROM pages WHERE id = v_page_1) <> 'pending' THEN
        RAISE EXCEPTION 'FAIL F08 : organized→pending 未能完成';
    END IF;
    IF (SELECT preferred_capture_id FROM pages WHERE id = v_page_1) <> v_cap_2 THEN
        RAISE EXCEPTION 'FAIL F08 : 首选 Capture 未切换到 cap_2';
    END IF;

    SELECT count(*) INTO v_after FROM captures WHERE page_id = v_page_1;
    IF v_after <> v_before THEN
        RAISE EXCEPTION 'FAIL F08 : 切换首选/回退状态后 Capture 行数由 % 变为 %', v_before, v_after;
    END IF;

    RAISE NOTICE 'PASS F08 : organized 需 ready 标准化图；组织态切首选被拒；改 pending 后切换成功且 Capture 未减少';
END $$;

-- ---------------------------------------------------------------------
-- N26/N27 + F09/F10. Asset 状态机
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_cap_1 uuid;
    v_tr    uuid;
    v_asset uuid;
    v_state text;
    v_msg   text;
BEGIN
    SELECT id INTO v_cap_1 FROM wb_test_ids WHERE name = 'cap_1';
    SELECT id INTO v_tr    FROM wb_test_ids WHERE name = 'tr_1';
    SELECT id INTO v_asset FROM image_assets WHERE transform_id = v_tr AND kind = 'standardized';

    -- ready 是终态：ready→failed 必须被拒
    v_state := ''; v_msg := '';
    BEGIN
        UPDATE image_assets SET status = 'failed' WHERE id = v_asset;
    EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE; v_msg := SQLERRM;
    END;
    IF v_state = '' THEN RAISE EXCEPTION 'FAIL N26 : ready→failed 竟然被接受'; END IF;
    IF v_state <> 'P0001' THEN RAISE EXCEPTION 'FAIL N26 : 期望 P0001，实得 %（%）', v_state, v_msg; END IF;

    -- ready→generating 必须被拒（重做应新增 transform 版本）
    v_state := ''; v_msg := '';
    BEGIN
        UPDATE image_assets SET status = 'generating' WHERE id = v_asset;
    EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE; v_msg := SQLERRM;
    END;
    IF v_state = '' THEN RAISE EXCEPTION 'FAIL N27 : ready→generating 竟然被接受'; END IF;
    IF v_state <> 'P0001' THEN RAISE EXCEPTION 'FAIL N27 : 期望 P0001，实得 %（%）', v_state, v_msg; END IF;

    -- 新的生成任务：generating→failed→generating→ready（来源与版本必须与 tr_106 一致）
    SELECT id INTO v_tr FROM wb_test_ids WHERE name = 'tr_106';

    INSERT INTO image_assets (capture_id, transform_id, kind, status, version)
    VALUES (v_cap_1, v_tr, 'standardized', 'generating', 106)
    RETURNING id INTO v_asset;

    UPDATE image_assets SET status = 'failed', last_error = '测试：生成失败' WHERE id = v_asset;
    UPDATE image_assets SET status = 'generating', last_error = NULL WHERE id = v_asset;
    UPDATE image_assets
       SET status = 'ready', storage_path = 'standardized/' || md5('asset-2') || '.jpg',
           media_type = 'image/jpeg', byte_size = 2048, width = 800, height = 600,
           sha256 = decode(md5('asset-2') || md5('asset-2b'), 'hex')
     WHERE id = v_asset;

    IF (SELECT status FROM image_assets WHERE id = v_asset) <> 'ready' THEN
        RAISE EXCEPTION 'FAIL F10 : generating→failed→generating→ready 未能完成';
    END IF;

    RAISE NOTICE 'PASS N26/N27/F09/F10 : ready 终态不可回退；generating→failed→generating→ready 成功';
END $$;

-- ---------------------------------------------------------------------
-- M01. 合并场景：两张拍摄在单事务内重挂到目标 Page，旧 Page 才可删除
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_page_1 uuid;
    v_page_3 uuid;
    v_cap_6  uuid;
    v_cap_7  uuid;
    v_cnt    integer;
BEGIN
    SELECT id INTO v_page_1 FROM wb_test_ids WHERE name = 'page_1';
    SELECT id INTO v_page_3 FROM wb_test_ids WHERE name = 'page_3';
    SELECT id INTO v_cap_6  FROM wb_test_ids WHERE name = 'cap_6';
    SELECT id INTO v_cap_7  FROM wb_test_ids WHERE name = 'cap_7';

    UPDATE captures SET page_id = v_page_1 WHERE id IN (v_cap_6, v_cap_7);

    SELECT count(*) INTO v_cnt
      FROM captures
     WHERE id IN (v_cap_6, v_cap_7) AND page_id = v_page_1;
    IF v_cnt <> 2 THEN
        RAISE EXCEPTION 'FAIL M01 : 重挂后目标 Page 下只有 % 张拍摄（应为 2）', v_cnt;
    END IF;

    DELETE FROM pages WHERE id = v_page_3;

    IF EXISTS (SELECT 1 FROM pages WHERE id = v_page_3) THEN
        RAISE EXCEPTION 'FAIL M01 : 已无 Capture/Transform 的旧 Page 未能删除';
    END IF;

    RAISE NOTICE 'PASS M01 : 两张拍摄在单事务内重挂成功（% 行），空旧 Page 随后可删', v_cnt;
END $$;

-- ---------------------------------------------------------------------
-- T01. documents.updated_at 由触发器维护，created_at 不被改写
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_doc_1   uuid;
    v_created timestamptz;
BEGIN
    SELECT id INTO v_doc_1 FROM wb_test_ids WHERE name = 'doc_1';

    UPDATE documents SET updated_at = '2000-01-01 00:00:00+00' WHERE id = v_doc_1;
    IF (SELECT updated_at FROM documents WHERE id = v_doc_1) <= '2000-01-02 00:00:00+00'::timestamptz THEN
        RAISE EXCEPTION 'FAIL T01 : 显式写入旧 updated_at 未被触发器覆盖';
    END IF;

    SELECT created_at INTO v_created FROM documents WHERE id = v_doc_1;

    UPDATE documents SET title = '测试资料A（改标题）' WHERE id = v_doc_1;
    UPDATE documents SET updated_at = '2001-01-01 00:00:00+00' WHERE id = v_doc_1;

    IF (SELECT updated_at FROM documents WHERE id = v_doc_1) <= '2001-01-02 00:00:00+00'::timestamptz THEN
        RAISE EXCEPTION 'FAIL T01 : 业务列更新后 updated_at 未刷新';
    END IF;
    IF (SELECT created_at FROM documents WHERE id = v_doc_1) <> v_created THEN
        RAISE EXCEPTION 'FAIL T01 : 更新改写了 created_at';
    END IF;

    RAISE NOTICE 'PASS T01 : updated_at 始终被触发器覆盖为 now()，created_at 保持不变';
END $$;

-- ---------------------------------------------------------------------
-- T02. pages / captures / image_assets 的 updated_at 同样由触发器维护
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_page_1 uuid;
    v_cap_1  uuid;
    v_asset  uuid;
BEGIN
    SELECT id INTO v_page_1 FROM wb_test_ids WHERE name = 'page_1';
    SELECT id INTO v_cap_1  FROM wb_test_ids WHERE name = 'cap_1';
    SELECT id INTO v_asset  FROM image_assets WHERE capture_id = v_cap_1 AND kind = 'standardized' LIMIT 1;

    UPDATE pages SET updated_at = '2000-01-01 00:00:00+00' WHERE id = v_page_1;
    IF (SELECT updated_at FROM pages WHERE id = v_page_1) <= '2000-01-02 00:00:00+00'::timestamptz THEN
        RAISE EXCEPTION 'FAIL T02 : pages.updated_at 未由触发器刷新';
    END IF;

    UPDATE captures SET updated_at = '2000-01-01 00:00:00+00' WHERE id = v_cap_1;
    IF (SELECT updated_at FROM captures WHERE id = v_cap_1) <= '2000-01-02 00:00:00+00'::timestamptz THEN
        RAISE EXCEPTION 'FAIL T02 : captures.updated_at 未由触发器刷新';
    END IF;

    UPDATE image_assets SET updated_at = '2000-01-01 00:00:00+00' WHERE id = v_asset;
    IF (SELECT updated_at FROM image_assets WHERE id = v_asset) <= '2000-01-02 00:00:00+00'::timestamptz THEN
        RAISE EXCEPTION 'FAIL T02 : image_assets.updated_at 未由触发器刷新';
    END IF;

    RAISE NOTICE 'PASS T02 : pages / captures / image_assets 的 updated_at 均由触发器维护';
END $$;

-- ---------------------------------------------------------------------
-- T03. 中断恢复五类样本可被同一查询唯一分类（DESIGN 10.5）
--      s1 仅预留 / s2 仅复制成功 / s3 已登记未归组 / s4 页面已建立 / s5 标准化已完成
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_doc     uuid;
    v_page_p  uuid;
    v_page_o  uuid;
    v_cap_s1  uuid;
    v_cap_s2  uuid;
    v_cap_s3  uuid;
    v_cap_s4  uuid;
    v_cap_s5  uuid;
    v_tr      uuid;
    v_cap     uuid;
    v_labels  text;
    v_name    text;
    v_expect  text;
    v_bad     integer := 0;
BEGIN
    SELECT id INTO v_doc FROM wb_test_ids WHERE name = 'doc_1';

    INSERT INTO pages (document_id, page_number) VALUES (v_doc, 201) RETURNING id INTO v_page_p;
    INSERT INTO pages (document_id, page_number) VALUES (v_doc, 202) RETURNING id INTO v_page_o;

    INSERT INTO captures (sha256, original_path, original_filename, status)
    VALUES (decode(md5('s1') || md5('s1b'), 'hex'), '数学/一年级上/s1.jpg', 'S1.JPG', 'reserved')
    RETURNING id INTO v_cap_s1;

    INSERT INTO captures (sha256, original_path, original_filename, status)
    VALUES (decode(md5('s2') || md5('s2b'), 'hex'), '数学/一年级上/s2.jpg', 'S2.JPG', 'copied')
    RETURNING id INTO v_cap_s2;

    INSERT INTO captures (sha256, original_path, original_filename,
                          media_type, byte_size, width, height, status)
    VALUES (decode(md5('s3') || md5('s3b'), 'hex'), '数学/一年级上/s3.jpg', 'S3.JPG',
            'image/jpeg', 10, 10, 10, 'registered')
    RETURNING id INTO v_cap_s3;

    INSERT INTO captures (page_id, sha256, original_path, original_filename,
                          media_type, byte_size, width, height, status)
    VALUES (v_page_p, decode(md5('s4') || md5('s4b'), 'hex'), '数学/一年级上/s4.jpg', 'S4.JPG',
            'image/jpeg', 10, 10, 10, 'registered')
    RETURNING id INTO v_cap_s4;

    INSERT INTO captures (page_id, sha256, original_path, original_filename,
                          media_type, byte_size, width, height, status)
    VALUES (v_page_o, decode(md5('s5') || md5('s5b'), 'hex'), '数学/一年级上/s5.jpg', 'S5.JPG',
            'image/jpeg', 10, 10, 10, 'registered')
    RETURNING id INTO v_cap_s5;

    INSERT INTO page_transforms (page_id, source_capture_id, version, operations_json)
    VALUES (v_page_o, v_cap_s5, 1, '{}'::jsonb) RETURNING id INTO v_tr;

    INSERT INTO image_assets (capture_id, transform_id, kind, status, storage_path,
                              media_type, byte_size, width, height, sha256, version)
    VALUES (v_cap_s5, v_tr, 'standardized', 'ready',
            'standardized/' || md5('asset-s5') || '.jpg', 'image/jpeg', 10, 10, 10,
            decode(md5('asset-s5') || md5('asset-s5b'), 'hex'), 1);

    UPDATE pages SET preferred_capture_id = v_cap_s5 WHERE id = v_page_o;
    UPDATE pages SET status = 'organized' WHERE id = v_page_o;

    FOR v_name, v_expect IN
        SELECT t.nm, t.expect_label
          FROM (VALUES
                  ('s1', 'reserved'),
                  ('s2', 'copied'),
                  ('s3', 'registered-unassigned'),
                  ('s4', 'page-pending'),
                  ('s5', 'organized')
               ) AS t (nm, expect_label)
    LOOP
        IF v_name = 's1' THEN v_cap := v_cap_s1;
        ELSIF v_name = 's2' THEN v_cap := v_cap_s2;
        ELSIF v_name = 's3' THEN v_cap := v_cap_s3;
        ELSIF v_name = 's4' THEN v_cap := v_cap_s4;
        ELSE v_cap := v_cap_s5;
        END IF;

        SELECT string_agg(v.lbl, '+' ORDER BY v.lbl)
          INTO v_labels
          FROM captures c
          LEFT JOIN pages p ON p.id = c.page_id
          CROSS JOIN LATERAL (VALUES
              ('reserved',              c.status = 'reserved'),
              ('copied',                c.status = 'copied'),
              ('registered-unassigned', c.status = 'registered' AND c.page_id IS NULL),
              ('page-pending',          c.status = 'registered' AND c.page_id IS NOT NULL
                                        AND p.status = 'pending'
                                        AND NOT EXISTS (SELECT 1 FROM image_assets a
                                                         WHERE a.capture_id = c.id
                                                           AND a.kind = 'standardized'
                                                           AND a.status = 'ready')),
              ('organized',             c.status = 'registered' AND c.page_id IS NOT NULL
                                        AND p.status = 'organized'
                                        AND EXISTS (SELECT 1 FROM image_assets a
                                                     WHERE a.capture_id = c.id
                                                       AND a.kind = 'standardized'
                                                       AND a.status = 'ready'))
          ) AS v (lbl, ok)
         WHERE c.id = v_cap AND v.ok;

        IF v_labels IS DISTINCT FROM v_expect THEN
            v_bad := v_bad + 1;
            RAISE WARNING 'T03 分类不符：样本 % 期望 %，实得 %', v_name, v_expect, coalesce(v_labels, '<无匹配>');
        END IF;
    END LOOP;

    IF v_bad > 0 THEN
        RAISE EXCEPTION 'FAIL T03 : 有 % 个恢复样本无法被唯一分类为预期状态（见上方 WARNING）', v_bad;
    END IF;

    RAISE NOTICE 'PASS T03 : 五类恢复样本各自被唯一分类为 reserved / copied / registered-unassigned / page-pending / organized';
END $$;

-- ---------------------------------------------------------------------
-- 结束：回滚全部测试数据，只保留先前已提交的结构与种子
-- ---------------------------------------------------------------------
ROLLBACK;

SELECT 'TEST SCRIPT COMPLETED' AS result;
