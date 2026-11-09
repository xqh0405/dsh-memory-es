#!/usr/bin/env bash
# 阶段 32 的字段迁移：给个人记忆索引与模板补 `pinned`（每轮常驻注入的载体）。
#
# 为什么必须先跑这个再上代码：个人索引是 `dynamic: strict`，
# saveMemory / memory_pin 一旦写入 `pinned`，缺字段直接 400（strict_dynamic_mapping_exception），
# 而且失败是静默的——表现只是「存不进去」，看不出是 mapping 缺字段。
#
# 模板的 JSON **现场从 init-indices.sh 提取**，不在这里抄第二份：
# 抄一份就会漂移（"幂等 ≠ 无害"：重跑脚本会覆盖别人追加的字段）。
#
# 幂等：字段已存在时 PUT _mapping 是空操作；模板整体替换（内容即 init-indices.sh 的定义）；
# 回填只动 `pinned` 缺失的文档。
#
# 用法：
#   scripts/migrate-pinned-field.sh
#   ES_URL=https://<ES_HOST>:9200 ES_DIR=/docker/dsh-es \
#     ES_CA=/path/ca.crt ES_USER=elastic ES_PASS=... scripts/migrate-pinned-field.sh
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

# 从 init-indices.sh 现场提取个人记忆模板（第一个 heredoc）
TEMPLATE_JSON=$(awk '/<<'"'"'JSON'"'"'/{if(!started){started=1; next}} started && /^JSON$/{exit} started{print}' "$ROOT/scripts/init-indices.sh")
if ! printf '%s' "$TEMPLATE_JSON" | grep -q '"pinned"'; then
  echo 'init-indices.sh 的模板里没有 pinned —— 先把模板改好再迁移' >&2
  exit 1
fi

echo '== 1/3 模板 personal_memory_template =='
printf '%s\n' "$TEMPLATE_JSON" | es -X PUT "$ES/_index_template/personal_memory_template" -d @- >/dev/null
echo '  ok'

echo '== 2/3 已存在的个人索引 =='
indices=$(es "$ES/_cat/indices/personal_memory_*?h=index" 2>/dev/null || true)
if [ -z "$indices" ]; then
  echo '  （没有 personal_memory_* 索引，跳过）'
else
  for idx in $indices; do
    es -X PUT "$ES/$idx/_mapping" -d @- >/dev/null <<'JSON'
{
  "properties": {
    "pinned": { "type": "boolean" }
  }
}
JSON
    # 回填：老文档没有这个字段，补成 false，让「pinned 计数」不用区分 exists/missing
    backfilled=$(es -X POST "$ES/$idx/_update_by_query?refresh=true&conflicts=proceed" -d @- <<'JSON' \
      | sed -n 's/.*"updated":\([0-9]*\).*/\1/p'
{
  "query": { "bool": { "must_not": { "exists": { "field": "pinned" } } } },
  "script": { "source": "ctx._source.pinned = false" }
}
JSON
    )
    echo "  [mapping] $idx ← pinned（回填 ${backfilled:-0} 条）"
  done
fi

echo '== 3/3 校验 =='
ok=1
tpl=$(es -X GET "$ES/_index_template/personal_memory_template")
printf '%s' "$tpl" | grep -q '"pinned"' || { echo "  模板缺 pinned" >&2; ok=0; }
for idx in ${indices:-}; do
  body=$(es -X GET "$ES/$idx/_mapping")
  printf '%s' "$body" | grep -q '"pinned"' || { echo "  $idx 缺 pinned" >&2; ok=0; }
  printf '  %s: ok\n' "$idx"
done
if [ "$ok" -ne 1 ]; then
  echo '迁移未完成（见上面缺字段的索引）' >&2
  exit 1
fi
echo '全部完成'