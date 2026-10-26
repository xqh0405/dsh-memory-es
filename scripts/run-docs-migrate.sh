#!/usr/bin/env bash
# 批量把各容器的 mnemon Documents 切片写入 personal_doc_<uid>
set -uo pipefail
cd /docker/dsh-es
for u in xqh chencan hongzhihui laoliu liuxinling molijin tanxu zhongjinqi zhongyuhang; do
  R=/docker/lib/docker/volumes/dsh-home-$u/_data/.mnemon
  if [ ! -f "$R/documents/index.json" ]; then
    echo "===== $u：无 index.json，跳过"
    continue
  fi
  n=$(python3 -c "import json,sys;print(len(json.load(open(sys.argv[1])).get('documents',[])))" "$R/documents/index.json")
  if [ "$n" = "0" ]; then
    echo "===== $u：0 篇，跳过"
    continue
  fi
  echo "===== $u：$n 篇"
  PW=$(grep '^MEM_PASSWORD=' "users/$u.env" | cut -d= -f2-)
  ES_PW="$PW" python3 scripts/migrate-docs.py \
    --index-json "$R/documents/index.json" --docs-dir "$R/documents/active" \
    --user "$u" --es https://192.168.1.125:9200 --ca certs/ca.crt \
    --username "mem-user-$u" --password-env ES_PW \
    --ollama http://127.0.0.1:11434 --model bge-m3 --batch 8
done
echo "=== 全部完成 ==="
