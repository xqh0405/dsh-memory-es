#!/usr/bin/env bash
# 建角色 / 用户 / API key，并把 key 与用户密码写入 deploy/es/.env。
#
# 免费版（basic license）没有 DLS，所以隔离靠「一人一索引 + 索引级 ACL」：
#   · 个人 key 只能读 personal_memory_<自己>
#   · writer 能写 personal_memory_*（插件唯一写入口）
#   · consolidator 读所有个人索引、只写 team_knowledge
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ES_DIR="$ROOT/deploy/es"
ENV_FILE="$ES_DIR/.env"
CA="$ES_DIR/certs/ca.crt"
ES="https://127.0.0.1:9200"
PASS=$(grep '^ELASTIC_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
USER_ID=$(grep '^MEM_USER_ID=' "$ENV_FILE" | cut -d= -f2-)
USER_ID=${USER_ID:-xqh}
PERSONAL="personal_memory_$USER_ID"

get_env() { grep "^$1=" "$ENV_FILE" | cut -d= -f2- || true; }
set_env() {
  if grep -q "^$1=" "$ENV_FILE"; then
    sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"
  else
    echo "$1=$2" >> "$ENV_FILE"
  fi
}
rand_pw() { openssl rand -base64 24 | tr -d '/+=' | cut -c1-24; }
admin() { curl -sS --fail-with-body --cacert "$CA" -u "elastic:$PASS" -H 'Content-Type: application/json' "$@"; }

echo "== 1/3 角色 =="
admin -X PUT "$ES/_security/role/mem_personal_$USER_ID" -d @- >/dev/null <<JSON
{
  "indices": [
    { "names": ["$PERSONAL"], "privileges": ["read", "view_index_metadata"] }
  ]
}
JSON
echo "  mem_personal_$USER_ID → 只读 $PERSONAL"

admin -X PUT "$ES/_security/role/mem_team_read" -d @- >/dev/null <<'JSON'
{ "indices": [ { "names": ["team_knowledge"], "privileges": ["read", "view_index_metadata"] } ] }
JSON
echo '  mem_team_read → 只读 team_knowledge'

admin -X PUT "$ES/_security/role/mem_writer" -d @- >/dev/null <<'JSON'
{
  "indices": [
    {
      "names": ["personal_memory_*"],
      "privileges": ["index", "read", "create_index", "view_index_metadata"]
    }
  ]
}
JSON
echo '  mem_writer → 写个人库（通配 personal_memory_*）'

admin -X PUT "$ES/_security/role/mem_consolidator" -d @- >/dev/null <<'JSON'
{
  "indices": [
    { "names": ["personal_memory_*"], "privileges": ["read", "view_index_metadata"] },
    { "names": ["team_knowledge"], "privileges": ["index", "read", "view_index_metadata"] }
  ]
}
JSON
echo '  mem_consolidator → 读个人库 + 写团队库'

# 用户不会自动拥有 API key 管理权限，需显式给（只允许管理自己的 key）
admin -X PUT "$ES/_security/role/mem_apikey_owner" -d @- >/dev/null <<'JSON'
{ "cluster": ["manage_own_api_key"], "indices": [] }
JSON
echo '  mem_apikey_owner → 允许自助创建/吊销自己的 API key'

echo "== 2/3 用户 =="
READER="mem-reader-$USER_ID"
PUB=$(get_env MEM_READER_PASSWORD); [ -n "${PUB:-}" ] || { PUB=$(rand_pw); set_env MEM_READER_PASSWORD "$PUB"; }
PWB=$(get_env MEM_WRITER_PASSWORD); [ -n "${PWB:-}" ] || { PWB=$(rand_pw); set_env MEM_WRITER_PASSWORD "$PWB"; }
PWC=$(get_env MEM_CONSOLIDATOR_PASSWORD); [ -n "${PWC:-}" ] || { PWC=$(rand_pw); set_env MEM_CONSOLIDATOR_PASSWORD "$PWC"; }

admin -X PUT "$ES/_security/user/$READER" -d "{\"password\":\"$PUB\",\"roles\":[\"mem_personal_$USER_ID\",\"mem_team_read\",\"mem_apikey_owner\"]}" >/dev/null
echo "  $READER ok"
admin -X PUT "$ES/_security/user/mem-writer" -d "{\"password\":\"$PWB\",\"roles\":[\"mem_writer\",\"mem_apikey_owner\"]}" >/dev/null
echo '  mem-writer ok'
admin -X PUT "$ES/_security/user/mem-consolidator" -d "{\"password\":\"$PWC\",\"roles\":[\"mem_consolidator\",\"mem_apikey_owner\"]}" >/dev/null
echo '  mem-consolidator ok'

echo "== 3/3 API key =="
make_key() {
  local name=$1 user=$2 pass=$3 envkey=$4
  local cur; cur=$(get_env "$envkey")
  if [ -n "${cur:-}" ]; then
    # 关键：.env 里有值不代表还有效。灾备恢复后 .security 是空的，
    # 旧 key 必然 401，直接跳过会把失效 key 留在配置里（客户端全线 401）。
    # 所以先验活：200 才跳过，否则重建并覆盖 .env。
    local code
    code=$(curl -sS -o /dev/null -w '%{http_code}' --cacert "$CA" \
      -H "Authorization: ApiKey $cur" "$ES/_security/_authenticate" 2>/dev/null || echo 000)
    if [ "$code" = "200" ]; then
      echo "  $name 仍有效，跳过"
      return 0
    fi
    echo "  $name 已失效（HTTP $code）→ 重建"
  fi
  local encoded
  encoded=$(curl -sS --fail-with-body --cacert "$CA" -u "$user:$pass" \
    -H 'Content-Type: application/json' -X POST "$ES/_security/api_key" \
    -d "{\"name\":\"$name\"}" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["encoded"])')
  set_env "$envkey" "$encoded"
  echo "  $name 已创建 → .env:$envkey（新 key，客户端需同步新值）"
}

make_key "mem-read-$USER_ID" "$READER" "$PUB" MEM_READ_API_KEY
make_key "mem-writer" "mem-writer" "$PWB" MEM_WRITER_API_KEY
make_key "mem-consolidator" "mem-consolidator" "$PWC" MEM_CONSOLIDATOR_API_KEY

chmod 600 "$ENV_FILE"
echo
echo '完成。'
grep -cE '^(MEM_READ_API_KEY|MEM_WRITER_API_KEY|MEM_CONSOLIDATOR_API_KEY)=.+' "$ENV_FILE" \
  | xargs -I{} echo "  已写入 {} 个 API key 到 .env"
