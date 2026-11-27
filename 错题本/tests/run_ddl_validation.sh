#!/usr/bin/env bash
# 在 wrongbook 库的独立 schema 里执行 DDL + 种子 + 约束测试，跑完即回滚/清理。
# 用法: tests/run_ddl_validation.sh [schema名]
# 退出码: 0=全部通过  非0=失败（失败点会打印）
set -uo pipefail

SCHEMA="${1:-wb_ddl_v1}"
DB="${WB_DB:-wrongbook}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/tests/logs"
mkdir -p "$LOG_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$LOG_DIR/run-$TS.log"

# 所有语句都在这个 schema 下解析
export PGOPTIONS="-c search_path=${SCHEMA},public"

psql_() { psql -X -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

fail() {
  echo "" | tee -a "$OUT"
  echo "❌ FAILED: $*" | tee -a "$OUT"
  echo "   日志: $OUT" | tee -a "$OUT"
  exit 1
}

echo "== 0. 准备空 schema: $SCHEMA ==" | tee -a "$OUT"
psql -X -q -d "$DB" -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;" -c "CREATE SCHEMA ${SCHEMA};" >>"$OUT" 2>&1 \
  || fail "无法重建 schema ${SCHEMA}"

echo "== 1. 建表 001_schema_v1.sql ==" | tee -a "$OUT"
psql_ -f "$ROOT/sql/001_schema_v1.sql" >>"$OUT" 2>&1 || fail "001_schema_v1.sql 执行失败"

echo "== 2. 参考数据 002_seed_v1.sql ==" | tee -a "$OUT"
psql_ -f "$ROOT/sql/002_seed_v1.sql" >>"$OUT" 2>&1 || fail "002_seed_v1.sql 执行失败"

echo "== 2b. 种子幂等性（再跑一次必须不报错、不重复）==" | tee -a "$OUT"
BEFORE=$(psql -X -At -d "$DB" -c "select count(*) from ${SCHEMA}.subjects")
psql_ -f "$ROOT/sql/002_seed_v1.sql" >>"$OUT" 2>&1 || fail "002_seed_v1.sql 不可重复执行"
AFTER=$(psql -X -At -d "$DB" -c "select count(*) from ${SCHEMA}.subjects")
[ "$BEFORE" = "$AFTER" ] || fail "种子不幂等: subjects 行数 ${BEFORE} -> ${AFTER}"
echo "   subjects=${AFTER} 行，幂等 OK" | tee -a "$OUT"

echo "== 3. 约束测试 003_test_v1.sql ==" | tee -a "$OUT"
psql_ -f "$ROOT/sql/003_test_v1.sql" >>"$OUT" 2>&1 || fail "003_test_v1.sql 执行失败（某条约束未生效或 SQL 报错）"

echo "== 4. 对象清单 ==" | tee -a "$OUT"
psql -X -d "$DB" >>"$OUT" 2>&1 <<SQL
\echo '--- 表 ---'
select tablename, (select count(*) from pg_attribute a where a.attrelid=('${SCHEMA}."'||tablename||'"')::regclass and a.attnum>0 and not a.attisdropped) as cols
  from pg_tables where schemaname='${SCHEMA}' order by tablename;
\echo '--- 约束数 ---'
select contype, count(*) from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace
 where n.nspname='${SCHEMA}' group by contype order by contype;
\echo '--- 索引数 ---'
select count(*) from pg_indexes where schemaname='${SCHEMA}';
SQL
sed -n '/== 4/,$p' "$OUT" | tail -30 | tee -a /dev/null

echo "" | tee -a "$OUT"
echo "✅ ALL PASSED  (schema ${SCHEMA})" | tee -a "$OUT"
echo "   日志: $OUT" | tee -a "$OUT"
