#!/usr/bin/env bash
# 增加情绪相关字段（阶段 6.1 + 6.2）：
#   · mood_valence / mood_arousal / mood_updated_at / mood_events —— 固定文档 __mood__ 用的状态
#   · valence / arousal —— 单条记忆自带的情感色彩（可选，缺省不标）
#
# 为什么复用 personal_memory 而不是新开索引：新索引要改 init-user.sh 的精确授权列表
# 并重跑用户初始化；而状态文档用 status=mood，检索只认 status=active，天然不进结果。
#
# **不需要回填**：读不到就是中性态（valence=0）。
# 幂等：字段已存在时 PUT _mapping 是空操作。
#
# 用法：
#   scripts/migrate-mood-fields.sh [USER_ID]
#   ES_URL=... ES_CA=... ES_USER=... ES_PASS=... scripts/migrate-mood-fields.sh xqh
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
USER_ID="${1:-$(grep '^MEM_USER_ID=' "$ENV_FILE" | cut -d= -f2-)}"
USER_ID=${USER_ID:-xqh}
PERSONAL="personal_memory_$USER_ID"

es() { es_curl "$AUTH" --fail-with-body -H 'Content-Type: application/json' "$@"; }

echo "[mapping] $PERSONAL ← mood_valence / mood_arousal / mood_updated_at / mood_events"
es -X PUT "$ES/$PERSONAL/_mapping" -d @- >/dev/null <<'JSON'
{
  "properties": {
    "mood_valence":    { "type": "float" },
    "mood_arousal":    { "type": "float" },
    "mood_updated_at": { "type": "date" },
    "mood_events":     { "type": "object", "enabled": false },
    "valence":         { "type": "float" },
    "arousal":         { "type": "float" },
    "evidence_ids":    { "type": "object", "enabled": false },
    "traits_window_days": { "type": "integer" },
    "reviewed_at":     { "type": "date" },
    "reviewed_by":     { "type": "keyword" },
    "review_note":     { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart" }
  }
}
JSON
echo '  ok'

echo '== 校验 =='
body=$(es -X GET "$ES/$PERSONAL/_mapping")
ok=1
for f in mood_valence mood_arousal mood_updated_at mood_events valence arousal evidence_ids traits_window_days reviewed_at reviewed_by review_note; do
  echo "$body" | grep -q "\"$f\"" || { echo "  $f 缺失" >&2; ok=0; }
done
[ "$ok" = "1" ] && echo "  $PERSONAL: 情绪状态 + 记忆情感 + 提炼字段已就绪" || exit 1
