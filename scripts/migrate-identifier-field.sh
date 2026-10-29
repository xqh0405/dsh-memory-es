#!/usr/bin/env bash
# 增加 content_exact 字段并回填（阶段 1：标识符精确匹配）。
#
# 为什么要它：`lot.bd_write_sync` 这类标识符在 ik_max_word 下被切碎，
# 实测 BM25 只有 13.9，导致「精确问某个函数/任务名」的查询排在噪声之后。
# 这里用 standard 分析器单独存一份正文：UAX#29 会把 `lot.bd_write_sync`
# 保留成单个 token（下划线与点号在字母之间不产生边界），而中文仍然逐字可搜。
#
# 幂等：字段已存在时 PUT _mapping 是空操作；回填只处理「还没有 content_exact」的文档。
#
# 用法：scripts/migrate-identifier-field.sh [USER_ID]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ES_DIR="${ES_DIR:-$ROOT/deploy/es}"
ENV_FILE="$ES_DIR/.env"
# CA 可覆盖：本机退役后指向 125 的集群时用的是另一张 CA
CA="${ES_CA:-$ES_DIR/certs/ca.crt}"
source "$(dirname "$0")/lib/curl-es.sh"
ES="${ES_URL:-https://127.0.0.1:9200}"
# 凭据优先取 ES_USER/ES_PASS（125 上 elastic 密码与本机 .env 不同，且个人账号
# 已验证可以改自己索引的 mapping）；都没有才回落到本机 .env 的 elastic。
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

put_field() {
  local index=$1
  echo "[mapping] $index.content_exact"
  es -X PUT "$ES/$index/_mapping" -d @- >/dev/null <<'JSON'
{
  "properties": {
    "content_exact": { "type": "text", "analyzer": "standard" }
  }
}
JSON
}

backfill() {
  local index=$1
  echo "[backfill] $index"
  # 只处理「还没有该字段」的文档；conflicts=proceed 让并发写入不会中断整批。
  # 失败必须把 ES 的报错原文打出来——第一次跑时 403 被 grep 吞掉，排查绕了远路。
  local out rc=0
  out=$(es -X POST "$ES/$index/_update_by_query?conflicts=proceed&refresh=true" -d @- <<'JSON'
{
  "script": {
    "source": "ctx._source.content_exact = ctx._source.content",
    "lang": "painless"
  },
  "query": { "bool": { "must_not": { "exists": { "field": "content_exact" } } } }
}
JSON
) || rc=$?
  if [ "$rc" -ne 0 ] || ! printf '%s' "$out" | grep -q '"updated"'; then
    echo "[backfill] $index 失败（exit=$rc）：$out" >&2
    return 1
  fi
  printf '  %s\n' "$(printf '%s' "$out" | grep -oE '"(total|updated|failures)":[0-9]+' | tr '\n' ' ')"
}

put_field "$PERSONAL"
backfill "$PERSONAL"
put_field "$TEAM"
backfill "$TEAM"

echo '== 校验：抽一条含标识符的文档，看 standard 是否保留完整 token =='
es -X GET "$ES/$PERSONAL/_search?size=1" -d @- <<'JSON' | head -c 600 || true
{
  "_source": ["content_exact"],
  "query": { "match_phrase": { "content_exact": "lot.bd_write_sync" } }
}
JSON
echo
