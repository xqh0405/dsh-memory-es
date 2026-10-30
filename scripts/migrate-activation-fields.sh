#!/usr/bin/env bash
# 增加联结与激活字段：related / activation（阶段 5.1）。
#
# 为什么需要：
#  · 现有排序乘子只作用于**单条**记忆（importance / hit_count / last_hit_at），
#    记忆之间没有任何边，也没有会随时间衰减的「强度」；
#  · related    —— 邻接表 [{id, weight}]，写入时建边，供后续扩散激活使用；
#  · activation —— 可衰减的强度，与 hit_count（计数）语义不同：
#                  一周前被命中 100 次，和昨天被命中 1 次，靠计数分不出来。
#
# `related` 用 `enabled: false`：扩散激活在检索后读 `_source` 算，不需要检索它，
# 不索引 = 零倒排开销。`dynamic: strict` 下 `enabled: false` 的对象内部字段
# 不会被校验，所以 [{id, weight}] 可以原样存。
#
# **不需要回填**：代码把缺失值当 `related=[]`、`activation=0`，只加 mapping 即可。
# 不做 reindex：`dynamic: strict` 下 PUT _mapping 加字段就是原地生效（阶段 0 已验证）。
#
# 幂等：字段已存在时 PUT _mapping 是空操作。
#
# 用法：
#   scripts/migrate-activation-fields.sh [USER_ID]
#   ES_URL=... ES_CA=... ES_USER=... ES_PASS=... scripts/migrate-activation-fields.sh xqh
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
  echo "[mapping] $index ← related / activation"
  es -X PUT "$ES/$index/_mapping" -d @- >/dev/null <<'JSON'
{
  "properties": {
    "related":    { "type": "object", "enabled": false },
    "activation": { "type": "float" }
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
  body=$(es -X GET "$ES/$idx/_mapping")
  ok=1
  echo "$body" | grep -q '"related"' || ok=0
  echo "$body" | grep -q '"activation"' || ok=0
  if [ "$ok" = "1" ]; then
    echo "  $idx: related / activation 已就绪"
  else
    echo "  $idx: 字段缺失" >&2
    exit 1
  fi
done

echo '== 既有文档读回（不回填，缺失即空）=='
es -X GET "$ES/$PERSONAL/_search" -d @- <<'JSON' | head -20
{
  "size": 1,
  "query": { "match_all": {} },
  "_source": ["memory_id", "related", "activation", "hit_count"],
  "sort": [{ "created_at": "desc" }]
}
JSON
