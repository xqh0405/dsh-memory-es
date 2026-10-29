#!/usr/bin/env bash
# 建共享角色，并按「一人一个 ES 账号」建用户（2026-10-26 起）。
#
# 免费版（basic license）没有 DLS，所以隔离靠「一人一索引 + 索引级 ACL」：
#   · 每个人一个账号 mem-user-<uid>：只能读写 personal_memory_<uid>（不是通配符）
#   · 团队库按档位授权：mem_team_read（只读）/ mem_team_write（读写删 + 写审计，审计不可删）
#   · 每人的账号和密码由 scripts/init-user.sh 生成到 deploy/es/users/<uid>.env（600）
#
# ⚠️ mem_writer（能写 personal_memory_* 通配）是旧设计，本脚本**不再创建**；
#    已有部署里它还在，只为兼容尚未迁移的 CLI/面板。迁移完成后可用
#    scripts/init-user.sh --drop-legacy-writer 删掉（见该脚本 help）。
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

admin -X PUT "$ES/_security/role/mem_team_write" -d @- >/dev/null <<'JSON'
{
  "indices": [
    { "names": ["team_knowledge"], "privileges": ["index", "read", "delete", "view_index_metadata"] },
    { "names": ["memory_audit"], "privileges": ["index", "read", "view_index_metadata"] }
  ]
}
JSON
echo '  mem_team_write → 团队库读写删 + 审计读写（审核员的角色；审计不可删；旧 mem_writer 通配已不再创建）'

# 管理员角色（2026-10-29）：团队库维护 + 跨用户只读个人记忆。
# 与 mem_team_write 分开是刻意的——"团队写"不该等于"能读所有人的个人库"。
# 必须定义在本脚本里：重跑 init-security.sh 会覆盖角色，漏写就会被抹掉。
admin -X PUT "$ES/_security/role/mem_admin" -d @- >/dev/null <<'JSON'
{
  "indices": [
    { "names": ["team_knowledge"], "privileges": ["index", "read", "delete", "view_index_metadata"] },
    { "names": ["memory_audit"], "privileges": ["index", "read", "view_index_metadata"] },
    { "names": ["personal_memory_*", "personal_doc_*"], "privileges": ["read", "index", "view_index_metadata"] }
  ]
}
JSON
echo '  mem_admin → 团队库读写删 + 审计读写 + 所有人的个人库通配读（含 index，整理回写用；不含 delete）'

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
# MEM_WRITER_PASSWORD 不再生成：单账号（mem-user-<uid>）已取代 mem-writer；
# 旧的键如果还在 .env 里只是历史残留，别再用它当回落。
# MEM_CONSOLIDATOR_PASSWORD 仍保留（整理任务跨用户扫库时要用）
PWC=$(get_env MEM_CONSOLIDATOR_PASSWORD); [ -n "${PWC:-}" ] || { PWC=$(rand_pw); set_env MEM_CONSOLIDATOR_PASSWORD "$PWC"; }

admin -X PUT "$ES/_security/user/$READER" -d "{\"password\":\"$PUB\",\"roles\":[\"mem_personal_$USER_ID\",\"mem_team_read\"]}" >/dev/null
echo "  $READER ok"
# 不再创建 mem-writer（通配 personal_memory_*，等于能写别人的个人库）
echo '  mem-writer 已废弃（通配越权），改由 init-user.sh 建 per-user 账号'
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
echo "== 3/3 本用户账号（一人一账号）=="
ES_DIR="$ES_DIR" ES_URL="$ES" bash "$(dirname "$0")/init-user.sh" "$USER_ID" --team-write \
  || echo '  （init-user.sh 失败：per-user 账号没建，插件仍可用旧三账号）'

echo '完成。认证方式 = Basic Auth（用户名 + 密码），不再创建 API key。'
echo "  用户账号：mem-user-$USER_ID（个人库读写 + 团队库读写）"
echo '  遗留：mem-reader-<uid> / mem-consolidator 仍保留（兼容未迁移的调用）；mem-writer 已不再创建'
grep -E '^(MEM_READER_PASSWORD|MEM_CONSOLIDATOR_PASSWORD)=' "$ENV_FILE" \
  | sed 's/=.*/=<已设置>/' | sed 's/^/  /'
grep -q '^MEM_WRITER_PASSWORD=.' "$ENV_FILE" \
  && echo '  提示：.env 里还有遗留的 MEM_WRITER_PASSWORD（不再生成/使用，可手工删掉）'
echo '  凭据通过临时配置文件传给 curl（--config，权限 600、返回前删除），密码不进 argv/ps。'
echo '     仍需注意：密码本身以明文存在 .env（600）；要更强隔离应改用 API key + 最小角色。'
