#!/usr/bin/env bash
# 让 ES 容器接入每个 DSH 容器的 docker 网络，并补齐各容器里的 CA 证书。
#
# 为什么需要这个脚本：
#   · 容器里插件配置的是 https://dsh-es:9200（容器名），要解析这个名字、要连通，
#     双方必须在同一个 docker 网络里；ES 只在自己的 dsh-es_default 里，必须被接进
#     每个成员容器的 <容器名>_default。
#   · `docker network connect` 是**运行时状态**，不写进 compose：ES 容器一旦
#     `docker-compose up -d` 重建，这些连接全丢，症状是插件报
#     `getaddrinfo EAI_AGAIN dsh-es`（看起来像 DNS 坏了，其实是网络没接）。
#   · 容器里的 CA（/home/node/ca-memory-es.crt）也是各人 home 卷里的文件，
#     新建容器/换卷时不会自动出现，缺了报 ENOENT，同样表现为「ES 不可达」。
#
# 幂等：已接入的网络、已存在的 CA 都会跳过，可以反复跑。
#
# 用法（在 125 宿主上以 root 跑）：
#   bash scripts/es-attach-networks.sh
#   ES_CONTAINER=dsh-es DSH_PREFIX=dsh- bash scripts/es-attach-networks.sh
set -euo pipefail

ES_CONTAINER="${ES_CONTAINER:-dsh-es}"
DSH_PREFIX="${DSH_PREFIX:-dsh-}"
# 宿主上 ES 的 CA 源文件；容器里插件配置的落点
ES_CA_SRC="${ES_CA_SRC:-/docker/dsh-es/certs/ca.crt}"
CA_IN_CONTAINER="${CA_IN_CONTAINER:-/home/node/ca-memory-es.crt}"

nets_of() {
  docker inspect "$1" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
}

[ -f "$ES_CA_SRC" ] || { echo "找不到 ES 的 CA：$ES_CA_SRC" >&2; exit 1; }
docker inspect "$ES_CONTAINER" >/dev/null 2>&1 || { echo "找不到容器 $ES_CONTAINER" >&2; exit 1; }

echo "== 1/2 把 $ES_CONTAINER 接入各 DSH 容器的网络 =="
es_nets="$(nets_of "$ES_CONTAINER")"
for c in $(docker ps --format '{{.Names}}' | grep "^${DSH_PREFIX}" | grep -vx "$ES_CONTAINER"); do
  for net in $(nets_of "$c"); do
    if echo " $es_nets " | grep -qw "$net"; then
      echo "  [skip]    $net（$c 已在同一网络）"
    else
      docker network connect "$net" "$ES_CONTAINER"
      es_nets="$es_nets $net"
      echo "  [connect] $ES_CONTAINER → $net（供 $c 解析 dsh-es）"
    fi
  done
done

echo "== 2/2 补齐各容器里的 CA =="
for c in $(docker ps --format '{{.Names}}' | grep "^${DSH_PREFIX}" | grep -vx "$ES_CONTAINER"); do
  # 只有配置里真的引用了这个 CA 路径的容器才需要
  if ! docker exec "$c" sh -c "ls /data/dsh/profiles/*/cordis.patch.yml 2>/dev/null | xargs -r grep -lqs 'ca-memory-es.crt'" 2>/dev/null; then
    echo "  [n/a]     $c（配置未引用 ca-memory-es.crt）"
    continue
  fi
  if docker exec "$c" test -f "$CA_IN_CONTAINER" 2>/dev/null; then
    echo "  [skip]    $c:$CA_IN_CONTAINER 已存在"
    continue
  fi
  docker cp "$ES_CA_SRC" "$c:$CA_IN_CONTAINER"
  # dsh 以 node 用户跑，证书必须它可读
  docker exec "$c" chown node:node "$CA_IN_CONTAINER" 2>/dev/null || true
  echo "  [copy]    $c:$CA_IN_CONTAINER ← $ES_CA_SRC"
done

echo
echo "完成。验证某个容器："
echo "  docker exec <容器> node -e \"require('dns').lookup('dsh-es',(e,a)=>console.log(e?e.code:a))\""
