#!/usr/bin/env bash
# 给远程 125 上的 dsh-* 容器装「人格内核 + 表情包」（方案 A）。
#
# 为什么不是 deploy-panel.sh：那个是给"完整记忆库 + 面板"用的。
# 这里的前提是容器**已经有** memory-es 配置与 ES 账号（各自 mem-user-<uid>），
# 所以只做三件事：更新主插件 lib、补 persona/stickers 段、拷表情包 —— 不装面板。
#
# 幂等：配置段已存在就跳过；lib 每次覆盖（本来就该覆盖）；贴图整目录替换。
# 用法：
#   ./scripts/deploy-persona-pack.sh dsh-test        # 先在一个容器验证
#   ./scripts/deploy-persona-pack.sh                 # 不给参数 = 除 dsh-xqh/dsh-es 外全部
#   PACK_HOST=root@host PACK_SSH_KEY=~/.ssh/key ./scripts/deploy-persona-pack.sh ...
set -euo pipefail

# 目标主机必填（仓库里不写真实内网地址）；留空走 ssh 默认配置的私钥
HOST="${PACK_HOST:?请用 PACK_HOST=user@host 指定目标主机}"
SSH_KEY="${PACK_SSH_KEY:-}"
# 三套贴图一起分发，但容器的 stickers.dir 指向哪套由 PACK_PERSONA 决定
PACK_PERSONA="${PACK_PERSONA:-xilian}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=no)
if [ -n "$SSH_KEY" ]; then SSH_OPTS=(-i "$SSH_KEY" "${SSH_OPTS[@]}"); fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "==> 打包主插件"
# 0.3.0 起插件与面板是一个包，cordis.patch.yml 里两条条目（主插件 + 面板宿主）：
# 只推 lib 会让第二条解析不到 dsh-memory-es/panel，容器启动就报「1 entry did not activate」，
# 所以 panel 必须一起带上（它只是几个 JS + locale，不增加依赖）。
tar -czf "$work/plugin.tgz" -C "$REPO_ROOT" lib panel persona package.json cordis.patch.yml

echo "==> 打包表情包（三套：xilian / hutao / dafeiyu）"
if [ -d "$REPO_ROOT/persona/stickers" ]; then
  # 打进 tar 的路径是 stickers/，远程解到 /data/dsh 即 /data/dsh/stickers/<name>/
  tar -czf "$work/stickers.tgz" -C "$REPO_ROOT/persona" stickers
else
  echo "  ! 仓库里没有 persona/stickers/，退回本机已装目录"
  tar -czf "$work/stickers.tgz" -C "$HOME/.dsh" stickers
fi

echo "==> 取人格内核（本机配置里的 seed 正文）"
python3 - "$work/seed.txt" <<'PY'
import os, re, sys
src = open(os.path.expanduser('~/.dsh/profiles/web/cordis.patch.yml')).read()
m = re.search(r'^      seed: [|>][+-]?\n((?:(?:        .*)?\n)+)', src, re.M)
if not m:
    sys.exit('本机配置里没有 persona.seed，先确认本机的人格内核')
out = '\n'.join(l[8:] if l.startswith('        ') else '' for l in m.group(1).rstrip('\n').split('\n'))
open(sys.argv[1], 'w').write(out)
print('  seed: %d 字，首行：%s' % (len(out.strip()), out.strip().split('\n')[0][:40]))
PY

scp -q "${SSH_OPTS[@]}" "$work/plugin.tgz" "$work/stickers.tgz" "$work/seed.txt" "$HOST:/tmp/"

ssh "${SSH_OPTS[@]}" "$HOST" "PACK_PERSONA='${PACK_PERSONA}' bash -s" -- "$@" <<'REMOTE'
set -euo pipefail
targets=("$@")
if [ ${#targets[@]} -eq 0 ]; then
  mapfile -t targets < <(docker ps --filter name=dsh- --format '{{.Names}}' \
    | grep -v -e '^dsh-es$' -e '^dsh-xqh$' | sort)
fi
echo "共 ${#targets[@]} 个容器：${targets[*]}"

for c in "${targets[@]}"; do
  echo "── $c"
  # 1) 主插件 lib：两份副本都要换（dsh 加载的是 profile/node_modules 那份）
  docker cp /tmp/plugin.tgz "$c":/tmp/plugin.tgz >/dev/null
  docker exec "$c" sh -c '
    set -e
    rm -rf /tmp/mem-plugin && mkdir -p /tmp/mem-plugin
    tar -xzf /tmp/plugin.tgz -C /tmp/mem-plugin
    for d in /data/dsh/local-plugins/dsh-memory-es /data/dsh/profiles/web/node_modules/dsh-memory-es; do
      [ -d "$d" ] || { echo "  跳过（不存在）: $d"; continue; }
      rm -rf "$d/lib"
      cp -a /tmp/mem-plugin/lib "$d/lib"
      # persona/ 是内置人格：容器里若删掉配置段就会回落到它，不同步等于回落旧口吻
      if [ -d /tmp/mem-plugin/persona ]; then
        rm -rf "$d/persona"
        cp -a /tmp/mem-plugin/persona "$d/persona"
      fi
      cp -f /tmp/mem-plugin/package.json "$d/package.json"
      chown -R node:node "$d"
    done
    rm -rf /tmp/plugin.tgz /tmp/mem-plugin
  '

  # 2) 配置：persona.seed **总是替换**、stickers 只补缺（不碰 es/identity）
  #
  # 为什么 seed 不能"已有就跳过"：人格内核会随版本更新，跳过等于把每个容器永远
  # 钉在第一次部署的那一版（2026-11-12 踩过：11 个容器全是旧口吻，脚本却报"跳过"）。
  docker exec "$c" cat /data/dsh/profiles/web/cordis.patch.yml > "/tmp/$c.yml"
  STICKER_DIR="/data/dsh/stickers/$PACK_PERSONA" python3 - "/tmp/$c.yml" <<'PY'
import os, re, sys
path = sys.argv[1]
seed = open('/tmp/seed.txt').read()
lines = open(path).read().split('\n')
start = next((i for i, l in enumerate(lines) if l.strip() == '- id: dsh-memory-es'), None)
if start is None:
    sys.exit('  ✗ 没有 dsh-memory-es 配置段，先手工配一次')
# 该条目范围的结束：下一个顶层 '- ' 行
stop = next((i for i in range(start + 1, len(lines)) if lines[i].startswith('- ')), len(lines))
body = '\n'.join(lines[start:stop])

# 字面块 |（保换行）；空行必须完全空，否则 YAML 会当成内容的一部分
seed_body = '\n'.join(('        ' + l) if l.strip() else '' for l in seed.rstrip('\n').split('\n'))
seed_block = '      seed: |\n' + seed_body + '\n'

changed = []
# ① seed 已存在 → 替换整块正文（吞掉 8 空格缩进行与空行，直到下一个 key）
m = re.search(r'^      seed: [|>][+-]?\n(?:        .*\n|\n)*', body, re.M)
if m:
    body = body[:m.start()] + seed_block + body[m.end():]
    changed.append('替换 seed')
elif re.search(r'^    persona:', body, re.M):
    # persona 段在但没写 seed（手改过）→ 紧跟 persona: 行插入
    body = re.sub(r'^(    persona:\n)', r'\1      enabled: true\n' + seed_block.replace('\\', r'\\'),
                  body, count=1, flags=re.M)
    changed.append('补 seed')
else:
    body = body.rstrip('\n') + '\n    persona:\n      enabled: true\n' + seed_block
    changed.append('加 persona 段')

# ② stickers 段不存在就补；存在则只改 dir（跟人格一起切），enabled/maxPerTurn 不动
target_dir = os.environ.get('STICKER_DIR', '/data/dsh/stickers/xilian')
if not re.search(r'^    stickers:', body, re.M):
    body = body.rstrip('\n') + '\n    stickers:\n      enabled: true\n      dir: ' + target_dir + '\n      maxPerTurn: 1\n'
    changed.append('补 stickers')
else:
    m = re.search(r'^(      dir: )\S+\s*$', body, re.M)
    if m and m.group(1):
        body = body[:m.start()] + '      dir: ' + target_dir + body[m.end():]
        changed.append('切 stickers.dir')

out = lines[:start] + body.split('\n') + lines[stop:]
open(path, 'w').write('\n'.join(out))
print('  ~ %s（seed %d 字）' % ('/'.join(changed) or '无需改动', len(seed.strip())))
PY

  docker exec "$c" cp /data/dsh/profiles/web/cordis.patch.yml \
    "/data/dsh/profiles/web/cordis.patch.yml.bak-pack-$(date +%Y%m%d%H%M%S)"
  docker cp "/tmp/$c.yml" "$c":/data/dsh/profiles/web/cordis.patch.yml >/dev/null
  docker exec "$c" sh -c 'chown node:node /data/dsh/profiles/web/cordis.patch.yml && chmod 600 /data/dsh/profiles/web/cordis.patch.yml'
  rm -f "/tmp/$c.yml"

  # 3) 表情包：只补缺，不覆盖容器里已有的（用户可能改过图、加过自己的贴图）
  docker cp /tmp/stickers.tgz "$c":/tmp/stickers.tgz >/dev/null
  docker exec "$c" sh -c '
    mkdir -p /data/dsh/stickers
    tar -xzf /tmp/stickers.tgz -C /data/dsh --skip-old-files
    rm -f /tmp/stickers.tgz
    chown -R node:node /data/dsh/stickers
    echo "  贴图 $(ls /data/dsh/stickers | wc -l) 个文件（只补缺，已有文件未动）"
  '

  # 4) 重启（lib 换了必须重启，进程持旧模块图）
  docker restart "$c" >/dev/null
  status=starting
  for _ in $(seq 1 20); do
    status="$(docker inspect "$c" --format '{{.State.Health.Status}}')"
    [ "$status" = healthy ] && break
    sleep 3
  done
  echo "  health=$status"
done

rm -f /tmp/plugin.tgz /tmp/stickers.tgz
echo "==> 完成"
REMOTE
