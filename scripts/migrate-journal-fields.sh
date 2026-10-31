#!/usr/bin/env bash
# 阶段 9.5 的字段迁移：给个人记忆索引与模板补 `day` / `review_state`。
#
# 为什么必须单独有个迁移：journal.ts 写 `memory_type=journal` 的文档时带这两个字段，
# 而个人索引是 `dynamic: strict`，缺字段直接 400
# （实测：strict_dynamic_mapping_exception: dynamic introduction of [day] is not allowed）。
# init-indices.sh 的模板已经补上（新部署不再踩），但**已存在的索引与已发布的模板**
# 不会自动跟着变，所以这里补一次。
#
# 幂等：字段已存在时 PUT _mapping 是空操作；模板是整体替换（内容与 init-indices.sh 一致）。
#
# 用法：
#   scripts/migrate-journal-fields.sh
#   ES_URL=https://192.168.1.125:9200 ES_DIR=/docker/dsh-es scripts/migrate-journal-fields.sh
#   ES_URL=... ES_USER=elastic ES_PASS=... scripts/migrate-journal-fields.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ES_DIR="${ES_DIR:-$ROOT/deploy/es}"
ENV_FILE="$ES_DIR/.env"
CA="${ES_CA:-$ES_DIR/certs/ca.crt}"
source "$(dirname "$0")/lib/curl-es.sh"
ES="${ES_URL:-https://127.0.0.1:9200}"
if [ -n "${ES_USER:-}" ] && [ -n "${ES_PASS:-}" ]; then
  AUTH="$ES_USER:$ES_PASS"
else
  PASS=$(grep '^ELASTIC_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
  AUTH="elastic:$PASS"
fi

es() { es_curl "$AUTH" --fail-with-body -H 'Content-Type: application/json' "$@"; }

# 1) 模板：整体替换成与 init-indices.sh 同一份定义（含 day / review_state）
echo "== 1/3 模板 personal_memory_template =="
es -X PUT "$ES/_index_template/personal_memory_template" -d @- >/dev/null <<'JSON'
{
  "index_patterns": ["personal_memory_*"],
  "priority": 100,
  "template": {
    "settings": {
      "number_of_shards": 1,
      "number_of_replicas": 0,
      "refresh_interval": "5s"
    },
    "mappings": {
      "dynamic": "strict",
      "properties": {
        "memory_id":         { "type": "keyword" },
        "user_id":           { "type": "keyword" },
        "content":           { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart" },
        "content_exact":     { "type": "text", "analyzer": "standard" },
        "summary":           { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart" },
        "semantic_keywords": { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart" },
        "embedding":         { "type": "dense_vector", "dims": 1024, "index": true, "similarity": "cosine" },
        "memory_type":       { "type": "keyword" },
        "domain":            { "type": "keyword" },
        "topic_key":         { "type": "keyword" },
        "privacy":           { "type": "keyword" },
        "importance":        { "type": "keyword" },
        "hit_count":         { "type": "integer" },
        "last_hit_at":       { "type": "date" },
        "related":           { "type": "object", "enabled": false },
        "activation":        { "type": "float" },
        "mood_valence":      { "type": "float" },
        "mood_arousal":      { "type": "float" },
        "mood_updated_at":   { "type": "date" },
        "mood_events":       { "type": "object", "enabled": false },
        "valence":           { "type": "float" },
        "evidence_ids":      { "type": "object", "enabled": false },
        "traits_window_days": { "type": "integer" },
        "arousal":           { "type": "float" },
        "superseded_at":     { "type": "date" },
        "reviewed_at":       { "type": "date" },
        "reviewed_by":       { "type": "keyword" },
        "review_note":       { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart" },
        "anchor":            { "type": "boolean" },
        "day":               { "type": "keyword" },
        "review_state":      { "type": "keyword" },
        "blocked_reason":    { "type": "keyword" },
        "personal_only_reason": { "type": "text" },
        "distill_state":        { "type": "keyword" },
        "distilled_at":         { "type": "date" },
        "distill_source_chars": { "type": "integer" },
        "promote_state":     { "type": "keyword" },
        "status":            { "type": "keyword" },
        "supersedes":        { "type": "keyword" },
        "superseded_by":     { "type": "keyword" },
        "content_sha256":    { "type": "keyword" },
        "created_at":        { "type": "date" },
        "updated_at":        { "type": "date" },
        "expires_at":        { "type": "date" }
      }
    }
  }
}
JSON
echo '  ok'

# 2) 已存在的个人索引：逐个补字段（新增字段的 PUT _mapping 幂等）
echo "== 2/3 已存在的个人索引 =="
indices=$(es "$ES/_cat/indices/personal_memory_*?h=index" 2>/dev/null || true)
if [ -z "$indices" ]; then
  echo '  （没有 personal_memory_* 索引，跳过）'
else
  for idx in $indices; do
    es -X PUT "$ES/$idx/_mapping" -d @- >/dev/null <<'JSON'
{
  "properties": {
    "day":          { "type": "keyword" },
    "review_state": { "type": "keyword" }
  }
}
JSON
    echo "  [mapping] $idx ← day / review_state"
  done
fi

# 3) 校验：模板 + 每个索引都必须真的有这两个字段
echo '== 3/3 校验 =='
ok=1
tpl=$(es -X GET "$ES/_index_template/personal_memory_template")
for f in day review_state; do
  echo "$tpl" | grep -q "\"$f\"" || { echo "  模板缺 $f" >&2; ok=0; }
done
for idx in ${indices:-}; do
  body=$(es -X GET "$ES/$idx/_mapping")
  for f in day review_state; do
    echo "$body" | grep -q "\"$f\"" || { echo "  $idx 缺 $f" >&2; ok=0; }
  done
done
[ "$ok" = "1" ] && echo '  模板与索引均已含 day / review_state' || exit 1
