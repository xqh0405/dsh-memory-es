#!/usr/bin/env bash
# 把 dsh 自带的 @deepseek-ai/* 以符号链接接进本项目 node_modules。
# 骨架里的 link_deps.py 是 Windows junction 版，这里是 Linux 等价实现。
#
# 为什么不用 npm install 装这些包：必须与运行中的 dsh 版本完全一致，
# 装 registry 版本会因为 Loader 校验的是它自己那份实例而出现类型/运行时不一致。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${DSH_HOST_PKGS:-/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai}"
DST="$ROOT/node_modules/@deepseek-ai"
PKGS=(cordis schemastery dsh-tools dsh-system-prompt)

if [ ! -d "$SRC" ]; then
  echo "找不到 dsh 宿主包目录：$SRC"
  echo "用 DSH_HOST_PKGS=/path/to/@deepseek-ai 覆盖（通常在同 dsh 的 node_modules/@deepseek-ai）"
  exit 1
fi

mkdir -p "$DST"
missing=()
for p in "${PKGS[@]}"; do
  if [ -d "$SRC/$p" ]; then
    ln -sfn "$SRC/$p" "$DST/$p"
    echo "  link @deepseek-ai/$p -> $SRC/$p"
  else
    missing+=("$p")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "缺少宿主依赖：${missing[*]}"
  exit 1
fi
echo "宿主依赖链接完成（$(node -p "require('$SRC/dsh-tools/package.json').version")）"
