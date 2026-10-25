#!/usr/bin/env bash
# 下载并安装与 ES 版本严格一致的 analysis-ik 插件。
# 注意：插件版本必须与 ES 完全一致，否则节点起不来（plugin version mismatch）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ES_DIR="$ROOT/deploy/es"
VER="${ES_VERSION:-8.19.23}"
DEST="$ES_DIR/plugins/analysis-ik"
URL="https://release.infinilabs.com/analysis-ik/stable/elasticsearch-analysis-ik-$VER.zip"

if [ -f "$DEST/plugin-descriptor.properties" ]; then
  installed=$(grep '^version=' "$DEST/plugin-descriptor.properties" | cut -d= -f2)
  echo "IK 已安装（$installed）→ $DEST"
  exit 0
fi

echo "下载 $URL ..."
mkdir -p "$DEST"
tmp=$(mktemp /tmp/analysis-ik-XXXXXX.zip)
trap 'rm -f "$tmp"' EXIT
curl -sS -L --max-time 300 -o "$tmp" "$URL"
unzip -q -o "$tmp" -d "$DEST"
echo "已安装 IK $VER → $DEST"
grep -E '^(version|elasticsearch.version)=' "$DEST/plugin-descriptor.properties"
