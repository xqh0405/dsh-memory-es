#!/usr/bin/env bash
# 版本号管理：**唯一来源是 package.json 的 version**，这个脚本负责把它同步到面板包。
#
# 为什么需要脚本：版本号散在两个包里（主插件 + 面板），面板页脚显示的版本由
# `/overview` 从服务端返回，所以两处必须永远同号。手工改最容易漏掉面板那份——
# 漏了的症状是「部署了新版，页脚还是旧号」，比没有版本号更误导。
#
# 用法：
#   scripts/version.sh                 # 看当前版本（两个包各读一次并校验一致）
#   scripts/version.sh bump patch      # 补丁（修 bug / 小改）  0.2.0 → 0.2.1
#   scripts/version.sh bump minor      # 功能（新能力/结构变化）0.2.1 → 0.3.0
#   scripts/version.sh bump major      # 大改（口径/接口不兼容）0.3.0 → 1.0.0
#   scripts/version.sh set 1.2.3       # 直接指定（必须 X.Y.Z）
#
# 约定：**每次要让 114 或 125 重新加载插件时，先 bump**。版本号只在「发布」时动，
# 平时改代码不必每 commit 都改（否则一串 commit 全是版本噪声）。
# 生效：版本号写进 package.json，主插件 `ready: vX.Y.Z` 与面板页脚/自检行都会显示；
#      改完仍需重启 dsh-web（或重跑 deploy-panel.sh）才会被加载。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAIN="$ROOT/package.json"
PANEL="$ROOT/panel/package.json"

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

show() {
  local main panel
  main=$(read_version "$MAIN")
  panel=$(read_version "$PANEL")
  printf '主插件 package.json : %s\n' "${main:-（读不到）}"
  printf '面板   package.json : %s\n' "${panel:-（读不到）}"
  if [ -z "$main" ] || [ "$main" != "$panel" ]; then
    echo '!! 两处版本不一致（或读不到）——跑 scripts/version.sh bump patch 对齐' >&2
    return 1
  fi
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

apply() {
  local ver=$1
  validate "$ver"
  write_version "$MAIN" "$ver"
  write_version "$PANEL" "$ver"
  sync_lock "$ver"
  if ! show >/dev/null 2>&1; then
    echo '!! 写入后两处仍不一致，请检查 package.json 的 version 行格式' >&2
    show || true
    exit 1
  fi
  show
  echo
  echo "已改为 ${ver}。让运行态看到它："
  echo '  本机：bash scripts/sync-local-plugin.sh && bash scripts/sync-local-panel.sh，然后重启 dsh-web'
  echo '  125 ：PANEL_HOST=root@<es 主机> PANEL_CONTAINER=dsh-xqh bash scripts/deploy-panel.sh'
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
    show >/dev/null && echo "版本一致：$(read_version "$MAIN")"
    ;;
  *)
    echo "未知子命令「$1」；可用：get / bump <patch|minor|major> / set X.Y.Z / check" >&2
    exit 2
    ;;
esac
