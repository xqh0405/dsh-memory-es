#!/usr/bin/env bash
# 人格切换：把 preset 写进本机 profile 配置的 persona.seed，并连带把 stickers.dir
# 指到同名的那套表情包（persona/stickers/<name>/）。
#
# 只改「本机实际生效」的那处（profile 配置）。
# 仓库默认人格就是 persona/presets/xilian.md 本身（2026-11-20 起不再有 seed.md 副本），
# 所以 --also-default 已经不需要了——保留参数只为不弄坏旧脚本，它会打印一句提示。
#
# 用法：
#   scripts/use-persona.sh                      # 列出预设与贴图，标出当前生效的
#   scripts/use-persona.sh hutao                # 人格 + 贴图一起切
#   scripts/use-persona.sh hutao --seed-only    # 只换人格，贴图不动
#   scripts/use-persona.sh hutao --stickers-only# 只换贴图，人格不动
#   scripts/use-persona.sh hutao --dry-run      # 只打印要做什么，不写任何文件
#   scripts/use-persona.sh hutao --also-default # 已废弃：默认人格直接取预设，没有副本可同步
#   scripts/use-persona.sh hutao --deploy       # 切换后顺便分发到 125（需 PACK_HOST）
#
# 环境变量：
#   PERSONA_CONFIG         覆盖 profile 配置路径（默认 ~/.dsh/profiles/web/cordis.patch.yml）
#   PERSONA_STICKERS_ROOT  贴图根目录（默认 ~/.dsh/stickers；本机切三套用）
#
# 回滚：脚本会打印备份路径（.bak-<时间戳>），cp 回去即恢复。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRESET_DIR="$ROOT/persona/presets"
STICKER_DIR="$ROOT/persona/stickers"
DEFAULT_PRESET_FILE="$PRESET_DIR/xilian.md"
CONFIG="${PERSONA_CONFIG:-$HOME/.dsh/profiles/web/cordis.patch.yml}"
STICKER_ROOT="${PERSONA_STICKERS_ROOT:-$HOME/.dsh/stickers}"
DRY_RUN=0
DEPLOY=0
SEED_ONLY=0
STICKERS_ONLY=0

# 列出可用预设：文件名、字数、首行摘要
list_presets() {
  local current
  # 必须用 bash 重新调本脚本：直接 python3 "$0" 会让 python 去解释 bash 脚本
  current=$(bash "$0" --read-current "$CONFIG" 2>/dev/null || echo '')
  echo "可用预设（persona/presets/）："
  local f
  # 只列 presets：seed.md 是「当前默认实例」，不是预设条目（内容通常是其中一份的副本）
  for f in "$PRESET_DIR"/*.md; do
    [ -f "$f" ] || continue
    local name chars first mark
    name="$(basename "$f" .md)"
    # 字数只算正文：剥掉 frontmatter，否则会多报两三百字（用户会以为预设变长了）
    chars=$(python3 - "$f" <<'PYCHARS'
import re
import sys

text = open(sys.argv[1], encoding='utf-8').read()
text = re.sub(r'^\s*---\r?\n[\s\S]*?\r?\n---\r?\n?', '', text)
print(len(text.replace('\n', '').replace(' ', '')))
PYCHARS
)
    # 用 python 按「字符」截断：cut -c 会切坏 UTF-8 多字节，终端里变成乱码。
    # 摘要取「身份」正文：跳过 frontmatter 与 `【身份】` 这类段落标题，
    # 否则 2026-11-20 加了标记之后列表里全是 `---`。
    first=$(python3 - "$f" <<'PYFIRST'
import re
import sys

text = open(sys.argv[1], encoding='utf-8').read()
text = re.sub(r'^\s*---\r?\n[\s\S]*?\r?\n---\r?\n?', '', text)
for line in text.split('\n'):
    stripped = line.strip()
    if stripped == '' or re.fullmatch(r'【[^】]*】', stripped):
        continue
    print(stripped[:46])
    break
PYFIRST
)
    mark=""
    # 本机生效的那份：去掉所有空白后比对（配置里的块标量可能多/少空行，
    # 逐字节比会漏判；人格正文里空白不携带语义）
    if [ -n "$current" ] && [ "$(python3 -c '
import sys
def norm(s): return "".join(s.split())
print("1" if norm(open(sys.argv[1], encoding="utf-8").read()) == norm(sys.argv[2]) else "0")
' "$f" "$current")" = "1" ]; then
      mark="  ← 当前生效"
    fi
    printf '  %-10s %5s 字  %s%s\n' "$name" "$chars" "$first" "$mark"
  done
  echo
  if [ -n "$current" ]; then
    local tip
    # 与列表里的摘要同一套规则：跳过 frontmatter 与段落标题（否则显示成 `---`）
    tip=$(printf '%s' "$current" | python3 -c '
import re, sys
text = re.sub(r"^\s*---\r?\n[\s\S]*?\r?\n---\r?\n?", "", sys.stdin.read())
for line in text.split("\n"):
    s = line.strip()
    if s == "" or re.fullmatch(r"【[^】]*】", s):
        continue
    print(s[:46])
    break
')
    echo "当前本机生效（$CONFIG）：$tip…"
  else
    echo "当前本机生效：读不到配置里的 persona.seed（$CONFIG）"
  fi
  # 默认人格就是 xilian.md 本身（单一源）。它存在与否决定「新装用户有没有人格」
  if [ -f "$DEFAULT_PRESET_FILE" ]; then
    echo "默认人格（persona/presets/xilian.md）：新装即生效"
  else
    echo "默认人格缺失：persona/presets/xilian.md 不存在，新装用户将没有人格"
  fi
  # 贴图包：与人格同名，dir 指向哪套就说明当前在用哪套
  local curdir
  curdir=$(bash "$0" --read-stickers-dir "$CONFIG" 2>/dev/null || echo '')
  echo
  echo "贴图包（persona/stickers/，当前 dir = ${curdir:-读不到}）："
  local sd n
  for sd in "$STICKER_DIR"/*/; do
    [ -f "$sd/stickers.json" ] || continue
    n=$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["items"]))' "$sd/stickers.json")
    local nm="${sd%/}"; nm="${nm##*/}"
    local smark=""
    case "$curdir" in
      *"/$nm"|*"/$nm/") smark="  ← 当前生效" ;;
    esac
    printf '  %-10s %3s 张%s\n' "$nm" "$n" "$smark"
  done
  echo "切换：scripts/use-persona.sh <预设名>（人格与贴图一起切）"
}

# 读配置里 stickers.dir（只读）
if [ "${1:-}" = "--read-stickers-dir" ]; then
  exec python3 - "${2:?缺少配置路径}" <<'PY'
import re, sys
lines = open(sys.argv[1], encoding='utf-8').read().split('\n')
inside = False
for line in lines:
    if re.match(r'^    stickers:\s*$', line):
        inside = True
        continue
    if inside:
        m = re.match(r'^      dir:\s*(\S+)\s*$', line)
        if m:
            print(m.group(1)); sys.exit(0)
        if re.match(r'^    \S', line):
            break
sys.exit(1)
PY
fi

# 读配置里 persona.seed 的整段正文（只读，不碰其他字段；供列表比对与展示）
if [ "${1:-}" = "--read-current" ]; then
  exec python3 - "${2:?缺少配置路径}" <<'PY'
import re, sys
path = sys.argv[1]
try:
    lines = open(path, encoding='utf-8').read().split('\n')
except OSError:
    sys.exit(1)

# 定位 seed 行与它的缩进；必须是块标量
idx = indent = None
for i, line in enumerate(lines):
    m = re.match(r'^( +)seed: [|>][+-]?\s*$', line)
    if m:
        idx, indent = i, len(m.group(1))
        break
if idx is None:
    sys.exit(1)

# 块内容 = 缩进比 seed 行更深的连续行（中间允许空行）；
# 遇到同级/更浅的非空行就结束 —— 不能再用「吞到文件尾」的正则，
# 否则会把后面的 stickers: 等字段吃进人格正文（2026-11-12 实测踩到）。
end = idx + 1
while end < len(lines):
    line = lines[end]
    if line.strip() == '':
        end += 1
        continue
    if len(line) - len(line.lstrip()) > indent:
        end += 1
        continue
    break

body = '\n'.join(line[indent + 2:] if line.strip() else '' for line in lines[idx + 1:end])
body = body.rstrip('\n')
if not body.strip():
    sys.exit(1)
sys.stdout.write(body + '\n')
PY
fi

NAME="${1:-}"
if [ -z "$NAME" ]; then
  list_presets
  exit 0
fi
shift || true
ALSO_DEFAULT=0
TIER_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --also-default) ALSO_DEFAULT=1 ;;
    --deploy) DEPLOY=1 ;;
    --seed-only) SEED_ONLY=1 ;;
    --stickers-only) STICKERS_ONLY=1 ;;
    --tier=*) TIER_OVERRIDE="${1#--tier=}" ;;
    --tier)
      shift || true
      TIER_OVERRIDE="${1:-}"
      [ -n "$TIER_OVERRIDE" ] || { echo "--tier 需要一个值：lite 或 full" >&2; exit 2; }
      ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
  shift
done
case "$TIER_OVERRIDE" in
  ''|lite|full) ;;
  *) echo "--tier 只接受 lite 或 full（收到：$TIER_OVERRIDE）" >&2; exit 2 ;;
esac
if [ "$SEED_ONLY" = "1" ] && [ "$STICKERS_ONLY" = "1" ]; then
  echo "--seed-only 与 --stickers-only 只能选一个" >&2; exit 2
fi

# 找预设：hutao → presets/hutao.md；xilian / seed 都是 presets/xilian.md 的别名
# 预设只认 presets/ 下的文件；seed 是昔涟的历史别名（早期列表把它当预设名发出去过）
case "$NAME" in
  seed|xilian|昔涟) SRC="$PRESET_DIR/xilian.md" ;;
  *) SRC="$PRESET_DIR/$NAME.md" ;;
esac
if [ ! -f "$SRC" ]; then
  echo "没有这个预设：$NAME" >&2
  echo "可选：$(ls "$PRESET_DIR" | sed 's/\.md$//' | tr '\n' ' ')" >&2
  exit 2
fi

# 档位：--tier 指定优先；否则取预设 frontmatter 的 tier_default（缺省 lite）
if [ -n "$TIER_OVERRIDE" ]; then
  TIER="$TIER_OVERRIDE"
  TIER_FROM="--tier 指定"
else
  TIER=$(python3 - "$SRC" <<'PYTIER'
import re, sys
text = open(sys.argv[1], encoding='utf-8').read()
match = re.match(r'^\s*---\r?\n([\s\S]*?)\r?\n---', text)
tier = 'lite'
if match:
    found = re.search(r'^tier_default:\s*(\S+)', match.group(1), re.M)
    if found:
        tier = found.group(1).strip()
print(tier if tier in ('lite', 'full') else 'lite')
PYTIER
)
  TIER_FROM="预设 tier_default"
fi

echo "==> 目标预设：$SRC（$(python3 -c 'import sys;print(len(open(sys.argv[1],encoding="utf-8").read().replace("\n","").replace(" ","")))' "$SRC") 字）"
echo "==> 档位：$TIER（$TIER_FROM）"
echo "==> 本机配置：$CONFIG（默认只改这里，热生效）"
if [ "$ALSO_DEFAULT" = "1" ]; then
  echo "==> --also-default 已废弃：默认人格直接取 persona/presets/xilian.md，没有副本要同步（本次忽略）" >&2
fi
STICKER_PACK=""
if [ "$SEED_ONLY" != "1" ]; then
  # 贴图包与人格同名；没有对应目录就跳过（不阻塞人格切换）
  case "$NAME" in
    seed|昔涟) STICKER_PACK="$STICKER_DIR/xilian" ;;
    *) STICKER_PACK="$STICKER_DIR/$NAME" ;;
  esac
  [ -f "$STICKER_PACK/stickers.json" ] || STICKER_PACK=""
  if [ -n "$STICKER_PACK" ]; then
    echo "==> 贴图包：$STICKER_PACK → dir $STICKER_ROOT/$(basename "$STICKER_PACK")"
  else
    echo "==> 贴图包：没有同名的一套（贴图不动）"
  fi
fi

if [ "$DRY_RUN" = "1" ]; then
  echo
  echo "[dry-run] 将做的事："
  echo "  1. 备份配置 → $CONFIG.bak-<时间戳>"
  [ "$STICKERS_ONLY" != "1" ] && echo "  2. 替换其中 persona.seed 块（保持缩进与 |+ 语义）"
  [ -n "$STICKER_PACK" ] && echo "  3. 把 stickers.dir 指到 $STICKER_ROOT/$(basename "$STICKER_PACK")"
  [ "$ALSO_DEFAULT" = "1" ] && echo "  4. （--also-default 已废弃，忽略）"
  [ "$DEPLOY" = "1" ] && echo "  5. 分发到 125（PACK_HOST / PACK_SSH_KEY）"
  exit 0
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
CONFIG_BAK="$CONFIG.bak-$STAMP"
cp -p "$CONFIG" "$CONFIG_BAK"
echo "  备份配置：$CONFIG_BAK"

if [ "$STICKERS_ONLY" != "1" ]; then
if ! python3 - "$SRC" "$CONFIG" "$CONFIG_BAK" <<'PY'
import re, sys
import yaml

src_path, cfg_path, bak_path = sys.argv[1:4]
body = open(src_path, encoding='utf-8').read().rstrip('\n')
if not body.strip():
    sys.exit('预设是空的，拒绝写入')

src = open(cfg_path, encoding='utf-8').read()
lines = src.split('\n')

# 定位 persona.seed 块：必须有且只有一个
idx = None
indent = 0
for i, line in enumerate(lines):
    m = re.match(r'^( +)seed: [|>][+-]?\s*$', line)
    if m:
        if idx is not None:
            sys.exit('配置里出现多个 seed: 块，拒绝自动修改（请手工处理）')
        idx, indent = i, len(m.group(1))
if idx is None:
    sys.exit('配置里没有 persona.seed 块（预期形如 `      seed: |+`）')

# 块内容 = 后续空行或缩进更深的行；遇到同级/更浅的非空行即结束
end = idx + 1
while end < len(lines):
    line = lines[end]
    if line.strip() == '':
        end += 1
        continue
    if len(line) - len(line.lstrip()) > indent:
        end += 1
        continue
    break

pad = ' ' * (indent + 2)
new_block = [(pad + ln if ln else '') for ln in body.split('\n')]
new_lines = lines[:idx] + [(' ' * indent) + 'seed: |+'] + new_block + lines[end:]

# 校验一：替换后的块能单独解析成 YAML 块标量，且内容与预设逐字一致
frag = 'seed: |+\n' + '\n'.join(('  ' + ln if ln else '') for ln in body.split('\n')) + '\n'
got = yaml.safe_load(frag)['seed']
if got.rstrip('\n') != body:
    sys.exit('校验失败：块标量 round-trip 与预设内容不一致')

# 校验二：配置其余行原样保留（只删了旧块、加了新块）
assert lines[:idx] == new_lines[:idx]
if end < len(lines):
    tail = lines[end:]
    assert new_lines[len(new_lines) - len(tail):] == tail, '尾部内容被改动'

open(cfg_path, 'w', encoding='utf-8').write('\n'.join(new_lines))
print('  配置已替换：seed 块 %d 行 → %d 行' % (end - idx - 1, len(new_block)))
PY
then
  cp -p "$CONFIG_BAK" "$CONFIG"
  echo "配置写入失败，已回滚到 $CONFIG_BAK" >&2
  exit 1
fi
fi  # STICKERS_ONLY

# 档位写进 profile 配置的 persona.tier（与 seed 同一个文件，热生效）
if [ "$STICKERS_ONLY" != "1" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    echo "==> [dry-run] 会把 persona.tier 设为 $TIER"
  elif ! python3 - "$CONFIG" "$TIER" <<'PYSET'
import re
import sys

cfg, tier = sys.argv[1], sys.argv[2]
lines = open(cfg, encoding='utf-8').read().split('\n')

# 定位 persona: 块（顶格或缩进的都认，取第一个）
start = None
for i, line in enumerate(lines):
    m = re.match(r'^(\s*)persona:\s*$', line)
    if m:
        start = i
        base_indent = len(m.group(1))
        break
if start is None:
    print('  配置里没有 persona: 块，跳过档位写入（用默认 lite）')
    sys.exit(0)

# 块尾：下一个缩进 <= base_indent 的非空行
end = len(lines)
for j in range(start + 1, len(lines)):
    if not lines[j].strip():
        continue
    if len(lines[j]) - len(lines[j].lstrip()) <= base_indent:
        end = j
        break

# 已有 tier: 就替换
for j in range(start + 1, end):
    m = re.match(r'^(\s*)tier:\s*(\S*)\s*$', lines[j])
    if m:
        lines[j] = f'{m.group(1)}tier: {tier}'
        open(cfg, 'w', encoding='utf-8').write('\n'.join(lines))
        print(f'  persona.tier → {tier}（替换原有值）')
        sys.exit(0)

# 没有就插在 seed: 行前，缩进跟着 seed
for j in range(start + 1, end):
    m = re.match(r'^(\s*)seed:', lines[j])
    if m:
        lines.insert(j, f'{m.group(1)}tier: {tier}')
        open(cfg, 'w', encoding='utf-8').write('\n'.join(lines))
        print(f'  persona.tier → {tier}（新增）')
        sys.exit(0)

print('  persona: 块里没有 seed:，跳过档位写入')
PYSET
  then
    echo "  ⚠️ 档位写入失败，配置里仍是上一次的值（人格已切换）" >&2
  fi
fi

# 贴图：只改 stickers.dir（不搬文件，图片在 persona/stickers/<name>/ 里）
if [ -n "$STICKER_PACK" ]; then
  TARGET_DIR="$STICKER_ROOT/$(basename "$STICKER_PACK")"
  if ! python3 - "$CONFIG" "$TARGET_DIR" <<'PY'
import re, sys
path, target = sys.argv[1], sys.argv[2]
lines = open(path, encoding='utf-8').read().split('\n')

start = next((i for i, l in enumerate(lines) if l.strip() == '- id: dsh-memory-es'), None)
if start is None:
    sys.exit('配置里没有 dsh-memory-es 段')
stop = next((i for i in range(start + 1, len(lines)) if lines[i].startswith('- ')), len(lines))

# 在段内找 stickers: 下的 dir:
for i in range(start, stop):
    if lines[i].strip() == 'stickers:':
        indent = len(lines[i]) - len(lines[i].lstrip()) + 2
        for j in range(i + 1, stop):
            m = re.match(r'^(\s+)dir:\s*\S+\s*$', lines[j])
            if m:
                lines[j] = f"{' ' * indent}dir: {target}"
                break
            if lines[j].strip() and (len(lines[j]) - len(lines[j].lstrip())) <= indent - 2:
                break  # 离开了 stickers 段
        else:
            lines.insert(i + 1, f"{' ' * indent}dir: {target}")
        break
else:
    # 没有 stickers 段：追加到 dsh-memory-es 段尾
    lines[stop:stop] = ['', '    stickers:', '      enabled: true', f'      dir: {target}']
    print('  补建 stickers 段')

open(path, 'w', encoding='utf-8').write('\n'.join(lines))
print('  stickers.dir → %s' % target)
PY
  then
    cp -p "$CONFIG_BAK" "$CONFIG"
    echo "贴图目录写入失败，已回滚到 $CONFIG_BAK" >&2
    exit 1
  fi
  echo "  贴图目录已切换"
  # 本机还没有这套图片时从仓库复制（幂等：已存在就不覆盖，避免冲掉用户改过的图）
  if [ ! -d "$TARGET_DIR" ]; then
    mkdir -p "$(dirname "$TARGET_DIR")"
    cp -a "$STICKER_PACK" "$TARGET_DIR"
    echo "  已复制贴图到 $TARGET_DIR（首次）"
  elif [ ! -f "$TARGET_DIR/stickers.json" ]; then
    cp -a "$STICKER_PACK/." "$TARGET_DIR/"
    echo "  目录存在但缺 stickers.json，已补齐"
  fi
fi

echo
echo "完成。本机配置监听会热生效，下一轮对话即换口吻。"
echo "回滚：cp '$CONFIG_BAK' '$CONFIG'"

if [ "$DEPLOY" = "1" ]; then
  echo
  echo "==> 分发到 125（需要 PACK_HOST / PACK_SSH_KEY）"
  bash "$ROOT/scripts/deploy-persona-pack.sh"
fi
