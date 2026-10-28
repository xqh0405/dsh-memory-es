#!/usr/bin/env bash
# 配置 ES snapshot 仓库 + 每日自动快照（SLM）。幂等，可重复执行。
#
# 为什么不用「拷 data 目录」：运行中复制 Lucene 段会得到不一致状态，
# snapshot 是 ES 唯一保证一致性的备份方式，且增量。
#
# 两套部署共用本脚本，靠环境变量区分（曾因写死路径，.125 上从没跑起来过）：
#   .114 本机：ES_DIR=<repo>/deploy/es        ES=https://127.0.0.1:9200
#   .125 内网：ES_DIR=/docker/dsh-es          ES=https://192.168.1.125:9200
# 例：ES_DIR=/docker/dsh-es ES=https://192.168.1.125:9200 bash scripts/init-snapshot.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ES_DIR="${ES_DIR:-$ROOT/deploy/es}"
ENV_FILE="$ES_DIR/.env"
CA="$ES_DIR/certs/ca.crt"
ES="${ES:-https://127.0.0.1:9200}"
source "$(dirname "$0")/lib/curl-es.sh"
PASS=$(grep '^ELASTIC_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
REPO="${REPO:-fs_repo}"
POLICY="${POLICY:-dsh_memory_daily}"

# 索引清单从 .env 派生，别写死：.125 上除记忆与团队库，还多了个人文档库（personal_doc_*）
# 与审计库（memory_audit）。只备份记忆库的话，恢复回来文档全丢。
env_get() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -1 | tr -d '\r'; }
pick() { local v="${1:-}"; shift; local k; for k in "$@"; do [ -n "$v" ] && break; v=$(env_get "$k"); done; printf '%s' "$v"; }

PERSONAL_PREFIX=$(pick "${MEM_PERSONAL_PREFIX:-}" MEM_PERSONAL_PREFIX); PERSONAL_PREFIX=${PERSONAL_PREFIX:-personal_memory_}
DOC_PREFIX=$(pick "${MEM_DOC_PREFIX:-}" MEM_DOC_PREFIX);             DOC_PREFIX=${DOC_PREFIX:-personal_doc_}
TEAM_INDEX=$(pick "${MEM_TEAM_INDEX:-}" MEM_TEAM_INDEX);             TEAM_INDEX=${TEAM_INDEX:-team_knowledge}
AUDIT_INDEX=$(pick "${MEM_AUDIT_INDEX:-}" MEM_AUDIT_INDEX);          AUDIT_INDEX=${AUDIT_INDEX:-memory_audit}
INDICES_JSON=$(printf '["%s*","%s*","%s","%s"]' "$PERSONAL_PREFIX" "$DOC_PREFIX" "$TEAM_INDEX" "$AUDIT_INDEX")

es() { es_curl "elastic:$PASS" --fail-with-body -H 'Content-Type: application/json' "$@"; }

mkdir -p "$ES_DIR/snapshots"
# 快照里含 .security 相关状态（用户/角色/密码哈希），产出目录不能给别的用户读
chmod 700 "$ES_DIR/snapshots"

echo "== 0/4 目标 =="
echo "  ES      : $ES"
echo "  目录    : $ES_DIR/snapshots"
echo "  索引    : $INDICES_JSON"

echo "== 1/4 注册 snapshot 仓库 $REPO =="
# location 是相对路径，落在 path.repo 下：<path.repo>/fs_repo
es -X PUT "$ES/_snapshot/$REPO" -d "{\"type\":\"fs\",\"settings\":{\"location\":\"$REPO\",\"compress\":true}}" >/dev/null
es -X POST "$ES/_snapshot/$REPO/_verify" -o /dev/null -w '  verify: HTTP %{http_code}\n'

echo "== 2/4 配置 SLM（每天北京 03:30 = UTC 19:30，保留 14 天，最少 3 个）=="
# 注意：ES 的 SLM cron 按 UTC 解释，写 03:30 会在北京 11:30 跑
es -X PUT "$ES/_slm/policy/$POLICY" -d @- >/dev/null <<JSON
{
  "schedule": "0 30 19 * * ?",
  "name": "<dsh-memory-{now/d}>",
  "repository": "$REPO",
  "config": {
    "indices": $INDICES_JSON,
    "include_global_state": true,
    "partial": false
  },
  "retention": { "expire_after": "14d", "min_count": 3, "max_count": 14 }
}
JSON
es -X GET "$ES/_slm/policy/$POLICY?filter_path=*.policy.schedule,*.next_execution_millis" \
  | python3 -c 'import sys,json; p=list(json.load(sys.stdin).values())[0]; print("  schedule=%s  next=%s" % (p.get("policy",{}).get("schedule"), p.get("next_execution_millis")))'

echo "== 3/4 立即触发一次快照 =="
if [ "${SKIP_SNAPSHOT:-0}" = "1" ]; then
  echo '  跳过（SKIP_SNAPSHOT=1）'
else
  SNAP="manual-$(date +%Y%m%d%H%M%S)"
  es -X PUT "$ES/_snapshot/$REPO/$SNAP?wait_for_completion=true" \
    -d "{\"indices\":$INDICES_JSON,\"include_global_state\":true,\"partial\":false}" \
    | python3 -c 'import sys,json; s=json.load(sys.stdin)["snapshot"]; print("  %s: state=%s shards=%s/%s" % (s["snapshot"], s["state"], s["shards"]["successful"], s["shards"]["total"]))'
fi

echo '== 4/4 核对 =='
echo '--- 仓库 ---'
es -X GET "$ES/_snapshot/$REPO?filter_path=*.settings.location,*.settings.compress" | sed 's/^/  /'
echo '--- 现有快照 ---'
es -X GET "$ES/_snapshot/$REPO/_all?filter_path=snapshots.snapshot,snapshots.state,snapshots.start_time_in_millis" \
  | python3 -c 'import sys,json
rows=json.load(sys.stdin).get("snapshots",[])
print("\n".join("  %-40s %s" % (r["snapshot"], r["state"]) for r in rows) or "  (无)")'
echo '--- 磁盘产出 ---'
du -sh "$ES_DIR/snapshots" 2>/dev/null | sed 's/^/  /'
