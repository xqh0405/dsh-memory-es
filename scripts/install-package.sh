#!/usr/bin/env bash
# 从发行包安装/更新 dsh-memory-es（由 scripts/package.sh 打进 tar.gz 里，文件名 install.sh）。
#
# 设计目标：**只带一个包**，目标机器上不需要仓库、不需要 node_modules、不需要构建。
# 这个脚本负责把包里的三样东西放到 dsh 会读取的位置：
#   1) 主插件  → $DSH_HOME/local-plugins/dsh-memory-es        （+ dsh plugin add 装进 profile）
#   2) 面板    → $DSH_HOME/local-plugins/dsh-memory-es-panel  （含面板内置的 CLI 源码）
#   3) 表情包  → $DSH_HOME/stickers                            （可选，--no-stickers 跳过）
#
# 用法（在解包后的目录里）：
#   ./install.sh                        # 本机：DSH_HOME=~/.dsh，profile=web
#   ./install.sh --dsh-home /data/dsh   # 容器里（node 用户）
#   ./install.sh --dry-run              # 只打印要做什么
#   ./install.sh --profile web-test     # 装到别的 profile
#   ./install.sh --owner node           # root 执行时把属主改成 node（容器里 dsh 以 node 跑）
#
# 幂等：重复跑 = 覆盖成这一版。装完需要重启 dsh-web（插件从 lib 加载，运行中进程持旧模块图）。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${MEMORY_ES_PROFILE:-web}"
WITH_STICKERS=1
DRY_RUN=0
# 容器里常以 root 执行 docker exec，但 dsh 以 node 跑：装完需要 chown，
# 否则 node 用户读不到 / 写不了（症状是插件不加载或面板打不开）
OWNER=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dsh-home) DSH_HOME="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --no-stickers) WITH_STICKERS=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --owner) OWNER="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

VERSION="$(cat "$HERE/VERSION" 2>/dev/null || echo unknown)"
echo "==> dsh-memory-es 安装包 v${VERSION}"
echo "    DSH_HOME=${DSH_HOME}"
echo "    profile =${PROFILE}"

[ -f "$HERE/plugin/package.json" ] || { echo "包不完整：缺少 plugin/package.json" >&2; exit 1; }
[ -f "$HERE/plugin/lib/index.js" ] || { echo "包不完整：缺少 plugin/lib/index.js（构建产物）" >&2; exit 1; }
[ -f "$HERE/panel/package.json" ] || { echo "包不完整：缺少 panel/package.json" >&2; exit 1; }

run() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "    [dry-run] $*"
  else
    "$@"
  fi
}

PLUGIN_DEST="$DSH_HOME/local-plugins/dsh-memory-es"
PANEL_DEST="$DSH_HOME/local-plugins/dsh-memory-es-panel"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"

echo "==> 1/5 主插件 → $PLUGIN_DEST"
run mkdir -p "$PLUGIN_DEST"
run rm -rf "$PLUGIN_DEST/lib"
run cp -a "$HERE/plugin/lib" "$HERE/plugin/package.json" "$HERE/plugin/cordis.patch.yml" "$PLUGIN_DEST/"

echo "==> 2/5 面板（含内置 CLI）→ $PANEL_DEST"
run mkdir -p "$PANEL_DEST"
run cp -f "$HERE"/panel/*.js "$PANEL_DEST"/
run cp -f "$HERE/panel/package.json" "$HERE/panel/cordis.patch.yml" "$PANEL_DEST"/
if [ -f "$HERE/panel/icon.svg" ]; then run cp -f "$HERE/panel/icon.svg" "$PANEL_DEST"/; fi
if [ -d "$HERE/panel/locale" ]; then run cp -a "$HERE/panel/locale" "$PANEL_DEST"/; fi
run mkdir -p "$PANEL_DEST/cli"
run cp -a "$HERE/panel/cli/consolidate" "$HERE/panel/cli/src" "$PANEL_DEST/cli/"

echo "==> 3/5 装进 profile（dsh plugin add，等价于 pnpm add file:）"
if command -v dsh >/dev/null 2>&1; then
  if [ "$DRY_RUN" = "1" ]; then
    echo "    [dry-run] dsh plugin --profile $PROFILE add file:$PLUGIN_DEST"
    echo "    [dry-run] dsh plugin --profile $PROFILE add file:$PANEL_DEST"
  else
    dsh plugin --profile "$PROFILE" add "file:$PLUGIN_DEST" >/dev/null
    dsh plugin --profile "$PROFILE" add "file:$PANEL_DEST" >/dev/null
    echo "    ok（profile 已记录）"
  fi
else
  echo "    ! 找不到 dsh 命令：跳过 profile 注册。请在能执行 dsh 的环境里补跑：" >&2
  echo "      dsh plugin --profile $PROFILE add file:$PLUGIN_DEST" >&2
  echo "      dsh plugin --profile $PROFILE add file:$PANEL_DEST" >&2
fi

if [ "$WITH_STICKERS" = "1" ] && [ -d "$HERE/stickers" ] && [ -f "$HERE/stickers/stickers.json" ]; then
  echo "==> 4/5 表情包 → $DSH_HOME/stickers"
  if [ -d "$DSH_HOME/stickers" ] && ! diff -rq "$HERE/stickers" "$DSH_HOME/stickers" >/dev/null 2>&1; then
    BACKUP="$DSH_HOME/stickers.bak-$(date +%Y%m%d%H%M%S)"
    echo "    已有目录内容不同，先备份到 $BACKUP"
    run mv "$DSH_HOME/stickers" "$BACKUP"
  fi
  run mkdir -p "$DSH_HOME/stickers"
  run cp -a "$HERE/stickers/." "$DSH_HOME/stickers/"
else
  echo "==> 4/5 表情包：跳过"
fi

# 第三步才是"真加载"：dsh plugin add 只把包装进 node_modules，
# 而 profile 的 dsh.profile.bundles 里没有包名时，插件**不会加载**（接口 404、日志静默）。
# 这一步幂等：已在列表里就什么都不做。
echo "==> 5/5 确认 profile 的 bundles 列表"
PROFILE_PKG="$PROFILE_DIR/package.json"
if [ ! -f "$PROFILE_PKG" ]; then
  echo "    ! 找不到 $PROFILE_PKG（profile 还没初始化？先跑一次 dsh --profile $PROFILE 任意命令）" >&2
elif [ "$DRY_RUN" = "1" ]; then
  echo "    [dry-run] 确保 $PROFILE_PKG 的 dsh.profile.bundles 含 dsh-memory-es 与 dsh-memory-es-panel"
elif command -v node >/dev/null 2>&1; then
  PROFILE_PKG="$PROFILE_PKG" node -e '
    const fs = require("node:fs")
    const file = process.env.PROFILE_PKG
    const want = ["dsh-memory-es", "dsh-memory-es-panel"]
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"))
    pkg.dsh = pkg.dsh || {}
    pkg.dsh.profile = pkg.dsh.profile || {}
    const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
    const added = []
    for (const name of want) if (!bundles.includes(name)) { bundles.push(name); added.push(name) }
    pkg.dsh.profile.bundles = bundles
    if (added.length > 0) fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n")
    console.log(added.length > 0 ? "    已加入 bundles: " + added.join("、") : "    bundles 已包含两个包")
  '
else
  echo "    ! 找不到 node：请手工把 dsh-memory-es 与 dsh-memory-es-panel 加进 $PROFILE_PKG 的 dsh.profile.bundles" >&2
fi

# root 执行且给了 --owner 时收尾 chown（容器里 dsh 以 node 运行，属主不对会读不到）
if [ -n "$OWNER" ] && [ "$(id -u)" = "0" ] && [ "$DRY_RUN" != "1" ]; then
  echo "==> 调整属主为 $OWNER"
  chown -R "$OWNER" "$PLUGIN_DEST" "$PANEL_DEST" 2>/dev/null || true
  if [ -d "$PROFILE_DIR" ]; then chown -R "$OWNER" "$PROFILE_DIR" 2>/dev/null || true; fi
  if [ -d "$DSH_HOME/stickers" ]; then chown -R "$OWNER" "$DSH_HOME/stickers" 2>/dev/null || true; fi
elif [ -n "$OWNER" ] && [ "$(id -u)" != "0" ]; then
  echo "    ! --owner 只有 root 执行时生效（当前 uid=$(id -u)），已忽略"
fi

echo
echo "完成：v${VERSION} 已就位（$PLUGIN_DEST / $PANEL_DEST）"
echo "生效：重启 dsh-web（本机：kill -TERM \$(systemctl show dsh-web -p MainPID --value)；容器：docker restart <容器名>）"
echo "核对：插件日志里的 'ready: v${VERSION}'，面板自检行的 '自检通过 v${VERSION}'，面板页脚「版本 ${VERSION}」"
