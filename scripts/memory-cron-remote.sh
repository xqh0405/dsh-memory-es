#!/usr/bin/env bash
# 容器化 DSH 的定时任务入口（在**宿主**上跑，用 docker exec 驱动容器里的 CLI）。
#
# 为什么不在容器里装 cron：dsh 容器里没有 crontab，也不该为一个任务往镜像里塞 cron；
# 宿主的 crontab 更简单，且 9200 端口已 publish 到宿主回环，凭据从 deploy/es-remote/users/ 读。
#
# 用法（在目标宿主上）：
#   memory-cron-remote.sh status
#   memory-cron-remote.sh enable / disable
#   memory-cron-remote.sh consolidate / export
set -uo pipefail

CONTAINER="${CONTAINER:-dsh}"
ES_DIR="${ES_DIR:-/srv/es-memory/deploy/es-remote}"
ES_URL="${ES_URL:-https://dsh-es-remote:9200}"
CLI_DIR="/data/dsh/local-plugins/dsh-memory-es-panel/cli"
STATE_DIR="${STATE_DIR:-/srv/es-memory/.state}"
CONF="$STATE_DIR/remote-cron.env"
LOG="$STATE_DIR/cron.log"

mkdir -p "$STATE_DIR"
DEFAULT_CONF='# 容器化部署的定时任务开关（由 memory-cron-remote.sh 维护）
MEMCRON_ENABLED=0
CONSOLIDATE_APPLY=0
'

ensure_conf() {
  [ -f "$CONF" ] || { printf '%s' "$DEFAULT_CONF" >"$CONF"; chmod 600 "$CONF"; }
}
conf_get() { [ -f "$CONF" ] && sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$CONF" | tail -1 | tr -d '\r'; }
conf_set() {
  ensure_conf
  if grep -qE "^[[:space:]]*$1[[:space:]]*=" "$CONF"; then
    sed -i "s|^[[:space:]]*$1[[:space:]]*=.*|$1=$2|" "$CONF"
  else
    echo "$1=$2" >>"$CONF"
  fi
}
log_line() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"; }
require_enabled() {
  [ "$(conf_get MEMCRON_ENABLED)" = "1" ] || { echo "disabled（$CONF 里 MEMCRON_ENABLED=0）"; exit 0; }
}

# 单账号凭据：从 users/<uid>.env 读，用 docker exec -e 注入（不落 argv 之外的持久文件）
user_env() {
  local uid
  uid=$(sed -n 's/^MEM_USER_ID=//p' "$ES_DIR/.env" | tail -1)
  printf '%s/users/%s.env' "$ES_DIR" "$uid"
}

run_cli() {
  local envf username password uid tmp
  envf=$(user_env)
  [ -f "$envf" ] || { echo "找不到 $envf（先跑 init-user.sh）" >&2; return 1; }
  username=$(sed -n 's/^MEM_USERNAME=//p' "$envf" | tail -1)
  password=$(sed -n 's/^MEM_PASSWORD=//p' "$envf" | tail -1)
  uid=$(sed -n 's/^MEM_USER_ID=//p' "$envf" | tail -1)

  # CLI 只认 $ES_DIR/.env + $ES_DIR/certs/ca.crt，所以在容器里造一个临时 ES_DIR
  # （和面板 cliRunner 的做法一致）；凭据走 600 临时文件 + docker cp，不进 argv。
  tmp=$(mktemp "${TMPDIR:-/tmp}/mem-cron-env-XXXXXX")
  umask 077
  printf 'MEM_USER_ID=%s\nMEM_USERNAME=%s\nMEM_PASSWORD=%s\n' "$uid" "$username" "$password" >"$tmp"

  docker exec "$CONTAINER" sh -c 'rm -rf /tmp/mem-cron-env && mkdir -p /tmp/mem-cron-env/certs && cp /home/node/ca-memory-es.crt /tmp/mem-cron-env/certs/ca.crt' >/dev/null
  docker cp "$tmp" "$CONTAINER:/tmp/mem-cron-env/.env" >/dev/null
  rm -f "$tmp"
  docker exec "$CONTAINER" sh -c 'chown -R node:node /tmp/mem-cron-env && chmod 600 /tmp/mem-cron-env/.env' >/dev/null

  local rc=0
  docker exec -u node -e ES_DIR=/tmp/mem-cron-env "$CONTAINER" sh -c \
    "cd $CLI_DIR && node consolidate/cli.ts --es-url $ES_URL --state /data/dsh/memory-es-state/consolidate.json $*" || rc=$?
  docker exec "$CONTAINER" sh -c 'rm -rf /tmp/mem-cron-env' >/dev/null 2>&1 || true
  return "$rc"
}

cmd_consolidate() {
  require_enabled
  local flags=(--auto)
  [ "$(conf_get CONSOLIDATE_APPLY)" = "1" ] && flags=(--auto --apply)
  log_line "consolidate start (apply=$(conf_get CONSOLIDATE_APPLY))"
  local out rc
  out=$(run_cli "${flags[*]}" 2>&1); rc=$?
  log_line "consolidate end rc=$rc"
  printf '%s\n' "$out"
  return "$rc"
}

cmd_export() {
  require_enabled
  log_line "export start"
  local out rc
  out=$(run_cli "--export /data/dsh/memory-mirror" 2>&1); rc=$?
  log_line "export end rc=$rc"
  printf '%s\n' "$out"
  return "$rc"
}

cmd_check_certs() {
  local p12="$ES_DIR/certs/elastic-certificates.p12"
  local pass not_after days
  pass=$(sed -n 's/^CERT_PASS=//p' "$ES_DIR/.env" | tail -1)
  [ -f "$p12" ] || { echo "证书检查：找不到 $p12"; return 0; }
  not_after=$(openssl pkcs12 -in "$p12" -clcerts -nokeys -passin pass:"$pass" 2>/dev/null \
    | openssl x509 -noout -enddate 2>/dev/null | sed 's/^notAfter=//')
  [ -n "$not_after" ] || { echo '证书检查：读不到有效期'; return 1; }
  days=$(( ( $(date -d "$not_after" +%s) - $(date +%s) ) / 86400 ))
  echo "证书到期：$not_after（剩余 ${days} 天）"
  [ "$days" -ge "${CERT_WARN_DAYS:-30}" ] || {
    echo "!! 证书即将过期：CERT_DAYS=3650 FORCE=1 scripts/es-certs.sh 重签 → 重启 ES → 同步 ca.crt"
    return 1
  }
}

cmd_status() {
  ensure_conf
  echo "开关文件: $CONF"
  echo "  MEMCRON_ENABLED   = $(conf_get MEMCRON_ENABLED)"
  echo "  CONSOLIDATE_APPLY = $(conf_get CONSOLIDATE_APPLY)"
  echo "日志: $LOG"
  [ -f "$LOG" ] && tail -4 "$LOG" | sed 's/^/  /'
}

case "${1:-status}" in
  status) cmd_status ;;
  enable) conf_set MEMCRON_ENABLED 1; echo "已启用（apply=$(conf_get CONSOLIDATE_APPLY)）" ;;
  disable) conf_set MEMCRON_ENABLED 0; echo '已关闭' ;;
  apply-on) conf_set CONSOLIDATE_APPLY 1; echo '整理任务改为真写库' ;;
  apply-off) conf_set CONSOLIDATE_APPLY 0; echo '整理任务改为 dry-run' ;;
  consolidate) cmd_consolidate ;;
  export) cmd_export ;;
  check-certs) cmd_check_certs ;;
  *) echo "用法: $0 {status|enable|disable|apply-on|apply-off|consolidate|export|check-certs}" >&2; exit 2 ;;
esac
