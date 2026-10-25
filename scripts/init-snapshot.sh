#!/usr/bin/env bash
# 配置 ES snapshot 仓库 + 每日自动快照（SLM）。幂等，可重复执行。
#
# 为什么不用「拷 data 目录」：运行中复制 Lucene 段会得到不一致状态，
# snapshot 是 ES 唯一保证一致性的备份方式，且增量。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ES_DIR="$ROOT/deploy/es"
ENV_FILE="$ES_DIR/.env"
CA="$ES_DIR/certs/ca.crt"
ES="https://127.0.0.1:9200"
PASS=$(grep '^ELASTIC_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
REPO=fs_repo
POLICY=dsh_memory_daily

es() { curl -sS --fail-with-body --cacert "$CA" -u "elastic:$PASS" -H 'Content-Type: application/json' "$@"; }

mkdir -p "$ES_DIR/snapshots"

echo "== 1/3 注册 snapshot 仓库 $REPO =="
# location 是相对路径，落在 path.repo 下：/usr/share/elasticsearch/snapshots/fs_repo
es -X PUT "$ES/_snapshot/$REPO" -d "{\"type\":\"fs\",\"settings\":{\"location\":\"$REPO\",\"compress\":true}}" >/dev/null
es -X POST "$ES/_snapshot/$REPO/_verify" -o /dev/null -w '  verify: HTTP %{http_code}\n'

echo "== 2/3 配置 SLM（每天北京 03:30 = UTC 19:30，保留 14 天，最少 3 个）=="
# 注意：ES 的 SLM cron 按 UTC 解释，写 03:30 会在北京 11:30 跑
es -X PUT "$ES/_slm/policy/$POLICY" -d @- >/dev/null <<'JSON'
{
  "schedule": "0 30 19 * * ?",
  "name": "<dsh-memory-{now/d}>",
  "repository": "fs_repo",
  "config": {
    "indices": ["personal_memory_*", "team_knowledge"],
    "include_global_state": true,
    "partial": false
  },
  "retention": { "expire_after": "14d", "min_count": 3, "max_count": 14 }
}
JSON
es -X GET "$ES/_slm/policy/$POLICY?filter_path=*.policy.schedule,*.next_execution_millis" \
  | python3 -c 'import sys,json; p=list(json.load(sys.stdin).values())[0]; print("  schedule=%s  next=%s" % (p.get("policy",{}).get("schedule"), p.get("next_execution_millis")))'

echo "== 3/3 立即触发一次快照 =="
if [ "${SKIP_SNAPSHOT:-0}" = "1" ]; then
  echo '  跳过（SKIP_SNAPSHOT=1）'
else
  SNAP="manual-$(date +%Y%m%d%H%M%S)"
  es -X PUT "$ES/_snapshot/$REPO/$SNAP?wait_for_completion=true" \
    -d '{"indices":["personal_memory_*","team_knowledge"],"include_global_state":true,"partial":false}' \
    | python3 -c 'import sys,json; s=json.load(sys.stdin)["snapshot"]; print("  %s: state=%s shards=%s/%s" % (s["snapshot"], s["state"], s["shards"]["successful"], s["shards"]["total"]))'
fi

echo '--- 现有快照 ---'
es -X GET "$ES/_snapshot/$REPO/_all?filter_path=snapshots.snapshot,snapshots.state" \
  | python3 -c 'import sys,json
rows=json.load(sys.stdin).get("snapshots",[])
print("\n".join("  %-34s %s" % (r["snapshot"], r["state"]) for r in rows) or "  (无)")'
echo '--- 磁盘产出 ---'
du -sh "$ES_DIR/snapshots" 2>/dev/null | sed 's/^/  /'
