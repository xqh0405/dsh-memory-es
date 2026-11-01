#!/usr/bin/env bash
# 本机同步：仓库 → local-plugins/dsh-memory-es（整包）→ profile 里那份安装拷贝。
#
# 为什么需要它（2026-10-31 踩过）：profile 的依赖声明是
#   "dsh-memory-es": "file:~/.dsh/local-plugins/dsh-memory-es"
# pnpm 再把它拷进 profile 的 node_modules。**这两份都不是指向仓库的链接**，
# 所以只 `tsdown` 构建仓库的 lib/，重启 dsh-web 也还是旧代码。
#
# 合并成一个包之后（0.3.0 起），插件与面板一起同步：lib/（Node 半边）+ panel/（浏览器 +
# 宿主路由）+ package.json + cordis.patch.yml。不再有单独的 sync-local-panel.sh。
#
# 用法：
#   scripts/sync-local-plugin.sh            # 同步并逐处校验 md5
#   scripts/sync-local-plugin.sh --check    # 只比对不写（排查「改了没生效」用）
#
# 生效：必须重启 dsh-web（插件是 ESM，加载后不热重载）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_LIB="$ROOT/lib"
SRC_PANEL="$ROOT/panel"
CHECK_ONLY=0
if [ "${1:-}" = "--check" ]; then
  CHECK_ONLY=1
fi

[ -f "$SRC_LIB/index.js" ] || {
  echo "缺少 $SRC_LIB/index.js —— 先构建：npx tsdown（或 npm run build）" >&2
  exit 1
}

DESTS=(
  "$HOME/.dsh/local-plugins/dsh-memory-es"
  "$HOME/.dsh/profiles/web/node_modules/dsh-memory-es"
)

sum() { if [ -f "$1" ]; then md5sum <"$1" | cut -d' ' -f1; else echo missing; fi; }

src_lib=$(sum "$SRC_LIB/index.js")
src_panel=$(sum "$SRC_PANEL/index.js")
echo "仓库  lib/index.js   md5=$src_lib"
echo "仓库  panel/index.js md5=$src_panel"

pending=0
for dest in "${DESTS[@]}"; do
  if [ ! -d "$dest" ]; then
    echo "  [skip] $dest 不存在（这不是本机部署的目标目录）"
    continue
  fi
  dest_lib=$(sum "$dest/lib/index.js")
  dest_panel=$(sum "$dest/panel/index.js")
  if [ "$CHECK_ONLY" = "1" ]; then
    if [ "$dest_lib" = "$src_lib" ] && [ "$dest_panel" = "$src_panel" ]; then
      if [ -f "$dest/panel/cli/consolidate/cli.ts" ]; then
        echo "  [ok]   $dest（一致）"
      else
        echo "  [diff] $dest（缺 panel/cli）"
        pending=1
      fi
    else
      echo "  [diff] $dest（lib=$dest_lib panel=$dest_panel）"
      pending=1
    fi
    continue
  fi
  rm -rf "$dest/lib" "$dest/panel"
  cp -a "$SRC_LIB" "$dest/lib"
  cp -a "$SRC_PANEL" "$dest/panel"
  # 仓库 panel/ 里不存 CLI 源码副本（打包时才生成）；本地同步也必须补上，
  # 否则面板「维护」页会报「未随带 CLI 源码，整理与导出不可用」
  mkdir -p "$dest/panel/cli"
  cp -a "$ROOT/consolidate" "$ROOT/src" "$dest/panel/cli/"
  cp -f "$ROOT/package.json" "$ROOT/cordis.patch.yml" "$dest"/
  echo "  [sync] $dest（lib + panel + package.json + cordis.patch.yml）"
done

if [ "$CHECK_ONLY" = "1" ]; then
  if [ "$pending" = "1" ]; then
    echo "有目录与仓库不一致：跑一次 scripts/sync-local-plugin.sh" >&2
    exit 1
  fi
  echo "全部一致"
else
  echo
  echo "已同步。生效需要重启 dsh-web："
  echo "  kill -TERM \$(systemctl show dsh-web -p MainPID --value)"
  echo "判据：进程启动时间晚于 lib/index.js 的 mtime，且面板自检行版本号是新的"
fi
