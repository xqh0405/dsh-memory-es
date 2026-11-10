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
#   ES_URL=https://<ES_HOST>:9200 ES_DIR=/docker/dsh-es scripts/migrate-journal-fields.sh
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

# 1) 模板：**现场提取** init-indices.sh 的那份（含 day / review_state）
#
# ⚠️ 这里原来内联手抄了一份 44 字段的模板，注释还写着「内容与 init-indices.sh 一致」——
#    实际 init-indices 是 51 字段，重跑一次会删掉 origin / pinned / quarantine_reason /
#    forget_reason / confirmed_use / corrections / feedback_at 共 7 个（2026-11-10 审查 P2/#18）。
#    `PUT _index_template` 是整体替换，手抄子集的代价是**延迟到新建索引才发作**。
#    改成与其余 5 个迁移脚本同款的现场提取，由 tests/template-sync.test.ts 钉住不复发。
TEMPLATE_JSON=$(awk '/<<'"'"'JSON'"'"'/{if(!started){started=1; next}} started && /^JSON$/{exit} started{print}' "$ROOT/scripts/init-indices.sh")
if ! printf '%s' "$TEMPLATE_JSON" | grep -q '"day"'; then
  echo 'init-indices.sh 的模板里没有 day —— 先把模板改好再迁移' >&2
  exit 1
fi
es -X PUT "$ES/_index_template/personal_memory_template" -d @- >/dev/null <<<"$TEMPLATE_JSON"
echo '  ok（模板与 init-indices.sh 同源）'

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
