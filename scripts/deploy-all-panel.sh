#!/usr/bin/env bash
# 把「全量」部署铺到 125 上的全部 dsh 容器（plugin + panel + cli 三包）。
#
# 为什么必须全量：只换主插件 lib 会留下两种漂移——
#   · 面板停在旧构建（2026-10-30 实测：主插件已 105841，面板还是 del-20261029，
#     用户在页面上完全看不出更新过）；
#   · CLI 找不到新源码（面板「维护」页跑 consolidate 依赖 local-plugins/cli/）。
# 逐容器的同步/重装/重启/自检全部由 scripts/deploy-panel.sh 负责，本脚本只做编排。
#
# 用法：
#   PANEL_SSH_KEY=~/.ssh/dsh_ai ./scripts/deploy-all-panel.sh              # 全部 10 个
#   PANEL_SSH_KEY=~/.ssh/dsh_ai ./scripts/deploy-all-panel.sh dsh-test     # 只跑指定容器
#
# ⚠️ 会重启容器 —— 白天不要跑成员容器（唯一例外 dsh-test），部署窗口见 MEMORY。
set -uo pipefail

HOST="${PANEL_HOST:?请用 PANEL_HOST=user@host 指定目标主机}"
KEY="${PANEL_SSH_KEY:-$HOME/.ssh/dsh_ai}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 显式列出而不是 docker ps 通配：dsh-es 是 ES 本体，dsh-* 里还有 dsh-market 之类非实例容器
ALL=(dsh-xqh dsh-chencan dsh-hongzhihui dsh-laoliu dsh-liuxinling
     dsh-molijin dsh-tanxu dsh-test dsh-zhongjinqi dsh-zhongyuhang)

if [ $# -gt 0 ]; then
  TARGETS=("$@")
else
  TARGETS=("${ALL[@]}")
fi

ok=0; fail=0
for c in "${TARGETS[@]}"; do
  printf '\n========== %s ==========\n' "$c"
  if PANEL_HOST="$HOST" PANEL_SSH_KEY="$KEY" PANEL_CONTAINER="$c" \
       bash "$REPO_ROOT/scripts/deploy-panel.sh"; then
    ok=$((ok + 1))
  else
    echo "!! $c 部署失败（继续下一个）" >&2
    fail=$((fail + 1))
  fi
done

printf '\n结束：成功 %d，失败 %d\n' "$ok" "$fail"
[ "$fail" -eq 0 ]
