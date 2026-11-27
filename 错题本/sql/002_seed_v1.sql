-- =====================================================================
-- 错题本 DSH 插件 / 数据库 wrongbook — v1 参考数据种子
-- 文件        : sql/002_seed_v1.sql
-- 目标版本    : v1（依赖 sql/001_schema_v1.sql 已执行）
-- 数据库依赖  : PostgreSQL 18+
-- 安装方式    : PGOPTIONS="-c search_path=<目标schema>" psql -v ON_ERROR_STOP=1 -f sql/002_seed_v1.sql
--               本文件不含 schema 管理语句、不含 schema 前缀、不设 search_path。
-- 幂等性      : 全部使用 ON CONFLICT (code) DO NOTHING，可重复执行；
--               重复执行后每个 code 仍只有一行，且不覆盖已有行的人工修改。
-- 设计对应    : DESIGN.md §9.1（科目字典）、§9.2（学期字典，目录名到显示名的显式映射）
-- 映射约定    : directory_name 用于 Windows 原件归档目录（Pictures/错题本照片/<科目>/<学期>/），
--               display_name 用于 UI；两者显式列出，禁止从显示名反推路径。
--               「一年级上」对应「一年级上学期」，「一年级下」对应「一年级下学期」。
-- 兜底项      : 科目 other / unclassified 与学期 unclassified 保证元数据不全时也能入库。
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. subjects — 科目字典
-- ---------------------------------------------------------------------
INSERT INTO subjects (code, display_name, directory_name, sort_order, enabled)
VALUES
    ('math',         '数学',   '数学',   10, true),
    ('chinese',      '语文',   '语文',   20, true),
    ('english',      '英语',   '英语',   30, true),
    ('other',        '其他',   '其他',   80, true),
    ('unclassified', '未分类', '未分类', 90, true)
ON CONFLICT (code) DO NOTHING;


-- ---------------------------------------------------------------------
-- 2. terms — 学期字典
--    grade/term_number 成对可空：unclassified 两者均为 NULL
-- ---------------------------------------------------------------------
INSERT INTO terms (code, grade, term_number, display_name, directory_name, sort_order)
VALUES
    ('g1t1',         1::smallint, 1::smallint, '一年级上学期', '一年级上', 10),
    ('g1t2',         1::smallint, 2::smallint, '一年级下学期', '一年级下', 20),
    ('unclassified', NULL,        NULL,        '未分类',       '未分类',   90)
ON CONFLICT (code) DO NOTHING;


-- =====================================================================
-- v1 种子结束（可重复执行）
-- =====================================================================
