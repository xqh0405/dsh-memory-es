#!/usr/bin/env bash
# 增加排序与时效字段：importance / hit_count / last_hit_at / superseded_at（阶段 2-3）。
#
# 为什么需要：
#  · importance —— 记忆之间的「重要度」不参与检索，critical 的规则和随手记的笔记
#    权重完全一样；
#  · hit_count / last_hit_at —— 检索命中不回写，被反复用到的记忆不会浮上来。
#
# **不需要回填**：代码把缺失值当 `importance=normal`、`hit_count=0`、`last_hit_at=null`，
# 所以只加 mapping 即可。这也是为什么本脚本比 content_exact 那个简单得多。
#
# 幂等：字段已存在时 PUT _mapping 是空操作。
#
# 用法：
#   scripts/migrate-ranking-fields.sh [USER_ID]
#   ES_URL=... ES_CA=... ES_USER=... ES_PASS=... scripts/migrate-ranking-fields.sh xqh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ES_DIR="${ES_DIR:-$ROOT/deploy/es}"
ENV_FILE="$ES_DIR/.env"
# CA 可覆盖：本机退役后指向 125 的集群时用的是另一张 CA
CA="${ES_CA:-$ES_DIR/certs/ca.crt}"
source "$(dirname "$0")/lib/curl-es.sh"
ES="${ES_URL:-https://127.0.0.1:9200}"
if [ -n "${ES_USER:-}" ] && [ -n "${ES_PASS:-}" ]; then
  AUTH="$ES_USER:$ES_PASS"
else
  PASS=$(grep '^ELASTIC_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
  AUTH="elastic:$PASS"
fi
USER_ID="${1:-$(grep '^MEM_USER_ID=' "$ENV_FILE" | cut -d= -f2-)}"
USER_ID=${USER_ID:-xqh}
PERSONAL="personal_memory_$USER_ID"
TEAM="team_knowledge"

es() { es_curl "$AUTH" --fail-with-body -H 'Content-Type: application/json' "$@"; }

put_fields() {
  local index=$1
  echo "[mapping] $index ← importance / hit_count / last_hit_at / superseded_at"
  es -X PUT "$ES/$index/_mapping" -d @- >/dev/null <<'JSON'
{
  "properties": {
    "importance":    { "type": "keyword" },
    "hit_count":     { "type": "integer" },
    "last_hit_at":   { "type": "date" },
    "superseded_at": { "type": "date" }
  }
}
JSON
  echo '  ok'
}

put_fields "$PERSONAL"
put_fields "$TEAM"

echo '== 校验 =='
# GET _mapping 不接受 body（带上会 400），这里只要确认字段在
for idx in "$PERSONAL" "$TEAM"; do
  if es -X GET "$ES/$idx/_mapping" | grep -q '"importance"'; then
    echo "  $idx: importance / hit_count / last_hit_at / superseded_at 已就绪"
  else
    echo "  $idx: 字段缺失" >&2
    exit 1
  fi
done
