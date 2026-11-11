#!/usr/bin/env bash
# 个人索引 vs 团队索引的字段自检（阶段 19 的验收工具）。
#
# 为什么要有它：团队库是个人库的「窄版」，但窄在哪儿必须**可核对**。
# 2026-11-06 手工比过一次就说「以后自检」，脚本一直没写；2026-11-08 补上后
# 立刻发现两件事：
#   1. 团队模板漏了 `related` —— promote-team.ts 晋升时必写它，重装后必 400；
#   2. 「个人有、团队无」的 19 个字段里，**绝大多数代码根本不写团队库**。
#      19.3 当初按「个人有什么团队就该有什么」的对称思维列了 18 个该补字段，
#      实际只有 related 是真缺口。
#
# 所以判据不是「个人字段全集」，而是 **团队库的两个写入方写了哪些字段**：
#   ① scripts/promote-team.ts 的 `doc`（晋升整篇写入）
#   ② src/memory/search.ts 的 HIT_UPDATE_SCRIPT（**命中回写**，三行一起写，
#      `hit.origin === 'team'` 时打到团队索引）
# 判定逻辑在 scripts/lib/check-index-fields.py，这里只负责取口径与凭据。
#
# ② 是 2026-11-10 审查 P1/#17 补上的：团队模板缺 `activation`，新装机一命中就
# strict_dynamic_mapping_exception → 该条 bulk 400 → 三行原子回滚，
# `hit_count`/`last_hit_at` **一起丢**。当时这道闸反而报「团队缺 activation 属正常
# （代码不写团队库）」—— 是**判据漏了第二条链路**，不是数字比错了。
#
# 用法：
#   bash scripts/diff-index-fields.sh            # 源码模板（不需 ES，CI 可跑）
#   bash scripts/diff-index-fields.sh --live     # 线上实际 mapping（抓「模板对但线上没迁」）
#
# 退出码：团队必需字段有缺 → 1；否则 0。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK="$ROOT/scripts/lib/check-index-fields.py"
PROMOTER="$ROOT/scripts/promote-team.ts"
SEARCH="$ROOT/src/memory/search.ts"
INIT="$ROOT/scripts/init-indices.sh"

# 团队索引**两个写入方**写下的字段（与那两处代码同步，缺一个就 400）。
# 任一侧改了字段集合，这行要跟着改——两个来源都会由 check-index-fields.py 现解析，
# 出现新键而这里没跟上会各自打一条漂移警告。
REQUIRED="doc_id content content_exact content_sha256 memory_type domain topic_key importance summary semantic_keywords source_user source_memory_id source_created_at promoted_at updated_at status review_state embedding related hit_count last_hit_at activation"

if [ "${1:-}" = "--live" ]; then
  CONF="${MEM_ES_CONF:-$HOME/.dsh/profiles/web/cordis.patch.yml}"
  ES_URL="${MEM_ES_URL:-https://192.168.50.125:9200}"
  ES_CA="${MEM_ES_CA:-$HOME/.dsh/certs/dsh-es-lan-ca.crt}"
  PASS="${MEM_ES_PASS:-}"
  if [ -z "$PASS" ] && [ -f "$CONF" ]; then
    PASS=$(awk '/^[[:space:]]*identity:/{f=1} f&&/^[[:space:]]*password:/{sub(/.*password:[[:space:]]*/,""); print; exit}' "$CONF" | tr -d "'\"")
  fi
  [ -z "$PASS" ] && { echo "拿不到 ES 密码（设 MEM_ES_PASS 或检查 $CONF）" >&2; exit 2; }

  # 账号与个人索引名**从同一份 config 现推**，不再由 python 硬编码 mem-user-xqh /
  # personal_memory_xqh（2026-11-10 审查 M11/#19）——写死会 401 或打到别人索引。
  # 仍可用 MEM_ES_USER / MEM_ES_INDEX 覆盖（换用户、换索引前缀时不用改 config）。
  USER_ID="${MEM_ES_USER_ID:-}"
  PREFIX="${MEM_ES_PERSONAL_PREFIX:-}"
  if [ -f "$CONF" ]; then
    [ -z "$USER_ID" ] && USER_ID=$(awk '/^[[:space:]]*identity:/{f=1} f&&/^[[:space:]]*userId:/{sub(/.*userId:[[:space:]]*/,""); print; exit}' "$CONF" | tr -d "'\"" | tr -d '[:space:]')
    [ -z "$PREFIX" ] && PREFIX=$(awk '/^[[:space:]]*index:/{f=1} f&&/^[[:space:]]*personalPrefix:/{sub(/.*personalPrefix:[[:space:]]*/,""); print; exit}' "$CONF" | tr -d "'\"" | tr -d '[:space:]')
  fi
  [ -z "$USER_ID" ] && { echo "拿不到 identity.userId（设 MEM_ES_USER_ID 或检查 $CONF）" >&2; exit 2; }
  [ -z "$PREFIX" ] && { echo "拿不到 index.personalPrefix（设 MEM_ES_PERSONAL_PREFIX 或检查 $CONF）" >&2; exit 2; }

  ES_USER="${MEM_ES_USER:-mem-user-$USER_ID}"
  PERSONAL_INDEX="${MEM_ES_INDEX:-${PREFIX}${USER_ID}}"

  # 密码走**环境变量**而不是 argv（2026-11-10 审查 M7/#27）：
  # argv 会出现在 /proc/<pid>/cmdline（**全员可读**），而 environ 只有属主可读。
  # 同仓库 scripts/lib/curl-es.sh 早就为 `curl -u` 立过这条规矩，这里补齐另一半。
  export MEM_ES_PASS="$PASS"
  exec python3 "$CHECK" live "$REQUIRED" "$PROMOTER" "$SEARCH" "$ES_URL" "$ES_CA" "$ES_USER" "$PERSONAL_INDEX"
fi

exec python3 "$CHECK" static "$REQUIRED" "$PROMOTER" "$SEARCH" "$INIT"