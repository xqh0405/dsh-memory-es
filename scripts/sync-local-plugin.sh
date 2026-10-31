#!/usr/bin/env bash
# 本机同步主插件的构建产物：仓库 lib/ → local-plugins → profile 的 node_modules。
#
# 为什么需要它（2026-10-31 踩过）：profile 的依赖声明是
#   "dsh-memory-es": "file:~/.dsh/local-plugins/dsh-memory-es"
# pnpm 再把它拷进 profile 的 node_modules。**这两份都不是指向仓库的链接**，
# 所以只 `tsdown` 构建仓库的 lib/，重启 dsh-web 也还是旧代码——
# 今天就是这样白重启了一次：判重功能构建好了、grep 得到，界面上却依然 0 条跳过。
#
# 与 sync-local-panel.sh 的分工：那个管面板（panel/*.js + 内置 CLI），这个管主插件。
#
# 用法：
#   scripts/sync-local-plugin.sh            # 同步并逐处校验 md5
#   scripts/sync-local-plugin.sh --check    # 只比对不写（排查「改了没生效」用）
#
# 生效：必须重启 dsh-web（插件是 ESM，加载后不热重载）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/lib"
DESTINATIONS=(
  "$HOME/.dsh/local-plugins/dsh-memory-es/lib"
  "$HOME/.dsh/profiles/web/node_modules/dsh-memory-es/lib"
)
CHECK_ONLY=0
if [ "${1:-}" = "--check" ]; then
  CHECK_ONLY=1
fi

if [ ! -f "$SRC/index.js" ]; then
  echo "缺少 $SRC/index.js —— 先构建：npx tsdown（或 npm run build）" >&2
  exit 1
fi

src_sum=$(md5sum < "$SRC/index.js" | cut -d' ' -f1)
echo "仓库 lib/index.js  md5=$src_sum"

pending=0
for dest in "${DESTINATIONS[@]}"; do
  if [ ! -d "$dest" ]; then
    echo "[跳过] $dest 不存在（这台机器可能不是本机部署）"
    continue
  fi
  cur=$(md5sum < "$dest/index.js" 2>/dev/null | cut -d' ' -f1 || true)
  if [ "$cur" = "$src_sum" ]; then
    echo "[一致] $dest"
    continue
  fi
  if [ "$CHECK_ONLY" = "1" ]; then
    echo "[待同步] $dest （当前 ${cur:-缺失}）"
    pending=$((pending + 1))
    continue
  fi
  cp -a "$SRC"/. "$dest"/
  new=$(md5sum < "$dest/index.js" | cut -d' ' -f1)
  if [ "$new" = "$src_sum" ]; then
    echo "[已同步] $dest"
    pending=$((pending + 1))
  else
    echo "[失败] $dest 写入后 md5 仍不一致（$new）" >&2
    exit 1
  fi
done

if [ "$CHECK_ONLY" = "1" ]; then
  if [ "$pending" -eq 0 ]; then
    echo '全部一致，无需同步。'
  else
    echo "$pending 处待同步 —— 跑一次不带参数的即可。"
  fi
  exit 0
fi

if [ "$pending" -gt 0 ]; then
  echo
  echo '⚠️ 插件是 ESM，加载后不热重载：要让新代码生效必须重启 dsh-web。'
  echo '   本机 systemctl restart 会被 polkit 拦（Interactive authentication required），'
  echo '   可用的是给主进程发 SIGTERM，靠 Restart=always 拉起（详见 README 部署一节）。'
fi
