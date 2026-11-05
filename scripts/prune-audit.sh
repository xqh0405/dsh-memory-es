#!/usr/bin/env bash
# 清理过期的日志类索引（memory_audit 与 search_log_*）。
#
# 为什么单独一个脚本：
#   · delete_by_query 需要 delete 权限，而业务身份（mem_team_write / consolidator）对
#     **memory_audit** 故意没有 delete —— 审计是治理证据，能删就等于能篡改，所以这条清理
#     必须用 elastic 管理员身份，单独放在这里。
#     （team_knowledge 的 delete 已下放给 mem_team_write，那是给管理员人工清理走错的记忆用的，
#      与审计无关。）
#   · 默认 **dry-run**（只报会被删多少条），要真删得显式 --apply，和整理任务一个口径。
#
# 阶段 20 新增 `--search-log`：`search_log_<uid>` 一直在长（每次检索一行，含 query 原文），
# 但以前没有任何清理者（prune 只认 memory_audit）。**它存的是用户问过什么**，属于隐私面，
# 保留期必须显式存在。
#
# 用法：
#   scripts/prune-audit.sh                      # dry-run，报告 memory_audit 里 90 天前的条数
#   scripts/prune-audit.sh --apply              # 真删审计
#   scripts/prune-audit.sh --search-log         # dry-run，同时报告 search_log_* 的过期条数
#   scripts/prune-audit.sh --search-log --apply # 两边都真删
#   AUDIT_KEEP_DAYS=180 SEARCH_LOG_KEEP_DAYS=90 scripts/prune-audit.sh --search-log --apply
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ES_DIR="${ES_DIR:-$ROOT/deploy/es}"
# ES_CA 是「ES 在别的机器」时的逃生口（memory-cron.sh 的 apply_es_target 会导出它）
CA="${CA:-${ES_CA:-$ES_DIR/certs/ca.crt}}"
ENV_FILE="$ES_DIR/.env"
source "$(dirname "$0")/lib/curl-es.sh"
ES="${ES_URL:-https://127.0.0.1:9200}"
INDEX="${AUDIT_INDEX:-memory_audit}"
KEEP_DAYS="${AUDIT_KEEP_DAYS:-90}"
SEARCH_LOG_PREFIX="${SEARCH_LOG_PREFIX:-search_log_}"
SEARCH_LOG_KEEP_DAYS="${SEARCH_LOG_KEEP_DAYS:-90}"

APPLY=0
WITH_SEARCH_LOG=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --search-log) WITH_SEARCH_LOG=1 ;;
    *) echo "未知参数：$arg（只支持 --apply / --search-log）" >&2; exit 2 ;;
  esac
done

[ -f "$ENV_FILE" ] || { echo "找不到 $ENV_FILE" >&2; exit 1; }
PASS=$(grep '^ELASTIC_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
[ -n "$PASS" ] || { echo "$ENV_FILE 缺 ELASTIC_PASSWORD" >&2; exit 1; }
admin() { es_curl "elastic:$PASS" --fail-with-body -H 'Content-Type: application/json' "$@"; }

# 单个索引的清理：先数、再（可选）删。时间字段对两种索引都叫 `at`。
# 参数：$1=索引名  $2=保留天数  $3=展示名（默认同索引名）
prune_index() {
  local index="$1" days="$2" label="${3:-$1}"
  local query="{\"query\":{\"range\":{\"at\":{\"lt\":\"now-${days}d\"}}}}"
  echo "== ${label}：保留 ${days} 天（索引 $index）=="

  local count
  count=$(admin -X POST "$ES/$index/_count" -d "$query" | sed -n 's/.*"count":\([0-9]*\).*/\1/p')
  echo "  过期条数：${count:-?}"
  if [ "${count:-0}" = "0" ]; then
    echo '  没有需要清理的记录'
    return 0
  fi
  if [ "$APPLY" != "1" ]; then
    echo '  dry-run：未删除（加 --apply 才真删）'
    return 0
  fi

  local result deleted
  result=$(admin -X POST "$ES/$index/_delete_by_query?refresh=true&conflicts=proceed" -d "$query")
  deleted=$(printf '%s' "$result" | sed -n 's/.*"deleted":\([0-9]*\).*/\1/p')
  echo "  已删除：${deleted:-0} 条"
}

prune_index "$INDEX" "$KEEP_DAYS"

if [ "$WITH_SEARCH_LOG" = "1" ]; then
  # `search_log_*` 是「一人一索引」，必须先枚举；_cat 对无匹配返回空（不是 404），
  # 所以空列表是正常情况（还没人检索过）。
  indices=$(admin "$ES/_cat/indices/${SEARCH_LOG_PREFIX}*?h=index&expand_wildcards=open" 2>/dev/null | tr -d '\r' | sort -u || true)
  if [ -z "${indices:-}" ]; then
    echo "== 检索埋点：没有 ${SEARCH_LOG_PREFIX}* 索引，跳过 =="
    exit 0
  fi
  while IFS= read -r idx; do
    [ -n "$idx" ] || continue
    prune_index "$idx" "$SEARCH_LOG_KEEP_DAYS" '检索埋点'
  done <<< "$indices"
fi