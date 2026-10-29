#!/usr/bin/env bash
# 建索引。单节点 replicas 必须为 0。
#
# 重要：ES 免费版（basic license）不支持 DLS（document level security），
# 所以个人库改成「一人一索引」：personal_memory_<user_id>，用索引级 ACL 隔离。
# 索引模板负责让新用户的索引自动继承同一套 mapping。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 默认是本仓库的本地部署；远端部署用 ES_DIR=/path/to/deploy/es ES_URL=https://host:9200
ES_DIR="${ES_DIR:-$ROOT/deploy/es}"
ENV_FILE="$ES_DIR/.env"
CA="$ES_DIR/certs/ca.crt"
source "$(dirname "$0")/lib/curl-es.sh"
ES="${ES_URL:-https://127.0.0.1:9200}"
PASS=$(grep '^ELASTIC_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
USER_ID=$(grep '^MEM_USER_ID=' "$ENV_FILE" | cut -d= -f2-)
USER_ID=${USER_ID:-xqh}
PERSONAL="personal_memory_$USER_ID"
SEARCH_LOG="search_log_$USER_ID"

es() { es_curl "elastic:$PASS" --fail-with-body -H 'Content-Type: application/json' "$@"; }

exists() {
  code=$(es_curl "elastic:$PASS" -o /dev/null -w '%{http_code}' -I "$ES/$1")
  [ "$code" = "200" ]
}

echo '== 索引模板 personal_memory_* =='
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

put_index() {
  local name=$1; shift
  if exists "$name"; then
    echo "[skip] 索引 $name 已存在"
    return 0
  fi
  echo "[create] 索引 $name"
  es -X PUT "$ES/$name" -d @- >/dev/null
  echo '  ok'
}

# 空 body：settings/mappings 全部继承索引模板
put_index "$PERSONAL" <<'JSON'
{}
JSON

put_index team_knowledge <<'JSON'
{
  "settings": { "number_of_shards": 1, "number_of_replicas": 0 },
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "doc_id":            { "type": "keyword" },
      "content":           { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart" },
      "content_exact":     { "type": "text", "analyzer": "standard" },
      "semantic_keywords": { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart" },
      "embedding":         { "type": "dense_vector", "dims": 1024, "index": true, "similarity": "cosine" },

      "memory_type":       { "type": "keyword" },
      "domain":            { "type": "keyword" },
      "topic_key":         { "type": "keyword" },
      "content_sha256":    { "type": "keyword" },

      "source_user":       { "type": "keyword" },
      "source_memory_id":  { "type": "keyword" },
      "source_created_at": { "type": "date" },
      "promoted_at":       { "type": "date" },

      "status":            { "type": "keyword" },
      "review_state":      { "type": "keyword" },
      "reviewed_at":       { "type": "date" },
      "reviewed_by":       { "type": "keyword" },
      "reject_reason":     { "type": "keyword" },
      "conflict_with":     { "type": "keyword" },
      "supersedes":        { "type": "keyword" },
      "superseded_by":     { "type": "keyword" },
      "updated_at":        { "type": "date" }
    }
  }
}
JSON

# ── 检索埋点（P1）────────────────────────────────────────────────
# 只存「查了什么、召回几条、多久、是不是空/降级」。
# 为什么不塞 memory_audit：audit 是知识治理流水（低频、留 90 天），
# 检索是高频读操作（一天几十次），混进去会把 audit 撑成日志表，
# 也会让「谁晋升了什么」这种审计问题被噪声淹没。
echo '== 索引模板 search_log_* =='
es -X PUT "$ES/_index_template/search_log_template" -d @- >/dev/null <<'JSON'
{
  "index_patterns": ["search_log_*"],
  "priority": 100,
  "template": {
    "settings": {
      "number_of_shards": 1,
      "number_of_replicas": 0,
      "refresh_interval": "30s"
    },
    "mappings": {
      "dynamic": "strict",
      "properties": {
        "user_id":  { "type": "keyword" },
        "at":       { "type": "date" },
        "tool":     { "type": "keyword" },
        "query":    { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart" },
        "scope":    { "type": "keyword" },
        "hits":     { "type": "integer" },
        "note":     { "type": "keyword" },
        "zero_hit": { "type": "boolean" },
        "degraded": { "type": "boolean" },
        "filtered": { "type": "boolean" },
        "routes":   { "type": "keyword" },
        "ms":       { "type": "integer" },
        "margin":   { "type": "float" }
      }
    }
  }
}
JSON
echo '  ok'

put_index "$SEARCH_LOG" <<'JSON'
{}
JSON

echo '--- 索引列表 ---'
es -X GET "$ES/_cat/indices?v&h=index,health,docs.count,store.size"
echo "--- 个人索引是否继承模板（$PERSONAL）---"
es -X GET "$ES/$PERSONAL/_mapping" | python3 -c '
import sys,json
d=json.load(sys.stdin)
props=list(d.values())[0]["mappings"]["properties"]
print("  字段数:", len(props), "| embedding.dims:", props["embedding"].get("dims"), "| content.analyzer:", props["content"].get("analyzer"))
'
echo '--- IK 分词验证 ---'
es -X POST "$ES/_analyze" \
  -d '{"analyzer":"ik_max_word","text":"北单中断开奖，win_price 与 win_price_practical 必须同时写入"}' \
  | python3 -c 'import sys,json;print("  " + " / ".join(t["token"] for t in json.load(sys.stdin)["tokens"]))'
