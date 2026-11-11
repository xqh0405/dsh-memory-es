#!/usr/bin/env bash
# 在 125 上起一套**一次性**集成测试 ES，建好隧道与索引/账号；测完用 es-test-down.sh 删。
#
# 为什么需要（2026-11-10 审查 #30）：
#   集成测试写的是**真实索引**（`personal_memory_<uid>` 与全员共享的 `team_knowledge`），
#   靠 `__it` 类 marker 域标记 + before/after 双清。指向生产 `dsh-es` = 往共享库写测试数据
#   （运行窗口内成员可能搜到）—— 不可接受；而 CI runner 根本没有 ES
#   （路线 21.4 已明确撤销「CI 真连 ES」）。所以起一套专用的，用完即删。
#
# 隔离怎么保证（这是本脚本的安全前提，改它之前先看这段）：
#   · 不同容器名 / 端口 / 数据目录 / 密码；
#   · **`discovery.type=single-node` + 独立 cluster.name** → 不会并进生产集群；
#   · 只绑 `127.0.0.1:9201` → **对局域网完全不暴露**，本机走 `ssh -L` 隧道访问；
#   · certs 与 IK 插件**只读挂载生产目录** → 同一个 CA，客户端配置一行都不用改；
#   · `restart: no` → 机器重启后它不会自己爬起来；
#   · 只挂 default 网络 → 成员容器连不到它。
#
# 用法：
#   scripts/es-test-up.sh            # 起实例 + 建隧道 + 初始化索引/账号
#   scripts/es-test-up.sh status     # 看实例与隧道状态
#   scripts/es-test-down.sh          # 关隧道 + 删实例（测完即删）
set -euo pipefail

MODE="${1:-start}"
PANEL_HOST="${PANEL_HOST:-root@192.168.50.125}"
PANEL_SSH_KEY="${PANEL_SSH_KEY:-$HOME/.ssh/dsh_ai}"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i "$PANEL_SSH_KEY")

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_DIR="/docker/dsh-es-test"     # 与生产 /docker/dsh-es 完全分开
PROD_DIR="/docker/dsh-es"
LOCAL_DIR="$ROOT/deploy/es-test"     # 本地凭据（裸 .env 规则已 gitignore，600）
ENV_FILE="$LOCAL_DIR/.env"
REMOTE_PORT=9201                     # 125 上只绑 127.0.0.1
LOCAL_PORT="${TEST_ES_LOCAL_PORT:-19201}"   # 本机隧道端口（回环）
CA="$HOME/.dsh/certs/dsh-es-lan-ca.crt"     # 生产那张 CA 的副本（SAN 含 127.0.0.1）
ES_URL="https://127.0.0.1:${LOCAL_PORT}"    # 隧道之后就是回环 → 写闸天然放行

tunnel_pid() { pgrep -f "ssh .*-L ${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}" 2>/dev/null | head -1 || true; }

case "$MODE" in
status)
  echo "== 实例（125）=="
  ssh "${SSH_OPTS[@]}" "$PANEL_HOST" "docker ps --filter name=dsh-es-test --format '  {{.Names}}  {{.Status}}  {{.Ports}}'" || true
  echo "== 隧道（本机）=="
  tp=$(tunnel_pid)
  [ -n "$tp" ] && echo "  在（pid=$tp）→ $ES_URL" || echo "  不在"
  echo "== 本地凭据 =="
  [ -f "$ENV_FILE" ] && echo "  有 $ENV_FILE" || echo "  无（先跑 scripts/es-test-up.sh）"
  exit 0
  ;;
esac

# ---------- 1) 本地凭据（只在没有时生成，重复跑不换密码）----------
mkdir -p "$LOCAL_DIR"; chmod 700 "$LOCAL_DIR"
if [ ! -f "$ENV_FILE" ]; then
  # 随机 elastic 密码；MEM_USER_ID 决定测试索引名，与生产同名但**在另一套实例上**，互不影响
  EL_PW=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)
  cat > "$ENV_FILE" <<EOF
# 一次性集成测试实例的凭据（es-test-up.sh 生成，600，gitignore）
# 跑测试：set -a && . deploy/es-test/.env && set +a && npm run test:integration
ELASTIC_PASSWORD=$EL_PW
MEM_USER_ID=xqh
MEM_ES_URL=$ES_URL
ES_CA_PATH=$CA
EOF
  chmod 600 "$ENV_FILE"
  echo "已生成 $ENV_FILE（600）"
fi

# ---------- 2) 125 侧：目录 + compose + .env ----------
echo "==> 在 125 上准备 $REMOTE_DIR"
ssh "${SSH_OPTS[@]}" "$PANEL_HOST" "mkdir -p $REMOTE_DIR/data $REMOTE_DIR/snapshots"

# CERT_PASS 是**打开共享证书 p12** 的口令（它写在证书文件里，换不了），
# 从生产 .env 读出来直接写进测试 .env —— 只在 125 侧流转，不打印、不落到本机。
scp -q "${SSH_OPTS[@]}" "$ENV_FILE" "$PANEL_HOST:$REMOTE_DIR/.env"
ssh "${SSH_OPTS[@]}" "$PANEL_HOST" "bash -s" <<REMOTE
set -euo pipefail
cd $REMOTE_DIR
CERT_PASS=\$(grep '^CERT_PASS=' $PROD_DIR/.env | cut -d= -f2-)
if [ -n "\$CERT_PASS" ] && ! grep -q '^CERT_PASS=' .env; then
  printf 'CERT_PASS=%s\n' "\$CERT_PASS" >> .env
fi
chmod 600 .env
# ES 以 uid 1000 跑：目录必须属它，否则起不来（root 拥有的 data 目录会写不进去）
chown -R 1000:0 data snapshots 2>/dev/null || true

cat > docker-compose.yml <<'COMPOSE'
# 一次性集成测试 ES：与生产 dsh-es 同机但**完全隔离**（详见 scripts/es-test-up.sh 头注释）
services:
  es01:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.19.23
    container_name: dsh-es-test
    restart: "no"                      # 一次性实例：重启机器后不要自己爬起来
    environment:
      - node.name=dsh-es-test
      - cluster.name=dsh-memory-es-test # 独立集群名 + 下面 single-node → 不会并进生产
      - discovery.type=single-node
      - bootstrap.memory_lock=true
      - xpack.security.enabled=true
      - xpack.security.enrollment.enabled=false
      - xpack.security.http.ssl.enabled=true
      - xpack.security.http.ssl.keystore.path=certs/elastic-certificates.p12
      - xpack.security.http.ssl.keystore.password=\${CERT_PASS:-changeme}
      - xpack.security.http.ssl.truststore.path=certs/elastic-certificates.p12
      - xpack.security.http.ssl.truststore.password=\${CERT_PASS:-changeme}
      - xpack.security.transport.ssl.enabled=true
      - xpack.security.transport.ssl.keystore.path=certs/elastic-certificates.p12
      - xpack.security.transport.ssl.keystore.password=\${CERT_PASS:-changeme}
      - xpack.security.transport.ssl.truststore.path=certs/elastic-certificates.p12
      - xpack.security.transport.ssl.truststore.password=\${CERT_PASS:-changeme}
      - ELASTIC_PASSWORD=\${ELASTIC_PASSWORD:?需要本目录 .env 里的 ELASTIC_PASSWORD}
      - ES_JAVA_OPTS=-Xms1g -Xmx1g    # 测试数据只有几条，比生产的 2g 更轻
      - path.repo=/usr/share/elasticsearch/snapshots
    ulimits:
      memlock: { soft: -1, hard: -1 }
      nofile:  { soft: 65536, hard: 65536 }
    mem_limit: 2g
    volumes:
      - ./data:/usr/share/elasticsearch/data
      - ./snapshots:/usr/share/elasticsearch/snapshots
      # 共享生产的证书与 IK 插件（**只读**）：同一个 CA → 客户端配置不用改，
      # 同一个 IK → 分词行为与生产一致（集成测的就是这套部署形态）
      - $PROD_DIR/certs:/usr/share/elasticsearch/config/certs:ro
      - $PROD_DIR/plugins/analysis-ik:/usr/share/elasticsearch/plugins/analysis-ik:ro
    ports:
      - "127.0.0.1:$REMOTE_PORT:9200"  # 只绑回环：局域网根本连不到，只能走 SSH 隧道
    healthcheck:
      test: ["CMD-SHELL", "curl -fsSk -u elastic:\$\$ELASTIC_PASSWORD https://localhost:9200/_cluster/health >/dev/null || exit 1"]
      interval: 5s
      timeout: 5s
      retries: 30
      start_period: 30s
COMPOSE

# 125 上**没有 compose 插件**（跑 docker compose 会报 not a docker command），
# 只有独立的 docker-compose v2 —— 两种都试，按可用的那个走。
if docker compose version >/dev/null 2>&1; then C="docker compose"; else C="docker-compose"; fi

if docker ps --filter name=^dsh-es-test\$ --format '{{.Names}}' | grep -q .; then
  echo "实例已在，跳过创建"
else
  \$C up -d --wait --wait-timeout 180
fi
docker ps --filter name=dsh-es-test --format '  {{.Names}}  {{.Status}}'
REMOTE

# ---------- 3) 隧道（本机回环 → 125 的 127.0.0.1:9201）----------
if [ -z "$(tunnel_pid)" ]; then
  echo "==> 建隧道 127.0.0.1:$LOCAL_PORT → 125 的 127.0.0.1:$REMOTE_PORT"
  ssh -f -N "${SSH_OPTS[@]}" -L "$LOCAL_PORT:127.0.0.1:$REMOTE_PORT" "$PANEL_HOST"
  sleep 1
else
  echo "==> 隧道已在（pid=$(tunnel_pid)）"
fi

# ---------- 4) 等健康（必须等，否则下面初始化会连不上）----------
# 认证是必须的：开了 security 的 ES 对匿名请求回 **401**，而 401 的 body 里**没有
# "status" 字段** —— 只 grep '"status"' 会永远不匹配、空等到超时（2026-11-11 首跑就踩了）。
# 凭据走 es_curl 的 600 临时配置文件，**不进 argv**（同 #27 那条规矩，别用 curl -u）。
echo "==> 等 ES 健康"
source "$ROOT/scripts/lib/curl-es.sh"
ES_CURL_TIMEOUT=5
PW=$(grep '^ELASTIC_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
body=""
st=""
for i in $(seq 1 60); do
  body=$(es_curl "elastic:$PW" "$ES_URL/_cluster/health" 2>/dev/null || true)
  st=$(printf '%s' "$body" | grep -oE '"status":"[a-z]+"' | head -1 || true)
  if [ -n "$st" ]; then
    echo "  就绪（$st）"; break
  fi
  if [ "$i" = 60 ]; then
    echo "✗ 等不到健康状态。最后一轮响应（前 200 字）：${body:0:200}" >&2
    exit 1
  fi
  sleep 2
done

# ---------- 5) 初始化索引 + 账号（复用现有脚本，不重写）----------
echo "==> 初始化索引模板与账号"
export ES_URL CA
export ES_DIR="$LOCAL_DIR"           # init-*.sh 从这里读 .env / 写 users/<uid>.env
bash "$ROOT/scripts/init-indices.sh" >/dev/null
bash "$ROOT/scripts/init-user.sh" xqh --team-write

# init-user 把账号密码写在 users/xqh.env；并进 .env，测试就只需 source 这一个文件
if [ -f "$LOCAL_DIR/users/xqh.env" ]; then
  while IFS= read -r line; do
    case "$line" in MEM_*|MEM_TEAM_*)
      grep -q "^${line%%=*}=" "$ENV_FILE" || echo "$line" >> "$ENV_FILE" ;;
    esac
  done < "$LOCAL_DIR/users/xqh.env"
  chmod 600 "$ENV_FILE"
fi

echo
echo "✅ 测试实例就绪"
echo "   URL   : $ES_URL （回环 → 写闸天然放行，不需要 MEM_ES_ALLOW_REMOTE_WRITE）"
echo "   CA    : $CA"
echo "   实例  : 125:$REMOTE_PORT（只绑回环，局域网不可达）"
echo
echo "跑集成测试："
echo "  set -a && . deploy/es-test/.env && set +a && npm run test:integration"
echo "测完删除："
echo "  scripts/es-test-down.sh"
