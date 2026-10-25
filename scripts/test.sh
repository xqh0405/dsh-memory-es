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
# --test-concurrency=1：集成测试共用同一个 ES 索引，并发跑文件会互相看不见/互相删数据。
# 2026-10-25 实测：整理任务（按设计扫整个个人索引）把别的测试文件刚写的文档也当成了候选，
# dry-run 的条数断言假红，apply 还会去改别人正在清理的文档（404 document_missing）。
exec node --test --test-concurrency=1 "${files[@]}"
