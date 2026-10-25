#!/usr/bin/env bash
# 起 ES：缺 .env 就生成（随机密码）、缺证书就生成、然后启动并等健康。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ES_DIR="$ROOT/deploy/es"
ENV_FILE="$ES_DIR/.env"

# 1) .env
if [ ! -f "$ENV_FILE" ]; then
  cp "$ES_DIR/.env.example" "$ENV_FILE"
  pw=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)
  sed -i "s|^ELASTIC_PASSWORD=.*|ELASTIC_PASSWORD=$pw|" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "已生成 $ENV_FILE（权限 600，含随机 elastic 密码）"
fi

# 2) 证书
if [ ! -f "$ES_DIR/certs/elastic-certificates.p12" ]; then
  "$ROOT/scripts/es-certs.sh"
fi

# 2.5) IK 插件（版本必须与 compose 里的镜像 tag 一致）
if [ ! -f "$ES_DIR/plugins/analysis-ik/plugin-descriptor.properties" ]; then
  ES_VERSION=$(grep -oP 'elasticsearch:\K[0-9.]+' "$ES_DIR/docker-compose.yml" | head -1)
  ES_VERSION="$ES_VERSION" "$ROOT/scripts/fetch-ik.sh"
fi

# 3) 启动
cd "$ES_DIR"
docker compose up -d --wait --wait-timeout 240
echo '--- 容器状态 ---'
docker compose ps

# 4) 用 CA 从宿主机验证
CA="$ES_DIR/certs/ca.crt"
PASS=$(grep '^ELASTIC_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
echo '--- 集群健康 ---'
curl -sS --cacert "$CA" -u "elastic:$PASS" 'https://127.0.0.1:9200/_cluster/health?pretty' | head -20
echo '--- 版本与插件 ---'
curl -sS --cacert "$CA" -u "elastic:$PASS" 'https://127.0.0.1:9200/_cat/plugins?v&h=name,component,version'
