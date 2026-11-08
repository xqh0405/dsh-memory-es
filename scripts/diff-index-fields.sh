#!/usr/bin/env bash
# 个人索引 vs 团队索引的字段差集自检（阶段 19 的验收工具）。
#
# 为什么要有它：团队库是个人库的「窄版」，但窄在哪儿必须**可核对**。
# 2026-11-06 手工比过一次（个人 50 / 团队 26 / 团队缺 31），比完就散了；
# 之后加字段（summary）又出现「个人有、团队无」→ 写团队必 400。
# 这个脚本把那次比对固化，以后每次加字段跑一次就够。
#
# 口径：
#   · 默认读 **源码模板**（scripts/init-indices.sh 里的两段 JSON），不需要 ES。
#     这样 CI 里也能跑，且能抓到「模板漏改」——线上补了字段但模板没补，重装即丢。
#   · `--live` 改读**线上实际 mapping**，用来发现「模板对了但线上没迁」。
#
# 判据：
#   缺口必须**只剩 PERSONAL_ONLY 白名单**里的字段（那些字段语义上就不该进团队库，
#   比如 memory_id / user_id / privacy / 情绪与激活状态）。
#   非白名单缺口 > 0 就是真漏，退出码 1。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIVE=0
[ "${1:-}" = "--live" ] && LIVE=1

# 个人库独有、语义上不该进团队库的字段。
# 加新字段时若要进团队库，从这里的「不该迁」反过来判断：能从别的字段重算、
# 或只对单个用户有意义的（隐私、情绪、衰减状态、原始 id）都留个人。
PERSONAL_ONLY="memory_id user_id privacy related activation mood_valence mood_arousal mood_updated_at mood_label mood_note mood_events quarantine_reason distill_state distill_model distill_at supersedes soft_deleted_at"

if [ "$LIVE" -eq 1 ]; then
  # 线上口径：需要能读 _mapping 的账号（mem-user 角色带 view_index_metadata）
  CONF="${MEM_ES_CONF:-$HOME/.dsh/profiles/web/cordis.patch.yml}"
  ES_URL="${MEM_ES_URL:-https://192.168.50.125:9200}"
  ES_CA="${MEM_ES_CA:-$HOME/.dsh/certs/dsh-es-lan-ca.crt}"
  PASS="${MEM_ES_PASS:-}"
  if [ -z "$PASS" ] && [ -f "$CONF" ]; then
    PASS=$(awk '/^[[:space:]]*identity:/{f=1} f&&/^[[:space:]]*password:/{sub(/.*password:[[:space:]]*/,""); print; exit}' "$CONF" | tr -d "'\"")
  fi
  [ -z "$PASS" ] && { echo "拿不到 ES 密码（设 MEM_ES_PASS 或检查 $CONF）" >&2; exit 2; }

  python3 - "$ES_URL" "$ES_CA" "$PASS" "$PERSONAL_ONLY" <<'PY'
import base64, json, ssl, sys, urllib.request

url, ca, pw, personal_only = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4].split()
ctx = ssl.create_default_context(cafile=ca)

def get(path):
    req = urllib.request.Request(url + path, headers={
        "Authorization": "Basic " + base64.b64encode(f"mem-user-xqh:{pw}".encode()).decode()
    })
    return json.load(urllib.request.urlopen(req, context=ctx, timeout=15))

def fields(index):
    m = get(f"/{index}/_mapping")
    props = list(m.values())[0]["mappings"].get("properties", {})
    return set(props)

p = fields("personal_memory_xqh")
t = fields("team_knowledge")
missing = sorted(p - t)
real = [f for f in missing if f not in personal_only]
extra = sorted(t - p)

print(f"个人 personal_memory_xqh: {len(p)} 字段")
print(f"团队 team_knowledge:      {len(t)} 字段")
print(f"团队缺 {len(missing)} 个：{', '.join(missing) if missing else '(无)'}")
print(f"  其中预期个人专用 {len(missing) - len(real)} 个")
print(f"  非预期缺口 {len(real)} 个：{', '.join(real) if real else '(无)'}")
if extra:
    print(f"团队独有 {len(extra)} 个（允许，团队有自己的字段）：{', '.join(extra)}")
sys.exit(1 if real else 0)
PY
  exit $?
fi

# 默认口径：静态解析 init-indices.sh 的两段模板
python3 - "$ROOT/scripts/init-indices.sh" "$PERSONAL_ONLY" <<'PY'
import json, re, sys

path, personal_only = sys.argv[1], sys.argv[2].split()
src = open(path, encoding="utf-8").read()

# 按 heredoc 切开：<<'JSON' ... JSON
parts = re.split(r"<<'JSON'\n", src)
blocks = []
for i, b in enumerate(parts[1:], start=1):
    body, sep, _ = b.partition("\nJSON")
    if not sep:
        continue
    # 该 heredoc 前面的近处文本决定它是哪个索引
    head = parts[i - 1][-400:]
    try:
        doc = json.loads(body)
    except json.JSONDecodeError:
        continue
    props = (doc.get("template", {}).get("mappings", {}) or doc.get("mappings", {})).get("properties")
    if not props:
        continue  # 例如 $PERSONAL 那个空 {} 块
    if "personal_memory_template" in head:
        blocks.append(("personal", set(props)))
    elif "team_knowledge" in head:
        blocks.append(("team", set(props)))

if len(blocks) < 2:
    print(f"解析失败：只找到 {len(blocks)} 段模板（期望 personal + team）", file=sys.stderr)
    sys.exit(2)

p = next(f for n, f in blocks if n == "personal")
t = next(f for n, f in blocks if n == "team")
missing = sorted(p - t)
real = [f for f in missing if f not in personal_only]

print(f"个人模板 personal_memory_template: {len(p)} 字段")
print(f"团队模板 team_knowledge:           {len(t)} 字段")
print(f"团队缺 {len(missing)} 个：{', '.join(missing) if missing else '(无)'}")
print(f"  其中预期个人专用 {len(missing) - len(real)} 个")
print(f"  非预期缺口 {len(real)} 个：{', '.join(real) if real else '(无)'}")
sys.exit(1 if real else 0)
PY