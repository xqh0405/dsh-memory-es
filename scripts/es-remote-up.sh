#!/usr/bin/env bash
# 起第二套 ES：给「DSH 本身跑在容器里」的场景用（ES 与该容器同在一个 docker 网络）。
# **这个脚本在目标主机上跑**，不在开发机跑：它需要 docker，并要写 ES 的运行目录。
#
# 用法（目标主机上）：
#   cd <es-memory 目录> && bash scripts/es-remote-up.sh
#   或 BASE=/srv/es-memory bash scripts/es-remote-up.sh
#
# 目录约定（远端解包后）：
#   es-memory/
#     deploy/es/         ← 复用本地那套初始化脚本的布局（certs/.env/scripts 都在里面）
#     deploy/es-remote/  ← 远端专用编排（加入 DSH 容器的 docker 网络、SAN 带 ES 容器名）
#     scripts/           ← 从仓库拷来的脚本（es-certs / init-indices / init-security / fetch-ik）
set -euo pipefail

BASE="${BASE:-$(cd "$(dirname "$0")/.." && pwd)}"
# DSH 容器所在的 docker 网络、以及 ES 自己的容器名：默认值只是示例，按你的部署覆盖
DSH_NETWORK="${DSH_NETWORK:-dsh_default}"
ES_CONTAINER="${ES_CONTAINER:-dsh-es-remote}"
REMOTE_DIR="$BASE/deploy/es-remote"
ENV_FILE="$REMOTE_DIR/.env"
CA="$REMOTE_DIR/certs/ca.crt"
source "$(dirname "$0")/lib/curl-es.sh"
IMG="docker.elastic.co/elasticsearch/elasticsearch:8.19.23"

echo "== 0/5 前置检查 =="
docker network inspect "$DSH_NETWORK" >/dev/null 2>&1 || {
  echo "找不到 $DSH_NETWORK 网络（DSH 容器没起？或用 DSH_NETWORK=... 指定）" >&2
  exit 1
}
echo "  docker 网络 $DSH_NETWORK ok"

echo "== 1/5 .env（远端独立一套密码） =="
if [ ! -f "$ENV_FILE" ]; then
  cp "$BASE/deploy/es/.env.example" "$ENV_FILE"
  pw=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)
  sed -i "s|^ELASTIC_PASSWORD=.*|ELASTIC_PASSWORD=$pw|" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "  已生成 $ENV_FILE（600）"
else
  echo "  已存在，沿用：$ENV_FILE"
fi

echo "== 2/5 镜像 =="
if docker image inspect "$IMG" >/dev/null 2>&1; then
  echo "  镜像已在本地：$IMG"
else
  echo "  拉取 $IMG（首次约 1 GB）..."
  docker pull "$IMG"
fi

echo "== 3/5 证书（SAN 必须含 ES 容器名） =="
if [ ! -f "$REMOTE_DIR/certs/elastic-certificates.p12" ]; then
  ES_DIR="$REMOTE_DIR" \
  NODE_NAME="$ES_CONTAINER" CERT_DNS="$ES_CONTAINER,localhost" CERT_IP="127.0.0.1" \
    bash "$BASE/scripts/es-certs.sh"
else
  echo "  证书已存在，跳过"
fi

echo "== 4/5 IK 插件版本对齐 =="
IK="$REMOTE_DIR/plugins/analysis-ik/plugin-descriptor.properties"
if [ ! -f "$IK" ]; then
  echo "  缺少 IK 插件：请先把 analysis-ik 目录放到 $REMOTE_DIR/plugins/" >&2
  exit 1
fi
ver=$(grep '^version=' "$IK" | cut -d= -f2)
esver=$(grep '^elasticsearch.version=' "$IK" | cut -d= -f2)
echo "  analysis-ik $ver (for ES $esver)"
[ "$esver" = "8.19.23" ] || { echo "IK 版本与 ES 8.19.23 不匹配，节点会起不来" >&2; exit 1; }

echo "== 4.5/5 数据目录归属 =="
# 容器以 uid 1000（elasticsearch 用户）运行；bind mount 的目录若由 root 创建会写不进去，
# 表现为「failed to obtain node locks ... maybe these locations are not writable」。
mkdir -p "$REMOTE_DIR/data" "$REMOTE_DIR/snapshots"
if [ "$(id -u)" = "0" ]; then
  chown -R 1000:0 "$REMOTE_DIR/data" "$REMOTE_DIR/snapshots"
fi
echo "  data/snapshots 归属 ok"

echo "== 5/5 启动 =="
# 某些宿主没有 docker compose 插件（`docker compose` 直接报 unknown command），
# 但装了独立的 docker-compose v2；两种都支持，优先插件。
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "这台机器既没有 docker compose 插件也没有 docker-compose，无法启动" >&2
  exit 1
fi
echo "  使用：${COMPOSE[*]}"
cd "$REMOTE_DIR"
"${COMPOSE[@]}" up -d --wait --wait-timeout 300
"${COMPOSE[@]}" ps

PASS=$(grep '^ELASTIC_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
echo '--- 宿主侧健康（用 CA，不走 -k）---'
es_curl "elastic:$PASS" 'https://127.0.0.1:9200/_cluster/health?pretty' | head -12
echo '--- 插件 ---'
es_curl "elastic:$PASS" 'https://127.0.0.1:9200/_cat/plugins?v&h=name,component,version'
echo '--- 证书 SAN（客户端必须用这里列出的名字访问）---'
docker run --rm -v "$REMOTE_DIR/certs:/certs" "$IMG" bash -c \
  'openssl pkcs12 -in /certs/elastic-certificates.p12 -nokeys -passin pass:'"${CERT_PASS:-changeme}"' 2>/dev/null | openssl x509 -noout -subject -ext subjectAltName' || true
