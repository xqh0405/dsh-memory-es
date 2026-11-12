#!/usr/bin/env bash
# 打一个「可以直接拿去更新」的发行包：
#   dist/dsh-memory-es-<version>.tar.gz
#
# 包内布局（目标机器上不需要仓库、不需要 npm、不需要构建）：
#   dsh-memory-es-<ver>/
#     VERSION / manifest.json / SHA256SUMS
#     install.sh              ← 一条命令装/更新（plugin + panel + CLI + 表情包）
#     selfcheck.sh            ← 装完自检（七项 PASS/FAIL；install.sh 自动跑）
#     README-INSTALL.md
#     plugin/                 ← 主插件（package.json + cordis.patch.yml + lib/）
#     panel/                  ← 面板（含 cli/ 源码，面板「整理/导出」按钮要用）
#     stickers/               ← 三套表情包（xilian/hutao/dafeiyu，--no-stickers 可不打）
#     es/                     ← ES 引导（评审 P0-3）：setup.sh + 自检 + compose 模板 + 引导脚本
#
# 用法：
#   scripts/package.sh                 # 打包（要求 lib 不旧于源码；版本号两处一致）
#   scripts/package.sh --build         # 先 npm run build 再打包
#   scripts/package.sh --no-stickers   # 不打表情包（包体 ~7MB → ~250KB）
#   scripts/package.sh --out /tmp/x    # 指定输出目录
#
# 判据（打完自己看一眼）：
#   `tar tzf dist/*.tar.gz | grep -cE 'es/setup.sh|es/selfcheck.sh|es/scripts/es-up.sh'` = 3
#   `tar tzf dist/*.tar.gz | grep plugin/lib/index.js` 非空；版本号与 `scripts/version.sh check` 一致。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist"
WITH_STICKERS=1
DO_BUILD=0

while [ $# -gt 0 ]; do
  case "$1" in
    --build) DO_BUILD=1; shift ;;
    --no-stickers) WITH_STICKERS=0; shift ;;
    --out) OUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

cd "$ROOT"

VERSION="$(bash scripts/version.sh check 2>/dev/null | sed 's/^版本：//')" || {
  echo '版本号不一致，先跑 scripts/version.sh bump patch 对齐' >&2
  exit 1
}
echo "==> 版本 v${VERSION}"

if [ "$DO_BUILD" = "1" ]; then
  echo '==> 构建 lib/'
  npm run build >/dev/null
fi

# lib 必须比源码新：否则包里是旧代码，而"包能装"会让这个问题更难发现
if [ ! -f lib/index.js ]; then
  echo 'lib/index.js 不存在：先 npm run build（或加 --build）' >&2
  exit 1
fi
stale=$(find src -newer lib/index.js -name '*.ts' -print -quit 2>/dev/null || true)
if [ -n "$stale" ]; then
  echo "!! lib/index.js 比源码旧（例如 ${stale}）——先 npm run build，或用 scripts/package.sh --build" >&2
  exit 1
fi

if [ -n "$(git status --porcelain 2>/dev/null | head -1)" ]; then
  echo '   注意：工作区有未提交改动，包里会包含它们（本地迭代用，发布前记得提交）'
fi

NAME="dsh-memory-es-${VERSION}"
STAGE="$OUT/$NAME"
rm -rf "$STAGE"
# 一个包：plugin/ 就是 dsh-memory-es 包本身（lib + panel + package.json + patch）
mkdir -p "$STAGE/plugin/lib"

echo '==> 收集文件'
cp -a lib/. "$STAGE/plugin/lib/"
cp -f package.json cordis.patch.yml "$STAGE/plugin/"
# 内置人格：插件默认值会读它（persona.seed 的 default），所以必须跟 lib 一起进包
if [ -d persona ]; then cp -a persona "$STAGE/plugin/persona"; fi

mkdir -p "$STAGE/plugin/panel"
cp -a panel/. "$STAGE/plugin/panel/"
# 面板的「整理 / 导出」按钮要跑 CLI：源码随包进去（panel/cli 仓库里不存副本，打包时生成）
mkdir -p "$STAGE/plugin/panel/cli"
cp -a consolidate src "$STAGE/plugin/panel/cli/"

if [ "$WITH_STICKERS" = "1" ] && [ -d persona/stickers/xilian ]; then
  mkdir -p "$STAGE/stickers"
  cp -a persona/stickers/. "$STAGE/stickers/"
fi

cp -f scripts/install-package.sh "$STAGE/install.sh"
chmod +x "$STAGE/install.sh"

# ES 引导（评审 P0-3 / M1）：以前包里 0 个引导脚本，新用户装完只会得到一个连不上库的插件。
# 目录结构刻意保留仓库的相对布局（scripts/ 与 deploy/es/ 同级），这样脚本里的
# ROOT="$(dirname)/.." 在包里同样成立，不需要为发行版改一遍路径。
mkdir -p "$STAGE/es/scripts/lib" "$STAGE/es/deploy/es"
cp -f deploy/es/docker-compose.yml deploy/es/.env.example "$STAGE/es/deploy/es/"
for s in es-up es-certs es-down fetch-ik init-indices init-security init-user es-setup selfcheck; do
  cp -f "scripts/$s.sh" "$STAGE/es/scripts/$s.sh"
done
cp -f scripts/lib/curl-es.sh "$STAGE/es/scripts/lib/"
# 入口放两个常见位置：es/setup.sh（引导）与顶层 selfcheck.sh（装完自检/排障）
cp -f scripts/es-setup.sh "$STAGE/es/setup.sh"
cp -f scripts/selfcheck.sh "$STAGE/es/selfcheck.sh"
cp -f scripts/selfcheck.sh "$STAGE/selfcheck.sh"
chmod +x "$STAGE/es/setup.sh" "$STAGE/es/selfcheck.sh" "$STAGE/selfcheck.sh" "$STAGE/es/scripts/"*.sh
printf '%s\n' "$VERSION" >"$STAGE/VERSION"

# 清单：部署后核对"这一包是什么时候、从哪个 commit 打的"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BUILT_AT="$(date -Iseconds)"
FILES=$(find "$STAGE" -type f | wc -l | tr -d ' ')
cat >"$STAGE/manifest.json" <<JSON
{
  "name": "dsh-memory-es",
  "version": "${VERSION}",
  "commit": "${COMMIT}",
  "builtAt": "${BUILT_AT}",
  "files": ${FILES},
  "withStickers": $([ "$WITH_STICKERS" = "1" ] && echo true || echo false),
  "withEs": true,
  "node": "$(node -p 'process.version' 2>/dev/null || echo unknown)"
}
JSON

cat >"$STAGE/README-INSTALL.md" <<MD
# dsh-memory-es ${VERSION} 安装包

## 前置清单（先看一眼，能省掉 90% 的「装完不能用」）

| 需要 | 为什么 | 没有会怎样 |
|---|---|---|
| Linux + Docker（含 \`docker compose\` v2） | 本包自带 ES 引导，用容器起 8.19 | \`./es/setup.sh\` 会直接告诉缺哪个命令 |
| 内存 ≥ 4 GB（ES heap 2g + Ollama ~1.2g） | ES 单节点 + 中文向量模型 | \`mem_limit 6g\` 起不来，日志报 OOMKilled |
| 出网（仅首次） | 拉 ES 镜像 + IK 分词插件（release.infinilabs.com） | 可手动放 \`es/deploy/es/plugins/analysis-ik\` 后重跑 |
| Ollama + \`bge-m3\`（1024 维） | 向量检索；没有它只剩 BM25 | 自检 05 会 FAIL，功能降级但可用 |
| Node.js ≥ 22 + dsh | 插件本身 | \`install.sh\` 装不了 |
| 一个 ES 账号目录 | 一人一索引 ACL | \`es/setup.sh --user <uid>\` 会建 |

## 装（插件 + 面板，单包，一条命令）

\`\`\`bash
tar xzf ${NAME}.tar.gz
cd ${NAME}
./install.sh                     # 本机：DSH_HOME=~/.dsh，profile=web
# 容器里：./install.sh --dsh-home /data/dsh --owner node
\`\`\`

## 开箱（第一次装才需要：起 ES + 建账号 + 出配置）

\`\`\`bash
./es/setup.sh                    # 用户默认取当前登录名；也可以 --user <uid> --tier team-write
\`\`\`

它会：起 ES（生成随机密码与自签证书、下载 IK）→ 建索引模板与共享索引 →
建角色/账号 → 生成 \`<ES 目录>/plugin-config.yml\`（含密码，600）。

把那段配置合并进 \`\$DSH_HOME/profiles/<profile>/cordis.patch.yml\`（与其它 \`- id:\` 同级），
然后重启 dsh web。**已经有 ES 的**别跑 setup，直接写配置（\`es.caCertPath\` 可以留空，
会自动找 \`\$DSH_HOME/memory-es/es/certs/ca.crt\`）。

## 装完自检（install.sh 会自动跑一遍）

\`\`\`bash
./selfcheck.sh                            # 七项 PASS/FAIL
./selfcheck.sh --profile web-test         # 装到别的 profile
./selfcheck.sh --es-dir /srv/dsh-es       # ES 在别处
\`\`\`

七项：ES 连通（含 CA 校验）/ 本用户账号 / 索引齐不齐 / 团队库 ACL / embedding 模型与维度 /
插件与 bundles 加载清单 / 插件配置（identity 与 CA）。有 FAIL 就按它给的「下一步」修。

从旧版（面板是独立包）升级时，\`install.sh\` 会自动移除 \`dsh-memory-es-panel\` 并从
\`dsh.profile.bundles\` 删掉旧名，否则会出现两个「记忆库」面板。

装完重启 dsh-web（本机：kill -TERM \$(systemctl show dsh-web -p MainPID --value)；
容器：docker restart <容器名>）。

核对版本（三处都该是 ${VERSION}）：
- 插件日志：\`ready: v${VERSION} …\`
- 面板自检：\`[记忆库面板] 自检通过 v${VERSION} …\`
- 面板页脚：\`版本 ${VERSION}\`

不想要表情包用 \`--no-stickers\`；不想装完跑自检用 \`--skip-selfcheck\`（插件与面板仍会装）。
MD

echo '==> 生成校验和'
( cd "$STAGE" && find . -type f ! -name SHA256SUMS -exec sha256sum {} \; | sort -k2 > SHA256SUMS )

echo '==> 打包'
( cd "$OUT" && tar -czf "$NAME.tar.gz" "$NAME" && sha256sum "$NAME.tar.gz" >"$NAME.tar.gz.sha256" )

SIZE="$(du -h "$OUT/$NAME.tar.gz" | cut -f1)"
echo
echo "完成：$OUT/$NAME.tar.gz（${SIZE}，${FILES} 个文件）"
echo "校验：$OUT/$NAME.tar.gz.sha256"
echo "用法：tar xzf $NAME.tar.gz && cd $NAME && ./install.sh"
