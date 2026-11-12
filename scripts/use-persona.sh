#!/usr/bin/env bash
# 人格切换：把 preset 写进本机 profile 配置的 persona.seed。
#
# 默认只改「本机实际生效」的那处（profile 配置），仓库 persona/seed.md 不动——
# 它是「新装默认」，属于发布动作，要一起改得显式加 --also-default。
# 三处生效位置见 persona/README.md。
#
# 用法：
#   scripts/use-persona.sh                      # 列出预设 + 当前本机生效的是哪份
#   scripts/use-persona.sh hutao                # 切换（自动备份 + YAML 片段校验）
#   scripts/use-persona.sh hutao --dry-run      # 只打印要做什么，不写任何文件
#   scripts/use-persona.sh hutao --also-default # 同时把仓库默认 seed.md 也换掉
#   scripts/use-persona.sh hutao --deploy       # 切换后顺便分发到 125（需 PACK_HOST）
#
# 环境变量：
#   PERSONA_CONFIG  覆盖 profile 配置路径（默认 ~/.dsh/profiles/web/cordis.patch.yml）
#
# 回滚：脚本会打印备份路径（.bak-<时间戳>），cp 回去即恢复。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRESET_DIR="$ROOT/persona/presets"
SEED_FILE="$ROOT/persona/seed.md"
CONFIG="${PERSONA_CONFIG:-$HOME/.dsh/profiles/web/cordis.patch.yml}"
DRY_RUN=0
DEPLOY=0

# 列出可用预设：文件名、字数、首行摘要
list_presets() {
  local current
  # 必须用 bash 重新调本脚本：直接 python3 "$0" 会让 python 去解释 bash 脚本
  current=$(bash "$0" --read-current "$CONFIG" 2>/dev/null || echo '')
  echo "可用预设（persona/）："
  local f
  for f in "$SEED_FILE" "$PRESET_DIR"/*.md; do
    [ -f "$f" ] || continue
    local name chars first mark
    name="$(basename "$f" .md)"
    chars=$(python3 -c 'import sys;print(len(open(sys.argv[1],encoding="utf-8").read().replace("\n","").replace(" ","")))' "$f")
    # 用 python 按「字符」截断：cut -c 会切坏 UTF-8 多字节，终端里变成乱码
    first=$(python3 -c 'import sys;print(open(sys.argv[1],encoding="utf-8").readline().strip()[:46])' "$f")
    mark=""
    [ "$name" = "seed" ] && name="seed(昔涟)"
    # 本机生效的那份：去掉所有空白后比对（配置里的块标量可能多/少空行，
    # 逐字节比会漏判；人格正文里空白不携带语义）
    if [ -n "$current" ] && [ "$(python3 -c '
import sys
def norm(s): return "".join(s.split())
print("1" if norm(open(sys.argv[1], encoding="utf-8").read()) == norm(sys.argv[2]) else "0")
' "$f" "$current")" = "1" ]; then
      mark="  ← 当前生效"
    fi
    printf '  %-14s %5s 字  %s%s\n' "$name" "$chars" "$first" "$mark"
  done
  echo
  if [ -n "$current" ]; then
    local tip
    tip=$(printf '%s' "$current" | python3 -c 'import sys;print(sys.stdin.readline().strip()[:46])')
    echo "当前本机生效（$CONFIG）：$tip…"
  else
    echo "当前本机生效：读不到配置里的 persona.seed（$CONFIG）"
  fi
  echo "切换：scripts/use-persona.sh <预设名>"
}

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
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

# 找预设：hutao → presets/hutao.md；xilian/seed → persona/seed.md
case "$NAME" in
  seed|xilian|昔涟) SRC="$SEED_FILE" ;;
  *) SRC="$PRESET_DIR/$NAME.md" ;;
esac
if [ ! -f "$SRC" ]; then
  echo "没有这个预设：$NAME" >&2
  echo "可选：$(ls "$PRESET_DIR" | sed 's/\.md$//' | tr '\n' ' ')(另加 seed)" >&2
  exit 2
fi

echo "==> 目标预设：$SRC（$(python3 -c 'import sys;print(len(open(sys.argv[1],encoding="utf-8").read().replace("\n","").replace(" ","")))' "$SRC") 字）"
echo "==> 本机配置：$CONFIG（默认只改这里，热生效）"
if [ "$ALSO_DEFAULT" = "1" ]; then
  echo "==> 仓库默认：$SEED_FILE（--also-default：一起换）"
fi

if [ "$DRY_RUN" = "1" ]; then
  echo
  echo "[dry-run] 将做的事："
  echo "  1. 备份配置 → $CONFIG.bak-<时间戳>"
  echo "  2. 替换其中 persona.seed 块（保持缩进与 |+ 语义）"
  echo "  3. 用 PyYAML 解析替换后的块，校验内容无损"
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

if [ "$ALSO_DEFAULT" = "1" ] && [ "$SRC" != "$SEED_FILE" ]; then
  cp -p "$SRC" "$SEED_FILE"
  echo "  仓库默认已更新：$SEED_FILE（--also-default）"
fi
echo
echo "完成。本机配置监听会热生效，下一轮对话即换口吻。"
echo "回滚：cp '$CONFIG_BAK' '$CONFIG'${SEED_BAK:+ && cp '$SEED_BAK' '$SEED_FILE'}"

if [ "$DEPLOY" = "1" ]; then
  echo
  echo "==> 分发到 125（需要 PACK_HOST / PACK_SSH_KEY）"
  bash "$ROOT/scripts/deploy-persona-pack.sh"
fi
