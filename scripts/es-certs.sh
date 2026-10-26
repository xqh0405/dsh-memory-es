#!/usr/bin/env bash
# 生成 ES 用的 CA 与节点证书（p12）。密码固定 changeme：它保护的是文件本身，
# 真正的边界是 certs/ 目录权限（600）与不提交仓库。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 默认写本仓库的 deploy/es/certs；远端部署用 ES_DIR=<...>/deploy/es-remote 指定
ES_DIR="${ES_DIR:-$ROOT/deploy/es}"
CERTS="$ES_DIR/certs"
IMG="docker.elastic.co/elasticsearch/elasticsearch:8.19.23"
PASS="${CERT_PASS:-changeme}"
# 证书的 SAN 必须与「客户端实际用的地址」一致，否则 hostname 校验失败。
# 本地：默认 es01 / localhost / 127.0.0.1；
# 远端（deploy/es-remote）：NODE_NAME=<ES 容器名> CERT_DNS=<ES 容器名>,localhost CERT_IP=127.0.0.1
NODE_NAME="${NODE_NAME:-es01}"
CERT_DNS="${CERT_DNS:-localhost}"
CERT_IP="${CERT_IP:-127.0.0.1}"

mkdir -p "$CERTS"
# certutil 在容器里以 uid 1000 运行：宿主机目录若是 root 建的，必须放开归属，
# 否则报 java.nio.file.AccessDeniedException /certs/elastic-stack-ca.p12（2026-10-25 在 远程主机 踩到）
if [ "$(id -u)" = "0" ]; then
  chown -R 1000:0 "$CERTS"
fi

if [ -f "$CERTS/elastic-certificates.p12" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "证书已存在，跳过（FORCE=1 才覆盖）：$CERTS/elastic-certificates.p12"
  exit 0
fi

# 证书有效期（天）。默认 10 年：内部自签不受公网证书「≤398 天」限制（那是浏览器对公共
# 信任链的要求），所以按"少折腾"取长。想短一点就 CERT_DAYS=1095（3 年）。
CERT_DAYS="${CERT_DAYS:-3650}"

# certutil 不会覆盖已有输出文件，重生成前必须先删
if [ "${FORCE:-0}" = "1" ]; then
  rm -f "$CERTS/elastic-stack-ca.p12" "$CERTS/elastic-certificates.p12" "$CERTS/ca.crt"
fi

echo "生成 CA ..."
docker run --rm -v "$CERTS:/certs" "$IMG" \
  bin/elasticsearch-certutil ca --silent --pass "$PASS" --days "$CERT_DAYS" --out /certs/elastic-stack-ca.p12

echo "生成节点证书 ..."
# --name/--dns/--ip 必须给：certutil 默认只签 CN=instance 且无 SAN，
# 客户端访问 https://127.0.0.1:9200 会因主机名不匹配被 curl 拒绝。
docker run --rm -v "$CERTS:/certs" "$IMG" \
  bin/elasticsearch-certutil cert --silent --pass "$PASS" --days "$CERT_DAYS" \
  --ca /certs/elastic-stack-ca.p12 --ca-pass "$PASS" \
  --name "$NODE_NAME" --dns "$CERT_DNS" --ip "$CERT_IP" \
  --out /certs/elastic-certificates.p12

echo "导出 CA 为 PEM（供 curl 与插件客户端信任）..."
docker run --rm --entrypoint bash -v "$CERTS:/certs" "$IMG" -c \
  "openssl pkcs12 -in /certs/elastic-stack-ca.p12 -nokeys -passin pass:$PASS -out /certs/ca.crt"

chmod 600 "$CERTS"/*.p12
echo "有效期 $CERT_DAYS 天；核对："
docker run --rm --entrypoint bash -v "$CERTS:/certs" "$IMG" -c \
  "openssl pkcs12 -in /certs/elastic-certificates.p12 -clcerts -nokeys -passin pass:$PASS | openssl x509 -noout -dates" \
  2>/dev/null || true
ls -l "$CERTS"
