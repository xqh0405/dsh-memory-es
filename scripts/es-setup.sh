#!/usr/bin/env bash
# 开箱引导：一条命令把 ES 备好（起容器 → 建索引 → 建角色 → 建本用户账号 → 出配置片段）。
#
# 为什么需要它：发行包里以前**一个引导脚本都没有**，新用户装完插件只会得到一个连不上
# ES 的「记忆库」。这个脚本就是那条「装完还能用」的路径（发行包里它叫 es/setup.sh）。
#
# 两种跑法，脚本自己找目录：
#   · 仓库里：scripts/es-setup.sh   → 默认用 repo 的 deploy/es（那里已经有 .env / data）
#   · 发行包里：es/setup.sh        → 默认用 $DSH_HOME/memory-es/es（持久目录，删了解包目录也不影响）
#
# 用法：
#   ./es/setup.sh                          # 用户 = .env 里的 MEM_USER_ID，没有就用当前登录名
#   ./es/setup.sh --user lisi --tier team-read
#   ./es/setup.sh --dir /srv/dsh-es        # 指定 ES 数据目录
#   ./es/setup.sh --no-check               # 起完不自检
#
# 幂等：容器已起、证书/IK 已在、索引已存在、账号已存在 → 都跳过；
# 重跑只会重设角色（init-security/init-user 的设计如此），密码沿用 users/<uid>.env。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
USER_ARG=""
TIER="team-write"
DIR_ARG=""
DO_CHECK=1

while [ $# -gt 0 ]; do
  case "$1" in
    --user) USER_ARG="$2"; shift 2 ;;
    --tier) TIER="$2"; shift 2 ;;
    --dir) DIR_ARG="$2"; shift 2 ;;
    --no-check) DO_CHECK=0; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

case "$TIER" in
  team-write|team-read|personal-only) ;;
  *) echo "--tier 只能是 team-write / team-read / personal-only（当前 $TIER）" >&2; exit 2 ;;
esac

# ── 0. 前置检查 ────────────────────────────────────────────────
need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少命令：$1（$2）" >&2; exit 1; }; }
need docker '先装 Docker：https://docs.docker.com/engine/install/'
need curl '安装 curl 后重试'
need openssl '安装 openssl 后重试（生成 ES 密码）'
need unzip '安装 unzip 后重试（解压 IK 插件）'
docker compose version >/dev/null 2>&1 || {
  echo 'docker compose 不可用（需要 compose v2 插件，不是已废弃的 docker-compose 独立二进制）' >&2
  exit 1
}
if [ "$(id -u)" = "0" ]; then
  echo '    ! 以 root 运行：生成的文件属主是 root。dsh 若以别的用户跑，装完要 chown。'
fi

# ── 1. 决定 ES 目录 ────────────────────────────────────────────
if [ -n "$DIR_ARG" ]; then
  ES_DIR="$DIR_ARG"
elif [ -n "${ES_DIR:-}" ]; then
  : # 环境里已指定
elif [ -f "$ROOT/deploy/es/.env" ]; then
  ES_DIR="$ROOT/deploy/es"
else
  ES_DIR="$DSH_HOME/memory-es/es"
fi

echo "==> ES 目录：$ES_DIR"
mkdir -p "$ES_DIR"
# 模板（compose + .env.example）随包带的；仓库里本来就有，存在就不动
[ -f "$ES_DIR/docker-compose.yml" ] || cp "$ROOT/deploy/es/docker-compose.yml" "$ES_DIR/"
[ -f "$ES_DIR/.env.example" ] || cp "$ROOT/deploy/es/.env.example" "$ES_DIR/"
[ -f "$ES_DIR/docker-compose.yml" ] || { echo "缺少 $ES_DIR/docker-compose.yml（包不完整？）" >&2; exit 1; }
[ -f "$ES_DIR/.env.example" ] || { echo "缺少 $ES_DIR/.env.example（包不完整？）" >&2; exit 1; }
chmod 700 "$ES_DIR" 2>/dev/null || true

# ── 2. 起 ES（内部会生成 .env、CA、下载 IK）────────────────────
echo '==> 1/4 启动 Elasticsearch（首次会生成证书与随机密码，约 1~3 分钟）'
ES_DIR="$ES_DIR" bash "$ROOT/scripts/es-up.sh"

# ── 3. 定用户 ─────────────────────────────────────────────────
ENV_FILE="$ES_DIR/.env"
if [ -z "$USER_ARG" ]; then
  USER_ARG=$(grep '^MEM_USER_ID=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
fi
[ -n "${USER_ARG:-}" ] || USER_ARG="$(id -un)"
# .env.example 里写死了 MEM_USER_ID=xqh：新装机必须改成自己的，否则索引名会顶着别人的 id
if grep -q '^MEM_USER_ID=' "$ENV_FILE"; then
  sed -i "s|^MEM_USER_ID=.*|MEM_USER_ID=$USER_ARG|" "$ENV_FILE"
else
  echo "MEM_USER_ID=$USER_ARG" >>"$ENV_FILE"
fi
echo "==> 本机身份：$USER_ARG（索引 personal_memory_$USER_ARG）"

# ── 4. 建索引（模板先于索引，否则个人索引长成动态映射）─────────
echo '==> 2/4 建索引模板与共享索引'
ES_DIR="$ES_DIR" bash "$ROOT/scripts/init-indices.sh"

# ── 5. 建角色与账号 ───────────────────────────────────────────
echo '==> 3/4 建角色与账号'
ES_DIR="$ES_DIR" bash "$ROOT/scripts/init-security.sh"
# init-security 会为 MEM_USER_ID 建 team-write 账号；显式再跑一次是为了支持 --user/--tier
ES_DIR="$ES_DIR" bash "$ROOT/scripts/init-user.sh" "$USER_ARG" "--$TIER"

# ── 6. 出配置片段（插件要读的那一段）──────────────────────────
USER_ENV="$ES_DIR/users/$USER_ARG.env"
PW=$(grep '^MEM_PASSWORD=' "$USER_ENV" 2>/dev/null | cut -d= -f2- || true)
SNIPPET="$ES_DIR/plugin-config.yml"
umask 077
cat >"$SNIPPET" <<YAML
# 粘到 profile 的 cordis.patch.yml 里（与其它 - id: 同级）。
# 生成自 scripts/es-setup.sh；含密码，权限 600，别提交仓库。
- id: dsh-memory-es
  config:
    es:
      url: https://127.0.0.1:9200
      caCertPath: ${ES_DIR}/certs/ca.crt
    identity:
      userId: ${USER_ARG}
      username: mem-user-${USER_ARG}
      password: ${PW}
      teamWrite: $([ "$TIER" = "team-write" ] && echo true || echo false)
    embedding:
      url: http://127.0.0.1:11434
      model: bge-m3
      dims: 1024
YAML
chmod 600 "$SNIPPET"

echo '==> 4/4 配置片段'
echo "    $SNIPPET（600）——把它合并进 profile 的 cordis.patch.yml："
echo "      \$DSH_HOME/profiles/<profile>/cordis.patch.yml"
echo '    改完重启 dsh web（运行中的进程持旧模块图）。'

# ── 7. 自检 ───────────────────────────────────────────────────
if [ "$DO_CHECK" = "1" ] && [ -f "$ROOT/scripts/selfcheck.sh" ]; then
  echo
  echo '==> 自检'
  DSH_HOME="$DSH_HOME" ES_DIR="$ES_DIR" bash "$ROOT/scripts/selfcheck.sh" --user "$USER_ARG" || true
fi

echo
echo '完成。ES 数据在：'"$ES_DIR"'（.env / certs / data / plugins / users 都在这里）'
echo "凭据：$ES_DIR/users/$USER_ARG.env（600，密码未打印）"