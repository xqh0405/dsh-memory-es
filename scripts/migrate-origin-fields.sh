#!/usr/bin/env bash
# 阶段 9 的字段迁移：给个人记忆索引与模板补 `origin` / `quarantine_reason`。
#
# 为什么必须先跑这个再上代码：个人索引是 `dynamic: strict`，
# save 一旦写入 `origin`，缺字段直接 400（strict_dynamic_mapping_exception），
# **每一次 memory_save 都会静默失败**——这是 related 字段那次事故的同类形态。
#
# 模板的 JSON **现场从 init-indices.sh 提取**，不在这里抄第二份：
# 抄一份就会漂移（"幂等 ≠ 无害"那条教训：重跑脚本会覆盖别人追加的字段）。
#
# 幂等：字段已存在时 PUT _mapping 是空操作；模板是整体替换（内容即 init-indices.sh 的定义）。
#
# 用法：
#   scripts/migrate-origin-fields.sh
#   ES_URL=https://<ES_HOST>:9200 ES_DIR=/docker/dsh-es \
#     ES_CA=/path/ca.crt ES_USER=elastic ES_PASS=... scripts/migrate-origin-fields.sh
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
if ! printf '%s' "$TEMPLATE_JSON" | grep -q '"quarantine_reason"'; then
  echo 'init-indices.sh 的模板里没有 quarantine_reason —— 先把模板改好再迁移' >&2
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
    "origin":            { "type": "keyword" },
    "quarantine_reason": { "type": "keyword", "ignore_above": 256 }
  }
}
JSON
    echo "  [mapping] $idx ← origin / quarantine_reason"
  done
fi

echo '== 3/3 校验 =='
ok=1
tpl=$(es -X GET "$ES/_index_template/personal_memory_template")
for f in origin quarantine_reason; do
  printf '%s' "$tpl" | grep -q "\"$f\"" || { echo "  模板缺 $f" >&2; ok=0; }
done
for idx in ${indices:-}; do
  body=$(es -X GET "$ES/$idx/_mapping")
  for f in origin quarantine_reason; do
    printf '%s' "$body" | grep -q "\"$f\"" || { echo "  $idx 缺 $f" >&2; ok=0; }
  done
  printf '  %s: ok\n' "$idx"
done
if [ "$ok" != "1" ]; then
  exit 1
fi
echo '迁移完成：字段已就绪（缺失值按空处理，无需回填）'
