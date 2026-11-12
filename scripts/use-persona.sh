#!/usr/bin/env bash
# 人格切换：把 preset 写进本机 profile 配置的 persona.seed，并连带把 stickers.dir
# 指到同名的那套表情包（persona/stickers/<name>/）。
#
# 默认只改「本机实际生效」的那处（profile 配置），仓库 persona/seed.md 不动——
# 它是「新装默认」，属于发布动作，要一起改得显式加 --also-default。
# 三处生效位置见 persona/README.md。
#
# 用法：
#   scripts/use-persona.sh                      # 列出预设与贴图，标出当前生效的
#   scripts/use-persona.sh hutao                # 人格 + 贴图一起切
#   scripts/use-persona.sh hutao --seed-only    # 只换人格，贴图不动
#   scripts/use-persona.sh hutao --stickers-only# 只换贴图，人格不动
#   scripts/use-persona.sh hutao --dry-run      # 只打印要做什么，不写任何文件
#   scripts/use-persona.sh hutao --also-default # 同时把仓库默认 seed.md 也换掉
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
SEED_FILE="$ROOT/persona/seed.md"
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
    chars=$(python3 -c 'import sys;print(len(open(sys.argv[1],encoding="utf-8").read().replace("\n","").replace(" ","")))' "$f")
    # 用 python 按「字符」截断：cut -c 会切坏 UTF-8 多字节，终端里变成乱码
    first=$(python3 -c 'import sys;print(open(sys.argv[1],encoding="utf-8").readline().strip()[:46])' "$f")
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
    tip=$(printf '%s' "$current" | python3 -c 'import sys;print(sys.stdin.readline().strip()[:46])')
    echo "当前本机生效（$CONFIG）：$tip…"
  else
    echo "当前本机生效：读不到配置里的 persona.seed（$CONFIG）"
  fi
  # 仓库默认是发布用的「实例」：显示它现在等于哪份预设，避免只看文件分不清
  local defaultTip defaultMatch
  defaultTip=$(python3 -c 'import sys;print(open(sys.argv[1],encoding="utf-8").readline().strip()[:46])' "$SEED_FILE")
  defaultMatch=""
  for f in "$PRESET_DIR"/*.md; do
    [ -f "$f" ] || continue
    if cmp -s "$f" "$SEED_FILE"; then
      defaultMatch=" = $(basename "$f" .md)"
      break
    fi
  done
  echo "仓库默认（persona/seed.md）：$defaultTip…${defaultMatch}"
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
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --also-default) ALSO_DEFAULT=1 ;;
    --deploy) DEPLOY=1 ;;
    --seed-only) SEED_ONLY=1 ;;
    --stickers-only) STICKERS_ONLY=1 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done
if [ "$SEED_ONLY" = "1" ] && [ "$STICKERS_ONLY" = "1" ]; then
  echo "--seed-only 与 --stickers-only 只能选一个" >&2; exit 2
fi

# 找预设：hutao → presets/hutao.md；xilian/seed → persona/seed.md
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

echo "==> 目标预设：$SRC（$(python3 -c 'import sys;print(len(open(sys.argv[1],encoding="utf-8").read().replace("\n","").replace(" ","")))' "$SRC") 字）"
echo "==> 本机配置：$CONFIG（默认只改这里，热生效）"
if [ "$ALSO_DEFAULT" = "1" ]; then
  echo "==> 仓库默认：$SEED_FILE（--also-default：一起换）"
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
  [ "$ALSO_DEFAULT" = "1" ] && echo "  4. 同时覆盖仓库默认 $SEED_FILE（--also-default）"
  [ "$DEPLOY" = "1" ] && echo "  5. 分发到 125（PACK_HOST / PACK_SSH_KEY）"
  exit 0
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
CONFIG_BAK="$CONFIG.bak-$STAMP"
cp -p "$CONFIG" "$CONFIG_BAK"
echo "  备份配置：$CONFIG_BAK"

SEED_BAK=""
if [ "$ALSO_DEFAULT" = "1" ]; then
  SEED_BAK="$SEED_FILE.bak-$STAMP"
  cp -p "$SEED_FILE" "$SEED_BAK"
  echo "  备份仓库默认：$SEED_BAK"
fi

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

if [ "$ALSO_DEFAULT" = "1" ]; then
  if cmp -s "$SRC" "$SEED_FILE"; then
    echo "  仓库默认已与目标一致，跳过复制"
  else
    cp -p "$SRC" "$SEED_FILE"
    echo "  仓库默认已更新：$SEED_FILE（--also-default）"
  fi
fi
echo
echo "完成。本机配置监听会热生效，下一轮对话即换口吻。"
echo "回滚：cp '$CONFIG_BAK' '$CONFIG'${SEED_BAK:+ && cp '$SEED_BAK' '$SEED_FILE'}"

if [ "$DEPLOY" = "1" ]; then
  echo
  echo "==> 分发到 125（需要 PACK_HOST / PACK_SSH_KEY）"
  bash "$ROOT/scripts/deploy-persona-pack.sh"
fi
