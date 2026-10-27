#!/usr/bin/env bash
# dsh-memory-es 每日巡检（**只读**：不写库、不改配置、不触发整理）
#
# 用法：
#   scripts/daily-report.sh              # 看昨天（24h）调用 + 7 日对照
#   scripts/daily-report.sh --days 7     # 窗口改成 7 天
#   MEM_ES_URL=... MEM_ES_CA=... scripts/daily-report.sh   # 换一套部署
#
# 口径备注（踩过的坑，别改回去）：
#   1. 会话文件名是 session.v4.jsonl.zstd，不是 v3 —— 写死 v3 会永远统计到 0；
#      用 session.v*.jsonl.zstd 通配才兼容新旧格式。
#   2. 统计"真实调用"必须走 `type=="tool/call"` 的 `.data.name`。
#      直接 grep 工具名会把工具定义和系统提示段算进去：实测同一窗口
#      grep 出来 1346 次，真实调用只有 6 次（差 224 倍）。
#   3. ES 凭据从 profile 的 cordis.patch.yml 读（600），不落盘、不 echo；
#      本脚本在任何分支都不打印密码。
#   4. ES 不可达时明确标记「跳过」并返回非零，**不冒充成功**。
set -uo pipefail

DAYS=1
while [ $# -gt 0 ]; do
  case "$1" in
    --days) DAYS="${2:-1}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

SESS_ROOT="${DSH_SESSIONS:-/data/dsh/sessions}"
CONF="${MEM_ES_CONF:-/data/dsh/profiles/web/cordis.patch.yml}"
ES_URL="${MEM_ES_URL:-https://dsh-es:9200}"
ES_CA="${MEM_ES_CA:-/home/node/ca-memory-es.crt}"
MEM_USER="${MEM_ES_USER:-mem-user-xqh}"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
kv()   { printf '  %-26s %s\n' "$1" "$2"; }
warn() { printf '  \033[33m⚠ %s\033[0m\n' "$*"; }

# ── 会话侧 ────────────────────────────────────────────────────────────────
bold "① 记忆工具调用（近 ${DAYS} 天，tool/call 口径）"

if [ ! -d "$SESS_ROOT" ]; then
  warn "会话目录不存在：$SESS_ROOT（用 DSH_SESSIONS 指定）"
  SESS_TOTAL=0
else
  SESS_TOTAL=$(find "$SESS_ROOT" -name 'session.v*.jsonl.zstd' -mtime -"$DAYS" 2>/dev/null | wc -l)
  CALLS=$(find "$SESS_ROOT" -name 'session.v*.jsonl.zstd' -mtime -"$DAYS" -print0 2>/dev/null \
    | xargs -0 -n1 -P6 sh -c 'zstd -dc "$0" 2>/dev/null | jq -r "select(.type==\"tool/call\") | .data.name" 2>/dev/null' \
    | sort | uniq -c | sort -rn)
  MEM_CALLS=$(printf '%s\n' "$CALLS" | grep -E '^\s+[0-9]+ memory_' || true)
  MEM_SUM=$(printf '%s\n' "$MEM_CALLS" | awk '{s+=$1} END{print s+0}')

  kv "会话数" "$SESS_TOTAL"
  kv "记忆工具总调用" "$MEM_SUM"
  if [ -n "$MEM_CALLS" ]; then
    printf '%s\n' "$MEM_CALLS" | awk '{printf "    %-24s %s\n", $2, $1}'
  fi
  kv "全部工具调用 Top5" "$(printf '%s\n' "$CALLS" | head -5 | awk '{printf "%s(%s) ", $2, $1}')"

  if [ "$MEM_SUM" -eq 0 ]; then
    warn "近 ${DAYS} 天零调用 —— 先修「该存没存」，别调阈值"
  elif [ "$SESS_TOTAL" -gt 0 ]; then
    SESS_WITH=$(find "$SESS_ROOT" -name 'session.v*.jsonl.zstd' -mtime -"$DAYS" -print0 2>/dev/null \
      | xargs -0 -n1 -P6 sh -c 'zstd -dc "$0" 2>/dev/null | jq -e "select(.type==\"tool/call\" and (.data.name|tostring|startswith(\"memory_\")))" >/dev/null 2>&1 && echo x' \
      | wc -l)
    kv "有记忆调用的会话" "${SESS_WITH}/${SESS_TOTAL}"
  fi
fi

# ── ES 侧 ─────────────────────────────────────────────────────────────────
bold "② 库存（ES）"

MEM_PASS="${MEM_ES_PASS:-}"
if [ -z "$MEM_PASS" ] && [ -f "$CONF" ]; then
  MEM_PASS=$(awk '/^[[:space:]]*identity:/{f=1} f&&/^[[:space:]]*password:/{sub(/.*password:[[:space:]]*/,""); print; exit}' "$CONF" | tr -d "'\"")
fi

if [ -z "$MEM_PASS" ]; then
  warn "拿不到 ES 密码（跳过 ES 段）：设 MEM_ES_PASS 或检查 $CONF"
  OWNER="${MEM_USER#mem-user-}"
  PC="personal_memory_${OWNER}"
else
  es() { curl -s --max-time 8 --cacert "$ES_CA" -u "$MEM_USER:$MEM_PASS" -H 'Content-Type: application/json' "$@"; }
  OWNER="${MEM_USER#mem-user-}"
  PC="personal_memory_${OWNER}"

  if ! es "$ES_URL/$PC/_count" | grep -q '"count"'; then
    warn "ES 不可达（$ES_URL）—— 跳过库存段。容器网络/CA 见插件配置注释"
    MEM_PASS=""
  else
    TOTAL=$(es "$ES_URL/$PC/_count" | jq -r '.count // "?"')
    kv "个人库文档数（$PC）" "$TOTAL"

    AGG=$(es "$ES_URL/$PC/_search?size=0" -d '{
      "aggs":{
        "status":{"terms":{"field":"status"}},
        "type":{"terms":{"field":"memory_type","size":8}},
        "privacy":{"terms":{"field":"privacy"}},
        "recent":{"filter":{"range":{"created_at":{"gte":"now-'7'd"}}}}
      }}')
    kv "status" "$(printf '%s' "$AGG" | jq -r '[.aggregations.status.buckets[]?|"\(.key)=\(.doc_count)"]|join(" ")' )"
    kv "memory_type" "$(printf '%s' "$AGG" | jq -r '[.aggregations.type.buckets[]?|"\(.key)=\(.doc_count)"]|join(" ")' )"
    kv "privacy" "$(printf '%s' "$AGG" | jq -r '[.aggregations.privacy.buckets[]?|"\(.key)=\(.doc_count)"]|join(" ")' )"
    kv "近 7 日新增" "$(printf '%s' "$AGG" | jq -r '.aggregations.recent.doc_count // 0')"

    # type 偏斜哨兵：单一类型 >90% 说明抽取或迁移写歪了
    TYPES=$(printf '%s' "$AGG" | jq -r '.aggregations.type.buckets[0]? | "\(.key) \(.doc_count)"')
    TOP_T=$(echo "$TYPES" | awk '{print $1}'); TOP_N=$(echo "$TYPES" | awk '{print $2}')
    if [ -n "$TOP_N" ] && [ "$TOTAL" != "?" ] && [ "$TOTAL" -gt 20 ] 2>/dev/null; then
      PCT=$(( TOP_N * 100 / TOTAL ))
      [ "$PCT" -ge 90 ] && warn "memory_type 偏斜：${TOP_T} 占 ${PCT}%（>90% 要查迁移默认值/抽取偏科）"
    fi

    # 最新写入哨兵：库再大，最近没写就是链路断了。
    # P0 的教训：库里 251 条全是迁移来的，连续 9 天零新增却没人发现——只看总量永远看不出「写入已死」。
    LATEST=$(es "$ES_URL/$PC/_search?size=1&sort=created_at:desc&_source=created_at" 2>/dev/null | jq -r '.hits.hits[0]["_source"].created_at // ""' 2>/dev/null)
    if [ -n "$LATEST" ]; then
      EP=$(date -d "$LATEST" +%s 2>/dev/null || echo 0)
      if [ "$EP" -gt 0 ] 2>/dev/null; then AGE_D=$(( ( $(date +%s) - EP ) / 86400 )); else AGE_D="?"; fi
      kv "最新一条写入" "$LATEST（${AGE_D} 天前）"
      if [ "$AGE_D" != "?" ] && [ "$AGE_D" -ge 3 ] 2>/dev/null; then
        warn ">3 天零新增：先查写入链路，别急着加治理功能"
      fi
    fi

    # 团队库
    TC=$(es "$ES_URL/team_knowledge/_count" | jq -r '.count // "?"')
    PEND=$(es "$ES_URL/team_knowledge/_count" -d '{"query":{"term":{"review_state":"pending"}}}' 2>/dev/null | jq -r '.count // 0')
    kv "团队库文档数" "$TC"
    kv "待审队列（pending）" "$PEND"
    [ "${PEND:-0}" -gt 0 ] 2>/dev/null && warn "有 ${PEND} 条待审：不过审就永远不进检索（cli --review list）"

    # 审计流水
    AUD=$(es "$ES_URL/memory_audit/_search?size=0" -d "{\"query\":{\"range\":{\"at\":{\"gte\":\"now-7d\"}}},\"aggs\":{\"e\":{\"terms\":{\"field\":\"event\"}}}}" 2>/dev/null)
    kv "审计事件（近 7 天）" "$(printf '%s' "$AUD" | jq -r '[.aggregations.e.buckets[]?|"\(.key)=\(.doc_count)"]|join(" ")' 2>/dev/null)"
  fi
fi

# ── 仍缺的指标（诚实标注） ─────────────────────────────────────────────────
bold "③ 尚未自动化的指标"
printf '  %s\n' \
  "检索空结果率 / P95 耗时：插件未埋点，需解析 tool/result（按 callId 配对），暂未实现" \
  "重复交代率：人工看哨兵词（我上次说过/又忘了/说了多少遍），或每日人工归因" \
  "入库质量：每日抽 5 条新记忆人工判「明天能不能直接用」（自包含/长度/一条一件事）"

[ -z "${MEM_PASS:-}" ] && exit 1
exit 0
