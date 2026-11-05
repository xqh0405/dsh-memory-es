#!/usr/bin/env bash
# 从发行包安装/更新 dsh-memory-es（由 scripts/package.sh 打进 tar.gz 里，文件名 install.sh）。
#
# **一个包**：插件（Node 半边）与面板（浏览器 + 宿主路由）在同一个 npm 包里，
# 所以这里只需要把 plugin/ 放到 local-plugins/dsh-memory-es，再 add 一次。
#
# 用法（在解包后的目录里）：
#   ./install.sh                        # 本机：DSH_HOME=~/.dsh，profile=web
#   ./install.sh --dsh-home /data/dsh   # 容器里（node 用户）
#   ./install.sh --dry-run              # 只打印要做什么
#   ./install.sh --profile web-test     # 装到别的 profile
#   ./install.sh --owner node           # root 执行时把属主改成 node（容器里 dsh 以 node 跑）
#   ./install.sh --skip-selfcheck       # 不跑装后自检（CI/脚本里用）
#
# 装完会自动跑一次 selfcheck.sh（七项 PASS/FAIL）：装成功 ≠ 能用，
# ES/CA/账号/索引/embedding/配置 任一没就位都在那一屏里说清楚。
#
# 从旧版（面板是独立包 dsh-memory-es-panel）升级时，脚本会自动移除那个包并清理
# dsh.profile.bundles 里的旧名——否则两个「记忆库」面板会同时注册。
#
# 幂等：重复跑 = 覆盖成这一版。装完需要重启 dsh-web（运行中进程持旧模块图）。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${MEMORY_ES_PROFILE:-web}"
WITH_STICKERS=1
DRY_RUN=0
SELFCHECK=1
# 容器里常以 root 执行 docker exec，但 dsh 以 node 跑：装完需要 chown，
# 否则 node 用户读不到 / 写不了（症状是插件不加载或面板打不开）
OWNER=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dsh-home) DSH_HOME="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --no-stickers) WITH_STICKERS=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-selfcheck) SELFCHECK=0; shift ;;
    --owner) OWNER="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

VERSION="$(cat "$HERE/VERSION" 2>/dev/null || echo unknown)"
echo "==> dsh-memory-es 安装包 v${VERSION}（插件 + 面板，单包）"
echo "    DSH_HOME=${DSH_HOME}"
echo "    profile =${PROFILE}"

[ -f "$HERE/plugin/package.json" ] || { echo "包不完整：缺少 plugin/package.json" >&2; exit 1; }
[ -f "$HERE/plugin/lib/index.js" ] || { echo "包不完整：缺少 plugin/lib/index.js（构建产物）" >&2; exit 1; }
[ -f "$HERE/plugin/panel/index.js" ] || { echo "包不完整：缺少 plugin/panel/index.js（面板宿主）" >&2; exit 1; }

run() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "    [dry-run] $*"
  else
    "$@"
  fi
}

PLUGIN_DEST="$DSH_HOME/local-plugins/dsh-memory-es"
LEGACY_PANEL="$DSH_HOME/local-plugins/dsh-memory-es-panel"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
BUNDLES_SCRIPT="
    const fs = require('node:fs')
    const file = process.env.PROFILE_PKG
    const want = ['dsh-memory-es']
    const drop = ['dsh-memory-es-panel']
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
    pkg.dsh = pkg.dsh || {}
    pkg.dsh.profile = pkg.dsh.profile || {}
    const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
    const kept = bundles.filter((name) => !drop.includes(name))
    const added = []
    for (const name of want) if (!kept.includes(name)) { kept.push(name); added.push(name) }
    pkg.dsh.profile.bundles = kept
    const changed = added.length > 0 || kept.length !== bundles.length
    if (changed) fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
    const dropped = bundles.filter((name) => drop.includes(name))
    console.log('    ' + [
      added.length ? '已加入 bundles: ' + added.join('、') : 'bundles 已包含 dsh-memory-es',
      dropped.length ? '已移除旧面板 bundle: ' + dropped.join('、') : '',
    ].filter(Boolean).join('；'))
"

echo "==> 1/4 插件 + 面板 → $PLUGIN_DEST"
run mkdir -p "$PLUGIN_DEST"
# 先清掉旧版本的 lib/panel 再整体覆盖，避免删掉的文件残留（例如旧版遗留的 panel/package.json）
run rm -rf "$PLUGIN_DEST/lib" "$PLUGIN_DEST/panel"
run cp -a "$HERE/plugin/." "$PLUGIN_DEST/"

echo "==> 2/4 清理旧版独立面板包"
if [ -d "$LEGACY_PANEL" ]; then
  echo "    发现旧版 dsh-memory-es-panel，移除（新版已合并进主包）"
  run rm -rf "$LEGACY_PANEL"
else
  echo "    无旧面板包，跳过"
fi
if command -v dsh >/dev/null 2>&1 && [ "$DRY_RUN" != "1" ]; then
  # 失败不致命：该包可能从未装进这个 profile
  dsh plugin --profile "$PROFILE" remove dsh-memory-es-panel >/dev/null 2>&1 || true
fi

echo "==> 3/4 装进 profile（dsh plugin add，等价于 pnpm add file:）"
if command -v dsh >/dev/null 2>&1; then
  if [ "$DRY_RUN" = "1" ]; then
    echo "    [dry-run] dsh plugin --profile $PROFILE add file:$PLUGIN_DEST"
  else
    dsh plugin --profile "$PROFILE" add "file:$PLUGIN_DEST" >/dev/null
    echo "    ok（profile 已记录）"
  fi
else
  echo "    ! 找不到 dsh 命令：跳过 profile 注册。请在能执行 dsh 的环境里补跑：" >&2
  echo "      dsh plugin --profile $PROFILE add file:$PLUGIN_DEST" >&2
fi

# 第三步才是"真加载"：dsh plugin add 只把包装进 node_modules，
# profile 的 dsh.profile.bundles 里没有包名时插件不会加载（接口 404、日志静默）。
echo "==> 确认 profile 的 bundles 列表"
PROFILE_PKG="$PROFILE_DIR/package.json"
if [ ! -f "$PROFILE_PKG" ]; then
  echo "    ! 找不到 $PROFILE_PKG（profile 还没初始化？先跑一次 dsh --profile $PROFILE 任意命令）" >&2
elif [ "$DRY_RUN" = "1" ]; then
  echo "    [dry-run] 确保 bundles 含 dsh-memory-es、移除 dsh-memory-es-panel"
elif command -v node >/dev/null 2>&1; then
  PROFILE_PKG="$PROFILE_PKG" node -e "$BUNDLES_SCRIPT"
else
  echo "    ! 找不到 node：请手工把 dsh-memory-es 加进 $PROFILE_PKG 的 dsh.profile.bundles，并删掉 dsh-memory-es-panel" >&2
fi

# 表情包：**只补缺**。用户可能改过某张图、加了自己的贴图、或删掉了不喜欢的，
# 整目录替换会把这些全抹掉（旧版就是备份后覆盖），所以这里逐个文件判断存在性。
if [ "$WITH_STICKERS" = "1" ] && [ -d "$HERE/stickers" ] && [ -f "$HERE/stickers/stickers.json" ]; then
  echo "==> 4/4 表情包 → $DSH_HOME/stickers（只补缺，已有文件不动）"
  run mkdir -p "$DSH_HOME/stickers"
  if [ "$DRY_RUN" = "1" ]; then
    echo "    [dry-run] 补缺 $(cd "$HERE/stickers" && find . -type f | wc -l | tr -d ' ') 个文件"
  else
    added=0
    kept=0
    while IFS= read -r -d '' rel; do
      rel="${rel#./}"
      if [ -e "$DSH_HOME/stickers/$rel" ]; then
        kept=$((kept + 1))
        continue
      fi
      mkdir -p "$DSH_HOME/stickers/$(dirname "$rel")"
      cp -a "$HERE/stickers/$rel" "$DSH_HOME/stickers/$rel"
      added=$((added + 1))
    done < <(cd "$HERE/stickers" && find . -type f -print0)
    echo "    新增 ${added} 个；保留已有 ${kept} 个"
  fi
else
  echo "==> 4/4 表情包：跳过"
fi

# root 执行且给了 --owner 时收尾 chown（容器里 dsh 以 node 运行，属主不对会读不到）
if [ -n "$OWNER" ] && [ "$(id -u)" = "0" ] && [ "$DRY_RUN" != "1" ]; then
  echo "==> 调整属主为 $OWNER"
  chown -R "$OWNER" "$PLUGIN_DEST" 2>/dev/null || true
  if [ -d "$PROFILE_DIR" ]; then chown -R "$OWNER" "$PROFILE_DIR" 2>/dev/null || true; fi
  if [ -d "$DSH_HOME/stickers" ]; then chown -R "$OWNER" "$DSH_HOME/stickers" 2>/dev/null || true; fi
elif [ -n "$OWNER" ] && [ "$(id -u)" != "0" ]; then
  echo "    ! --owner 只有 root 执行时生效（当前 uid=$(id -u)），已忽略"
fi

# 装完自检：装成功 ≠ 能用。ES 没起 / CA 路径不对 / 账号没建 / 没配 identity，
# 全都在这一屏里用 PASS-FAIL 说清楚，并给出下一步命令。
# 自检不改变安装结果（退出码仍是 0），只在有 FAIL 时把「还没就绪」讲明白。
SELFCHECK_FAILED=0
if [ "$SELFCHECK" = "1" ] && [ "$DRY_RUN" != "1" ] && [ -f "$HERE/selfcheck.sh" ]; then
  echo
  echo "==> 装后自检"
  if ! DSH_HOME="$DSH_HOME" MEMORY_ES_PROFILE="$PROFILE" bash "$HERE/selfcheck.sh" \
      --dsh-home "$DSH_HOME" --profile "$PROFILE"; then
    SELFCHECK_FAILED=1
  fi
fi

echo
echo "完成：v${VERSION} 已就位（$PLUGIN_DEST，插件与面板同一个包）"
echo "人格：内置在插件里（persona/seed.md），装完直接生效，不需要写配置"
echo "      要换成自己的，就在 profile 的 cordis.patch.yml 里配 persona.seed —— 配置优先，升级不会覆盖"
echo "生效：重启 dsh-web（本机：kill -TERM \$(systemctl show dsh-web -p MainPID --value)；容器：docker restart <容器名>）"
echo "核对：插件日志 'ready: v${VERSION}'、面板自检 '自检通过 v${VERSION}'、面板页脚「版本 ${VERSION}」"
if [ "$SELFCHECK_FAILED" = "1" ]; then
  echo
  echo '!! 自检未全绿：插件已装好，但「还没就绪」。第一次装通常是因为 ES 还没起、'
  echo '   配置里还没有 dsh-memory-es 段。按上面「下一步」修，或直接跑：'
  echo '     ./es/setup.sh        # 起 ES + 建账号 + 生成配置片段'
  echo '     ./selfcheck.sh       # 修完再自检'
fi
