#!/usr/bin/env bash
# 生成 ES 用的 CA 与节点证书（p12）。密码固定 changeme：它保护的是文件本身，
# 真正的边界是 certs/ 目录权限（600）与不提交仓库。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CERTS="$ROOT/deploy/es/certs"
IMG="docker.elastic.co/elasticsearch/elasticsearch:8.19.23"
PASS="${CERT_PASS:-changeme}"

mkdir -p "$CERTS"

if [ -f "$CERTS/elastic-certificates.p12" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "证书已存在，跳过（FORCE=1 才覆盖）：$CERTS/elastic-certificates.p12"
  exit 0
fi

# certutil 不会覆盖已有输出文件，重生成前必须先删
if [ "${FORCE:-0}" = "1" ]; then
  rm -f "$CERTS/elastic-stack-ca.p12" "$CERTS/elastic-certificates.p12" "$CERTS/ca.crt"
fi

echo "生成 CA ..."
docker run --rm -v "$CERTS:/certs" "$IMG" \
  bin/elasticsearch-certutil ca --silent --pass "$PASS" --out /certs/elastic-stack-ca.p12

echo "生成节点证书 ..."
# --name/--dns/--ip 必须给：certutil 默认只签 CN=instance 且无 SAN，
# 客户端访问 https://127.0.0.1:9200 会因主机名不匹配被 curl 拒绝。
docker run --rm -v "$CERTS:/certs" "$IMG" \
  bin/elasticsearch-certutil cert --silent --pass "$PASS" \
  --ca /certs/elastic-stack-ca.p12 --ca-pass "$PASS" \
  --name es01 --dns localhost --ip 127.0.0.1 \
  --out /certs/elastic-certificates.p12

echo "导出 CA 为 PEM（供 curl 与插件客户端信任）..."
docker run --rm --entrypoint bash -v "$CERTS:/certs" "$IMG" -c \
  "openssl pkcs12 -in /certs/elastic-stack-ca.p12 -nokeys -passin pass:$PASS -out /certs/ca.crt"

chmod 600 "$CERTS"/*.p12
ls -l "$CERTS"
