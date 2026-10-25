#!/usr/bin/env bash
# dsh-memory-es 的定时任务入口（S10 之后的运维收口）。
#
# **默认关闭**：crontab 里装着这两条，但脚本读 `<repo>/.state/cron.env`，
# 只有 `MEMCRON_ENABLED=1` 才真的干活；否则打印一行 disabled 就退出 0（不再往日志里刷东西）。
# 这样「装好但不跑」不需要去改 crontab（crontab 没法禁用单条，只能注释或删）。
#
# 用法：
#   scripts/memory-cron.sh status        # 看当前开关与上次运行
#   scripts/memory-cron.sh enable        # 打开总开关（写 .state/cron.env）
#   scripts/memory-cron.sh disable       # 关闭总开关
#   scripts/memory-cron.sh consolidate   # 整理任务（默认 dry-run；APPLY=1 才真写）
#   scripts/memory-cron.sh export        # Markdown 镜像导出
#
# 为什么不把「快照」放进来：ES 自己的 SLM（`_slm/policy/dsh_memory_daily`）已经在跑，
# 再用 cron 触发一次只是重复造轮子、还多一个会坏的环节（2026-10-25 巡检结论）。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$ROOT/.state"
CONF="$STATE_DIR/cron.env"
LOG="$STATE_DIR/cron.log"
# cron 的 PATH 很窄，显式给绝对路径；允许用 NODE_BIN 覆盖（换 node 版本时）
NODE_BIN="${NODE_BIN:-/usr/local/bin/node}"

mkdir -p "$STATE_DIR"

# 配置默认值：关闭 + 整理任务只 dry-run
DEFAULT_CONF='# dsh-memory-es 定时任务开关（由 scripts/memory-cron.sh 维护；也可以手改）
# MEMCRON_ENABLED=1 才真正执行；0 或缺失 = 只打印 disabled 后退出
MEMCRON_ENABLED=0
# 整理任务是否真写库：0=只出报告（推荐先跑两周），1=真写团队库
CONSOLIDATE_APPLY=0
# 导出目录（缺省 <repo>/knowledge）
EXPORT_DIR=
'

ensure_conf() {
  if [ ! -f "$CONF" ]; then
    printf '%s' "$DEFAULT_CONF" >"$CONF"
    chmod 600 "$CONF"
  fi
}

# 读配置：只取 KEY=VALUE，不执行文件内容（避免被注入）
conf_get() {
  local key=$1
  [ -f "$CONF" ] || {
    printf ''
    return 0
  }
  sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "$CONF" | tail -1 | tr -d '\r'
}

conf_set() {
  local key=$1 value=$2
  ensure_conf
  if grep -qE "^[[:space:]]*${key}[[:space:]]*=" "$CONF"; then
    sed -i "s|^[[:space:]]*${key}[[:space:]]*=.*|${key}=${value}|" "$CONF"
  else
    printf '%s=%s\n' "$key" "$value" >>"$CONF"
  fi
}

log_line() {
  printf '[%s] %s\n' "$(date '+%F %T')" "$*" >>"$LOG"
}

require_enabled() {
  if [ "$(conf_get MEMCRON_ENABLED)" != "1" ]; then
    # 禁用态：一行到 stderr（cron 会记到 journal/邮件），不写 cron.log，避免刷屏
    echo "dsh-memory-es cron: disabled（开关在 $CONF 的 MEMCRON_ENABLED）" >&2
    exit 0
  fi
}

cmd_status() {
  ensure_conf
  printf '开关文件: %s\n' "$CONF"
  printf '  MEMCRON_ENABLED   = %s  (1=启用)\n' "$(conf_get MEMCRON_ENABLED)"
  printf '  CONSOLIDATE_APPLY = %s  (1=整理任务真写库)\n' "$(conf_get CONSOLIDATE_APPLY)"
  printf '  EXPORT_DIR        = %s\n' "$(conf_get EXPORT_DIR)"
  printf '日志: %s\n' "$LOG"
  if [ -f "$LOG" ]; then
    printf '最近 5 行：\n'
    tail -5 "$LOG" | sed 's/^/  /'
  else
    printf '（还没有运行记录）\n'
  fi
  # 顺手把 crontab 现状打出来。注意要区分「没装」和「读不到」：
  # 沙箱/权限受限时 crontab -l 会失败，若把 stderr 吞掉就会谎报「未安装」（2026-10-25 踩到）。
  if tab=$(crontab -l 2>&1); then
    if printf '%s' "$tab" | grep -q 'memory-cron.sh'; then
      printf 'crontab：已安装（见 crontab -l 中的 dsh-memory-es 段）\n'
    else
      printf 'crontab：**未安装**（能读 crontab，但里面没有 memory-cron.sh）\n'
    fi
  else
    printf 'crontab：读不到（%s）—— 无法判断是否已安装\n' "$(printf '%s' "$tab" | tr '\n' ' ' | cut -c1-80)"
  fi
}

cmd_consolidate() {
  require_enabled
  local apply_flag=(--auto)
  if [ "$(conf_get CONSOLIDATE_APPLY)" = "1" ]; then
    apply_flag=(--auto --apply)
  fi
  log_line "consolidate start (apply=$(conf_get CONSOLIDATE_APPLY))"
  local out
  out=$("$NODE_BIN" "$ROOT/consolidate/cli.ts" "${apply_flag[@]}" 2>&1)
  local rc=$?
  log_line "consolidate end rc=$rc"
  # 有内容时也回流到 stdout，cron 里能看到
  printf '%s\n' "$out"
  return "$rc"
}

cmd_export() {
  require_enabled
  local dir
  dir=$(conf_get EXPORT_DIR)
  log_line "export start (dir=${dir:-<repo>/knowledge})"
  local out
  if [ -n "$dir" ]; then
    out=$("$NODE_BIN" "$ROOT/consolidate/cli.ts" --export "$dir" 2>&1)
  else
    out=$("$NODE_BIN" "$ROOT/consolidate/cli.ts" --export 2>&1)
  fi
  local rc=$?
  log_line "export end rc=$rc"
  printf '%s\n' "$out"
  return "$rc"
}

case "${1:-}" in
  status) cmd_status ;;
  enable)
    ensure_conf
    conf_set MEMCRON_ENABLED 1
    echo "已启用：$(conf_get MEMCRON_ENABLED)（整理任务 apply=$(conf_get CONSOLIDATE_APPLY)）"
    ;;
  disable)
    ensure_conf
    conf_set MEMCRON_ENABLED 0
    echo '已关闭：定时任务只打印 disabled，不做任何事'
    ;;
  consolidate) cmd_consolidate ;;
  export) cmd_export ;;
  *)
    cat >&2 <<'USAGE'
用法: scripts/memory-cron.sh <status|enable|disable|consolidate|export>

  status        看开关、日志、crontab 状态
  enable        打开总开关（默认关闭）
  disable       关闭总开关
  consolidate   整理任务（默认 dry-run；CONSOLIDATE_APPLY=1 才真写）
  export        Markdown 镜像导出
USAGE
    exit 2
    ;;
esac
