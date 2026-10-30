#!/usr/bin/env bash
# 给已有用户补「个人审计」：建 personal_audit_<uid> 索引 + 在角色里加授权（阶段 7.3 补强）。
#
# 为什么要它：init-user.sh 只对新用户生效，已有用户的 mem_personal_rw_<uid> 里没有
# personal_audit_<uid>。不补的话，采纳/拒绝只能降级把痕迹记在条目上，查不到自己的审核流水。
#
# **幂等**：索引已存在跳过；角色里已有该索引就不重复加。
# **不覆盖**：读出现有角色定义、只追加一条 indices 再写回（直接 PUT 会抹掉别的权限——
# 记忆里那条「重跑 init-security.sh 把 S9 权限抹掉」就是这么来的）。
#
# 用法：
#   ES_URL=... ES_CA=... ES_USER=... ES_PASS=... scripts/migrate-personal-audit.sh xqh dsh-test
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$(dirname "$0")/lib/curl-es.sh"
ES="${ES_URL:-https://127.0.0.1:9200}"
CA="${ES_CA:-$ROOT/deploy/es/certs/ca.crt}"
if [ -z "${ES_USER:-}" ] || [ -z "${ES_PASS:-}" ]; then
  echo '需要 ES_USER / ES_PASS（管理员）' >&2; exit 1
fi
AUTH="$ES_USER:$ES_PASS"
es() { es_curl "$AUTH" --fail-with-body -H 'Content-Type: application/json' "$@"; }

for uid in "$@"; do
  idx="personal_audit_$uid"
  role="mem_personal_rw_$uid"
  echo "== $uid =="

  code=$(es_curl "$AUTH" -o /dev/null -w '%{http_code}' -I "$ES/$idx" || true)
  if [ "$code" = "200" ]; then
    echo "  [skip] 索引 $idx 已存在"
  else
    es -X PUT "$ES/$idx" -d '{}' >/dev/null
    echo "  已建索引 $idx（继承 personal_audit_template）"
  fi

  # 读角色 → 追加 → 写回。用 python 改 JSON，避免手工拼串把别的权限覆盖掉。
  es -X GET "$ES/_security/role/$role" > /tmp/role-$$.json
  python3 - "$idx" /tmp/role-$$.json > /tmp/role-new-$$.json <<'PY'
import json, sys
target, path = sys.argv[1], sys.argv[2]
role = json.load(open(path))[list(json.load(open(path)))[0]]
indices = role.get('indices', [])
if any(target in (entry.get('names') or []) for entry in indices):
    print(json.dumps({"__noop": True})); sys.exit(0)
indices.append({"names": [target], "privileges": ["read", "index", "delete", "view_index_metadata"]})
role['indices'] = indices
print(json.dumps({k: role[k] for k in ('cluster', 'indices', 'applications', 'run_as') if k in role}))
PY
  if grep -q '__noop' /tmp/role-new-$$.json; then
    echo "  [skip] 角色 $role 已含 $idx"
  else
    es -X PUT "$ES/_security/role/$role" -d @/tmp/role-new-$$.json >/dev/null
    echo "  已给 $role 追加 $idx（其余权限原样保留）"
  fi
  rm -f /tmp/role-$$.json /tmp/role-new-$$.json

  # 校验：索引存在 + 权限里含它
  body=$(es -X GET "$ES/_security/role/$role")
  echo "$body" | grep -q "$idx" && echo "  校验：权限已就绪" || { echo '  校验失败' >&2; exit 1; }
done
echo '== 完成（新用户的权限由 init-user.sh 负责）=='
