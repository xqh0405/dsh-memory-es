#!/usr/bin/env bash
# 阶段 28 的字段迁移：给文档索引与模板补 `status` / `last_accessed_at`。
#
# 为什么必须先跑这个再上代码：`personal_doc_*` 是 `dynamic: strict`，
# doc_search 的回写一旦写 `last_accessed_at`，缺字段直接 400 —— 而且是**静默**的
# （回写被设计成失败不阻断检索，所以只会表现为「热度一直是空的」）。
#
# 模板的 JSON **现场从 init-indices.sh 提取**，不在这里抄第二份：
# 抄一份就会漂移（"幂等 ≠ 无害"：重跑脚本会覆盖别人追加的字段）。
#
# ⚠️ 2026-11-08 之前 `personal_doc_template` 只存在于线上、仓库里没有脚本管它。
# 本脚本的 PUT 模板这一步同时把「模板版本化」补上——重装 ES 后不会再丢。
#
# 幂等：字段已存在时 PUT _mapping 是空操作；模板是整体替换（内容即 init-indices.sh 的定义）。
#
# 用法：
#   scripts/migrate-doc-fields.sh
#   ES_URL=https://<ES_HOST>:9200 ES_DIR=/docker/dsh-es \
#     ES_CA=/path/ca.crt ES_USER=elastic ES_PASS=... scripts/migrate-doc-fields.sh
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

# 从 init-indices.sh 现场提取 personal_doc_template 那段 heredoc
TEMPLATE_JSON=$(python3 - "$ROOT/scripts/init-indices.sh" <<'PY'
import re, sys
src = open(sys.argv[1], encoding="utf-8").read()
parts = re.split(r"<<'JSON'\n", src)
for i, b in enumerate(parts[1:], start=1):
    body, sep, _ = b.partition("\nJSON")
    if sep and "personal_doc_template" in parts[i - 1][-500:]:
        print(body.strip())
        break
PY
)
if [ -z "$TEMPLATE_JSON" ]; then
  echo 'init-indices.sh 里找不到 personal_doc_template —— 先把模板补进去再迁移' >&2
  exit 1
fi
for f in status last_accessed_at; do
  if ! printf '%s' "$TEMPLATE_JSON" | grep -q "\"$f\""; then
    echo "init-indices.sh 的文档模板里没有 $f —— 先把模板改好再迁移" >&2
    exit 1
  fi
done

echo '== 1/3 模板 personal_doc_template =='
printf '%s\n' "$TEMPLATE_JSON" | es -X PUT "$ES/_index_template/personal_doc_template" -d @- >/dev/null
echo '  ok（含 status / last_accessed_at；同时把模板纳入版本管理）'

echo '== 2/3 已存在的文档索引 =='
indices=$(es "$ES/_cat/indices/personal_doc_*?h=index" 2>/dev/null || true)
if [ -z "$indices" ]; then
  echo '  （没有 personal_doc_* 索引，跳过）'
else
  for idx in $indices; do
    es -X PUT "$ES/$idx/_mapping" -d @- >/dev/null <<'JSON'
{
  "properties": {
    "status":           { "type": "keyword" },
    "last_accessed_at": { "type": "date" }
  }
}
JSON
    echo "  [mapping] $idx ← status / last_accessed_at"
  done
fi

# 存量文档补 status=active：不补的话「默认只查 active」会把全部老文档过滤掉。
# 用 _update_by_query 而不是 reindex：只加一个字段，没必要重建索引。
# 幂等：加 `status` 不存在的条件，重跑不会重复处理。
echo '== 3/4 存量补 status=active =='
for idx in ${indices:-}; do
  resp=$(es -X POST "$ES/$idx/_update_by_query?conflicts=proceed&wait_for_completion=true&refresh=false" -d @- <<'JSON'
{
  "query": { "bool": { "must_not": { "exists": { "field": "status" } } } },
  "script": { "source": "ctx._source.status = 'active'", "lang": "painless" }
}
JSON
)
  updated=$(printf '%s' "$resp" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("updated","?"))' 2>/dev/null || echo '?')
  echo "  [$idx] 补 $updated 条"
done

# refresh=false 是刻意的：大索引（xqh 4038 条）逐条刷段会很慢。
# 但**校验前必须显式 refresh 一次**，否则 `_count` 看不到未刷新的写入，
# 会把「更新成功」误报成「active=0/4038」——2026-11-08 首跑就这么误判过。
echo '== 3.5/4 刷新（否则下面的 _count 看不到刚写的 status）=='
es -X POST "$ES/personal_doc_*/_refresh" >/dev/null && echo '  refreshed'

echo '== 4/4 校验 =='
ok=1
tpl=$(es -X GET "$ES/_index_template/personal_doc_template")
for f in status last_accessed_at; do
  printf '%s' "$tpl" | grep -q "\"$f\"" || { echo "  模板缺 $f" >&2; ok=0; }
done
for idx in ${indices:-}; do
  body=$(es -X GET "$ES/$idx/_mapping")
  for f in status last_accessed_at; do
    printf '%s' "$body" | grep -q "\"$f\"" || { echo "  $idx 缺 $f" >&2; ok=0; }
  done
  # 抽查：active 占比应为 100%（老文档都补上了）
  stat=$(es "$ES/$idx/_count" -d '{"query":{"term":{"status":"active"}}}' | python3 -c 'import json,sys;print(json.load(sys.stdin).get("count","?"))' 2>/dev/null || echo '?')
  total=$(es "$ES/$idx/_count" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("count","?"))' 2>/dev/null || echo '?')
  printf '  %s: mapping ok, active %s/%s\n' "$idx" "$stat" "$total"
done
[ "$ok" = "1" ] || exit 1
echo '迁移完成：字段与 status 已就绪（last_accessed_at 留空 = 入库后还没被检索用过）'