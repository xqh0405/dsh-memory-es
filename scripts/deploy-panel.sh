#!/usr/bin/env bash
# 把 dsh-memory-es（**一个包**：插件 + 面板）部署到远程主机上的 DSH 容器。
#
# 做法：在这里打出发行包 → 推到宿主机 → docker cp 进容器 → 容器内跑包里的
# install.sh（它负责放文件、装 profile、清理旧版独立面板包、补 bundles）→ 重启容器 → 打印自检。
# 不再手工维护「local-plugins + node_modules」两份副本，避免改了没生效。
#
# 用法：
#   PANEL_HOST=user@host ./scripts/deploy-panel.sh
#   PANEL_HOST=user@host PANEL_CONTAINER=dsh-test ./scripts/deploy-panel.sh   # 先拿测试容器验证
#   可选：PANEL_SSH_KEY=~/.ssh/xxx  （留空走 ssh 默认配置）
#         PANEL_CONTAINER（默认 dsh-xqh）、PANEL_PROFILE（默认 web）
set -euo pipefail

HOST="${PANEL_HOST:?请用 PANEL_HOST=user@host 指定目标主机}"
SSH_KEY="${PANEL_SSH_KEY:-}"
CONTAINER="${PANEL_CONTAINER:-dsh-xqh}"
PROFILE="${PANEL_PROFILE:-web}"
DSH_HOME_IN_CONTAINER="${PANEL_DSH_HOME:-/data/dsh}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null)
if [ -n "$SSH_KEY" ]; then SSH_OPTS=(-i "$SSH_KEY" "${SSH_OPTS[@]}"); fi

VERSION="$(bash "$REPO_ROOT/scripts/version.sh" check | sed 's/^版本：//')"
echo "==> 打包 dsh-memory-es v${VERSION}（单包：插件 + 面板）"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
bash "$REPO_ROOT/scripts/package.sh" --out "$work" >/dev/null
PKG="$work/dsh-memory-es-${VERSION}.tar.gz"
[ -f "$PKG" ] || { echo "打包失败：找不到 $PKG" >&2; exit 1; }
echo "    $(du -h "$PKG" | cut -f1)  $PKG"

echo "==> 上传到 ${HOST}"
scp -q "${SSH_OPTS[@]}" "$PKG" "${HOST}:/tmp/"

echo "==> 推进容器 ${CONTAINER} 并安装"
ssh "${SSH_OPTS[@]}" "$HOST" bash -s -- "$CONTAINER" "$PROFILE" "$DSH_HOME_IN_CONTAINER" "dsh-memory-es-${VERSION}.tar.gz" <<'REMOTE'
set -euo pipefail
container="$1"; profile="$2"; dsh_home="$3"; pkg="$4"
docker cp "/tmp/$pkg" "$container:/tmp/$pkg" >/dev/null
docker exec "$container" sh -c "
  set -e
  rm -rf /tmp/mem-pkg && mkdir -p /tmp/mem-pkg
  tar xzf /tmp/$pkg -C /tmp/mem-pkg
  cd /tmp/mem-pkg/dsh-memory-es-*
  ./install.sh --dsh-home $dsh_home --profile $profile --owner node
"
rm -f "/tmp/$pkg"
REMOTE

echo "==> 重启 ${CONTAINER} 并等待 healthy"
ssh "${SSH_OPTS[@]}" "$HOST" bash -s -- "$CONTAINER" <<'REMOTE'
set -euo pipefail
container="$1"
docker restart "$container" >/dev/null
for i in $(seq 1 40); do
  status=$(docker inspect "$container" --format '{{.State.Health.Status}}' 2>/dev/null || echo none)
  case "$status" in
    healthy) echo "    health=healthy"; exit 0 ;;
    unhealthy) echo "    health=unhealthy（容器已启动但健康检查未过）"; exit 1 ;;
  esac
  sleep 2
done
echo "    等待超时（health 仍不是 healthy）"
exit 1
REMOTE

echo "==> 面板自检（最后一行）"
# 这里原来写的是 `ssh … | grep … | tail -1 || true`，然后**无条件**打印「完成：vX 已部署」——
# 于是「容器 healthy 但插件/面板没起来」时（grep 找不到自检行 → 管道非 0 → `|| true` 吞掉），
# 脚本照样打印成功并 exit 0。**部署脚本报假成功比不报更糟**：它会连累调用方
# （deploy-all-panel.sh 只看退出码，于是整批都记成成功）。
# 与 scripts/deploy-all-containers.sh 对齐：取不到 `自检通过 v${VERSION}` 就非 0 退出。
# 用 `|| true` 只包住「取这行」这一步，判断留给下面的 case。
selfcheck=$(ssh "${SSH_OPTS[@]}" "$HOST" "docker logs --since 3m $CONTAINER 2>&1 | grep '记忆库面板.*自检' | tail -1" || true)
echo "    ${selfcheck:-（一条自检行都没有）}"

# --- 部署成败判定（改这里时同步 tests/deploy-gate.test.mjs 的同款用例）---
case "$selfcheck" in
  *"自检通过 v${VERSION}"*)
    echo
    echo "完成：v${VERSION} 已部署到 ${CONTAINER}（插件与面板同一个包）"
    echo "核对：插件日志 'ready: v${VERSION}'、面板自检 '自检通过 v${VERSION}'、面板页脚「版本 ${VERSION}」"
    ;;
  *)
    echo >&2
    echo "✗ 部署未确认：容器已 healthy，但自检行里没有「自检通过 v${VERSION}」" >&2
    echo "   实际自检行：${selfcheck:-（一条都没有 —— 插件或面板没起来）}" >&2
    echo "   排查：docker logs --since 3m $CONTAINER | grep -E '自检|error|Error'" >&2
    exit 1
    ;;
esac
