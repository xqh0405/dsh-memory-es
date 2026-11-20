#!/usr/bin/env bash
# 把本地改动**压成一条 commit** 推到公开仓库（默认 github）。
#
# 为什么需要它（2026-11-20 用户定的规矩）：
#  · 公开仓库只留「一版一条」记录：每条 message 说清「这一版更新了什么」；
#  · 开发过程的细碎提交（调试、返工、内部主机信息）只留在 origin（自建 Gitea）；
#  · 默认脱敏：message 与新增内容里不许出现内网地址、主机编号、账号令牌、私有域名。
#
# 做法：以 $REMOTE/$BRANCH 的当前 tip 为父，用本地工作树建一个 **squash commit**，
# 再 fast-forward 推送。不改写公开仓库既有历史（不 force、不 amend）。
#
# 用法：
#   scripts/push-github.sh --dry-run -m "0.7.6：<这一版改了什么>"     # 只检查与打印，不推送
#   scripts/push-github.sh -m "0.7.6：<这一版改了什么>"                # 真推
#   scripts/push-github.sh -m "..." --tag v0.7.6                      # 同时推这个 tag
#
# 退出码：0 成功；1 前置条件不满足；2 脱敏命中（阻断）；3 没有可推的变更
set -uo pipefail
cd "$(dirname "$0")/.."

REMOTE="${REMOTE:-github}"
BRANCH="${BRANCH:-main}"
DRY_RUN=0
MESSAGE=""
TAG=""

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    -m|--message) MESSAGE="${2:-}"; shift 2 ;;
    --tag) TAG="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) echo "未知参数：$1" >&2; usage ;;
  esac
done

[ -n "$MESSAGE" ] || { echo '必须用 -m 给出这一版的说明（会自动附上本地 commit 清单）' >&2; exit 1; }

# ── 1. 前置条件 ────────────────────────────────────────────────
git remote get-url "$REMOTE" >/dev/null 2>&1 || { echo "没有远端 $REMOTE" >&2; exit 1; }
git fetch --quiet "$REMOTE" "$BRANCH" 2>/dev/null || true

PARENT=$(git rev-parse "$REMOTE/$BRANCH" 2>/dev/null) || { echo "拿不到 $REMOTE/$BRANCH" >&2; exit 1; }

if [ -n "$(git status --porcelain)" ]; then
  echo "工作区有未提交改动——先提交到 origin 再来（squash 用的是已提交的内容）：" >&2
  git status --short | head -10 >&2
  exit 1
fi

# squash 模式下 $REMOTE/$BRANCH 是一条**独立线**（每次推送都是新 commit，本地不跟进），
# 所以它通常不在本地 HEAD 的历史里——这是正常状态，不是分叉。这里只做提示。
if ! git merge-base --is-ancestor "$PARENT" HEAD; then
  echo "提示：$REMOTE/$BRANCH 是独立的一条线（squash 模式），本次会用本地 HEAD 的内容建新的一条" >&2
  echo "      如需保留远端最新内容，请先人工核对（本脚本不做 force，也不找回旧内容）" >&2
fi

if [ "$(git rev-parse HEAD^{tree})" = "$(git rev-parse "$PARENT^{tree}")" ]; then
  echo "两边内容一致，没有可推的变更" >&2
  exit 3
fi

# ── 2. 脱敏扫描 ────────────────────────────────────────────────
# 只看「要推上去的新增行」，排除体积大且无信息量的产物与本地状态目录。
DIFF=$(git diff --unified=0 "$PARENT"..HEAD -- . \
  ':(exclude)dist' ':(exclude).state' ':(exclude).npm-cache-tmp' \
  ':(exclude)package-lock.json' ':(exclude)scripts/push-github.sh' 2>/dev/null || true)
# 排除本脚本自身：它就是脱敏规则的载体，必然含有这些模式字面量。
ADDED=$(printf '%s\n' "$DIFF" | grep -E '^\+' | grep -vE '^\+\+\+' || true)

# 阻断级：真实凭据与内网地址，出现就停
BLOCK_RE='(_authToken=|BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|(192\.168|10\.|172\.(1[6-9]|2[0-9]|3[01]))\.[0-9]+\.[0-9]+)'
# 警告级：内部标识（容器名、私有域名、业务项目名）**不写死在脚本里**——那本身就是泄露。
# 从本地词表读，一行一个，词表在 .gitignore 的 .state/ 下，不入库。
WARN_FILE="${WARN_WORDS_FILE:-.state/redact-words.txt}"
warn_hit() {
  # $1 = 待检文本；命中词表则输出「行号:该行」，无词表时什么都不命中
  [ -f "$WARN_FILE" ] && printf '%s\n' "$1" | grep -nF -f "$WARN_FILE" || true
}

BLOCK_HITS=$(printf '%s\n' "$ADDED" | grep -nE "$BLOCK_RE" || true)
if [ -n "$BLOCK_HITS" ]; then
  echo "脱敏扫描命中**阻断级**内容，已拒绝推送：" >&2
  printf '%s\n' "$BLOCK_HITS" | head -10 >&2
  echo "处理掉这些行（或改用环境变量/占位符）再重跑" >&2
  exit 2
fi

WARN_HITS=$(warn_hit "$ADDED")
if [ -n "$WARN_HITS" ]; then
  echo "脱敏扫描有**警告级**命中（人工确认是否可公开）：" >&2
  printf '%s\n' "$WARN_HITS" | head -10 >&2
  echo
fi

# ── 3. 组装 squash commit 的正文 ───────────────────────────────
# 正文自动附上「本地这一段的 commit 标题」，但逐条再过一遍脱敏：命中的不写进去。
BODY=""
while IFS= read -r line; do
  [ -n "$line" ] || continue
  if printf '%s' "$line" | grep -qE "$BLOCK_RE" || [ -n "$(warn_hit "$line")" ]; then
    BODY="${BODY}- （一条含内部信息的修改变更，已脱敏略去）"$'\n'
  else
    BODY="${BODY}- ${line}"$'\n'
  fi
done < <(git log --no-merges --pretty='%s' "$PARENT"..HEAD)

FULL_MESSAGE="${MESSAGE}"$'\n\n'"本次包含："$'\n'"${BODY}"

echo "== 将要推送到 $REMOTE/$BRANCH 的一条记录 =="
printf '%s\n' "$FULL_MESSAGE"
echo "== 变更规模 =="
git diff --shortstat "$PARENT"..HEAD
echo

# ── 4. 生成 squash commit 并推送 ───────────────────────────────
TREE=$(git rev-parse HEAD^{tree})
NEW=$(git commit-tree "$TREE" -p "$PARENT" -m "$FULL_MESSAGE")
echo "squash commit: $NEW"

if [ "$DRY_RUN" = "1" ]; then
  echo "== --dry-run：不推送。真推用：git push $REMOTE $NEW:$BRANCH =="
  exit 0
fi

git push "$REMOTE" "$NEW:refs/heads/$BRANCH"

if [ -n "$TAG" ]; then
  # tag 指向 squash commit，公开侧看到的 release 对应同一条记录
  git tag -f "$TAG" "$NEW" >/dev/null 2>&1
  git push "$REMOTE" "refs/tags/$TAG"
  echo "已推送 tag $TAG → $NEW"
fi

echo
echo "完成。本地分支没动（origin 的历史保持不变），公开仓库现在是："
git log --oneline -3 "$REMOTE/$BRANCH" 2>/dev/null || true
