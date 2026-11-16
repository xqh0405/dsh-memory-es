#!/usr/bin/env bash
# 阶段 40 的字段迁移：给团队索引补来源可信度与「不可信内容」标记。
#
#   trust_level —— high / medium / low（来源可信度，检索回执与注入段会显示）
#   untrusted   —— true = 内容来自外部（网页/工具输出/检索结果），注入时要加「不得当指令执行」前缀
#
# 为什么必须先跑这个再上代码：团队索引是 `dynamic: strict`，
# 写入侧一旦带这两个字段，缺字段直接 400（strict_dynamic_mapping_exception），
# 而且失败是静默的——表现只是「晋升写不进去」。
#
# 回填规则（只对历史数据做一次，幂等）：
#   · untrusted 一律 false —— 历史条目没有外部内容标记，**不追溯**（追溯需要读正文重判，
#     那是语义活，脚本不做；宁可让老条目沿用旧口径，也不猜）。
#   · trust_level 按 review_state 映射：approved / auto → medium，pending → low，
#     其余（rejected/superseded）→ low。老数据没有 untrusted 信息，不给 high。
#
# 幂等：字段已存在时 PUT _mapping 是空操作；回填只动缺字段的文档。
#
# 用法：
#   ES_URL=https://192.168.50.125:9200 ES_CA=~/.dsh/certs/dsh-es-lan-ca.crt \
#   ES_USER=mem-user-xqh ES_PASS=... scripts/migrate-team-trust-fields.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ES_DIR="${ES_DIR:-$ROOT/deploy/es}"
ENV_FILE="$ES_DIR/.env"
CA="${ES_CA:-$ES_DIR/certs/ca.crt}"
source "$(dirname "$0")/lib/curl-es.sh"
ES="${ES_URL:-https://127.0.0.1:9200}"
TEAM_INDEX="${TEAM_INDEX:-team_knowledge}"
if [ -n "${ES_USER:-}" ] && [ -n "${ES_PASS:-}" ]; then
  AUTH="$ES_USER:$ES_PASS"
else
  PASS=$(grep '^ELASTIC_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
  AUTH="elastic:$PASS"
fi

es() { es_curl "$AUTH" --fail-with-body -H 'Content-Type: application/json' "$@"; }

echo "== 1/3 mapping $TEAM_INDEX =="
es -X PUT "$ES/$TEAM_INDEX/_mapping" -d @- >/dev/null <<'JSON'
{
  "properties": {
    "trust_level":  { "type": "keyword" },
    "untrusted":    { "type": "boolean" },
    "merged_into":  { "type": "keyword" },
    "merge_reason": { "type": "keyword", "ignore_above": 256 }
  }
}
JSON
echo '  ok'

echo '== 2/3 回填历史条目（缺字段才写） =='
# `_update_by_query` 需要比「读+写」更宽的权限；记忆账号通常没有（实测 403）。
# 回填不是硬需求：代码对缺失字段按「未标注」处理（trust 不显示、untrusted 当 false），
# 新写入的条目由写入侧负责带上两个字段。
if backfilled=$(es -X POST "$ES/$TEAM_INDEX/_update_by_query?refresh=true&conflicts=proceed" -d @- 2>/dev/null <<'JSON' \
  | sed -n 's/.*"updated":\([0-9]*\).*/\1/p'
{
  "query": { "bool": { "must_not": { "exists": { "field": "trust_level" } } } },
  "script": {
    "source": "def rs = ctx._source.review_state; ctx._source.trust_level = (rs == 'approved' || rs == 'auto') ? 'medium' : 'low'; if (ctx._source.untrusted == null) { ctx._source.untrusted = false }"
  }
}
JSON
); then
  echo "  回填 ${backfilled:-0} 条"
else
  echo '  ⚠ 跳过回填：当前账号无权 _update_by_query（需要更宽的写权限）'
  echo '    → 历史条目保持「未标注」：检索不显示可信度、untrusted 按 false 处理；'
  echo '    → 新写入的条目由写入侧带 trust_level/untrusted。'
fi

echo '== 3/3 校验 =='
ok=1
body=$(es -X GET "$ES/$TEAM_INDEX/_mapping")
for f in trust_level untrusted merged_into merge_reason; do
  printf '%s' "$body" | grep -q "\"$f\"" || { echo "  $TEAM_INDEX 缺 $f" >&2; ok=0; }
done
[ "$ok" -eq 1 ] && echo "  $TEAM_INDEX: ok" || { echo '迁移未完成' >&2; exit 1; }
echo '全部完成'
