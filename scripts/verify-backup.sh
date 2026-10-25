#!/usr/bin/env bash
# 备份链验收：写探针文档 → 快照 → 恢复成临时索引 → 校验数据真的回来了 → 全部清理。
# 不验证恢复的备份等于没有备份，这个脚本就是那个"验证"。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ES_DIR="$ROOT/deploy/es"
ENV_FILE="$ES_DIR/.env"
CA="$ES_DIR/certs/ca.crt"
source "$(dirname "$0")/lib/curl-es.sh"
ES="https://127.0.0.1:9200"
PASS=$(grep '^ELASTIC_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
WRITE_PASS=$(grep '^MEM_WRITER_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
USER_ID=$(grep '^MEM_USER_ID=' "$ENV_FILE" | cut -d= -f2-)
USER_ID=${USER_ID:-xqh}
SRC="personal_memory_$USER_ID"
REPO=fs_repo

TS=$(date +%Y%m%d%H%M%S)
SNAP="verify-$TS"
RESTORED="verify_${TS}_${USER_ID}"
pass=0; fail=0
chk() { if [ "$2" = "$1" ]; then echo "  PASS $3"; pass=$((pass+1)); else echo "  FAIL [期望 $1 实际 $2] $3"; fail=$((fail+1)); fi; }

admin() { es_curl "elastic:$PASS" --fail-with-body -H 'Content-Type: application/json' "$@"; }
writer() { es_curl "mem-writer:$WRITE_PASS" --fail-with-body -H 'Content-Type: application/json' "$@"; }
jget() { python3 -c "import sys,json; d=json.load(sys.stdin); print(eval(\"d$1\"))" 2>/dev/null || echo ERR; }

echo "== 1/5 写一条探针文档（带 1024 维向量）=="
VEC=$(python3 -c 'import json,random; random.seed(1); v=[random.gauss(0,1) for _ in range(1024)]; n=sum(x*x for x in v)**0.5; print(json.dumps([x/n for x in v]))')
DOC=$(python3 - "$VEC" "$USER_ID" <<'PY'
import json, sys
vec = json.loads(sys.argv[1]); uid = sys.argv[2]
print(json.dumps({
  "memory_id": "backup-probe", "user_id": uid,
  "content": "备份探针：这条文档用来验证 snapshot → restore 之后数据真的能回来",
  "semantic_keywords": "备份 恢复 验证", "embedding": vec,
  "memory_type": "fact", "domain": "ops", "privacy": "normal",
  "promote_state": "none", "status": "active", "content_sha256": "backup-probe",
  "created_at": "2026-10-25T06:00:00Z", "updated_at": "2026-10-25T06:00:00Z",
}))
PY
)
code=$(writer -X PUT "$ES/$SRC/_doc/backup-probe?refresh=wait_for" -d "$DOC" -o /dev/null -w '%{http_code}')
chk 201 "$code" "探针文档写入个人索引"
SRC_COUNT=$(admin -X GET "$ES/$SRC/_count" | jget "['count']")
echo "  源索引文档数=$SRC_COUNT"

echo "== 2/5 触发快照 =="
admin -X PUT "$ES/_snapshot/$REPO/$SNAP?wait_for_completion=true" \
  -d "{\"indices\":[\"personal_memory_*\",\"team_knowledge\"],\"include_global_state\":true,\"partial\":false}" \
  | python3 -c 'import sys,json; s=json.load(sys.stdin)["snapshot"]; print("  %s state=%s shards=%s/%s" % (s["snapshot"], s["state"], s["shards"]["successful"], s["shards"]["total"]))'

echo "== 3/5 恢复到临时索引 =="
admin -X POST "$ES/_snapshot/$REPO/$SNAP/_restore?wait_for_completion=true" -d @- >/dev/null <<JSON
{
  "indices": "personal_memory_*",
  "rename_pattern": "personal_memory_(.+)",
  "rename_replacement": "verify_${TS}_\$1",
  "include_global_state": false,
  "ignore_unavailable": true
}
JSON
for i in $(seq 1 20); do
  st=$(admin -X GET "$ES/_cluster/health/$RESTORED" 2>/dev/null | jget "['status']" || echo none)
  [ "$st" = green ] || [ "$st" = yellow ] && break
  sleep 1
done
echo "  恢复目标 $RESTORED status=${st:-none}"

echo "== 4/5 校验恢复结果 =="
REST_COUNT=$(admin -X GET "$ES/$RESTORED/_count" 2>/dev/null | jget "['count']")
chk "$SRC_COUNT" "$REST_COUNT" "恢复后文档数与源一致（$SRC_COUNT）"
probe=$(admin -X GET "$ES/$RESTORED/_doc/backup-probe" 2>/dev/null | jget "['_source']['memory_id']")
chk "backup-probe" "$probe" "恢复后探针文档可读"
fields=$(admin -X GET "$ES/$RESTORED/_mapping" 2>/dev/null \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(list(d.values())[0]["mappings"]["properties"]))' 2>/dev/null || echo ERR)
chk 16 "$fields" "mapping 字段数=16（dims=1024 / ik 分析器随快照一起回来）"

echo "== 5/5 清理 =="
admin -X DELETE "$ES/$RESTORED" -o /dev/null -w '  删临时索引 HTTP %{http_code}\n'
admin -X DELETE "$ES/$SRC/_doc/backup-probe" -o /dev/null -w '  删探针文档 HTTP %{http_code}\n'
admin -X DELETE "$ES/_snapshot/$REPO/$SNAP" -o /dev/null -w '  删验证快照 HTTP %{http_code}\n'

echo
echo "结果：PASS=$pass FAIL=$fail"
[ "$fail" = 0 ]
