#!/usr/bin/env bash
# 建角色 / 用户 / API key，并把 key 与用户密码写入 deploy/es/.env。
#
# 免费版（basic license）没有 DLS，所以隔离靠「一人一索引 + 索引级 ACL」：
#   · 个人 key 只能读 personal_memory_<自己>
#   · writer 能写 personal_memory_*（插件唯一写入口）
#   · consolidator 读所有个人索引、只写 team_knowledge
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 默认是本仓库的本地部署；远端部署用 ES_DIR=/path/to/deploy/es ES_URL=https://host:9200
ES_DIR="${ES_DIR:-$ROOT/deploy/es}"
ENV_FILE="$ES_DIR/.env"
CA="$ES_DIR/certs/ca.crt"
source "$(dirname "$0")/lib/curl-es.sh"
ES="${ES_URL:-https://127.0.0.1:9200}"
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
admin() { es_curl "elastic:$PASS" --fail-with-body -H 'Content-Type: application/json' "$@"; }

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
      "privileges": ["index", "read", "view_index_metadata"]
    }
  ]
}
JSON
echo '  mem_writer → 写个人库（通配 personal_memory_*；不含 create_index——建索引是 init-indices.sh 的活）'

admin -X PUT "$ES/_security/role/mem_consolidator" -d @- >/dev/null <<'JSON'
{
  "indices": [
    { "names": ["personal_memory_*"], "privileges": ["read", "view_index_metadata"] },
    { "names": ["team_knowledge"], "privileges": ["index", "read", "view_index_metadata"] },
    { "names": ["memory_audit"], "privileges": ["index", "read", "view_index_metadata"] }
  ]
}
JSON
echo '  mem_consolidator → 读个人库 + 写团队库 + 审计读写（memory_audit；漏了它，重跑本脚本会把 S9 的权限覆盖回去）'

# 认证方式：Basic Auth（用户名 + 密码）。
# 不用 API key 的原因：灾备恢复后 .security 为空，key 必须重建、secret 不可复现，
# 每个客户端都要同步新值；而用户名密码重建后保持不变，客户端零改动（见文档 §5.6）。

echo "== 2/3 用户 =="
READER="mem-reader-$USER_ID"
PUB=$(get_env MEM_READER_PASSWORD); [ -n "${PUB:-}" ] || { PUB=$(rand_pw); set_env MEM_READER_PASSWORD "$PUB"; }
PWB=$(get_env MEM_WRITER_PASSWORD); [ -n "${PWB:-}" ] || { PWB=$(rand_pw); set_env MEM_WRITER_PASSWORD "$PWB"; }
PWC=$(get_env MEM_CONSOLIDATOR_PASSWORD); [ -n "${PWC:-}" ] || { PWC=$(rand_pw); set_env MEM_CONSOLIDATOR_PASSWORD "$PWC"; }

admin -X PUT "$ES/_security/user/$READER" -d "{\"password\":\"$PUB\",\"roles\":[\"mem_personal_$USER_ID\",\"mem_team_read\"]}" >/dev/null
echo "  $READER ok"
admin -X PUT "$ES/_security/user/mem-writer" -d "{\"password\":\"$PWB\",\"roles\":[\"mem_writer\"]}" >/dev/null
echo '  mem-writer ok'
admin -X PUT "$ES/_security/user/mem-consolidator" -d "{\"password\":\"$PWC\",\"roles\":[\"mem_consolidator\"]}" >/dev/null
echo '  mem-consolidator ok'

# 清理历史遗留的 API key 值（已改用 Basic Auth，留着会让人误以为还在用）
for k in MEM_READ_API_KEY MEM_WRITER_API_KEY MEM_CONSOLIDATOR_API_KEY; do
  if grep -q "^$k=." "$ENV_FILE"; then
    sed -i "s|^$k=.*|$k=|" "$ENV_FILE"
    echo "  已清空 .env 的 $k（不再使用）"
  fi
done

chmod 600 "$ENV_FILE"
echo
echo '完成。认证方式 = Basic Auth（用户名 + 密码），不再创建 API key。'
echo '  读：mem-reader-<uid>   写：mem-writer   整理：mem-consolidator'
grep -E '^(MEM_READER_PASSWORD|MEM_WRITER_PASSWORD|MEM_CONSOLIDATOR_PASSWORD)=' "$ENV_FILE" \
  | sed 's/=.*/=<已设置>/' | sed 's/^/  /'
echo '  凭据通过临时配置文件传给 curl（--config，权限 600、返回前删除），密码不进 argv/ps。'
echo '     仍需注意：密码本身以明文存在 .env（600）；要更强隔离应改用 API key + 最小角色。'
