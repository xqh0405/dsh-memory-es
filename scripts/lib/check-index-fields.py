#!/usr/bin/env python3
"""个人索引 vs 团队索引的字段判定（被 scripts/diff-index-fields.sh 调用）。

判定依据是**团队库的两个写入方写了哪些字段**，写进去而 mapping 没有就 400：

  ① scripts/promote-team.ts 的 `doc` 对象（晋升时整篇写入）
  ② src/memory/search.ts 的 HIT_UPDATE_SCRIPT（**命中回写**，多行 painless 一起执行，
     `hit.origin === 'team'` 时打到团队索引）

② 是 2026-11-10 审查 P1/#17 补上的：原判据只有 ①，于是团队模板缺 `activation` 被
判成「个人有、团队无 → 代码不写团队库 → 属正常」——**判据漏了第二条链路**，
而新装机一命中就 strict_dynamic_mapping_exception → 该条 bulk 400 →
三行脚本原子回滚，hit_count / last_hit_at **一起丢**。

所以「个人有、团队无」本身不是问题（19.3 当初按对称思维列的 18 个该补字段，
2026-11-08 实测绝大多数代码根本不写团队库）；问题只在「代码写、mapping 没有」。
"""

import base64
import json
import os
import re
import ssl
import sys
import urllib.request


def fields_static(init_path: str) -> tuple[set[str], set[str]]:
    """从 init-indices.sh 的两段 JSON 模板取字段集。"""
    src = open(init_path, encoding="utf-8").read()
    parts = re.split(r"<<'JSON'\n", src)
    got: dict[str, set[str]] = {}
    for i, b in enumerate(parts[1:], start=1):
        body, sep, _ = b.partition("\nJSON")
        if not sep:
            continue
        head = parts[i - 1][-400:]
        try:
            doc = json.loads(body)
        except json.JSONDecodeError:
            continue
        props = (doc.get("template", {}).get("mappings", {}) or doc.get("mappings", {})).get("properties")
        if not props:
            continue
        if "personal_memory_template" in head:
            got["personal"] = set(props)
        elif "team_knowledge" in head:
            got["team"] = set(props)
    if "personal" not in got or "team" not in got:
        raise SystemExit(f"解析失败：只找到 {sorted(got)} 段模板（期望 personal + team）")
    return got["personal"], got["team"]


def fields_live(url: str, ca: str, es_user: str, personal_index: str) -> tuple[set[str], set[str]]:
    """从线上 _mapping 取字段集。

    账号与个人索引名**由调用方传**（2026-11-10 审查 M11/#19 去硬编码）：
    这里曾写死**一个固定账号 + 一个固定索引名**（都只对 xqh 那一套成立），换用户跑就 401
    或打到别人的索引，而 401 只会在报告里变成一行含糊的失败。
    （本 docstring 刻意不写出那两个字面量 —— tests/template-sync.test.ts 断言本文件
    不含它们，重写回硬编码会被那条测试抓红。）

    密码走**环境变量 `MEM_ES_PASS`，不进 argv**（2026-11-10 审查 M7/#27）：
    argv 会出现在 `/proc/<pid>/cmdline`（**全员可读**），而 `/proc/<pid>/environ`
    只有属主可读 —— 同仓库 `scripts/lib/curl-es.sh` 早就为 `curl -u` 立过这条规矩。
    """
    pw = os.environ.get('MEM_ES_PASS', '')
    if pw == '':
        print('live 模式需要环境变量 MEM_ES_PASS（密码不走 argv）', file=sys.stderr)
        raise SystemExit(2)
    ctx = ssl.create_default_context(cafile=ca)

    def get(path: str):
        req = urllib.request.Request(
            url + path,
            headers={"Authorization": "Basic " + base64.b64encode(f"{es_user}:{pw}".encode()).decode()},
        )
        return json.load(urllib.request.urlopen(req, context=ctx, timeout=15))

    def one(index: str) -> set[str]:
        m = get(f"/{index}/_mapping")
        return set(list(m.values())[0]["mappings"].get("properties", {}))

    return one(personal_index), one("team_knowledge")


def doc_keys_in_promoter(path: str) -> set[str]:
    """从 promote-team.ts 的 `const doc = {...}` 里取顶层键（含简写 key,）。"""
    try:
        src = open(path, encoding="utf-8").read()
    except OSError:
        return set()
    m = re.search(r"const doc = \{(.*?)\n\s{6}\}\n", src, re.S)
    if not m:
        return set()
    block = m.group(1)
    keys = set(re.findall(r"^\s+([a-z_]+):", block, re.M))
    keys |= set(re.findall(r"^\s+([a-z_]+),\s*$", block, re.M))
    return keys


def hit_writeback_fields(path: str) -> set[str]:
    """从 search.ts 的 HIT_UPDATE_SCRIPT 里取它写到 `_source` 上的字段。

    只截 HIT_UPDATE_SCRIPT 的定义块（到下一个 `export` 为止），不扫整份文件——
    否则将来别的 painless 脚本往**个人库**写字段时会被误判成团队必需。
    2026-11-10 审查 P1/#17 加：原判据只看 promote-team.ts，团队缺 activation
    因此被判成「代码不写团队库」，实际命中回写一直在往团队索引打。
    """
    try:
        src = open(path, encoding="utf-8").read()
    except OSError:
        return set()
    m = re.search(r"export const HIT_UPDATE_SCRIPT\s*=(.*?)(?=\nexport )", src, re.S)
    if not m:
        return set()
    return set(re.findall(r"ctx\._source\.(\w+)", m.group(1)))


def report(personal: set[str], team: set[str], required: list[str], promoter: str, search_path: str, mode: str) -> int:
    # 两个写入方合起来才是「团队必须有」的字段集：
    #   required      —— 脚本里手工同步的 promote-team.doc 字段
    #   writeback     —— 从 HIT_UPDATE_SCRIPT 现解析出来的命中回写字段
    writeback = hit_writeback_fields(search_path)
    need = set(required) | writeback

    missing = [f for f in required if f not in team] + sorted(writeback - set(required) - team)
    personal_only = sorted(personal - team - need)
    team_only = sorted(team - personal)
    drift_promoter = sorted(doc_keys_in_promoter(promoter) - set(required))
    drift_writeback = sorted(writeback - set(required))

    print(f"口径：{mode}")
    # need = required ∪ writeback，故 need-writeback（promote-team 提供）+ writeback（命中回写提供）
    # 恒等于 len(need)——两个来源没有重叠计数问题。
    print(f"  个人字段 {len(personal)} / 团队字段 {len(team)} / 团队必需 {len(need)}"
          f"（promote-team.doc {len(need - writeback)} + HIT_UPDATE_SCRIPT {len(writeback)}）")
    print()

    if missing:
        print(f"❌ 团队必需但 mapping 缺失 {len(missing)} 个（写这条就 400）：")
        print("   " + ", ".join(missing))
    else:
        print("✅ 团队必需字段齐全（promote-team.doc 与 HIT_UPDATE_SCRIPT 写的字段团队模板都有了）")

    if drift_promoter:
        print()
        print(f"⚠️  promote-team.ts 的 doc 里出现新键，REQUIRED 没跟上：{', '.join(drift_promoter)}")
        print("   改 scripts/diff-index-fields.sh 的 REQUIRED，并确认团队 mapping 也有这些字段")

    if drift_writeback:
        print()
        print(f"⚠️  HIT_UPDATE_SCRIPT 写了新字段，REQUIRED 没跟上：{', '.join(drift_writeback)}")
        print("   改 scripts/diff-index-fields.sh 的 REQUIRED —— 命中回写会打到团队索引，缺就 400")
        print(f"   （本次已按现解析结果计入必需集，团队 mapping 缺失会照常判失败；当前缺口："
              f"{', '.join(sorted(drift_writeback - team)) or '无'}）")

    if personal_only:
        print()
        print(f"ℹ️  个人有、团队无的 {len(personal_only)} 个（代码不写团队库，属正常）：")
        print("   " + ", ".join(personal_only))

    if team_only:
        print()
        print(f"ℹ️  团队独有 {len(team_only)} 个（团队自己的检索/审核字段，正常）：")
        print("   " + ", ".join(team_only))

    # drift 也要让 CI 变红（2026-11-10 审查 M11/#19）：原来只打警告、退出码只看 missing，
    # 于是「promote-team.doc 加了新字段而 REQUIRED 没跟上」时 CI 照样绿 ——
    # #17 那类缺口就是这么一路溜过去的。警告对人有信息量，但**不能是唯一的失败信号**。
    if drift_promoter or drift_writeback:
        print()
        print("❌ 判定失败：REQUIRED 与代码里的写入方不同步（drift 不再只是警告）")
        print("   同步 scripts/diff-index-fields.sh 的 REQUIRED 后本项才会变绿。")

    return 1 if (missing or drift_promoter or drift_writeback) else 0


def main() -> int:
    args = sys.argv[1:]
    if len(args) < 5:
        print("用法：check-index-fields.py <static|live> <required> <promoter> <search> <init|url> "
              "[ca user personal_index]\n"
              "      live 模式的密码走环境变量 MEM_ES_PASS（不进 argv）", file=sys.stderr)
        return 2
    mode, required_s, promoter, search_path = args[0], args[1], args[2], args[3]
    required = required_s.split()

    if mode == "live":
        # 注意**没有密码这个位置参数**：密码走 MEM_ES_PASS 环境变量（#27）。
        if len(args) < 8:
            print("live 模式要 8 个参数：… <url> <ca> <user> <personal_index>"
                  "（密码走 MEM_ES_PASS 环境变量，不进 argv）", file=sys.stderr)
            return 2
        url, ca, es_user, personal_index = args[4], args[5], args[6], args[7]
        personal, team = fields_live(url, ca, es_user, personal_index)
        label = f"线上 mapping（{url}，{es_user}@{personal_index}）"
    else:
        init = args[4]
        personal, team = fields_static(init)
        label = f"源码模板（{init}）"

    return report(personal, team, required, promoter, search_path, label)


if __name__ == "__main__":
    sys.exit(main())