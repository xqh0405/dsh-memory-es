#!/usr/bin/env bash
# 质量闸一条命令：静态层永远跑，真评测层只有在能连 ES 时才跑。
#
# 为什么不是「CI 里起一个 ES」：
#  · 契约评测按 memory_id 命中**真实记忆**（`tests/eval/contracts.jsonl` 里是固定 id），
#    临时 ES 里没有那些数据，跑出来必然全红——它只能在有真库的环境跑；
#  · 集成测试需要 TLS + 多身份权限（init-security.sh 那一套），在 GitHub runner 里
#    重建一遍的维护成本高于收益，而且这个仓库的 CI 只在 push github 时触发。
# 所以：**静态层进 CI（.github/workflows/ci.yml），真评测层留一条可复跑的入口**，
# 内网 Jenkins、本机、125 上都能用同一条命令。
#
# 用法：
#   scripts/quality-gate.sh              # 全跑（有 ES 环境时含真评测）
#   scripts/quality-gate.sh --static     # 只跑静态层（typecheck/test/契约静态闸）
#   scripts/quality-gate.sh --eval-config ~/.dsh/profiles/web/cordis.patch.yml
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

STATIC_ONLY=0
EVAL_CONFIG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --static) STATIC_ONLY=1; shift ;;
    --eval-config) EVAL_CONFIG="$2"; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

step() { printf '\n== %s ==\n' "$1"; }

step '1/4 类型检查'
npm run typecheck

step '2/4 单测'
npm test

step '3/4 契约静态闸（不连 ES）'
npm run check:contracts

if [ "$STATIC_ONLY" = "1" ]; then
  echo
  echo '静态层全过（--static：跳过真评测）'
  exit 0
fi

# 真评测的入口判断：有哪一份「能连 ES」的凭据就跑。
#  - deploy/es/.env        ：本机/容器内直接部署的 ES
#  - $MEM_ES_URL           ：CI 或远程
#  - profile 的 cordis.patch.yml：这台机器通过 DSH profile 连 ES（本机 114 就是这种）
CONFIG_ARG=()
if [ -n "$EVAL_CONFIG" ]; then
  CONFIG_ARG=(--config "$EVAL_CONFIG")
elif [ -f "$ROOT/deploy/es/.env" ]; then
  CONFIG_ARG=()
elif [ -n "${MEM_ES_URL:-}" ]; then
  CONFIG_ARG=()
elif [ -f "$HOME/.dsh/profiles/web/cordis.patch.yml" ]; then
  CONFIG_ARG=(--config "$HOME/.dsh/profiles/web/cordis.patch.yml")
else
  echo
  echo '跳过真评测：找不到 ES 环境（deploy/es/.env、$MEM_ES_URL 或 profile 配置都没有）'
  echo '静态层全过；要跑召回质量，在有 ES 的机器上加 --eval-config <path>'
  exit 0
fi

step '4/4 真实召回质量（--gate：should 失败数不得高于基线）'
node scripts/eval-contracts.ts "${CONFIG_ARG[@]}" --gate

echo
echo '全部通过'