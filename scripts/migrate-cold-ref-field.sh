#!/usr/bin/env bash
# 审查 16b 的字段迁移：给文档索引与模板补 `cold_memory_id`。
#
# 为什么必须先跑这个再上代码：`personal_doc_*` 是 `dynamic: strict`，
# 归档时一旦开始写 `cold_memory_id`，缺字段直接 400 —— 而且会**静默**：
# 面板的归档流程会把这次 update 算进 failures，用户只看到「归档了但恢复时清不掉冷引用」。
#
# 字段语义：归档时把冷引用（那条「【已归档文档】…」记忆）的 memory_id 写回该 doc 的
# **全部切片**；恢复时按它对那条记忆做**精确**删除。没有它就只能按 content 模糊搜，
# 代价大且会误伤别的文档（review 16b 的根因）。
#
# **不需要回填**：老文档从来没有被归档过（或被归档时还没这个字段），留空是正确的语义。
# 所以本脚本只做「模板 + 每个已存在索引的 _mapping」，不跑 _update_by_query。
#
# 模板的 JSON **现场从 init-indices.sh 提取**，不在这里抄第二份：
# 抄一份就会漂移（"幂等 ≠ 无害"：重跑脚本会覆盖别人追加的字段）。
#
# 幂等：字段已存在时 PUT _mapping 是空操作；模板是整体替换（内容即 init-indices.sh 的定义）。
#
# 用法：
#   scripts/migrate-cold-ref-field.sh
#   # 连 125 的集群（本机 .114 的默认指向）：
#   ES_URL=https://192.168.50.125:9200 ES_CA=$HOME/.dsh/certs/dsh-es-lan-ca.crt \
#     ES_USER=mem-user-xqh ES_PASS=... scripts/migrate-cold-ref-field.sh
set -euo pipefail

FIELD=cold_memory_id
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
# 模板必须先有该字段：否则「模板管新建、脚本管存量」两条路会给出不同 schema
if ! printf '%s' "$TEMPLATE_JSON" | grep -q "\"$FIELD\""; then
  echo "init-indices.sh 的文档模板里没有 $FIELD —— 先把模板改好再迁移" >&2
  exit 1
fi
# 顺带自检：模板必须是**合法 JSON**（踩过：在 JSON 里写 // 注释会让整份解析失败）
if ! printf '%s' "$TEMPLATE_JSON" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
  echo 'init-indices.sh 里的 personal_doc_template 不是合法 JSON（别在里面写 // 注释）' >&2
  exit 1
fi

echo "== 1/4 模板 personal_doc_template =="
printf '%s\n' "$TEMPLATE_JSON" | es -X PUT "$ES/_index_template/personal_doc_template" -d @- >/dev/null
echo "  ok（含 $FIELD；同时把模板纳入版本管理）"

echo '== 2/4 已存在的文档索引 =='
indices=$(es "$ES/_cat/indices/personal_doc_*?h=index" 2>/dev/null || true)
if [ -z "$indices" ]; then
  echo '  （没有 personal_doc_* 索引，跳过）'
else
  for idx in $indices; do
    es -X PUT "$ES/$idx/_mapping" -d @- >/dev/null <<JSON
{
  "properties": {
    "$FIELD": { "type": "keyword" }
  }
}
JSON
    echo "  [mapping] $idx ← $FIELD"
  done
fi

echo '== 3/4 刷新（否则下面的 _count 读到的是旧统计）=='
es -X POST "$ES/personal_doc_*/_refresh" >/dev/null && echo '  refreshed'

echo '== 4/4 校验 =='
ok=1
tpl=$(es -X GET "$ES/_index_template/personal_doc_template")
printf '%s' "$tpl" | grep -q "\"$FIELD\"" || { echo "  模板缺 $FIELD" >&2; ok=0; }
for idx in ${indices:-}; do
  body=$(es -X GET "$ES/$idx/_mapping")
  if printf '%s' "$body" | grep -q "\"$FIELD\""; then
    # 统计：切片数 / 已有该字段的条数（老文档应为 0，这是**预期**，不是失败）
    total=$(es "$ES/$idx/_count" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("count","?"))' 2>/dev/null || echo '?')
    filled=$(es "$ES/$idx/_count" -d "{\"query\":{\"exists\":{\"field\":\"$FIELD\"}}}" \
      | python3 -c 'import json,sys;print(json.load(sys.stdin).get("count","?"))' 2>/dev/null || echo '?')
    printf '  %s: mapping ok，%s 切片（其中 %s 条已有值；老文档为空是正常的）\n' "$idx" "$total" "$filled"
  else
    echo "  $idx 缺 $FIELD" >&2
    ok=0
  fi
done
[ "$ok" = "1" ] || exit 1
echo '✓ 迁移完成：可以上「归档写 cold_memory_id / 恢复清冷引用」的代码了'
