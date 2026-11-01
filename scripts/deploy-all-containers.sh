#!/usr/bin/env bash
# 把当前版本一次性部署到 125 上的**全部** dsh 用户容器。
#
# 与 deploy-panel.sh 的区别：那个是单容器（适合先拿 dsh-test 验证），
# 这个打包一次、上传一次，然后逐个容器 install + restart + 自检，最后汇总。
#
# 用法：
#   PANEL_HOST=root@<es-host> PANEL_SSH_KEY=~/.ssh/<key> ./scripts/deploy-all-containers.sh
#   PANEL_CONTAINERS="dsh-test dsh-xqh" ... ./scripts/deploy-all-containers.sh   # 只发指定容器
#
# ⚠️ 会重启每一个容器：正在生成的回复会被中断，页面要重连（会话历史不丢）。
#    白天动之前先确认没人在跑任务（看 docker logs --since 20m 更稳）。
#
# 退出码：全部成功 0；有容器失败 1（失败清单会打在最后）。
set -uo pipefail

HOST="${PANEL_HOST:?请用 PANEL_HOST=user@host 指定目标主机}"
SSH_KEY="${PANEL_SSH_KEY:-}"
PROFILE="${PANEL_PROFILE:-web}"
DSH_HOME_IN_CONTAINER="${PANEL_DSH_HOME:-/data/dsh}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null)
if [ -n "$SSH_KEY" ]; then SSH_OPTS=(-i "$SSH_KEY" "${SSH_OPTS[@]}"); fi

# 默认：目标机上所有 dsh-* 用户容器（dsh-es 是 ES 服务，不是用户实例）
if [ -n "${PANEL_CONTAINERS:-}" ]; then
  read -r -a CONTAINERS <<<"$PANEL_CONTAINERS"
else
  mapfile -t CONTAINERS < <(ssh "${SSH_OPTS[@]}" "$HOST" \
    "docker ps --format '{{.Names}}' | grep '^dsh-' | grep -v '^dsh-es$' | sort")
fi
if [ "${#CONTAINERS[@]}" -eq 0 ]; then
  echo "没有找到要部署的容器" >&2
  exit 1
fi

VERSION="$(bash "$REPO_ROOT/scripts/version.sh" check | sed 's/^版本：//')"
echo "==> 目标：v${VERSION} → ${#CONTAINERS[@]} 个容器"
printf '    %s\n' "${CONTAINERS[@]}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
bash "$REPO_ROOT/scripts/package.sh" --out "$work" >/dev/null
PKG="$work/dsh-memory-es-${VERSION}.tar.gz"
[ -f "$PKG" ] || { echo "打包失败：$PKG 不存在" >&2; exit 1; }
echo "==> 打包完成：$(du -h "$PKG" | cut -f1)"

scp -q "${SSH_OPTS[@]}" "$PKG" "${HOST}:/tmp/"

echo "==> 逐个容器安装并重启"
ssh "${SSH_OPTS[@]}" "$HOST" bash -s -- "$VERSION" "$PROFILE" "$DSH_HOME_IN_CONTAINER" "${CONTAINERS[@]}" <<'REMOTE'
set -uo pipefail
ver="$1"; profile="$2"; dsh_home="$3"; shift 3
containers=("$@")
pkg="dsh-memory-es-${ver}.tar.gz"
failed=()

for c in "${containers[@]}"; do
  printf '  %-18s ' "$c"
  if ! docker ps --format '{{.Names}}' | grep -qx "$c"; then
    echo "跳过（容器不在运行）"
    failed+=("$c: 未运行")
    continue
  fi

  docker cp "/tmp/$pkg" "$c:/tmp/$pkg" >/dev/null 2>&1 || { echo "复制失败"; failed+=("$c: 复制失败"); continue; }

  if ! docker exec "$c" sh -c "
    set -e
    rm -rf /tmp/mem-pkg && mkdir -p /tmp/mem-pkg
    tar xzf /tmp/$pkg -C /tmp/mem-pkg
    cd /tmp/mem-pkg/dsh-memory-es-*
    ./install.sh --dsh-home $dsh_home --profile $profile --owner node
  " >/tmp/install-$c.log 2>&1; then
    echo "安装失败（见 /tmp/install-$c.log）"
    failed+=("$c: 安装失败")
    continue
  fi

  docker restart "$c" >/dev/null 2>&1
  ok=0
  for _ in $(seq 1 40); do
    s=$(docker inspect "$c" --format '{{.State.Health.Status}}' 2>/dev/null || echo none)
    if [ "$s" = "healthy" ]; then ok=1; break; fi
    sleep 2
  done
  if [ "$ok" != "1" ]; then
    echo "启动后未达到 healthy"
    failed+=("$c: 未 healthy")
    continue
  fi

  line=$(docker logs --since 3m "$c" 2>&1 | grep '记忆库面板.*自检' | tail -1)
  case "$line" in
    *"自检通过 v${ver}"*) echo "ok（自检 v${ver}）" ;;
    *) echo "healthy，但自检未确认版本：${line:0:60}"; failed+=("$c: 自检版本不符") ;;
  esac
done

echo
if [ "${#failed[@]}" -eq 0 ]; then
  echo "全部完成：${#containers[@]} 个容器都已是 v${ver}"
  exit 0
fi
echo "有 ${#failed[@]} 个容器需要跟进："
printf '  - %s\n' "${failed[@]}"
exit 1
REMOTE

status=$?
ssh "${SSH_OPTS[@]}" "$HOST" "rm -f /tmp/dsh-memory-es-${VERSION}.tar.gz" >/dev/null 2>&1 || true
exit "$status"
