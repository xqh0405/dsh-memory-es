#!/usr/bin/env bash
# S9 治理所需的 mapping / 索引 / 角色变更（幂等，可反复跑）。
#
# 变更内容：
#   1. 个人索引 + 模板：加 `blocked_reason`（敏感命中类型，**只存类型不存原文**）
#   2. 团队库：加 `reviewed_at` / `reviewed_by` / `reject_reason` / `conflict_with`
#      （审核队列落库后要有这些字段才能表达「谁在什么时候批/驳了什么、和谁冲突」）
#   3. 新建 `memory_audit`：晋升 / 拦截 / 驳回 / 撤回的审计流水
#   4. mem_consolidator 角色补 memory_audit 的读写
#
# 注意：`dynamic: strict` 下加字段必须走 PUT _mapping（新增字段可行、不需要 reindex），
# 但**不能**改已有字段的类型——真改类型才需要重建索引，本脚本不碰那种情况。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ES_DIR="${ES_DIR:-$ROOT/deploy/es}"
ENV_FILE="$ES_DIR/.env"
CA="$ES_DIR/certs/ca.crt"
ES="${ES_URL:-https://127.0.0.1:9200}"
PASS=$(grep '^ELASTIC_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
USER_ID=$(grep '^MEM_USER_ID=' "$ENV_FILE" | cut -d= -f2-)
USER_ID=${USER_ID:-xqh}

# --max-time：S9 迁移是运维脚本，宁可失败也不要静默挂住（本机单节点，10s 足够）
admin() { curl -sS --max-time 10 --cacert "$CA" -u "elastic:$PASS" -H 'Content-Type: application/json' "$@"; }
# 必须用 -I（真正的 HEAD），不能用 `-X HEAD`：后者让 curl 依旧按响应头里的
# Content-Length 等 body，而 HEAD 永远不会送 body → curl 一直挂着（2026-10-25 实测卡住）。
exists() { admin -o /dev/null -w '%{http_code}' -I "$ES/$1" 2>/dev/null | grep -q '^200$'; }

echo "== 1/4 个人索引：加 blocked_reason =="
# 模板（给以后新建的 per-user 索引）
admin -X PUT "$ES/_template/personal_memory" -d @- >/dev/null <<'JSON'
{
  "index_patterns": ["personal_memory_*"],
  "priority": 100,
  "template": {
    "settings": { "number_of_shards": 1, "number_of_replicas": 0, "refresh_interval": "5s" },
    "mappings": {
      "dynamic": "strict",
      "properties": {
        "memory_id":         { "type": "keyword" },
        "user_id":           { "type": "keyword" },
        "content":           { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart" },
        "semantic_keywords": { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart" },
        "embedding":         { "type": "dense_vector", "dims": 1024, "index": true, "similarity": "cosine" },
        "memory_type":       { "type": "keyword" },
        "domain":            { "type": "keyword" },
        "privacy":           { "type": "keyword" },
        "promote_state":     { "type": "keyword" },
        "status":            { "type": "keyword" },
        "supersedes":        { "type": "keyword" },
        "superseded_by":     { "type": "keyword" },
        "content_sha256":    { "type": "keyword" },
        "blocked_reason":    { "type": "keyword" },
        "created_at":        { "type": "date" },
        "updated_at":        { "type": "date" },
        "expires_at":        { "type": "date" }
      }
    }
  }
}
JSON
echo '  模板 personal_memory 已更新'

# 已存在的个人索引（PUT _mapping 对新增字段是幂等的）
for idx in $(admin "$ES/_cat/indices/personal_memory_*?h=index" 2>/dev/null); do
  admin -X PUT "$ES/$idx/_mapping" -d '{"properties":{"blocked_reason":{"type":"keyword"}}}' >/dev/null
  echo "  索引 $idx 已加 blocked_reason"
done

echo "== 2/4 团队库：审核字段 + conflict_with =="
admin -X PUT "$ES/team_knowledge/_mapping" -d @- >/dev/null <<'JSON'
{
  "properties": {
    "reviewed_at":   { "type": "date" },
    "reviewed_by":   { "type": "keyword" },
    "reject_reason": { "type": "keyword" },
    "conflict_with": { "type": "keyword" }
  }
}
JSON
echo '  team_knowledge 已加 reviewed_at / reviewed_by / reject_reason / conflict_with'

echo "== 3/4 审计索引 memory_audit =="
if exists memory_audit; then
  echo '  已存在，跳过创建'
else
  admin -X PUT "$ES/memory_audit" -d @- >/dev/null <<'JSON'
{
  "settings": { "number_of_shards": 1, "number_of_replicas": 0 },
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "event":         { "type": "keyword" },
      "actor":         { "type": "keyword" },
      "at":            { "type": "date" },
      "subject_type":  { "type": "keyword" },
      "subject_id":    { "type": "keyword" },
      "memory_id":     { "type": "keyword" },
      "team_doc_id":   { "type": "keyword" },
      "from_state":    { "type": "keyword" },
      "to_state":      { "type": "keyword" },
      "reason":        { "type": "keyword" },
      "note":          { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart" }
    }
  }
}
JSON
  echo '  已创建 memory_audit'
fi

echo "== 4/4 mem_consolidator 角色：补审计读写 =="
admin -X PUT "$ES/_security/role/mem_consolidator" -d @- >/dev/null <<'JSON'
{
  "indices": [
    { "names": ["personal_memory_*"], "privileges": ["read", "view_index_metadata"] },
    { "names": ["team_knowledge"], "privileges": ["index", "read", "view_index_metadata"] },
    { "names": ["memory_audit"], "privileges": ["index", "read", "view_index_metadata"] }
  ]
}
JSON
echo '  mem_consolidator → 个人库读 + 团队库读写 + 审计读写'

echo '--- 校验：字段是否真的加上了 ---'
admin "$ES/personal_memory_${USER_ID}/_mapping" | python3 -c '
import sys,json
props=list(json.load(sys.stdin).values())[0]["mappings"]["properties"]
print("  personal: 字段数", len(props), "| blocked_reason:", "blocked_reason" in props)
'
admin "$ES/team_knowledge/_mapping" | python3 -c '
import sys,json
props=list(json.load(sys.stdin).values())[0]["mappings"]["properties"]
need=["review_state","reviewed_at","reviewed_by","reject_reason","conflict_with"]
print("  team:", {k: k in props for k in need})
'
admin "$ES/memory_audit/_mapping" | python3 -c '
import sys,json
props=list(json.load(sys.stdin).values())[0]["mappings"]["properties"]
print("  audit: 字段数", len(props), "|", ",".join(sorted(props)[:6]), "...")
'
