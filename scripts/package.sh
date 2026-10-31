#!/usr/bin/env bash
# 打一个「可以直接拿去更新」的发行包：
#   dist/dsh-memory-es-<version>.tar.gz
#
# 包内布局（目标机器上不需要仓库、不需要 npm、不需要构建）：
#   dsh-memory-es-<ver>/
#     VERSION / manifest.json / SHA256SUMS
#     install.sh              ← 一条命令装/更新（plugin + panel + CLI + 表情包）
#     README-INSTALL.md
#     plugin/                 ← 主插件（package.json + cordis.patch.yml + lib/）
#     panel/                  ← 面板（含 cli/ 源码，面板「整理/导出」按钮要用）
#     stickers/               ← 基础表情包（--no-stickers 可不打）
#
# 用法：
#   scripts/package.sh                 # 打包（要求 lib 不旧于源码；版本号两处一致）
#   scripts/package.sh --build         # 先 npm run build 再打包
#   scripts/package.sh --no-stickers   # 不打表情包（包体 ~7MB → ~250KB）
#   scripts/package.sh --out /tmp/x    # 指定输出目录
#
# 判据（打完自己看一眼）：`tar tzf dist/*.tar.gz | head` 有 plugin/lib/index.js；
# 版本号与 `scripts/version.sh check` 一致。
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

VERSION="$(bash scripts/version.sh check 2>/dev/null | sed 's/^版本一致：//')" || {
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
mkdir -p "$STAGE/plugin" "$STAGE/panel" "$STAGE/plugin/lib"

echo '==> 收集文件'
cp -a lib/. "$STAGE/plugin/lib/"
cp -f package.json cordis.patch.yml "$STAGE/plugin/"

cp -f panel/*.js panel/package.json panel/cordis.patch.yml "$STAGE/panel"/
# 注意：set -e 下不能写 `[ -f x ] && cp`——条件为假时整个列表返回非零会直接退出
if [ -f panel/icon.svg ]; then cp -f panel/icon.svg "$STAGE/panel"/; fi
if [ -d panel/locale ]; then cp -a panel/locale "$STAGE/panel"/; fi
# 面板的「整理 / 导出」按钮要跑 CLI：源码必须随面板包进去（与 deploy-panel.sh 同一布局）
mkdir -p "$STAGE/panel/cli"
cp -a consolidate src "$STAGE/panel/cli/"

if [ "$WITH_STICKERS" = "1" ] && [ -f stickers/stickers.json ]; then
  mkdir -p "$STAGE/stickers"
  cp -a stickers/. "$STAGE/stickers/"
fi

cp -f scripts/install-package.sh "$STAGE/install.sh"
chmod +x "$STAGE/install.sh"
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
  "node": "$(node -p 'process.version' 2>/dev/null || echo unknown)"
}
JSON

cat >"$STAGE/README-INSTALL.md" <<MD
# dsh-memory-es ${VERSION} 安装包

一条命令装/更新（本机或容器里都适用）：

\`\`\`bash
tar xzf ${NAME}.tar.gz
cd ${NAME}
./install.sh                     # 本机：DSH_HOME=~/.dsh，profile=web
# 容器里：./install.sh --dsh-home /data/dsh
\`\`\`

装完重启 dsh-web（本机：kill -TERM \$(systemctl show dsh-web -p MainPID --value)；
容器：docker restart <容器名>）。

核对版本（三处都该是 ${VERSION}）：
- 插件日志：\`ready: v${VERSION} …\`
- 面板自检：\`[记忆库面板] 自检通过 v${VERSION} …\`
- 面板页脚：\`版本 ${VERSION}\`

只装插件不装面板：\`./install.sh --no-stickers\` 仍会装面板；不想要表情包用 \`--no-stickers\`。
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
