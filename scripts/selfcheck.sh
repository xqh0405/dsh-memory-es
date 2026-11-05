#!/usr/bin/env bash
# 装完自检：七项 PASS/FAIL，告诉你「能不能用」和「下一步做什么」。
#
# 为什么要有它：插件装成功 ≠ 能用。历史上最常见的求助是「面板打不开/保存报错」，
# 而真因往往是 ES 没起、CA 路径不对、账号没建、索引没模板、Ollama 没模型。
# 这些现在一条命令就能看出来（install.sh 装完也会自动跑一遍）。
#
# 用法：
#   scripts/selfcheck.sh                       # 自动找 DSH_HOME / ES 目录 / 用户
#   scripts/selfcheck.sh --dsh-home /data/dsh  # 容器里
#   scripts/selfcheck.sh --profile web-test    # 装到别的 profile
#   scripts/selfcheck.sh --es-dir /srv/dsh-es --user lisi
#   scripts/selfcheck.sh --url https://es01:9200
#
# 取值顺序（尽量用「插件实际会用的那一份」，而不是猜）：
#   连接地址  --url → 插件配置 es.url → 环境变量 MEMORY_ES_URL → https://127.0.0.1:9200
#   CA       插件配置 es.caCertPath（文件存在时）→ <ES 目录>/certs/ca.crt
#   身份      插件配置 identity.username/password → <ES 目录>/users/<uid>.env
# 容器里通常看不到宿主上的 <ES 目录>，所以**优先读插件配置**才是对的。
#
# 退出码：全部 PASS = 0；有 FAIL = 1（INFO 不影响退出码）。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${MEMORY_ES_PROFILE:-web}"
ES_DIR_ARG="${ES_DIR:-}"
USER_ARG=""
URL_ARG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dsh-home) DSH_HOME="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --es-dir) ES_DIR_ARG="$2"; shift 2 ;;
    --user) USER_ARG="$2"; shift 2 ;;
    --url) URL_ARG="$2"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

PASS=0
FAIL=0
FAILED_KEYS=()
# 不用 printf 对齐列：中文是双宽字符，按字符数补空格只会看起来更乱
ok() { PASS=$((PASS + 1)); printf '[PASS] %s —— %s\n' "$1" "$2"; }
bad() { FAIL=$((FAIL + 1)); FAILED_KEYS+=("$3"); printf '[FAIL] %s —— %s\n' "$1" "$2"; }
info() { printf '[INFO] %s —— %s\n' "$1" "$2"; }

# ── 定位 ES 目录（与 es-setup.sh 同一套规则）────────────────────
if [ -n "$ES_DIR_ARG" ]; then
  ES_DIR="$ES_DIR_ARG"
elif [ -f "$DSH_HOME/memory-es/es/.env" ]; then
  ES_DIR="$DSH_HOME/memory-es/es"
elif [ -f "$ROOT/deploy/es/.env" ]; then
  ES_DIR="$ROOT/deploy/es"
else
  ES_DIR="$DSH_HOME/memory-es/es"
fi
ENV_FILE="$ES_DIR/.env"
PLUGIN_DIR="$DSH_HOME/local-plugins/dsh-memory-es"
PROFILE_PKG="$DSH_HOME/profiles/$PROFILE/package.json"
PATCH_FILE="$DSH_HOME/profiles/$PROFILE/cordis.patch.yml"

# ── 从 profile 的插件配置里取「真实值」────────────────────────
# 为什么不能只用环境变量默认值：ES 地址经常不是回环（125 上绑局域网 IP，
# 容器里又写成 es01:9200）。读配置才是「你实际在用的地址」。
SEG=""
if [ -f "$PATCH_FILE" ]; then
  SEG=$(awk '/^- id: dsh-memory-es/{f=1;next} f&&/^- id: /{exit} f' "$PATCH_FILE")
fi
# 取某一段（es: / embedding:）里的某个标量；段边界按「缩进回到 4 空格」判断
seg_pick() {
  local block=$1 key=$2
  printf '%s\n' "$SEG" | awk -v b="$block" '
    $0 ~ "^[[:space:]]*"b":[[:space:]]*$" { f=1; next }
    f && /^[[:space:]]{0,4}[A-Za-z_]+:[[:space:]]*$/ && $0 !~ "^[[:space:]]{5,}" { exit }
    f { print }
  ' | grep -E "^[[:space:]]*$key:" | head -1 | sed 's/^[^:]*:[[:space:]]*//' | sed 's/^["'\'']//; s/["'\'']$//'
}

ES="${URL_ARG:-$(seg_pick es url)}"
ES="${ES:-${MEMORY_ES_URL:-https://127.0.0.1:9200}}"

# CA：配置里那一份优先（它必须与「实际在连的那个 ES」配套；ES 目录下的可能属于另一套部署）
CFG_CA=$(seg_pick es caCertPath)
CA=""
if [ -n "$CFG_CA" ] && [ -f "$CFG_CA" ]; then
  CA="$CFG_CA"
elif [ -f "$ES_DIR/certs/ca.crt" ]; then
  CA="$ES_DIR/certs/ca.crt"
fi

# 用户与身份：配置优先，其次 users/<uid>.env
CFG_UID=$(seg_pick identity userId)
CFG_USER=$(seg_pick identity username)
CFG_PASS=$(seg_pick identity password)
if [ -z "$USER_ARG" ]; then USER_ARG="$CFG_UID"; fi
if [ -z "$USER_ARG" ]; then
  USER_ARG=$(grep '^MEM_USER_ID=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
fi
if [ -z "$USER_ARG" ]; then
  mapfile -t _users < <(find "$ES_DIR/users" -maxdepth 1 -name '*.env' -printf '%f\n' 2>/dev/null | sed 's/\.env$//')
  if [ "${#_users[@]}" = "1" ]; then USER_ARG="${_users[0]}"; fi
fi
USER_ENV="$ES_DIR/users/${USER_ARG:-unknown}.env"
CRED_USER=""
CRED_PASS=""
CRED_FROM=""
if [ -n "$CFG_USER" ] && [ -n "$CFG_PASS" ]; then
  CRED_USER="$CFG_USER"; CRED_PASS="$CFG_PASS"; CRED_FROM="插件配置 identity"
elif [ -f "$USER_ENV" ]; then
  CRED_USER="mem-user-${USER_ARG}"
  CRED_PASS=$(grep '^MEM_PASSWORD=' "$USER_ENV" 2>/dev/null | cut -d= -f2- || true)
  [ -n "$CRED_PASS" ] && CRED_FROM="$USER_ENV"
fi
PASS_ELASTIC=$(grep '^ELASTIC_PASSWORD=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)

echo "dsh-memory-es 自检"
# 版本读**已安装**的那份（面板页脚/启动日志也读它）；没装就说明白，别显示空
INSTALLED_VERSION=$(grep -o '"version": *"[^"]*"' "$PLUGIN_DIR/package.json" 2>/dev/null | head -1 | cut -d'"' -f4)
echo "  版本   ${INSTALLED_VERSION:-未安装}"
echo "  ES     $ES（目录 $ES_DIR）"
echo "  配置   $PATCH_FILE"
echo "  身份   ${CRED_USER:-未配置}${CRED_FROM:+（来自 $CRED_FROM）}"
echo

# 凭据不进 argv（curl -u 会把密码放进 /proc/<pid>/cmdline）
if [ -f "$(dirname "$0")/lib/curl-es.sh" ]; then
  # shellcheck disable=SC1091
  source "$(dirname "$0")/lib/curl-es.sh"
else
  es_curl() {
    local cred=$1; shift
    local cfg; cfg=$(mktemp "${TMPDIR:-/tmp}/es-curl-XXXXXX") || return 2
    chmod 600 "$cfg"
    printf 'user = "%s"\n' "${cred//\"/\\\"}" >"$cfg"
    local rc=0
    curl -sS --max-time "${ES_CURL_TIMEOUT:-15}" --cacert "$CA" --config "$cfg" "$@" || rc=$?
    rm -f "$cfg"
    return "$rc"
  }
fi
: "${ES_CURL_TIMEOUT:=15}"

code() {
  # curl 自己在 -w 里会打 000（连不上时），再 `|| echo 000` 就成了 000000
  local out
  out=$(es_curl "$1" -o /dev/null -w '%{http_code}' "${@:2}" 2>/dev/null) || true
  printf '%s' "${out:-000}"
}

# ── 01 ES 连通（顺带验 CA）────────────────────────────────────
# 判据是「有没有 HTTP 响应」，不是「状态码 200」：读者身份连 `GET /` 都是 403，
# 而 401/403 同样证明地址与 CA 都对。000 才是「真的连不上」。
# 也不拿 elastic 密码当唯一探针：它只属于这一套集群，连别处时必然对不上
# （2026-11-05 实测：本机插件连 125，本地 .env 的 elastic 密码是另一套）。
REACHABLE=0
HEALTH=""
STATUS=""
NEED_CA=0
case "$ES" in https://*) NEED_CA=1 ;; esac
PROBE_CRED="${CRED_USER:+$CRED_USER:$CRED_PASS}"
[ -n "$PROBE_CRED" ] || PROBE_CRED="elastic:${PASS_ELASTIC:-probe}"
if [ "$NEED_CA" = "1" ] && [ -z "$CA" ]; then
  bad '01 ES 连通' "自签 ES 需要 CA，但没找到：配置 es.caCertPath 或 $ES_DIR/certs/ca.crt（es/setup.sh 会生成）" es
else
  c=$(code "$PROBE_CRED" -I "$ES/")
  if [ "$c" = "000" ]; then
    bad '01 ES 连通' "连不上 $ES（容器没起 / 端口不通 / CA 不对）。看：docker ps | grep dsh-es" es
  else
    REACHABLE=1
    # 有响应就算通；能读 cluster health 时再补一句真实状态
    HEALTH=$(es_curl "elastic:$PASS_ELASTIC" "$ES/_cluster/health" 2>/dev/null || true)
    STATUS=$(printf '%s' "$HEALTH" | grep -o '"status":"[a-z]*"' | cut -d'"' -f4)
    case "$STATUS" in
      green|yellow) ok '01 ES 连通' "HTTP $c · 集群 $STATUS · CA 校验通过" ;;
      red) bad '01 ES 连通' '集群 red：节点没起来，看 docker logs dsh-es01' es ;;
      *) ok '01 ES 连通' "HTTP $c · CA 校验通过（无 elastic 权限，跳过健康度）" ;;
    esac
  fi
fi

# ── 02 本用户账号 ─────────────────────────────────────────────
if [ -z "${USER_ARG:-}" ] || [ -z "${CRED_PASS:-}" ]; then
  if [ -z "${USER_ARG:-}" ]; then
    bad '02 本用户账号' "配置里没有 identity.userId，也没在 $ES_DIR/users 下找到账号文件" user
  else
    bad '02 本用户账号' "没有可用身份：配置里缺 identity.username/password，也没有 $USER_ENV" user
  fi
elif [ "$REACHABLE" != "1" ]; then
  info '02 本用户账号' "跳过（ES 不可达）· 身份 $CRED_USER"
else
  PERSONAL="personal_memory_${USER_ARG}"
  c=$(code "$CRED_USER:$CRED_PASS" -I "$ES/$PERSONAL")
  if [ "$c" = "200" ]; then
    ok '02 本用户账号' "$CRED_USER 可读 $PERSONAL"
  else
    bad '02 本用户账号' "$CRED_USER → HTTP $c（401=密码错；403=角色缺；404=索引没建）" user
  fi
fi

# ── 03 索引齐不齐 ─────────────────────────────────────────────
# 用**本用户账号**逐个 HEAD，而不是 elastic 的 `_cat/indices`：
#   ① elastic 密码只属于这套集群，连别处时必错（会误报「全缺」）；
#   ② 403 也说明索引存在（没权限看 ≠ 不存在），只有 404 才是真的缺。
if [ "$REACHABLE" = "1" ] && [ -n "${CRED_PASS:-}" ] && [ -n "${USER_ARG:-}" ]; then
  missing=()
  unknown=()
  for name in "personal_memory_${USER_ARG}" "personal_doc_${USER_ARG}" \
              "search_log_${USER_ARG}" team_knowledge memory_audit; do
    c=$(code "$CRED_USER:$CRED_PASS" -I "$ES/$name")
    case "$c" in
      200|403) ;;
      404) missing+=("$name") ;;
      *) unknown+=("$name($c)") ;;
    esac
  done
  if [ "${#missing[@]}" = "0" ] && [ "${#unknown[@]}" = "0" ]; then
    ok '03 索引' '个人/文档/检索埋点/团队/审计 五类都在'
  elif [ "${#unknown[@]}" != "0" ]; then
    bad '03 索引' "探测失败 ${unknown[*]}（000=连不上，401=密码错）" index
  else
    bad '03 索引' "缺 ${missing[*]} —— 跑 scripts/init-indices.sh" index
  fi
else
  info '03 索引' '跳过（ES 不可达或账号未就绪）'
fi

# ── 04 账号 ACL（能读团队库，才算融入团队）────────────────────
if [ -n "${CRED_PASS:-}" ] && [ "$REACHABLE" = "1" ]; then
  c=$(code "$CRED_USER:$CRED_PASS" -I "$ES/team_knowledge")
  case "$c" in
    200) ok '04 团队库 ACL' "$CRED_USER 可读 team_knowledge" ;;
    403) bad '04 团队库 ACL' 'HTTP 403 —— 角色少了 mem_team_read / mem_admin，重跑 init-user.sh' acl ;;
    404) bad '04 团队库 ACL' 'HTTP 404 —— team_knowledge 未创建，跑 scripts/init-indices.sh' acl ;;
    *) bad '04 团队库 ACL' "HTTP $c" acl ;;
  esac
else
  info '04 团队库 ACL' '跳过（账号或 ES 未就绪）'
fi

# ── 05 embedding（模型在不在、维度对不对）────────────────────
# 以插件配置为准（容器里 Ollama 常在宿主，地址不是回环）
EMB_URL="${MEM_EMBEDDING_URL:-$(seg_pick embedding url)}"
EMB_URL="${EMB_URL:-http://127.0.0.1:11434}"
EMB_MODEL="${MEM_EMBEDDING_MODEL:-$(seg_pick embedding model)}"
EMB_MODEL="${EMB_MODEL:-bge-m3}"
EMB_DIMS="${MEM_EMBEDDING_DIMS:-$(seg_pick embedding dims)}"
EMB_DIMS="${EMB_DIMS:-1024}"
TAGS=$(curl -sS --max-time 5 "$EMB_URL/api/tags" 2>/dev/null || true)
if [ -z "$TAGS" ]; then
  bad '05 embedding' "连不上 $EMB_URL（Ollama 没起？）。降级也能用，但只剩 BM25 关键词检索" embed
elif ! printf '%s' "$TAGS" | grep -q "\"${EMB_MODEL%%:*}"; then
  bad '05 embedding' "$EMB_URL 里没有模型 $EMB_MODEL —— ollama pull $EMB_MODEL" embed
else
  # 维度必须与索引 mapping 一致，否则 knn 直接报错；实测一次最便宜
  RESP=$(curl -sS --max-time 20 "$EMB_URL/api/embed" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$EMB_MODEL\",\"input\":\"自检\"}" 2>/dev/null || true)
  DIMS=$(printf '%s' "$RESP" | grep -o '\[[^]]*\]' | head -1 | tr ',' '\n' | grep -c . || true)
  if [ -n "$DIMS" ] && [ "$DIMS" != "0" ] && [ "$DIMS" != "$EMB_DIMS" ]; then
    bad '05 embedding' "模型维度 $DIMS ≠ 索引 dims $EMB_DIMS（换模型必须重建索引）" embed
  elif [ -n "$DIMS" ] && [ "$DIMS" != "0" ]; then
    ok '05 embedding' "$EMB_MODEL · ${DIMS} 维，与索引一致"
  else
    info '05 embedding' "$EMB_MODEL 在（维度未探到：/api/embed 无响应，旧版 Ollama 只有 /api/embeddings）"
  fi
fi

# ── 06 插件就位 + 加载清单 ───────────────────────────────────
if [ -f "$PLUGIN_DIR/lib/index.js" ] && [ -f "$PLUGIN_DIR/panel/index.js" ]; then
  if [ ! -f "$PROFILE_PKG" ]; then
    bad '06 插件' "缺 $PROFILE_PKG（profile 还没初始化？先跑一次 dsh --profile $PROFILE 任意命令）" plugin
  else
    # bundles 才是「加载清单」：依赖里有包名 ≠ 会加载（旧版踩过：接口 404、日志静默）
    has_bundle=0
    if command -v node >/dev/null 2>&1; then
      node -e '
        const p = require(process.argv[1])
        const b = (p.dsh && p.dsh.profile && p.dsh.profile.bundles) || []
        process.exit(b.includes("dsh-memory-es") ? 0 : 1)
      ' "$PROFILE_PKG" 2>/dev/null && has_bundle=1
    else
      # 没有 node 时退化成「只看 bundles 数组那一段」，够用（不去解析整份 JSON）
      awk '/"bundles"/{f=1} f{print} f&&/\]/{exit}' "$PROFILE_PKG" 2>/dev/null \
        | grep -q '"dsh-memory-es"' && has_bundle=1
    fi
    if [ "$has_bundle" = "1" ] && grep -q '"dsh-memory-es"' "$PROFILE_PKG"; then
      ok '06 插件' 'lib + panel 已就位，bundles 含 dsh-memory-es'
    else
      bad '06 插件' "$PROFILE_PKG 的 dsh.profile.bundles 没有 dsh-memory-es（装了但不会加载）" plugin
    fi
  fi
else
  bad '06 插件' "缺 $PLUGIN_DIR/lib/index.js 或 panel/index.js —— 重新解包跑 install.sh" plugin
fi

# ── 07 插件配置（identity 与 CA 是写入的硬前提）───────────────
if [ ! -f "$PATCH_FILE" ]; then
  bad '07 插件配置' "缺 $PATCH_FILE" config
elif [ -z "$SEG" ]; then
  bad '07 插件配置' "$PATCH_FILE 里没有 dsh-memory-es 段 —— 把 $ES_DIR/plugin-config.yml 合并进去" config
else
  problems=()
  [ -n "$CFG_UID" ] || problems+=('identity.userId 空')
  if [ -z "$CFG_USER" ] && [ -z "$(seg_pick identity readPassword)" ]; then
    problems+=('既没有 identity.username 也没有 readPassword')
  fi
  if [ -n "$CFG_CA" ] && [ ! -f "$CFG_CA" ]; then
    problems+=("caCertPath 指向的文件不存在：$CFG_CA")
  fi
  if [ "$NEED_CA" = "1" ] && [ -z "$CFG_CA" ] && [ -z "$CA" ]; then
    problems+=('自签 ES 但配置里没有可用的 caCertPath')
  fi
  if [ "${#problems[@]}" = "0" ]; then
    ok '07 插件配置' "identity=${CFG_UID}${CFG_USER:+ · $CFG_USER}"
  else
    bad '07 插件配置' "${problems[*]}" config
  fi
fi

# ── 汇总 ─────────────────────────────────────────────────────
echo
echo "结果：${PASS} 通过 / ${FAIL} 失败$([ "$FAIL" = "0" ] && echo ' —— 可以用了')"
if [ "$FAIL" != "0" ]; then
  echo
  echo '下一步：'
  seen=""
  for k in "${FAILED_KEYS[@]}"; do
    case "$seen" in *"|$k|"*) continue ;; esac
    seen="$seen|$k|"
    case "$k" in
      es)     echo '  · 起 ES：es/setup.sh（仓库里：scripts/es-setup.sh）' ;;
      user)   echo '  · 建账号：scripts/init-user.sh <uid> --team-write' ;;
      index)  echo '  · 建索引：scripts/init-indices.sh（模板必须先于索引）' ;;
      acl)    echo '  · 重设角色：scripts/init-user.sh <uid> --team-write' ;;
      embed)  echo '  · 起 Ollama 并拉模型：ollama serve & ollama pull bge-m3' ;;
      plugin) echo '  · 重装插件：./install.sh（或 dsh plugin --profile <p> add file:<目录>）' ;;
      config) echo '  · 合并配置：把 es 目录下的 plugin-config.yml 并进 cordis.patch.yml 后重启 dsh web' ;;
    esac
  done
  exit 1
fi
exit 0