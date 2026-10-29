#!/usr/bin/env bash
# 按「用户」建 ES 账号与角色（一用户一账号，替代原来按用途拆的 reader/writer/consolidator）。
#
# 三档团队权限：
#   --team-write   个人读写 + 团队读写（管理员/审核员；面板会显示审核台）
#   --team-read    个人读写 + 团队读（普通成员，默认）
#   --personal-only 只有个人读写（不参与团队库）
#
# 幂等：角色每次覆盖定义；用户每次重设角色；密码**默认沿用** users/<uid>.env 里已有的，
# 只有 --reset-password 才换。密码写进 <ES_DIR>/users/<uid>.env（600），只在结尾打印路径。
#
# 用法：
#   scripts/init-user.sh xqh --team-write
#   ES_DIR=/path/deploy/es ES_URL=https://host:9200 scripts/init-user.sh lisi --team-read
#   scripts/init-user.sh wangwu --personal-only --reset-password
#   scripts/init-user.sh xqh --drop-legacy-writer    # 迁移完成后删掉旧的 mem-writer 通配账号
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ES_DIR="${ES_DIR:-$ROOT/deploy/es}"
CA="${CA:-$ES_DIR/certs/ca.crt}"
ENV_FILE="$ES_DIR/.env"
source "$(dirname "$0")/lib/curl-es.sh"
ES="${ES_URL:-https://127.0.0.1:9200}"

UID_ARG="${1:-}"
[ -n "$UID_ARG" ] || { echo '用法：init-user.sh <uid> [--team-write|--team-read|--personal-only] [--reset-password]' >&2; exit 2; }
shift

TIER="team-read"
RESET=0
DROP_LEGACY=0
for arg in "$@"; do
  case "$arg" in
    --drop-legacy-writer) DROP_LEGACY=1 ;;
    --team-write) TIER="team-write" ;;
    --team-read) TIER="team-read" ;;
    --personal-only) TIER="personal-only" ;;
    --reset-password) RESET=1 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

[ -f "$ENV_FILE" ] || { echo "找不到 $ENV_FILE（先跑 scripts/es-up.sh / init-security.sh）" >&2; exit 1; }
PASS=$(grep '^ELASTIC_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
[ -n "$PASS" ] || { echo "$ENV_FILE 缺 ELASTIC_PASSWORD" >&2; exit 1; }

admin() { es_curl "elastic:$PASS" --fail-with-body -H 'Content-Type: application/json' "$@"; }

if [ "$DROP_LEGACY" = "1" ]; then
  echo '== 删除遗留 mem-writer（能写 personal_memory_* 通配的旧账号）=='
  echo -n '  删除用户 mem-writer：'
  admin -X DELETE "$ES/_security/user/mem-writer" -o /dev/null -w '%{http_code}\n' || true
  echo -n '  删除角色 mem_writer  ：'
  admin -X DELETE "$ES/_security/role/mem_writer" -o /dev/null -w '%{http_code}\n' || true
  echo '  完成。若还有调用方在用 MEM_WRITER_PASSWORD，会开始报 401 —— 那是预期（逼它迁到单账号）。'
  exit 0
fi
rand_pw() { openssl rand -base64 24 | tr -d '/+=' | cut -c1-24; }

PERSONAL="personal_memory_${UID_ARG}"
USER_NAME="mem-user-${UID_ARG}"
USERS_DIR="$ES_DIR/users"
USER_ENV="$USERS_DIR/${UID_ARG}.env"

echo "== 1/3 共享角色（团队读 / 团队写）=="
# 团队读：只读团队库
admin -X PUT "$ES/_security/role/mem_team_read" -d @- >/dev/null <<'JSON'
{ "indices": [ { "names": ["team_knowledge"], "privileges": ["read", "view_index_metadata"] } ] }
JSON
echo '  mem_team_read  → team_knowledge 只读'

# 团队写：能写团队库，并且要能写审计（审核动作必须留痕）。
# team_knowledge 带 delete：管理员要能删掉走错的团队记忆（插件本身只做 superseded 软删，
# 这里的 delete 是给人工清理用的：误入库、脏数据、权限探针残留）。
# memory_audit **不给 delete**：审计是治理证据，能删就等于能篡改；过期清理走
# scripts/prune-audit.sh（elastic 身份 + 保留期）。
admin -X PUT "$ES/_security/role/mem_team_write" -d @- >/dev/null <<'JSON'
{
  "indices": [
    { "names": ["team_knowledge"], "privileges": ["index", "read", "delete", "view_index_metadata"] },
    { "names": ["memory_audit"], "privileges": ["index", "read", "view_index_metadata"] }
  ]
}
JSON
echo '  mem_team_write → team_knowledge 读写删 + memory_audit 读写（审计不可删）'

echo "== 2/3 本用户角色（个人读写，只限自己的索引）=="
admin -X PUT "$ES/_security/role/mem_personal_rw_${UID_ARG}" -d @- >/dev/null <<JSON
{
  "indices": [
    { "names": ["$PERSONAL", "personal_doc_${UID_ARG}", "search_log_${UID_ARG}"],
      "privileges": ["read", "index", "delete", "view_index_metadata"] }
  ]
}
JSON
echo "  mem_personal_rw_${UID_ARG} → ${PERSONAL} + personal_doc_${UID_ARG} + search_log_${UID_ARG} 读/写/删（不是通配）"

echo "== 3/3 用户与密码 =="
mkdir -p "$USERS_DIR"
chmod 700 "$USERS_DIR"
PW=""
if [ "$RESET" -eq 0 ] && [ -f "$USER_ENV" ]; then
  PW=$(grep '^MEM_PASSWORD=' "$USER_ENV" | cut -d= -f2- || true)
fi
[ -n "$PW" ] || PW=$(rand_pw)

ROLES="[\"mem_personal_rw_${UID_ARG}\""
case "$TIER" in
  team-write) ROLES="$ROLES,\"mem_team_write\"]" ;;
  team-read) ROLES="$ROLES,\"mem_team_read\"]" ;;
  personal-only) ROLES="$ROLES]" ;;
esac

admin -X PUT "$ES/_security/user/$USER_NAME" -d "{\"password\":\"$PW\",\"roles\":$ROLES}" >/dev/null

umask 077
cat >"$USER_ENV" <<ENV
# ${UID_ARG} 的 ES 凭据（由 scripts/init-user.sh 生成，600）
MEM_USER_ID=${UID_ARG}
MEM_USERNAME=${USER_NAME}
MEM_PASSWORD=${PW}
MEM_TEAM_TIER=${TIER}
ENV
chmod 600 "$USER_ENV"

echo
echo "完成：$USER_NAME（$TIER）roles=$ROLES"
echo "  凭据：$USER_ENV （600，密码未打印）"
echo "  自检："
printf '    读自己的库：'
es_curl "$USER_NAME:$PW" -o /dev/null -w '%{http_code}\n' "$ES/$PERSONAL/_count" || true
printf '    读团队库  ：'
es_curl "$USER_NAME:$PW" -o /dev/null -w '%{http_code}\n' "$ES/team_knowledge/_count" || true
if [ "$TIER" = "team-write" ]; then
  # 探针必须用映射里存在的最小字段：team_knowledge 是 dynamic:strict，
  # 随手塞个 {"probe":true} 会得到 400（映射错），看起来像"没权限"——两个错不能混。
  NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '    写团队库  ：'
  es_curl "$USER_NAME:$PW" -o /dev/null -w '%{http_code}\n' -X PUT "$ES/team_knowledge/_doc/__perm_probe?refresh=true" \
    -H 'Content-Type: application/json' \
    -d "{\"doc_id\":\"__perm_probe\",\"content\":\"权限探针\",\"memory_type\":\"fact\",\"domain\":\"selftest\",\"status\":\"superseded\",\"review_state\":\"pending\",\"updated_at\":\"$NOW\"}" || true
  # 探针用完必须真删：早先这里只把 status 改成 superseded，文档仍留在团队库里，
  # 每次建账号就多一条 __perm_probe 脏数据（2026-10-26 在 125 上实测发现）。
  printf '    清理探测文档：'
  es_curl "$USER_NAME:$PW" -o /dev/null -w '%{http_code}\n' -X DELETE "$ES/team_knowledge/_doc/__perm_probe?refresh=true" || true
  printf '    个人库不该被团队成员写：'
  es_curl "$USER_NAME:$PW" -o /dev/null -w '%{http_code}\n' -X POST "$ES/personal_memory_other/_doc/x?refresh=true" \
    -H 'Content-Type: application/json' -d '{}' || true
fi
