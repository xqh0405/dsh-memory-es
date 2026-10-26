#!/usr/bin/env bash
# 部署记忆库面板到远程主机上的 DSH 容器（DSH 跑在 docker 里时用）。
#
# 为什么要有这个脚本：面板在容器里有**两份副本** ——
#   1) /data/dsh/local-plugins/dsh-memory-es-panel   源码目录（跑 CLI 的那份，不能在 node_modules 下跑 .ts）
#   2) /data/dsh/profiles/web/node_modules/...       pnpm 装进 profile 的那份（dsh 真正加载的）
# 手工改一处忘另一处，就会出现"改了没生效"或"CLI 找不到"。脚本按顺序同步两边并打印自检行。
#
# 用法：
#   PANEL_HOST=user@host ./scripts/deploy-panel.sh            # 全量同步 + 重装 + 重启 + 打印自检
#   TRIGGER=0 PANEL_HOST=user@host ./scripts/deploy-panel.sh  # 不跑自检（自检需要启动，
#                                          # 只有 flag 触发的那两项写自检才需要额外放文件）
#   可选：PANEL_SSH_KEY=~/.ssh/xxx 指定私钥（留空走 ssh 默认配置）；
#         PANEL_CONTAINER 指定容器名（默认 dsh）；PANEL_PROFILE 指定 profile（默认 web）
set -euo pipefail

HOST="${PANEL_HOST:?请用 PANEL_HOST=user@host 指定目标主机}"
# 留空则走 ssh 默认配置（~/.ssh/config 或默认 IdentityFile）
SSH_KEY="${PANEL_SSH_KEY:-}"
CONTAINER="${PANEL_CONTAINER:-dsh}"
PROFILE="${PANEL_PROFILE:-web}"
LOCAL_PLUGIN="/data/dsh/local-plugins/dsh-memory-es-panel"
PLUGIN_DIR="/data/dsh/local-plugins/dsh-memory-es"
PROFILE_PLUGIN="/data/dsh/profiles/${PROFILE}/node_modules/dsh-memory-es-panel"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null)
if [ -n "$SSH_KEY" ]; then SSH_OPTS=(-i "$SSH_KEY" "${SSH_OPTS[@]}"); fi

echo "==> 打包（plugin + panel + consolidate + src）"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# 插件包也要打包：lib 变了却只同步面板，会出现「面板是新版、插件是旧版」的漂移
# （2026-10-26 实测：容器里的 lib 还停在旧提交，单账号 validateConfig 没进去）
tar -czf "$work/plugin.tgz" -C "$REPO_ROOT" lib package.json cordis.patch.yml
tar -czf "$work/panel.tgz" -C "$REPO_ROOT" panel
tar -czf "$work/cli.tgz" -C "$REPO_ROOT" consolidate src

echo "==> 上传到 $HOST"
scp -q "${SSH_OPTS[@]}" "$work/plugin.tgz" "$work/panel.tgz" "$work/cli.tgz" "$HOST:/tmp/"

echo "==> 同步进容器 $CONTAINER"
ssh "${SSH_OPTS[@]}" "$HOST" bash -s -- "$CONTAINER" "$LOCAL_PLUGIN" "$PROFILE" "$PROFILE_PLUGIN" "$PLUGIN_DIR" <<'REMOTE'
set -euo pipefail
container="$1"; local_plugin="$2"; profile="$3"; profile_plugin="$4"; plugin_dir="$5"

docker cp /tmp/plugin.tgz "$container:/tmp/plugin.tgz" >/dev/null
docker cp /tmp/panel.tgz "$container:/tmp/panel.tgz" >/dev/null
docker cp /tmp/cli.tgz "$container:/tmp/cli.tgz" >/dev/null
rm -f /tmp/plugin.tgz /tmp/panel.tgz /tmp/cli.tgz

docker exec "$container" sh -c "
set -e
  rm -rf /tmp/mem-panel /tmp/mem-cli /tmp/mem-plugin && mkdir -p /tmp/mem-panel /tmp/mem-cli /tmp/mem-plugin
  tar -xzf /tmp/plugin.tgz -C /tmp/mem-plugin
  tar -xzf /tmp/panel.tgz -C /tmp/mem-panel
  tar -xzf /tmp/cli.tgz  -C /tmp/mem-cli

  # 0) 插件包本体（lib + package.json + bundle patch）
  mkdir -p $plugin_dir
  rm -rf $plugin_dir/lib
  cp -a /tmp/mem-plugin/lib /tmp/mem-plugin/package.json /tmp/mem-plugin/cordis.patch.yml $plugin_dir/
  chown -R node:node $plugin_dir

  # 1) 源码目录：js/locale 全量替换，CLI 源码单独放 cli/
  mkdir -p $local_plugin/cli
  for f in index.js client.js es.js cliRunner.js package.json cordis.patch.yml; do
    cp -f /tmp/mem-panel/panel/\$f $local_plugin/\$f
  done
  rm -rf $local_plugin/locale $local_plugin/icon.svg
  cp -a /tmp/mem-panel/panel/locale $local_plugin/locale
  cp -a /tmp/mem-panel/panel/icon.svg $local_plugin/icon.svg
  rm -rf $local_plugin/cli/consolidate $local_plugin/cli/src
  cp -a /tmp/mem-cli/consolidate /tmp/mem-cli/src $local_plugin/cli/

  chown -R node:node $local_plugin
  rm -rf /tmp/mem-panel /tmp/mem-cli /tmp/mem-plugin /tmp/plugin.tgz /tmp/panel.tgz /tmp/cli.tgz
  echo '  源码目录: '\$(ls $local_plugin | tr '\n' ' ')
"

# 2) pnpm 装进 profile 的那份（dsh 加载的），重新 add 即按 files 复制
docker exec -u node -e HOME=/home/node -e DSH_HOME=/data/dsh "$container" sh -c \
  "dsh plugin --profile $profile add file:$local_plugin >/dev/null 2>&1 && echo '  已重装到 profile'"
REMOTE

if [ "${TRIGGER:-1}" = "0" ]; then
  echo "==> 跳过重启（TRIGGER=0）"
  exit 0
fi

echo "==> 重启 ${CONTAINER} 并等待 healthy"
ssh "${SSH_OPTS[@]}" "$HOST" bash -s -- "$CONTAINER" <<'REMOTE'
set -euo pipefail
container="$1"
docker restart "$container" >/dev/null
status=starting
for _ in $(seq 1 20); do
  status="$(docker inspect "$container" --format '{{.State.Health.Status}}')"
  [ "$status" = healthy ] && break
  sleep 3
done
echo "  health=$status"
sleep 6
docker exec "$container" sh -c "L=\$(ls -t /tmp/deepseek-harness-dsh-*.log | head -1); grep -a 记忆库面板 \"\$L\" | tail -1"
REMOTE

echo "==> 完成。客户端改动记得强刷浏览器（Ctrl+Shift+R）"
