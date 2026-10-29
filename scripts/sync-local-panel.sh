#!/usr/bin/env bash
# 本机（非容器）同步记忆库面板：panel/*.js + 面板内置的 CLI 源码 → profile / local-plugins。
#
# 为什么需要它：deploy-panel.sh 是给容器用的（打包 → docker cp → 重装 profile）。
# 本机以前是手工 `cp panel/*.js`，**漏了 cli/**——结果面板跑的是旧版 CLI，
# 单账号凭据不被识别，整理任务报「.env 缺少 MEM_READER_PASSWORD」（2026-10-29 踩过）。
#
# 用法：scripts/sync-local-panel.sh
# 生效：panel/*.js 改了要重启 dsh-web；cli/ 每次调用都会重新读文件，改完即生效。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESTINATIONS=(
  "$HOME/.dsh/profiles/web/node_modules/dsh-memory-es-panel"
  "$HOME/.dsh/local-plugins/dsh-memory-es-panel"
)

synced=0
for dest in "${DESTINATIONS[@]}"; do
  if [ ! -d "$dest" ]; then
    echo "[skip] $dest 不存在"
    continue
  fi
  cp -f "$ROOT"/panel/*.js "$dest"/
  # CLI 源码：面板内置的那份必须和仓库同步，否则「面板能连 ES、整理却报凭据缺失」
  if [ -d "$dest/cli" ]; then
    mkdir -p "$dest/cli/src/es" "$dest/cli/src/memory"
    cp -f "$ROOT"/consolidate/*.ts "$dest/cli/consolidate/"
    cp -f "$ROOT"/src/*.ts "$dest/cli/src/"
    cp -f "$ROOT"/src/es/*.ts "$dest/cli/src/es/"
    cp -f "$ROOT"/src/memory/*.ts "$dest/cli/src/memory/"
  fi
  echo "[ok] $dest"
  synced=$((synced + 1))
done

if [ "$synced" -eq 0 ]; then
  echo "没有可同步的目标目录（这台机器可能不是本机部署）" >&2
  exit 1
fi

# 自检：面板内置 CLI 必须认单账号凭据，否则整理任务会退回到三账号报错
for dest in "${DESTINATIONS[@]}"; do
  f="$dest/cli/consolidate/cli.ts"
  [ -f "$f" ] || continue
  if grep -q "MEM_USERNAME" "$f"; then
    echo "[check] $(basename "$(dirname "$dest")") 的 cli.ts 支持单账号"
  else
    echo "[check] 警告：$f 是旧版（不认识 MEM_USERNAME），整理任务会失败" >&2
    exit 1
  fi
done
