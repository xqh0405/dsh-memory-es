#!/usr/bin/env bash
# 版本号管理：**唯一来源是 package.json 的 version**（插件与面板已经是一个包，只有这一处）。
#
# 用法：
#   scripts/version.sh                 # 看当前版本
#   scripts/version.sh bump patch      # 补丁（修 bug / 小改）  0.3.0 → 0.3.1
#   scripts/version.sh bump minor      # 功能（新能力/结构变化）0.3.1 → 0.4.0
#   scripts/version.sh bump major      # 大改（口径/接口不兼容）0.4.0 → 1.0.0
#   scripts/version.sh set 1.2.3       # 直接指定（必须 X.Y.Z）
#   scripts/version.sh check           # 只校验格式（给 CI / 打包脚本用）
#
# 约定：**每次要让 114 / 125 重新加载插件时先 bump**。版本号只在「发布」时动，
# 平时改代码不必每 commit 都改。
# 生效：主插件 `ready: vX.Y.Z` 与面板页脚/自检行都读同一个值（面板读包根的 package.json）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAIN="$ROOT/package.json"

read_version() {
  # 只匹配顶层 `  "version": "x.y.z",`；不会误伤 engines 里的 `"dsh": ">=0.1.0"`
  sed -n 's/^  "version": "\([0-9][0-9.]*\)",$/\1/p' "$1" | head -1
}

write_version() {
  local file=$1 ver=$2
  sed -i -E "0,/^  \"version\": \"[0-9]+\.[0-9]+\.[0-9]+\",\$/s//  \"version\": \"${ver}\",/" "$file"
}

validate() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo "版本号必须是 X.Y.Z 的纯数字：收到「$1」" >&2
    exit 2
  }
}

# package-lock.json 里也有两处根版本（顶层 version 与 packages[""].version）。
# 不同步的话，下次 `npm install` 会把 lock 改回去，git status 永远多一条噪声。
sync_lock() {
  local ver=$1
  [ -f "$ROOT/package-lock.json" ] || return 0
  LOCKFILE="$ROOT/package-lock.json" NEWVER="$ver" node -e '
    const fs = require("node:fs")
    const file = process.env.LOCKFILE
    const ver = process.env.NEWVER
    const lock = JSON.parse(fs.readFileSync(file, "utf8"))
    lock.version = ver
    if (lock.packages && lock.packages[""]) lock.packages[""].version = ver
    fs.writeFileSync(file, JSON.stringify(lock, null, 2) + "\n")
  '
}

show() {
  local ver
  ver=$(read_version "$MAIN")
  printf '版本 : %s\n' "${ver:-（读不到）}"
  if [ -z "$ver" ]; then
    echo '!! 读不到 package.json 的 version' >&2
    return 1
  fi
}

apply() {
  local ver=$1
  validate "$ver"
  write_version "$MAIN" "$ver"
  sync_lock "$ver"
  if [ "$(read_version "$MAIN")" != "$ver" ]; then
    echo '!! 写入后读不回来，请检查 package.json 的 version 行格式' >&2
    exit 1
  fi
  show
  echo
  echo "已改为 ${ver}。让运行态看到它："
  echo '  本机：bash scripts/sync-local-plugin.sh，然后重启 dsh-web'
  echo '  125 ：PANEL_HOST=root@<es 主机> PANEL_CONTAINER=dsh-<user> bash scripts/deploy-panel.sh'
}

case "${1:-get}" in
  get|--get|"") show ;;
  bump)
    [ $# -ge 2 ] || { echo '用法：scripts/version.sh bump <patch|minor|major>' >&2; exit 2; }
    cur=$(read_version "$MAIN")
    validate "$cur"
    IFS=. read -r major minor patch <<<"$cur"
    case "$2" in
      patch) patch=$((patch + 1)) ;;
      minor) minor=$((minor + 1)); patch=0 ;;
      major) major=$((major + 1)); minor=0; patch=0 ;;
      *) echo "只支持 patch / minor / major，收到「$2」" >&2; exit 2 ;;
    esac
    apply "${major}.${minor}.${patch}"
    ;;
  set)
    [ $# -ge 2 ] || { echo '用法：scripts/version.sh set X.Y.Z' >&2; exit 2; }
    apply "$2"
    ;;
  check)
    validate "$(read_version "$MAIN")" && echo "版本：$(read_version "$MAIN")"
    ;;
  *)
    echo "未知子命令「$1」；可用：get / bump <patch|minor|major> / set X.Y.Z / check" >&2
    exit 2
    ;;
esac
