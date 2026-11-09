#!/usr/bin/env bash
# ============================================================
# provision-member.sh — 把新建实例整理成「干净的个人容器」
# ============================================================
# 背景：dsh-add.sh 用 dsh-plugins-seed.sh 从黄金模板预置 profile，而黄金模板
# 是 xqh 的配置快照 → 新实例默认带着 xqh 的 20 个 MCP（宝塔/jbp/grafana…，
# 每个都含 token）、xqh 的 ES 身份（mem-user-xqh）、以及 missing 的人格/表情包。
#
# 本脚本只做「把新容器变成它自己」这一步，不改黄金模板：
#   1) 剥离 cordis.patch.yml 里 id 以 mcp- 开头的顶层条目与 insert 子项
#   2) 建该成员的 ES 账号 + 4 个索引，identity 换成本人、teamWrite=false
#   3) 补 persona（人格内核）与 stickers（表情包）配置段、贴图目录
#   4) 补 local-plugins 源目录、CA 证书，把 dsh-es 接入该实例的 docker 网络
#   5) 重启并打印自检行（ES 可达 / 个人 / 团队 / 文档 计数）
#
# 幂等：已清理、已配置的项全部跳过；可反复跑。
#
# 用法（在 125 宿主，root）：
#   provision-member.sh <instance> [--dry-run] [--tier team-read] \
#                      [--ref-instance dsh-tanxu] [--skip-es]
#
# ⚠️ 改 cordis.patch.yml 必须「写临时文件 + rename」：profile 是用硬链接
#    从黄金模板预置的，原地改写会把黄金模板一起改掉（cp -al 共享 inode）。
# ============================================================
set -euo pipefail

BASE="${DSH_BASE:-/docker/dsh}"
ES_DIR="${ES_DIR:-/docker/dsh-es}"
ES_CONTAINER="${ES_CONTAINER:-dsh-es}"
REF_INSTANCE="${REF_INSTANCE:-dsh-tanxu}"

INSTANCE=""
DRY=0
TIER="team-read"
SKIP_ES=0

usage() {
  sed -n '3,26p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --skip-es) SKIP_ES=1 ;;
    --tier=*) TIER="${arg#--tier=}" ;;
    --ref-instance=*) REF_INSTANCE="${arg#--ref-instance=}" ;;
    -h|--help) usage ;;
    -*) echo "未知参数：$arg" >&2; exit 2 ;;
    *) INSTANCE="$arg" ;;
  esac
done
[ -n "$INSTANCE" ] || usage
case "$TIER" in team-read|team-write|personal-only) ;; *) echo "tier 非法：$TIER" >&2; exit 2 ;; esac

CONTAINER="dsh-$INSTANCE"
INST_DIR="$BASE/instances/$INSTANCE"
PROFILE="$INST_DIR/data/dsh/profiles/web"
PATCH="$PROFILE/cordis.patch.yml"
DATA="$INST_DIR/data/dsh"

[ -d "$INST_DIR" ] || { echo "✗ 实例目录不存在：$INST_DIR（先跑 dsh-add.sh）" >&2; exit 1; }
[ -f "$PATCH" ] || { echo "✗ 找不到 $PATCH（profile 未预置）" >&2; exit 1; }
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "✗ 容器 $CONTAINER 未运行（本脚本在 up 之后执行）" >&2
  exit 1
fi

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then say "  [dry-run] $*"; else "$@"; fi; }

# 容器内 node 的 uid/gid（不同镜像可能不是 1000，写文件后要还回去）
NODE_UID=$(docker exec "$CONTAINER" id -u node 2>/dev/null || echo 1000)
NODE_GID=$(docker exec "$CONTAINER" id -g node 2>/dev/null || echo 1000)

say "════════ 成员容器整理：$INSTANCE ════════"

# ────────────────────────────────────────────────────────────
# 1) ES 账号与索引（先建，后面写 identity 要用密码）
# ────────────────────────────────────────────────────────────
PW_FILE="$ES_DIR/users/$INSTANCE.env"
if [ "$SKIP_ES" = 1 ] || ! docker ps --format '{{.Names}}' | grep -qx "$ES_CONTAINER"; then
  say "① ES 账号：跳过（--skip-es 或 $ES_CONTAINER 未运行）"
  SKIP_ES=1
else
  say "① ES 账号与索引"
  if [ -f "$PW_FILE" ]; then
    say "  [skip]    $PW_FILE 已存在（沿用既有密码）"
  else
    say "  [create]  mem-user-$INSTANCE + 4 个索引"
    if [ "$DRY" = 1 ]; then
      say "  [dry-run] bash $ES_DIR/scripts/init-user.sh $INSTANCE --$TIER"
    else
      ES_DIR="$ES_DIR" ES_URL="${ES_URL:-https://192.168.50.125:9200}" \
        bash "$ES_DIR/scripts/init-user.sh" "$INSTANCE" "--$TIER" >/dev/null
    fi
  fi
fi

# ────────────────────────────────────────────────────────────
# 2) 改 cordis.patch.yml：剥 mcp-*、identity 换本人、补 persona/stickers
#    参数走 600 临时文件（密码不进 argv）
# ────────────────────────────────────────────────────────────
say "② 配置清理与补齐：$PATCH"
PARAMS="$(mktemp)"; chmod 600 "$PARAMS"
COPY="$(mktemp "${PATCH}.tmp.XXXXXX")"
cleanup() { rm -f "$PARAMS" "$COPY"; }
trap cleanup EXIT

PASSWORD=""
if [ -f "$PW_FILE" ]; then
  PASSWORD=$(grep '^MEM_PASSWORD=' "$PW_FILE" | cut -d= -f2- || true)
fi
REF_PATCH=""
[ -f "$BASE/instances/${REF_INSTANCE#dsh-}/data/dsh/profiles/web/cordis.patch.yml" ] && \
  REF_PATCH="$BASE/instances/${REF_INSTANCE#dsh-}/data/dsh/profiles/web/cordis.patch.yml"

python3 - "$PARAMS" "$INSTANCE" "$PASSWORD" "$REF_PATCH" <<'PY'
import json, sys
out = {
    "instance": sys.argv[2],
    "password": sys.argv[3] if sys.argv[3] else "",
    "ref": sys.argv[4] if len(sys.argv) > 4 else "",
}
json.dump(out, open(sys.argv[1], "w", encoding="utf-8"))
PY

python3 - "$PATCH" "$PARAMS" "$COPY" <<'PY'
import json, re, sys

src, params_path, dst = sys.argv[1], sys.argv[2], sys.argv[3]
p = json.load(open(params_path, encoding="utf-8"))
uid = p["instance"]
pw = p["password"]
ref = p.get("ref") or ""

lines = open(src, encoding="utf-8").read().split("\n")

def is_top(l):
    return re.match(r"^- (id:|insert:)", l) is not None

starts = [i for i, l in enumerate(lines) if is_top(l)]
blocks = [(s, starts[k + 1] if k + 1 < len(starts) else len(lines)) for k, s in enumerate(starts)]

drop = set()
removed_ids = []
for s, e in blocks:
    head = lines[s]
    m = re.match(r"^- id: (.+)$", head)
    if m and m.group(1).startswith("mcp-"):
        removed_ids.append(m.group(1))
        drop.update(range(s, e))
        continue
    if head.strip() == "- insert:":
        sub = [i for i in range(s + 1, e) if re.match(r"^    - id: ", lines[i])]
        subs = [(x, sub[k + 1] if k + 1 < len(sub) else e) for k, x in enumerate(sub)]
        kept = False
        for ss, se in subs:
            mm = re.match(r"^    - id: (.+)$", lines[ss])
            if mm and mm.group(1).startswith("mcp-"):
                removed_ids.append(mm.group(1))
                drop.update(range(ss, se))
            else:
                kept = True
        if not kept:
            drop.update(range(s, e))

lines = [l for i, l in enumerate(lines) if i not in drop]

# ---- memory-es 段内改 identity ----
starts = [i for i, l in enumerate(lines) if is_top(l)]
blocks = [(s, starts[k + 1] if k + 1 < len(starts) else len(lines)) for k, s in enumerate(starts)]
mi = next((i for i, l in enumerate(lines) if l.strip() == "- id: dsh-memory-es"), None)
if mi is None:
    sys.exit("✗ 配置里没有 - id: dsh-memory-es 段，无法写入身份")

ms, me = next((s, e) for s, e in blocks if s == mi)
ident_changed = []
for j in range(ms, me):
    l = lines[j]
    if re.match(r"^      userId:", l):
        lines[j] = "      userId: " + uid; ident_changed.append("userId")
    elif re.match(r"^      username:", l):
        lines[j] = "      username: mem-user-" + uid; ident_changed.append("username")
    elif re.match(r"^      password:", l):
        if pw:
            lines[j] = "      password: " + pw
        ident_changed.append("password")
    elif re.match(r"^      teamWrite:", l):
        lines[j] = "      teamWrite: false"; ident_changed.append("teamWrite")

# ---- 补 persona / stickers 段（从参照实例原样搬，保证与既有成员一致）----
def extract_ref_section(path):
    t = open(path, encoding="utf-8").read().split("\n")
    st = [i for i, l in enumerate(t) if is_top(l)]
    bl = [(s, st[k + 1] if k + 1 < len(st) else len(t)) for k, s in enumerate(st)]
    i0 = next((i for i, l in enumerate(t) if l.strip() == "- id: dsh-memory-es"), None)
    if i0 is None:
        return []
    s, e = next((s, e) for s, e in bl if s == i0)
    seg = t[s:e]
    p0 = next((k for k, l in enumerate(seg) if l.startswith("    persona:")), None)
    if p0 is None:
        return []
    end = len(seg)
    while end > p0 and seg[end - 1].strip() == "":
        end -= 1
    return seg[p0:end]

added = []
body = "\n".join(lines[ms:me])
need_persona = not re.search(r"^    persona:", body, re.M)
need_stickers = not re.search(r"^    stickers:", body, re.M)
if need_persona or need_stickers:
    payload = extract_ref_section(ref) if ref else []
    if payload:
        # 参照里可能两段都有；只取缺的那部分
        seg = payload
        if not need_persona:
            p0 = next(k for k, l in enumerate(seg) if l.startswith("    persona:"))
            p1 = next((k for k in range(p0 + 1, len(seg)) if seg[k].startswith("    stickers:")), len(seg))
            seg = seg[:p0] + seg[p1:]
        if not need_stickers:
            p0 = next((k for k, l in enumerate(seg) if l.startswith("    stickers:")), None)
            if p0 is not None:
                seg = seg[:p0]
        if seg:
            ins = me
            while ins > ms and lines[ins - 1].strip() == "":
                ins -= 1
            lines[ins:ins] = seg
            added = ["persona" if any(l.startswith("    persona:") for l in seg) else "",
                     "stickers" if any(l.startswith("    stickers:") for l in seg) else ""]
            added = [a for a in added if a]

open(dst, "w", encoding="utf-8").write("\n".join(lines))
if removed_ids:
    print("  [clean]    移除 MCP 条目 %d 个（新容器 MCP 全空、不带任何凭据）" % len(removed_ids))
else:
    print("  [skip]     没有 mcp-* 条目")
if ident_changed:
    print("  [identity] 身份 → mem-user-%s（teamWrite=false）" % uid)
if added:
    print("  [add]      已补配置段：" + " / ".join(added))
PY

# 校验 YAML 语法再落盘（写临时文件 + rename，打破与黄金模板的硬链接）
python3 -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1],encoding="utf-8"))' "$COPY" 2>/dev/null || {
  echo "✗ 改完的 YAML 解析失败，未写入（原文件未动）" >&2; exit 1; }
MCP_LEFT=$(grep -cE '^- id: mcp-|^    - id: mcp-' "$COPY" || true)
if [ "$MCP_LEFT" != "0" ]; then
  echo "✗ 仍残留 $MCP_LEFT 个 mcp 条目，未写入（原文件未动）" >&2; exit 1
fi

if cmp -s "$PATCH" "$COPY"; then
  say "  [skip]    配置无需改动"
else
  if [ "$DRY" = 1 ]; then
    say "  [dry-run] 将改写 $PATCH（剥离 mcp 条目 / identity / persona）"
  else
    cp -a "$PATCH" "$PATCH.bak-provision-$(date +%Y%m%d-%H%M%S)"
    chown "$NODE_UID:$NODE_GID" "$COPY"
    chmod 600 "$COPY"
    mv -f "$COPY" "$PATCH"   # rename：换 inode，绝不改黄金模板
    say "  [write]   已更新（备份：$(basename "$(ls -t "${PATCH}".bak-provision-* | head -1)"))"
  fi
fi

# ────────────────────────────────────────────────────────────
# 3) 表情包贴图（只补缺，不覆盖已有）
# ────────────────────────────────────────────────────────────
say "③ 表情包目录：$DATA/stickers"
SHARED_STICKERS="$BASE/shared/member-pack/stickers"
REF_STICKERS="$BASE/instances/${REF_INSTANCE#dsh-}/data/dsh/stickers"
[ -d "$SHARED_STICKERS" ] && REF_STICKERS="$SHARED_STICKERS"
if [ -d "$DATA/stickers" ] && [ "$(ls -A "$DATA/stickers" 2>/dev/null | wc -l)" -gt 0 ]; then
  say "  [skip]    已有 $(ls "$DATA/stickers" | wc -l) 个文件"
elif [ -d "$REF_STICKERS" ]; then
  say "  [copy]    从 $REF_STICKERS 复制"
  if [ "$DRY" = 0 ]; then
    mkdir -p "$DATA/stickers"
    cp -a -n "$REF_STICKERS/." "$DATA/stickers/"
    chown -R "$NODE_UID:$NODE_GID" "$DATA/stickers"
  fi
else
  say "  [warn]    参照实例没有贴图目录，跳过（可手工放 $DATA/stickers）"
fi

# ────────────────────────────────────────────────────────────
# 4) local-plugins 源目录（file: 依赖指向它；缺了以后升级会失败）
# ────────────────────────────────────────────────────────────
LP="$DATA/local-plugins/dsh-memory-es"
NM="$PROFILE/node_modules/dsh-memory-es"
say "④ local-plugins：$LP"
if [ -d "$LP" ]; then
  say "  [skip]    已存在"
elif [ -d "$NM" ]; then
  if [ "$DRY" = 1 ]; then
    say "  [dry-run] cp -a $NM $LP"
  else
    mkdir -p "$DATA/local-plugins"
    cp -a "$NM" "$LP"
    chown -R "$NODE_UID:$NODE_GID" "$DATA/local-plugins"
    say "  [copy]    从 node_modules 建立源目录"
  fi
else
  say "  [warn]    node_modules/dsh-memory-es 不存在，跳过"
fi

# ────────────────────────────────────────────────────────────
# 5) CA 证书 + 网络（ES 只在自己的网络里，实例必须能解析 dsh-es）
# ────────────────────────────────────────────────────────────
say "⑤ CA 与网络"
CA_SRC="$ES_DIR/certs/ca.crt"
if docker exec "$CONTAINER" test -f /home/node/ca-memory-es.crt 2>/dev/null; then
  say "  [skip]    CA 已存在"
elif [ -f "$CA_SRC" ]; then
  if [ "$DRY" = 1 ]; then
    say "  [dry-run] 拷贝 CA 到 $CONTAINER:/home/node/ca-memory-es.crt"
  else
    docker cp "$CA_SRC" "$CONTAINER":/home/node/ca-memory-es.crt >/dev/null
    docker exec -u root "$CONTAINER" chown node:node /home/node/ca-memory-es.crt
    say "  [copy]    CA 已放入容器"
  fi
else
  say "  [warn]    找不到 $CA_SRC"
fi

NET="dsh-${INSTANCE}_default"
if docker network inspect "$NET" >/dev/null 2>&1; then
  if docker inspect "$ES_CONTAINER" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' | grep -qw "$NET"; then
    say "  [skip]    $ES_CONTAINER 已在 $NET"
  elif [ "$DRY" = 1 ]; then
    say "  [dry-run] docker network connect $NET $ES_CONTAINER"
  else
    docker network connect "$NET" "$ES_CONTAINER" 2>/dev/null || true
    say "  [net]     $ES_CONTAINER 接入 $NET"
  fi
else
  say "  [warn]    网络 $NET 未创建（容器没起来？）"
fi

# ────────────────────────────────────────────────────────────
# 6) 重启 + 自检
# ────────────────────────────────────────────────────────────
say "⑥ 重启与自检"
if [ "$DRY" = 1 ]; then
  say "  [dry-run] docker restart $CONTAINER"
else
  docker restart "$CONTAINER" >/dev/null
  status=starting
  for _ in $(seq 1 20); do
    status=$(docker inspect "$CONTAINER" --format '{{.State.Health.Status}}')
    [ "$status" = healthy ] && break
    sleep 3
  done
  say "  health=$status"
  sleep 3
  line=$(docker logs --since 120s "$CONTAINER" 2>&1 | grep '\[记忆库面板\] 自检通过' | tail -1 || true)
  if [ -n "$line" ]; then
    say "  ${line#*\[记忆库面板\] }"
  else
    say "  （暂无自检行；插件日志不进 docker logs，稍后看面板）"
  fi
fi

say "════════ 完成：$INSTANCE ════════"