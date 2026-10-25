#!/usr/bin/env bash
# S1 构建：装 devDeps → 链宿主依赖 → 打包（lib/index.js + index.d.ts）
set -euo pipefail
cd "$(dirname "$0")/.."

echo '== 1/3 npm install（--legacy-peer-deps：宿主依赖靠 link-deps 提供，不从 registry 装）=='
npm install --no-audit --no-fund --legacy-peer-deps ${NPM_REGISTRY:+--registry="$NPM_REGISTRY"}

echo
echo '== 2/3 链宿主依赖 =='
bash scripts/link-deps.sh

echo
echo '== 3/3 tsdown =='
npx tsdown

echo
echo '== 产物 =='
ls -l lib/
