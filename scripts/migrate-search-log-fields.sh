#!/usr/bin/env bash
# 阶段 11 的字段迁移：给检索埋点索引与模板补 `query_norm` / `hit_ids`。
#
# 为什么必须先跑这个再上代码：`search_log_*` 是 `dynamic: strict`，
# search.ts 一旦写入这两个字段，缺字段就直接 400（strict_dynamic_mapping_exception），
# 埋点是 fire-and-forget 的，所以**失败是静默的**——只会看到日志里 record_degraded，
# 而面板的覆盖率看板永远是空的。这是 related 字段那次事故的同类形态。
#
# 两个字段的作用：
#   · query_norm —— 归一化后的查询（去空白标点、小写），用于把「同一个问题的重复提问」
#     聚成一簇。`query` 本身是 ik 分词的 text，没法直接 terms 聚合；
#   · hit_ids    —— 这次检索返回了哪些 memory_id，反查「这条记忆被哪些问题命中过」的地基。
#
# 模板的 JSON **现场从 init-indices.sh 提取**（按 search_log_template 定位），
# 不在这里抄第二份：抄一份就会漂移。
#
# 幂等：字段已存在时 PUT _mapping 是空操作；模板是整体替换。
# 存量记录没有这两个字段是正常的——覆盖率只统计补字段之后的新数据，面板会注明。
#
# 用法：
#   scripts/migrate-search-log-fields.sh
#   ES_URL=https://192.168.50.125:9200 ES_CA=/path/ca.crt ES_USER=elastic ES_PASS=... \
#     scripts/migrate-search-log-fields.sh
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

# 从 init-indices.sh 现场提取 search_log 模板
TEMPLATE_JSON=$(awk '/_index_template\/search_log_template/{mark=1} mark && /<<'"'"'JSON'"'"'/{grab=1; next} grab && /^JSON$/{exit} grab{print}' "$ROOT/scripts/init-indices.sh")
if ! printf '%s' "$TEMPLATE_JSON" | grep -q '"hit_ids"'; then
  echo 'init-indices.sh 的 search_log 模板里没有 hit_ids —— 先把模板改好再迁移' >&2
  exit 1
fi

echo '== 1/3 模板 search_log_template =='
printf '%s\n' "$TEMPLATE_JSON" | es -X PUT "$ES/_index_template/search_log_template" -d @- >/dev/null
echo '  ok'

echo '== 2/3 已存在的 search_log_* 索引 =='
indices=$(es "$ES/_cat/indices/search_log_*?h=index" 2>/dev/null || true)
if [ -z "$indices" ]; then
  echo '  （没有 search_log_* 索引，跳过）'
else
  for idx in $indices; do
    es -X PUT "$ES/$idx/_mapping" -d @- >/dev/null <<'JSON'
{
  "properties": {
    "query_norm": { "type": "keyword", "ignore_above": 512 },
    "hit_ids":    { "type": "keyword" }
  }
}
JSON
    echo "  [mapping] $idx ← query_norm / hit_ids"
  done
fi

echo '== 3/3 校验 =='
ok=1
tpl=$(es -X GET "$ES/_index_template/search_log_template")
for f in query_norm hit_ids; do
  printf '%s' "$tpl" | grep -q "\"$f\"" || { echo "  模板缺 $f" >&2; ok=0; }
done
for idx in ${indices:-}; do
  body=$(es -X GET "$ES/$idx/_mapping")
  for f in query_norm hit_ids; do
    printf '%s' "$body" | grep -q "\"$f\"" || { echo "  $idx 缺 $f" >&2; ok=0; }
  done
  printf '  %s: ok\n' "$idx"
done
if [ "$ok" != "1" ]; then
  exit 1
fi
echo '迁移完成：字段已就绪（存量记录缺这两个字段是正常的）'
