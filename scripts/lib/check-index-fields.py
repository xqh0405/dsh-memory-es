#!/usr/bin/env python3
"""个人索引 vs 团队索引的字段判定（被 scripts/diff-index-fields.sh 调用）。

判定依据只有一个：**scripts/promote-team.ts 的 `doc` 对象写哪些字段**。
那里的字段团队 mapping 缺一个，晋升就 400；不写团队的字段，团队库不需要。

所以「个人有、团队无」本身不是问题——19.3 当初按「个人有什么团队就该有什么」
的对称思维列了 18 个该补字段，2026-11-08 实测发现其中绝大多数代码根本不写团队库。
"""

import base64
import json
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


def fields_live(url: str, ca: str, pw: str) -> tuple[set[str], set[str]]:
    """从线上 _mapping 取字段集。"""
    ctx = ssl.create_default_context(cafile=ca)

    def get(path: str):
        req = urllib.request.Request(
            url + path,
            headers={"Authorization": "Basic " + base64.b64encode(f"mem-user-xqh:{pw}".encode()).decode()},
        )
        return json.load(urllib.request.urlopen(req, context=ctx, timeout=15))

    def one(index: str) -> set[str]:
        m = get(f"/{index}/_mapping")
        return set(list(m.values())[0]["mappings"].get("properties", {}))

    return one("personal_memory_xqh"), one("team_knowledge")


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


def report(personal: set[str], team: set[str], required: list[str], promoter: str, mode: str) -> int:
    missing = [f for f in required if f not in team]
    personal_only = sorted(personal - team - set(required))
    team_only = sorted(team - personal)
    drift = sorted(doc_keys_in_promoter(promoter) - set(required))

    print(f"口径：{mode}")
    print(f"  个人字段 {len(personal)} / 团队字段 {len(team)} / 晋升必需 {len(required)}")
    print()

    if missing:
        print(f"❌ 晋升必需但团队缺失 {len(missing)} 个（写这条就 400）：")
        print("   " + ", ".join(missing))
    else:
        print("✅ 晋升必需字段齐全（promote-team.ts 写的字段团队模板都有了）")

    if drift:
        print()
        print(f"⚠️  promote-team.ts 的 doc 里出现新键，本脚本的 REQUIRED 没跟上：{', '.join(drift)}")
        print("   改 scripts/diff-index-fields.sh 的 REQUIRED，并确认团队 mapping 也有这些字段")

    if personal_only:
        print()
        print(f"ℹ️  个人有、团队无的 {len(personal_only)} 个（代码不写团队库，属正常）：")
        print("   " + ", ".join(personal_only))

    if team_only:
        print()
        print(f"ℹ️  团队独有 {len(team_only)} 个（团队自己的检索/审核字段，正常）：")
        print("   " + ", ".join(team_only))

    return 1 if missing else 0


def main() -> int:
    args = sys.argv[1:]
    if len(args) < 4:
        print("用法：check-index-fields.py <static|live> <required> <promoter> [url ca pass init]", file=sys.stderr)
        return 2
    mode, required_s, promoter = args[0], args[1], args[2]
    required = required_s.split()

    if mode == "live":
        url, ca, pw = args[3], args[4], args[5]
        personal, team = fields_live(url, ca, pw)
        label = f"线上 mapping（{url}）"
    else:
        init = args[3]
        personal, team = fields_static(init)
        label = f"源码模板（{init}）"

    return report(personal, team, required, promoter, label)


if __name__ == "__main__":
    sys.exit(main())