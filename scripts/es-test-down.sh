#!/usr/bin/env bash
# 删掉 es-test-up.sh 起的一次性测试 ES（125 上的容器 + 目录 + 本机隧道与凭据）。
#
# 安全前提（改这个脚本前先读）：
#   · 生产是 `/docker/dsh-es`，测试是 `/docker/dsh-es-test` —— **两个不同的绝对路径**。
#     下面的删除前会硬校验路径，路径不对就拒绝执行，绝不给 `rm -rf` 一个能指到生产的机会；
#   · 测试实例对生产只做过**只读挂载**（certs / IK 插件），删测试目录不会碰到它们；
#   · 删完当场复核生产 `dsh-es` 还在跑、9200 还应答 —— 「没影响正在用的 es」要拿证据说话。
#
# 用法：scripts/es-test-down.sh [--keep-creds]
#   --keep-creds  保留本机 deploy/es-test/（含账号密码），方便下次直接重跑
set -euo pipefail

PANEL_HOST="${PANEL_HOST:-root@192.168.50.125}"
PANEL_SSH_KEY="${PANEL_SSH_KEY:-$HOME/.ssh/dsh_ai}"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i "$PANEL_SSH_KEY")

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_DIR="/docker/dsh-es-test"
PROD_DIR="/docker/dsh-es"
LOCAL_DIR="$ROOT/deploy/es-test"
LOCAL_PORT="${TEST_ES_LOCAL_PORT:-19201}"
REMOTE_PORT=9201
CA="$HOME/.dsh/certs/dsh-es-lan-ca.crt"

# ---- 硬校验：路径必须逐字等于测试目录（生产是另一个路径，绝不许 rm）----
if [ "$REMOTE_DIR" != "/docker/dsh-es-test" ] || [ "$PROD_DIR" != "/docker/dsh-es" ]; then
  echo "✗ 路径常量被改过（REMOTE_DIR=$REMOTE_DIR / PROD_DIR=$PROD_DIR）——拒绝执行删除" >&2
  exit 1
fi
case "$REMOTE_DIR" in /docker/dsh-es-test) ;; *)
  echo "✗ 目标不是一次性测试目录：$REMOTE_DIR" >&2; exit 1 ;;
esac

echo "==> 关隧道 127.0.0.1:$LOCAL_PORT"
tp=$(pgrep -f "ssh .*-L ${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}" 2>/dev/null | head -1 || true)
if [ -n "$tp" ]; then kill "$tp" 2>/dev/null && echo "  已关（pid=$tp）"; else echo "  本来就没开"; fi

echo "==> 删 125 上的测试实例"
ssh "${SSH_OPTS[@]}" "$PANEL_HOST" "bash -s" <<REMOTE
set -euo pipefail
if [ "$REMOTE_DIR" != "/docker/dsh-es-test" ]; then echo "拒绝：目标不是测试目录 $REMOTE_DIR" >&2; exit 1; fi
if docker ps -a --filter name=^dsh-es-test\$ --format '{{.Names}}' | grep -q .; then
  # 125 无 compose 插件，只有独立的 docker-compose v2（见 es-test-up.sh 同处注释）
  if docker compose version >/dev/null 2>&1; then C="docker compose"; else C="docker-compose"; fi
  if [ -f "$REMOTE_DIR/docker-compose.yml" ]; then
    \$C -f "$REMOTE_DIR/docker-compose.yml" down --remove-orphans 2>/dev/null || true
  fi
  docker rm -f dsh-es-test 2>/dev/null || true
  echo "  容器已删"
else
  echo "  容器已不存在"
fi
# 只删测试目录自己那点东西（.env / compose / data / snapshots）。
# certs 与 IK 是**从生产绝对路径挂进来的只读挂载**，本目录里没有它们的实体，删不到。
rm -rf "$REMOTE_DIR"
echo "  目录已删：$REMOTE_DIR"
[ -d "$PROD_DIR" ] && echo "  ✓ 生产目录仍在：$PROD_DIR"
REMOTE

echo "==> 删本机凭据（--keep-creds 可保留）"
if [ "${1:-}" = "--keep-creds" ]; then
  echo "  保留 $LOCAL_DIR"
else
  rm -rf "$LOCAL_DIR"
  echo "  已删 $LOCAL_DIR"
fi

echo
echo "==> 复核：生产 dsh-es 必须安然无恙"
ssh "${SSH_OPTS[@]}" "$PANEL_HOST" "docker ps --filter name=^dsh-es\$ --format '  生产容器：{{.Names}}  {{.Status}}'" || true
code=$(curl -sk --cacert "$CA" --max-time 6 -o /dev/null -w '%{http_code}' "https://192.168.50.125:9200/" || echo 000)
echo "  生产 9200 → HTTP $code （401=正常：要认证）"
if docker ps --filter name=dsh-es-test --format '{{.Names}}' 2>/dev/null | grep -q .; then
  echo "✗ 测试容器还在！" >&2; exit 1
fi
echo "✅ 测试实例已清除，生产未受影响"
