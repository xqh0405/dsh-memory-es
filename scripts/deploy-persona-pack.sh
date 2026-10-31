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
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=no)
if [ -n "$SSH_KEY" ]; then SSH_OPTS=(-i "$SSH_KEY" "${SSH_OPTS[@]}"); fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "==> 打包主插件"
tar -czf "$work/plugin.tgz" -C "$REPO_ROOT" lib package.json cordis.patch.yml

echo "==> 打包表情包"
if [ -d "$REPO_ROOT/stickers" ]; then
  tar -czf "$work/stickers.tgz" -C "$REPO_ROOT" stickers
else
  echo "  ! 仓库里没有 stickers/，退回本机 ~/.dsh/stickers"
  tar -czf "$work/stickers.tgz" -C "$HOME/.dsh" stickers
fi

echo "==> 取人格内核（本机配置里的 seed 正文）"
python3 - "$work/seed.txt" <<'PY'
import os, re, sys
src = open(os.path.expanduser('~/.dsh/profiles/web/cordis.patch.yml')).read()
m = re.search(r'^      seed: [|>]\n((?:(?:        .*)?\n)+)', src, re.M)
if not m:
    sys.exit('本机配置里没有 persona.seed，先确认本机的人格内核')
out = '\n'.join(l[8:] if l.startswith('        ') else '' for l in m.group(1).rstrip('\n').split('\n'))
open(sys.argv[1], 'w').write(out)
print('  seed: %d 字，首行：%s' % (len(out.strip()), out.strip().split('\n')[0][:40]))
PY

scp -q "${SSH_OPTS[@]}" "$work/plugin.tgz" "$work/stickers.tgz" "$work/seed.txt" "$HOST:/tmp/"

ssh "${SSH_OPTS[@]}" "$HOST" bash -s -- "$@" <<'REMOTE'
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
      cp -f /tmp/mem-plugin/package.json "$d/package.json"
      chown -R node:node "$d"
    done
    rm -rf /tmp/plugin.tgz /tmp/mem-plugin
  '

  # 2) 配置：补 persona/stickers（已有就跳过，不碰 es/identity）
  docker exec "$c" cat /data/dsh/profiles/web/cordis.patch.yml > "/tmp/$c.yml"
  python3 - "/tmp/$c.yml" <<'PY'
import re, sys
path = sys.argv[1]
seed = open('/tmp/seed.txt').read()
lines = open(path).read().split('\n')
start = next((i for i, l in enumerate(lines) if l.strip() == '- id: dsh-memory-es'), None)
if start is None:
    sys.exit('  ✗ 没有 dsh-memory-es 配置段，先手工配一次')
# 该条目范围的结束：下一个顶层 '- ' 行
stop = next((i for i in range(start + 1, len(lines)) if lines[i].startswith('- ')), len(lines))
body = '\n'.join(lines[start:stop])
if re.search(r'^    persona:', body, re.M) and re.search(r'^    stickers:', body, re.M):
    print('  = persona/stickers 已存在，跳过')
    sys.exit(0)
# 插到该条目末尾（最后一个非空行之后）
insert_at = stop
while insert_at > start and lines[insert_at - 1].strip() == '':
    insert_at -= 1
block = []
if not re.search(r'^    persona:', body, re.M):
    block += ['    persona:', '      enabled: true', '      seed: |']
    block += [('        ' + l) if l.strip() else '' for l in seed.rstrip('\n').split('\n')]
if not re.search(r'^    stickers:', body, re.M):
    block += ['    stickers:', '      enabled: true', '      dir: /data/dsh/stickers', '      maxPerTurn: 1']
lines[insert_at:insert_at] = block
open(path, 'w').write('\n'.join(lines))
print('  + 已补 persona/stickers')
PY

  docker exec "$c" cp /data/dsh/profiles/web/cordis.patch.yml \
    "/data/dsh/profiles/web/cordis.patch.yml.bak-pack-$(date +%Y%m%d%H%M%S)"
  docker cp "/tmp/$c.yml" "$c":/data/dsh/profiles/web/cordis.patch.yml >/dev/null
  docker exec "$c" sh -c 'chown node:node /data/dsh/profiles/web/cordis.patch.yml && chmod 600 /data/dsh/profiles/web/cordis.patch.yml'
  rm -f "/tmp/$c.yml"

  # 3) 表情包
  docker cp /tmp/stickers.tgz "$c":/tmp/stickers.tgz >/dev/null
  docker exec "$c" sh -c '
    rm -rf /data/dsh/stickers && mkdir -p /data/dsh/stickers
    tar -xzf /tmp/stickers.tgz -C /data/dsh
    rm -f /tmp/stickers.tgz
    chown -R node:node /data/dsh/stickers
    echo "  贴图 $(ls /data/dsh/stickers | wc -l) 个文件"
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
