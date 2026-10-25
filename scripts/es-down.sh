#!/usr/bin/env bash
# 停 ES（保留数据与证书）。要连数据一起删：确认路径后手动 rm -rf deploy/es/data
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/deploy/es"
docker compose down
echo "已停止。数据仍在 $ROOT/deploy/es/data"
