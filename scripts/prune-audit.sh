#!/usr/bin/env bash
# 清理过期的审计记录（memory_audit 只增不删，久了要收）。
#
# 为什么单独一个脚本：
#   · delete_by_query 需要 delete 权限，而业务身份（mem_team_write / consolidator）对
#     **memory_audit** 故意没有 delete —— 审计是治理证据，能删就等于能篡改，所以这条清理
#     必须用 elastic 管理员身份，单独放在这里。
#     （team_knowledge 的 delete 已下放给 mem_team_write，那是给管理员人工清理走错的记忆用的，
#      与审计无关。）
#   · 默认 **dry-run**（只报会被删多少条），要真删得显式 --apply，和整理任务一个口径。
#
# 用法：
#   scripts/prune-audit.sh                 # dry-run，报告 90 天前的条数
#   scripts/prune-audit.sh --apply         # 真删
#   AUDIT_KEEP_DAYS=180 scripts/prune-audit.sh --apply
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ES_DIR="${ES_DIR:-$ROOT/deploy/es}"
CA="${CA:-$ES_DIR/certs/ca.crt}"
ENV_FILE="$ES_DIR/.env"
source "$(dirname "$0")/lib/curl-es.sh"
ES="${ES_URL:-https://127.0.0.1:9200}"
INDEX="${AUDIT_INDEX:-memory_audit}"
KEEP_DAYS="${AUDIT_KEEP_DAYS:-90}"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

[ -f "$ENV_FILE" ] || { echo "找不到 $ENV_FILE" >&2; exit 1; }
PASS=$(grep '^ELASTIC_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
[ -n "$PASS" ] || { echo "$ENV_FILE 缺 ELASTIC_PASSWORD" >&2; exit 1; }
admin() { es_curl "elastic:$PASS" --fail-with-body -H 'Content-Type: application/json' "$@"; }

QUERY="{\"query\":{\"range\":{\"at\":{\"lt\":\"now-${KEEP_DAYS}d\"}}}}"

echo "== 审计清理：保留 ${KEEP_DAYS} 天（索引 $INDEX）=="
COUNT=$(admin -X POST "$ES/$INDEX/_count" -d "$QUERY" | sed -n 's/.*"count":\([0-9]*\).*/\1/p')
echo "  过期条数：${COUNT:-?}"

if [ "${COUNT:-0}" = "0" ]; then
  echo '  没有需要清理的记录'
  exit 0
fi

if [ "$APPLY" != "1" ]; then
  echo '  dry-run：未删除（加 --apply 才真删）'
  exit 0
fi

RESULT=$(admin -X POST "$ES/$INDEX/_delete_by_query?refresh=true&conflicts=proceed" -d "$QUERY")
DELETED=$(printf '%s' "$RESULT" | sed -n 's/.*"deleted":\([0-9]*\).*/\1/p')
echo "  已删除：${DELETED:-0} 条"
