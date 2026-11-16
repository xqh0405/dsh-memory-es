#!/usr/bin/env bash
# 阶段 39 的字段迁移：给个人记忆索引、团队索引与个人模板补失效语义三字段。
#
#   valid_until   —— 该条从什么时候起不再参与检索（date；缺省 = 不过期）
#   revoked_by    —— 被谁撤销/取代（memory_id，keyword）
#   revoke_reason —— 为什么失效（text，给人看，不进检索打分）
#
# 为什么必须先跑这个再上代码：个人索引与团队索引都是 `dynamic: strict`，
# `memory_update_status(supersede/expire)` 一旦写入这三个字段，缺字段直接 400
# （strict_dynamic_mapping_exception），而且失败是静默的——表现只是「改不动状态」。
#
# **不需要回填**：三个字段缺省即「没有失效」，代码按「字段缺失 = 不过滤」处理。
# 不做 reindex：`dynamic: strict` 下 PUT _mapping 加字段原地生效（阶段 0 已验证）。
#
# 模板的 JSON **现场从 init-indices.sh 提取**，不在这里抄第二份：
# 抄一份就会漂移（"幂等 ≠ 无害"：重跑脚本会覆盖别人追加的字段）。
#
# 幂等：字段已存在时 PUT _mapping 是空操作；模板整体替换（内容即 init-indices.sh 的定义）。
#
# 用法：
#   ES_URL=https://192.168.50.125:9200 \
#   ES_CA=~/.dsh/certs/dsh-es-lan-ca.crt \
#   ES_USER=mem-user-xqh ES_PASS=... scripts/migrate-validity-fields.sh
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

FIELDS='{ "properties": {
  "valid_until":   { "type": "date" },
  "revoked_by":    { "type": "keyword" },
  "revoke_reason": { "type": "text" }
} }'

# 从 init-indices.sh 现场提取个人记忆模板（第一个 heredoc）
TEMPLATE_JSON=$(awk '/<<'"'"'JSON'"'"'/{if(!started){started=1; next}} started && /^JSON$/{exit} started{print}' "$ROOT/scripts/init-indices.sh")
if ! printf '%s' "$TEMPLATE_JSON" | grep -q '"valid_until"'; then
  echo 'init-indices.sh 的个人模板里没有 valid_until —— 先把模板改好再迁移' >&2
  exit 1
fi

echo '== 1/3 模板 personal_memory_template =='
# `_index_template` 是**集群级**配置，需要 manage_index_templates —— 记忆账号（mem_admin）
# 没有这个权限，会 403。这不阻断索引级迁移：仓库里的 init-indices.sh 已含三字段，
# 新建索引由它创建即可；要立刻改线上模板，用 elastic 账号在 ES 主机上重跑本脚本。
tpl_updated=0
if printf '%s\n' "$TEMPLATE_JSON" | es -X PUT "$ES/_index_template/personal_memory_template" -d @- >/dev/null 2>/dev/null; then
  tpl_updated=1
  echo '  ok'
else
  echo '  ⚠ 跳过：当前账号无权改 _index_template（manage_index_templates）'
  echo '    → 仓库 init-indices.sh 已含三字段，新索引经它创建即可；'
  echo '    → 线上模板要立刻更新，需 elastic 账号执行本脚本。'
fi

echo '== 2/3 已存在的索引 =='
# `_cat/indices` 需要 cluster:monitor/state，普通记忆账号没有；`<pattern>/_mapping` 只要 view_index_metadata
indices=$(es "$ES/personal_memory_*/_mapping" 2>/dev/null \
  | grep -o '"personal_memory_[A-Za-z0-9_-]*"' | tr -d '"' | sort -u || true)
if [ -z "$indices" ]; then
  echo '  （没有 personal_memory_* 索引，跳过）'
fi
indices="$indices team_knowledge"

for idx in $indices; do
  es -X PUT "$ES/$idx/_mapping" -d "$FIELDS" >/dev/null
  echo "  [mapping] $idx ← valid_until / revoked_by / revoke_reason"
done

echo '== 3/3 校验 =='
ok=1
if [ "$tpl_updated" -eq 1 ]; then
  tpl=$(es -X GET "$ES/_index_template/personal_memory_template")
  for f in valid_until revoked_by revoke_reason; do
    printf '%s' "$tpl" | grep -q "\"$f\"" || { echo "  模板缺 $f" >&2; ok=0; }
  done
else
  echo '  （模板未更新，只校验索引级 mapping）'
fi
for idx in $indices; do
  body=$(es -X GET "$ES/$idx/_mapping")
  missing=''
  for f in valid_until revoked_by revoke_reason; do
    printf '%s' "$body" | grep -q "\"$f\"" || missing="$missing $f"
  done
  if [ -n "$missing" ]; then
    echo "  $idx 缺：$missing" >&2
    ok=0
  else
    printf '  %s: ok\n' "$idx"
  fi
done
if [ "$ok" -ne 1 ]; then
  echo '迁移未完成（见上面缺字段的索引）' >&2
  exit 1
fi
echo '全部完成'
