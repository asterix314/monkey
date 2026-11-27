#!/usr/bin/env bash
# 回归检查：触发器函数必须冻结 search_path，否则业务连接用默认 search_path 会炸。
# 用法: tests/check_trigger_search_path.sh [schema名]
set -uo pipefail
SCHEMA="${1:-wb_sp_check}"
DB="${WB_DB:-wrongbook}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

psql -X -q -d "$DB" -c "DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;" -c "CREATE SCHEMA ${SCHEMA};" >/dev/null 2>&1 || {
  echo "❌ 无法建 schema ${SCHEMA}"; exit 1; }

PGOPTIONS="-c search_path=${SCHEMA},public" psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/sql/001_schema_v1.sql" >/dev/null 2>&1 || {
  echo "❌ 001_schema_v1.sql 安装失败"; exit 1; }

# 所有触发器函数都必须有 proconfig 且含目标 schema
BAD=$(psql -X -At -d "$DB" -c "
select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='${SCHEMA}' and p.prorettype='trigger'::regtype
   and (p.proconfig is null or not exists (
        select 1 from unnest(p.proconfig) c where c like 'search_path=%${SCHEMA}%'));")
TOTAL=$(psql -X -At -d "$DB" -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='${SCHEMA}' and p.prorettype='trigger'::regtype;")

psql -X -q -d "$DB" -c "DROP SCHEMA ${SCHEMA} CASCADE;" >/dev/null 2>&1

if [ -n "$BAD" ]; then
  echo "❌ 以下触发器函数未冻结 search_path:"
  echo "$BAD"
  exit 1
fi
echo "✅ $TOTAL 个触发器函数全部冻结了 search_path，默认 search_path 下可用"
