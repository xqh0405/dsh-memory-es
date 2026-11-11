#!/usr/bin/env bash
# 建索引。单节点 replicas 必须为 0。
#
# 重要：ES 免费版（basic license）不支持 DLS（document level security），
# 所以个人库改成「一人一索引」：personal_memory_<user_id>，用索引级 ACL 隔离。
# 索引模板负责让新用户的索引自动继承同一套 mapping。
#
# 阶段 6.2 新增四个情绪状态字段（同一个索引里的固定文档 id __mood__，
# status=mood 不进检索；见 src/memory/mood.ts 的说明）。
#
# 阶段 5.1 新增两个字段：
#  · related    —— 记忆之间的邻接表 [{id, weight}]。用 `enabled: false`：扩散激活
#                 在检索后读 _source 计算，不需要检索它；不索引 = 零倒排开销。
#  · activation —— 会衰减的「强度」，与 hit_count（计数）是两回事。
# 都是纯新增：老文档读不到就是空数组 / 0，不影响既有排序。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 默认是本仓库的本地部署；远端部署用 ES_DIR=/path/to/deploy/es ES_URL=https://host:9200
# CA 可单独覆盖（与 init-user.sh 已有的 ${CA:-...} 模式对齐）：目标实例的证书目录
# 不在本地时（例如 es-test-up.sh 起的一次性测试实例），传 CA= 就够，不必为它造一个
# 与运行无关的 certs 目录（2026-11-10 审查 #30）。
ES_DIR="${ES_DIR:-$ROOT/deploy/es}"
ENV_FILE="$ES_DIR/.env"
CA="${CA:-$ES_DIR/certs/ca.crt}"
source "$(dirname "$0")/lib/curl-es.sh"
ES="${ES_URL:-https://127.0.0.1:9200}"
PASS=$(grep '^ELASTIC_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
USER_ID=$(grep '^MEM_USER_ID=' "$ENV_FILE" | cut -d= -f2-)
USER_ID=${USER_ID:-xqh}
PERSONAL="personal_memory_$USER_ID"
SEARCH_LOG="search_log_$USER_ID"

es() { es_curl "elastic:$PASS" --fail-with-body -H 'Content-Type: application/json' "$@"; }

# 把成功响应体丢掉，但**失败时必须回显**（2026-11-10 审查 M1/#22）。
#
# 为什么要有它：`es()` 开了 --fail-with-body，错误体走 **stdout** ——
# 原来的 `es … >/dev/null` 把 `strict_dynamic_mapping_exception` 的整段原文
# 连同成功输出一起丢了，只剩 curl 那句 `error: 400`，模板/mapping 哪个字段
# 不对完全看不出来。同仓 `migrate-identifier-field.sh` 修过同类
# （「第一次跑 403 被 grep 吞掉」），这里补上。
#
# 注意是**包装而不是改 es()**：`exists()` 走的是 `es_curl`（另一个函数），
# 别处还要 `es` 的正常输出（如 GET 后接 grep）。
es_quiet() {
  local out rc=0
  out=$(es "$@" 2>&1) || rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '✗ 失败（curl 退出码 %s）：%s\n' "$rc" "$out" >&2
    return "$rc"
  fi
  return 0
}

exists() {
  code=$(es_curl "elastic:$PASS" -o /dev/null -w '%{http_code}' -I "$ES/$1")
  [ "$code" = "200" ]
}

echo '== 索引模板 personal_memory_* =='
es_quiet -X PUT "$ES/_index_template/personal_memory_template" -d @- <<'JSON'
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
        "confirmed_use":     { "type": "integer" },
        "corrections":       { "type": "integer" },
        "feedback_at":       { "type": "date" },
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
        "pinned":            { "type": "boolean" },
        "day":               { "type": "keyword" },
        "review_state":      { "type": "keyword" },
        "blocked_reason":    { "type": "keyword" },
        "personal_only_reason": { "type": "text" },

        "distill_state":        { "type": "keyword" },
        "distilled_at":         { "type": "date" },
        "distill_source_chars": { "type": "integer" },
        "promote_state":     { "type": "keyword" },
        "status":            { "type": "keyword" },
        "origin":            { "type": "keyword" },
        "quarantine_reason": { "type": "keyword", "ignore_above": 256 },
        "supersedes":        { "type": "keyword" },
        "superseded_by":     { "type": "keyword" },
        "forget_reason":     { "type": "keyword", "ignore_above": 256 },
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
  es_quiet -X PUT "$ES/$name" -d @-
  echo '  ok'
}

# 空 body：settings/mappings 全部继承索引模板
put_index "$PERSONAL" <<'JSON'
{}
JSON

# 2026-11-10 审查 P1/#17 补 activation：它与 hit_count / last_hit_at 是**同一支
# painless 脚本一起写**的（src/memory/search.ts 的 HIT_UPDATE_SCRIPT 三行），
# 且 `hit.origin === 'team'` 时打到**团队索引**（search.ts 的回写按 origin 选索引）。
# 缺它的后果不是「少个字段」：dynamic:strict 下 merge 抛 strict_dynamic_mapping_exception
# → 该条 bulk 400 → 三行脚本原子回滚 → hit_count 与 last_hit_at **一起丢**，
# 只在 hit_record_partial 留一条观测日志。
# 线上团队索引有这个字段（migrate-activation-fields.sh 补过），但 es-setup.sh 只跑
# init-indices.sh → **新装机必中**，所以模板自己必须带。
# ⚠️ 下面是喂给 curl 的 raw JSON，**不许出现 // 注释**（JSON 不支持，会整份解析失败）。
put_index team_knowledge <<'JSON'
{
  "settings": { "number_of_shards": 1, "number_of_replicas": 0 },
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "doc_id":            { "type": "keyword" },
      "content":           { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart" },
      "content_exact":     { "type": "text", "analyzer": "standard" },
      "summary":           { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart" },
      "semantic_keywords": { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart" },
      "embedding":         { "type": "dense_vector", "dims": 1024, "index": true, "similarity": "cosine" },

      "memory_type":       { "type": "keyword" },
      "domain":            { "type": "keyword" },
      "topic_key":         { "type": "keyword" },
      "content_sha256":    { "type": "keyword" },
      "importance":        { "type": "keyword" },
      "hit_count":         { "type": "integer" },
      "last_hit_at":       { "type": "date" },
      "activation":        { "type": "float" },
      "superseded_at":     { "type": "date" },
      "related":           { "type": "object", "enabled": false },

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

# ── 文档库模板（personal_doc_*，阶段 28）────────────────────────────
# ⚠️ 这个模板在 2026-11-08 之前**只存在于线上、仓库里没有任何脚本管它**——
# 也就是「重装即丢」：新装的 ES 上 personal_doc_* 没有模板，doc_search 一写就
# 撞 strict mapping（或者 ES 自动推断出不可控的类型）。28 顺手补上。
#
# 阶段 28 新增两字段：
#   · status           —— active / archived。归档后默认不进检索（29 用它做冷热分层）。
#   · last_accessed_at —— 每次检索命中后回写（bulk，失败静默）。它撑起「热度」与
#                         将来的 LRU 归档；空表示「入库后还没被用过」。
#
# 审查 16b 新增：
#   · cold_memory_id   —— 归档时写回冷引用的 memory_id。恢复时靠它**精确**删掉那条
#                         「【已归档文档】…」记忆；没有它只能按 content 模糊搜，
#                         代价大且会误伤别的文档。老文档没这个字段（留空）是正确的。
#                         ⚠️ 已存在的索引不受模板影响，必须跑 scripts/migrate-cold-ref-field.sh。
es_quiet -X PUT "$ES/_index_template/personal_doc_template" -d @- <<'JSON'
{
  "index_patterns": ["personal_doc_*"],
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
        "doc_id":            { "type": "keyword" },
        "user_id":           { "type": "keyword" },
        "chunk_index":       { "type": "integer" },
        "chunk_total":       { "type": "integer" },

        "title":             { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart" },
        "title_keyword":     { "type": "keyword" },
        "content":           { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart" },
        "description":       { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart" },
        "section_path":      { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart" },
        "tags":              { "type": "keyword" },
        "domain":            { "type": "keyword" },
        "source":            { "type": "keyword" },
        "source_path":       { "type": "keyword" },
        "source_paths":      { "type": "keyword" },
        "content_sha256":    { "type": "keyword" },
        "embedding":         { "type": "dense_vector", "dims": 1024, "index": true, "similarity": "cosine" },

        "status":            { "type": "keyword" },
        "last_accessed_at":  { "type": "date" },
        "cold_memory_id":    { "type": "keyword" },

        "created_at":        { "type": "date" },
        "updated_at":        { "type": "date" }
      }
    }
  }
}
JSON

# ── 共享审计库（memory_audit）────────────────────────────────────
# 以前只由 migrate-s9.sh 创建，于是「全新装机」这条路上它是缺的：第一次晋升/驳回写不进去
# （ES 会自动建一个 dynamic 映射的索引，字段类型不可控）。开箱路径必须自己建它。
# 映射与 migrate-s9.sh 保持一致；已存在的索引不受影响（put_index 会跳过）。
put_index memory_audit <<'JSON'
{
  "settings": { "number_of_shards": 1, "number_of_replicas": 0 },
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "event":        { "type": "keyword" },
      "actor":        { "type": "keyword" },
      "at":           { "type": "date" },
      "subject_type": { "type": "keyword" },
      "subject_id":   { "type": "keyword" },
      "memory_id":    { "type": "keyword" },
      "team_doc_id":  { "type": "keyword" },
      "from_state":   { "type": "keyword" },
      "to_state":     { "type": "keyword" },
      "reason":       { "type": "keyword" },
      "note":         { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart" }
    }
  }
}
JSON

# ── 个人审计流水（阶段 7.3 补强）──────────────────────────────────
# 为什么单独一份而不是只写 memory_audit：
#   · memory_audit 是**共享**索引，只有 teamWrite 身份能写；普通用户采纳/拒绝自己的候选时
#     写不进去（实测 mem-user-* 403），只能降级把痕迹记在条目上——那样查不到"我做过哪些审核"。
#   · 个人操作写进共享审计还意味着任何人能写别人的审计记录，无法防伪造。
# 字段刻意与 memory_audit 对齐：以后要汇总时可以直接并起来看。
echo '== 索引模板 personal_audit_* =='
es_quiet -X PUT "$ES/_index_template/personal_audit_template" -d @- <<'JSON'
{
  "index_patterns": ["personal_audit_*"],
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
        "event":        { "type": "keyword" },
        "actor":        { "type": "keyword" },
        "at":           { "type": "date" },
        "subject_type": { "type": "keyword" },
        "subject_id":   { "type": "keyword" },
        "memory_id":    { "type": "keyword" },
        "team_doc_id":  { "type": "keyword" },
        "from_state":   { "type": "keyword" },
        "to_state":     { "type": "keyword" },
        "reason":       { "type": "keyword" },
        "note":         { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart" }
      }
    }
  }
}
JSON
echo '  personal_audit_* → 每用户一份操作审计（采纳/拒绝/晋升）'

# ── 检索埋点（P1）────────────────────────────────────────────────
# 只存「查了什么、召回几条、多久、是不是空/降级」。
# 为什么不塞 memory_audit：audit 是知识治理流水（低频、留 90 天），
# 检索是高频读操作（一天几十次），混进去会把 audit 撑成日志表，
# 也会让「谁晋升了什么」这种审计问题被噪声淹没。
echo '== 索引模板 search_log_* =='
es_quiet -X PUT "$ES/_index_template/search_log_template" -d @- <<'JSON'
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
        "query_norm": { "type": "keyword", "ignore_above": 512 },
        "hit_ids":  { "type": "keyword" },
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
