#!/usr/bin/env bash
# 测试入口。
#   不带参数：跑全部 tests/**/*.test.ts
#   带参数：当作文件名子串过滤，如 `npm test -- es-integration` 只跑集成测试
#          （es-http / es-dsl 那种纯单测不会被顺带跑起来，因为集成测试要真实 ES）
set -euo pipefail
cd "$(dirname "$0")/.."
shopt -s nullglob globstar

files=(tests/**/*.test.ts)
if [ $# -gt 0 ]; then
  selected=()
  for pattern in "$@"; do
    matched=(tests/*"$pattern"*.test.ts)
    if [ ${#matched[@]} -eq 0 ]; then
      echo "没有匹配的测试文件：tests/*${pattern}*.test.ts" >&2
      exit 1
    fi
    selected+=("${matched[@]}")
  done
  files=("${selected[@]}")
fi

if [ ${#files[@]} -eq 0 ]; then
  echo '没有找到任何 tests/**/*.test.ts' >&2
  exit 1
fi

echo "运行：${files[*]}"
exec node --test "${files[@]}"
