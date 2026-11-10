#!/usr/bin/env bash
# dsh 用户实例清单的**唯一发现函数**（2026-11-10 审查 M2/#23）。
#
# 为什么单独抽出来：两个部署脚本各写各的清单，两种写法都错过——
#   · `deploy-all-panel.sh` 写死 10 个 → 2026-11-09 漏铺了新加的 dsh-zhaoguichun
#     （当天才发现「dsh-* 数量会变，不能沿用记忆里的名单」）；
#   · `deploy-all-containers.sh` 用 `docker ps` 现取，但**只排除 dsh-es** →
#     dsh-market 之类非实例容器会被当成部署目标捞进来。
#
# 「写死」与「只按前缀通配」是同一个坑的两面：前者漏新容器，后者捞进垃圾。
# 正确形态 = **现取 + denylist + 白名单差集校验**，三条都要：
#
#   1. 只认 `docker ps` 里**正在跑**的 —— 部署不该顺手把一个停了两天的容器拉起来；
#   2. 前缀 `dsh-` 再减去 DENYLIST（dsh-es 是 ES 本体、dsh-market 不是实例）；
#   3. 与 KNOWN_WHITELIST 做差集，**两个方向分别处理**：
#        · 白名单里有、现取结果里没有 → 打印并 **return 1**
#          （已知实例不在跑：少铺一个比多铺一个更难发现，绝不静默跳过）；
#        · 现取到白名单之外的 → 打印为「新容器，本次会覆盖」**不失败**
#          （否则新增一台就得先改脚本，验收要求「不改脚本也能覆盖」）。
#
# 用法（两个部署脚本都 source 本文件）：
#   source "$REPO_ROOT/scripts/lib/dsh-targets.sh"
#   mapfile -t TARGETS < <(dsh_targets "$HOST" "$KEY")   # 失败时函数已把原因写 stderr
#
# 只依赖 ssh/docker，不碰任何状态；纯读操作。

# 不是实例的容器（前缀是 dsh- 但不该被部署）
DSH_DENYLIST=(dsh-es dsh-market)

# 已知实例白名单：只用于**反向差集**（少了要报错），不用于正向过滤。
# 新增容器后这里补一行即可；不补也不会被漏掉（它仍会被现取到并部署）。
DSH_WHITELIST=(
  dsh-xqh dsh-chencan dsh-hongzhihui dsh-laoliu dsh-liuxinling
  dsh-molijin dsh-tanxu dsh-test dsh-zhaoguichun dsh-zhongjinqi dsh-zhongyuhang
)

# 打印「现取到的、要部署的」容器名（每行一个）；异常时返回非 0，原因写 stderr。
dsh_targets() {
  local host=$1
  local key=${2:-}
  shift 2 || true

  local ssh_opts=(-o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null)
  if [ -n "$key" ]; then ssh_opts=(-i "$key" "${ssh_opts[@]}"); fi

  local live
  if ! live=$(ssh "${ssh_opts[@]}" "$host" "docker ps --format '{{.Names}}'" 2>/dev/null); then
    echo "dsh_targets: 连不上 $host 取 docker ps 清单" >&2
    return 1
  fi

  local targets=() denied=() fresh=() missing=()
  local c d known i
  for c in $live; do
    case "$c" in dsh-*) ;; *) continue ;; esac
    known=0
    for d in "${DSH_DENYLIST[@]}"; do
      if [ "$c" = "$d" ]; then known=1; break; fi
    done
    if [ "$known" -eq 1 ]; then
      denied+=("$c")
      continue
    fi
    targets+=("$c")
    known=0
    for d in "${DSH_WHITELIST[@]}"; do
      if [ "$c" = "$d" ]; then known=1; break; fi
    done
    [ "$known" -eq 0 ] && fresh+=("$c")
  done

  # 反向差集：白名单里有、现取不到 → 这台已知实例不在跑，必须报错
  for d in "${DSH_WHITELIST[@]}"; do
    known=0
    for c in "${targets[@]}"; do
      if [ "$c" = "$d" ]; then known=1; break; fi
    done
    [ "$known" -eq 0 ] && missing+=("$d")
  done

  if [ "${#denied[@]}" -gt 0 ]; then
    echo "dsh_targets: 已排除非实例容器：${denied[*]}" >&2
  fi
  if [ "${#fresh[@]}" -gt 0 ]; then
    echo "dsh_targets: 发现新容器（不在白名单，本次会一并覆盖）：${fresh[*]}" >&2
    echo "dsh_targets: 建议顺手补进 scripts/lib/dsh-targets.sh 的 DSH_WHITELIST，下次缺了才能报警" >&2
  fi
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "dsh_targets: ✗ 白名单里的实例没有在跑：${missing[*]}" >&2
    echo "dsh_targets:   少铺一个比多铺一个更难发现 —— 先确认它是被停了还是被删了，不要静默跳过" >&2
    return 1
  fi
  if [ "${#targets[@]}" -eq 0 ]; then
    echo "dsh_targets: 没有找到任何要部署的 dsh 实例容器" >&2
    return 1
  fi

  printf '%s\n' "${targets[@]}"
}
