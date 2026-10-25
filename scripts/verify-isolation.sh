#!/usr/bin/env bash
# M1 判据的可执行版：验证 per-user 索引的隔离、写边界、以及 kNN/BM25 端到端可用。
# 会临时创建 personal_memory_other 与测试文档，结束时全部清理。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ES_DIR="$ROOT/deploy/es"
ENV_FILE="$ES_DIR/.env"
CA="$ES_DIR/certs/ca.crt"
source "$(dirname "$0")/lib/curl-es.sh"
ES="https://127.0.0.1:9200"
PASS=$(grep '^ELASTIC_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
USER_ID=$(grep '^MEM_USER_ID=' "$ENV_FILE" | cut -d= -f2-)
USER_ID=${USER_ID:-xqh}
# 认证走 Basic Auth（用户名+密码），不用 API key：灾备重建后密码不变、客户端零改动
READ_USER="mem-reader-$USER_ID"
READ_PASS=$(grep '^MEM_READER_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
WRITE_PASS=$(grep '^MEM_WRITER_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
CONS_PASS=$(grep '^MEM_CONSOLIDATOR_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
PERSONAL="personal_memory_$USER_ID"
OTHER="personal_memory_other"

pass=0; fail=0
chk() { # chk <期望码> <实际码> <说明>
  if [ "$2" = "$1" ]; then echo "  PASS [$2] $3"; pass=$((pass+1));
  else echo "  FAIL [期望 $1 实际 $2] $3"; fail=$((fail+1)); fi
}
cred_of() { # cred_of <凭证类型> → 输出 user:pass（只进临时配置文件，不进 argv）
  case "$1" in
    admin) echo "elastic:$PASS" ;;
    read)  echo "$READ_USER:$READ_PASS" ;;
    write) echo "mem-writer:$WRITE_PASS" ;;
    cons)  echo "mem-consolidator:$CONS_PASS" ;;
    *) echo "未知凭证类型: $1" >&2; return 2 ;;
  esac
}
code() { # code <凭证类型> <method> <path> [body]
  local auth=$1 method=$2 path=$3 body=${4:-}
  local cred
  cred=$(cred_of "$auth") || return 2
  if [ -n "$body" ]; then
    es_curl "$cred" -o /dev/null -w '%{http_code}' \
      -H 'Content-Type: application/json' -X "$method" "$ES$path" -d "$body"
  else
    es_curl "$cred" -o /dev/null -w '%{http_code}' -X "$method" "$ES$path"
  fi
}

echo '== 准备：造一个他人索引 + 一条文档 =='
code admin DELETE "/$OTHER" >/dev/null 2>&1
code admin PUT "/$OTHER" '{}' >/dev/null
code admin PUT "/$OTHER/_doc/foreign-1?refresh=true" \
  '{"memory_id":"foreign-1","user_id":"other","content":"别人的记忆","status":"active"}' >/dev/null

echo '== A. 读隔离 =='
chk 200 "$(code read GET "/$PERSONAL/_search?size=1")" "本人 key 读自己的索引"
chk 200 "$(code read GET '/team_knowledge/_search?size=1')" "本人 key 读团队库"
chk 403 "$(code read GET "/$OTHER/_search?size=1")" "本人 key 读他人索引（必须 403）"
chk 403 "$(code read GET "/$OTHER/_doc/foreign-1")" "本人 key get 他人文档（必须 403）"

echo '== B. 写边界 =='
chk 403 "$(code read PUT "/$PERSONAL/_doc/read-write-probe?refresh=false" \
  '{"memory_id":"p1","user_id":"'"$USER_ID"'","content":"本人 key 写入","status":"active"}')" \
  "本人 key 写自己的索引（必须 403，个人 key 只读）"
chk 403 "$(code write PUT '/team_knowledge/_doc/writer-probe' \
  '{"doc_id":"d1","content":"writer 写团队库","status":"active"}')" \
  "writer 写团队库（必须 403，只走整理服务）"
chk 201 "$(code write PUT "/$PERSONAL/_doc/writer-probe?refresh=true" \
  '{"memory_id":"writer-probe","user_id":"'"$USER_ID"'","content":"writer 写入的测试文档","status":"active","content_sha256":"x"}')" \
  "writer 写个人库（应当 201）"
chk 201 "$(code cons PUT '/team_knowledge/_doc/cons-probe?refresh=true' \
  '{"doc_id":"cons-probe","content":"consolidator 写入的测试文档","status":"active","source_user":"'"$USER_ID"'"}')" \
  "consolidator 写团队库（应当 201）"

echo '== C. 检索链路（IK + dense_vector + kNN）=='
vec=$(curl -sS --max-time 60 http://127.0.0.1:11434/api/embeddings \
      -d '{"model":"bge-m3","prompt":"北单中断开奖必须同时写 win_price 和 win_price_practical"}' \
      | python3 -c 'import sys,json;e=json.load(sys.stdin)["embedding"];print(json.dumps(e))')
doc=$(python3 - "$vec" <<'PY'
import json,sys
vec=json.loads(sys.argv[1])
print(json.dumps({
  "memory_id":"knn-probe","user_id":"xqh",
  "content":"北单中断开奖必须同时写 win_price 和 win_price_practical，否则按 practical 统计的中奖会算 0",
  "embedding":vec,"memory_type":"fact","domain":"lottery-cloud",
  "privacy":"normal","promote_state":"none","status":"active",
  "content_sha256":"knn-probe","created_at":"2026-10-25T04:00:00Z","updated_at":"2026-10-25T04:00:00Z"
}))
PY
)
chk 201 "$(code write PUT "/$PERSONAL/_doc/knn-probe?refresh=true" "$doc")" "写入带 1024 维向量的记忆"

knn_body=$(python3 - "$vec" <<'PY'
import json,sys
vec=json.loads(sys.argv[1])
print(json.dumps({"knn":{"field":"embedding","query_vector":vec,"k":3,"num_candidates":10},
                  "size":1,"_source":["memory_id","content"]}))
PY
)
top=$(es_curl "$READ_USER:$READ_PASS" -H 'Content-Type: application/json' \
  -X POST "$ES/$PERSONAL/_search" -d "$knn_body" \
  | python3 -c 'import sys,json;h=json.load(sys.stdin)["hits"]["hits"];print(h[0]["_source"]["memory_id"] if h else "NONE")')
chk knn-probe "$top" "kNN 用中文问句召回命中（换说法）"

bm25=$(es_curl "$READ_USER:$READ_PASS" -H 'Content-Type: application/json' \
  -X POST "$ES/$PERSONAL/_search" \
  -d '{"query":{"match":{"content":"win_price_practical"}},"size":1,"_source":["memory_id"]}' \
  | python3 -c 'import sys,json;h=json.load(sys.stdin)["hits"]["hits"];print(h[0]["_source"]["memory_id"] if h else "NONE")')
chk knn-probe "$bm25" "BM25 精确命中错误码/字段名"

echo '== 清理 =='
code admin DELETE "/$OTHER" >/dev/null
code admin DELETE "/$PERSONAL/_doc/writer-probe" >/dev/null
code admin DELETE "/$PERSONAL/_doc/knn-probe" >/dev/null
code admin DELETE '/team_knowledge/_doc/cons-probe' >/dev/null
echo "  done"

echo
echo "结果：PASS=$pass FAIL=$fail"
[ "$fail" = 0 ]
