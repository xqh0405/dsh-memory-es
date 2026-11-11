#!/usr/bin/env python3
"""把 dsh-mnemon 的 Documents（长文）切片后写入 `personal_doc_<uid>`。

为什么不塞进 `personal_memory_<uid>`：
  记忆条目是「一句可独立成立的事实」（插件侧 4000 字符上限），文档平均 8~10KB。
  混在一起会撑爆上限、污染 memory_search 结果，去重口径也不一样。

切片策略（顺序即优先级）：
  1. 先按 Markdown 标题切 section —— 标题就是天然的语义边界
  2. section 仍过长，按空行段落切
  3. 还长才按句子硬切（目标 ~1000 字符，重叠 150，避免把一句话拦腰截断）
  4. 每个 chunk 的 `section_path` 记下它在文档里的位置（`标题 > 小节`）

向量输入是 **title + description + section_path + 正文**：
  单看一段正文往往"不知道在讲什么"，标题和描述是作者写的"什么时候该读这篇"，
  拼进去能明显提升语义召回；但 `content` 字段只存正文，不给模型看重复的元数据。

幂等：ES 文档 id = `{doc_id}-{chunk_index}`，同一文档重跑覆盖同一批 chunk。
文档被删/变短时旧 chunk 会残留 —— 用 `--prune` 先按 doc_id 删干净再写（更慢但准确）。

用法：
    python3 migrate-docs.py --dry-run \
      --index-json /path/.mnemon/documents/index.json \
      --docs-dir  /path/.mnemon/documents/active \
      --user xqh --es https://192.168.1.125:9200 --ca certs/ca.crt \
      --username mem-user-xqh --password-env ES_PW \
      --ollama http://127.0.0.1:11434 --model bge-m3
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

TARGET = 1000      # 目标 chunk 字符数
OVERLAP = 150      # 相邻 chunk 重叠
MAX_CHUNK = 2000   # 单个 chunk 硬上限（ES 侧不是问题，主要为向量质量）

# index.json 没有 domain 字段，用标题/描述/来源路径里出现的项目名推断
PROJECT_HINTS = ["lottery-cloud", "huoxin-data", "backup-server", "robot-task",
                 "jizhang", "crawler", "internal-service", "shared-library", "dsh"]


def infer_domain(d) -> str:
    blob = " ".join([
        str(d.get("title") or ""), str(d.get("description") or ""),
        " ".join(d.get("sourcePaths") or []),
    ]).lower()
    for p in PROJECT_HINTS:
        if p in blob:
            return p
    return "general"


def http_json(url, *, method="GET", body=None, headers=None, ctx=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("content-type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, context=ctx, timeout=timeout) as resp:
        raw = resp.read()
        return resp.status, (json.loads(raw) if raw else None)


def embed_batch(ollama, model, texts, timeout=300):
    last = None
    for attempt in range(2):
        try:
            st, payload = http_json(f"{ollama.rstrip('/')}/api/embed", method="POST",
                                    body={"model": model, "input": texts}, timeout=timeout)
            if st != 200 or "embeddings" not in (payload or {}):
                raise RuntimeError(f"Ollama 异常：{st} {str(payload)[:200]}")
            return payload["embeddings"]
        except Exception as exc:  # noqa: BLE001
            last = exc
            if attempt == 0:
                time.sleep(2)
    raise RuntimeError(f"embedding 失败：{last}")


def parse_frontmatter(text: str):
    """解析 `---` 包裹的简单 YAML（只用第一层 key / 列表，不引第三方库）。"""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    fm, body = text[3:end], text[end + 4:].lstrip("\n")
    meta: dict[str, object] = {}
    key = None
    for line in fm.splitlines():
        m = re.match(r"^\s*-\s+(.*)$", line)
        if m and key:
            val = m.group(1).strip().strip('"').strip("'")
            if not isinstance(meta.get(key), list):
                meta[key] = []
            meta[key].append(val)  # type: ignore[union-attr]
            continue
        m = re.match(r"^([A-Za-z_][\w-]*):\s*(.*)$", line)
        if m:
            key = m.group(1)
            val = m.group(2).strip().strip('"').strip("'")
            meta[key] = val
    return meta, body


def split_sections(body: str):
    """按标题切段，返回 [(section_path, text), ...]。"""
    out = []
    path: list[str] = []
    buf: list[str] = []
    for line in body.splitlines():
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            if buf and "".join(buf).strip():
                out.append((" > ".join(path), "\n".join(buf).strip()))
            level = len(m.group(1))
            path = path[: level - 1] + [m.group(2).strip()]
            buf = []
        else:
            buf.append(line)
    if buf and "".join(buf).strip():
        out.append((" > ".join(path), "\n".join(buf).strip()))
    return out


def chunk_text(text: str, target=TARGET, overlap=OVERLAP, max_len=MAX_CHUNK):
    """把一段长文本切成有重叠的块：先按段落，段落过大再按句子。"""
    text = text.strip()
    if len(text) <= max_len:
        return [text] if text else []

    units = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    if not units:
        units = [text]

    chunks, cur = [], ""
    for u in units:
        if len(u) > max_len:  # 超大段落按句子切
            sents = re.split(r"(?<=[。！？；.!?;])\s*", u)
            pieces, piece = [], ""
            for s in sents:
                if len(piece) + len(s) > target and piece:
                    pieces.append(piece)
                    piece = s
                else:
                    piece += s
            if piece:
                pieces.append(piece)
            units = pieces if not chunks else units
            for p in pieces:
                if len(cur) + len(p) + 1 > target and cur:
                    chunks.append(cur.strip())
                    cur = cur[-overlap:] + "\n" + p
                else:
                    cur = (cur + "\n" + p).strip()
            continue
        if len(cur) + len(u) + 2 > target and cur:
            chunks.append(cur.strip())
            cur = cur[-overlap:] + "\n\n" + u
        else:
            cur = (cur + "\n\n" + u).strip()
    if cur.strip():
        chunks.append(cur.strip())

    # 硬上限兜底（2026-11-11 审查 #35）：句子切分对「无标点的长串」无解
    # —— 代码块、长 URL、base64、没有句号的表格行，`sents` 只有一项，
    # pieces 里就是一整段超长文本，于是 MAX_CHUNK 这个「单块硬上限」形同虚设。
    # 这里按字符强制断开。硬切出来的相邻块**不带 overlap**：无标点串本来
    # 没有语义边界，重叠只会让同一段文字重复进索引、拉低向量质量。
    if any(len(c) > max_len for c in chunks):
        forced: list[str] = []
        for c in chunks:
            if len(c) <= max_len:
                forced.append(c)
                continue
            for i in range(0, len(c), max_len):
                forced.append(c[i : i + max_len])
        chunks = forced
    return chunks


def build_chunks(meta: dict, body: str, fallback_title: str):
    title = (meta.get("title") or fallback_title or "").strip()
    desc = (meta.get("description") or "").strip()
    sections = split_sections(body) or [("", body)]

    chunks = []
    for spath, stext in sections:
        if not stext.strip():
            continue
        # 太短的 section 也单独成块（标题本身就是线索）
        pieces = chunk_text(stext) if len(stext) > MAX_CHUNK else [stext]
        for piece in pieces:
            chunks.append({"section_path": spath, "content": piece})
    return title, desc, chunks


def fetch_existing(es: str, index: str, auth: str, ctx) -> dict:
    """
    阶段 30：拉 ES 里现有的 (doc_id → 各 chunk 的 sha256 与 status 集合)。

    为什么要比 content_sha256 而不是 updatedAt：md 的 mtime 会因为 checkout、
    touch、编辑器另存而变，但内容没变；按时间比会把「没改的」当「改过的」全量重灌，
    而这个脚本最贵的一步是 embedding。sha256 是内容指纹，才是「变没变」的真判据。

    一次拉 10000 条：单用户文档索引的 chunk 数远小于 `index.max_result_window`；
    真超了宁可报错也别悄悄截断（截断会让「已同步」的判断建立在半个库上）。
    """
    body = {
        "size": 10000,
        "_source": ["doc_id", "chunk_index", "content_sha256", "status"],
        "query": {"match_all": {}},
    }
    status, r = http_json(f"{es}/{index}/_search", method="POST", body=body,
                          headers={"authorization": auth}, ctx=ctx)
    if status != 200 or r is None:
        raise SystemExit(f"拉取现有文档失败：HTTP {status}")
    r = r
    total = r.get("hits", {}).get("total", {})
    total = total.get("value") if isinstance(total, dict) else total
    hits = r.get("hits", {}).get("hits", [])
    if isinstance(total, int) and total > len(hits):
        raise SystemExit(
            f"ES 里有 {total} 个 chunk，但只拉到 {len(hits)} 条"
            f"（超过 index.max_result_window）——先分片处理或调大窗口，别用半个库做增量判断"
        )
    out: dict = {}
    for h in hits:
        src = h.get("_source") or {}
        did = src.get("doc_id")
        if not did:
            continue
        rec = out.setdefault(did, {"chunks": {}, "statuses": set()})
        rec["chunks"][src.get("chunk_index")] = src.get("content_sha256")
        st = src.get("status")
        if st:
            rec["statuses"].add(st)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--index-json", required=True)
    ap.add_argument("--docs-dir", required=True)
    ap.add_argument("--user", required=True)
    ap.add_argument("--es", required=True)
    ap.add_argument("--ca", required=True)
    ap.add_argument("--username", required=True)
    ap.add_argument("--password-env", required=True)
    ap.add_argument("--ollama", default="http://127.0.0.1:11434")
    ap.add_argument("--model", default="bge-m3")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 篇（0=全部）")
    ap.add_argument("--batch", type=int, default=8, help="每次请求 Ollama 的 chunk 数")
    ap.add_argument("--prune", action="store_true", help="写前先按 doc_id 删除旧 chunk")
    ap.add_argument("--incremental", action="store_true",
                    help="阶段 30：只灌新增/变更（按 doc_id + content_sha256 比对），并输出差集报告")
    args = ap.parse_args()

    password = os.environ.get(args.password_env, "")
    if not args.dry_run and not password:
        print(f"缺少环境变量 {args.password_env}", file=sys.stderr)
        return 2
    auth = "Basic " + base64.b64encode(f"{args.username}:{password}".encode()).decode()
    ctx = ssl.create_default_context(cafile=args.ca)
    es = args.es.rstrip("/")
    index = f"personal_doc_{args.user}"

    with open(args.index_json, encoding="utf-8") as fh:
        idx = json.load(fh)
    docs = idx.get("documents", [])
    if args.limit > 0:
        docs = docs[: args.limit]
    print(f"文档 {len(docs)} 篇 → {index}" + ("（dry-run）" if args.dry_run else ""))

    # 阶段 30：增量模式的基线（ES 现有的 doc_id → chunk 指纹）
    existing = {}
    if args.incremental:
        existing = fetch_existing(es, index, auth, ctx)
        print(f"ES 现有 {len(existing)} 篇文档，按 doc_id + content_sha256 比对")
    added = changed = unchanged = skipped_archived = 0
    mnemon_ids = set()

    total_chunks = written = failed = 0
    for n, d in enumerate(docs, 1):
        doc_id = d.get("id") or ""
        fn = d.get("filename") or ""
        path = os.path.join(args.docs_dir, fn)
        if not doc_id or not os.path.isfile(path):
            failed += 1
            print(f"  跳过（缺文件或 id）: {fn}", file=sys.stderr)
            continue
        with open(path, encoding="utf-8") as fh:
            raw = fh.read()
        meta, body = parse_frontmatter(raw)
        title, desc, chunks = build_chunks(meta, body, d.get("title") or "")
        if not chunks:
            continue
        mnemon_ids.add(doc_id)

        # 阶段 30：增量模式先判断这篇要不要写
        prune_needed = False
        if args.incremental:
            rec = existing.get(doc_id)
            if rec is not None and rec["statuses"] == {"archived"}:
                # ES 里已归档：不复活它（归档是人的决定，同步不该覆盖）
                skipped_archived += 1
                continue
            sig = {ci: hashlib.sha256(c["content"].encode()).hexdigest()
                   for ci, c in enumerate(chunks)}
            if rec is None:
                added += 1
            elif rec["chunks"] == sig:
                if rec["statuses"]:
                    unchanged += 1
                    continue
                # 内容没变但缺 status（阶段 29 之前灌的老数据）：补写一次，否则永远搜不到
                added += 0
                changed += 1
                prune_needed = True
            else:
                changed += 1
                # chunk 数变了就要清尾巴，否则旧的 9、10 号切片会留在索引里
                prune_needed = True

        total_chunks += len(chunks)
        if args.dry_run:
            if n <= 3:
                print(f"  [{n}] {title[:40]} → {len(chunks)} 块")
            continue

        if args.prune or prune_needed:
            try:
                http_json(f"{es}/{index}/_delete_by_query?conflicts=proceed&refresh=false",
                          method="POST", headers={"authorization": auth}, ctx=ctx,
                          body={"query": {"term": {"doc_id": doc_id}}})
            except Exception as exc:  # noqa: BLE001
                print(f"  prune 失败 {doc_id}: {exc}", file=sys.stderr)

        # 向量输入包含标题/描述/小节路径：单段正文的语义太弱
        texts = [
            "\n".join(x for x in (title, desc, c["section_path"], c["content"]) if x)[:8000]
            for c in chunks
        ]
        vectors = []
        for i in range(0, len(texts), args.batch):
            try:
                vectors.extend(embed_batch(args.ollama, args.model, texts[i:i + args.batch]))
            except Exception as exc:  # noqa: BLE001
                print(f"  embedding 失败 {doc_id}: {exc}", file=sys.stderr)
                vectors.extend([None] * len(texts[i:i + args.batch]))

        for ci, (c, vec) in enumerate(zip(chunks, vectors)):
            # ⚠️ 这里**不要**照 migrate-mnemon.py 去补 content_exact / importance /
            # pinned / related / activation（2026-11-10 审查 L12/#29 曾把两者混为一谈）：
            # 本脚本写的是 **`personal_doc_*`**，那份模板（init-indices.sh 的第二份 heredoc）
            # 只有 20 个字段，**这 5 个一个都没有**，而索引是 `dynamic: strict` ——
            # 写进去就是 strict_dynamic_mapping_exception，整批灌不进去。
            # 标识符精确匹配（content_exact / IDENTIFIER_FIELD）目前只服务于
            # `memory_search`，`doc_search` 那条路根本不读它；真要给文档加标识符匹配，
            # 得先改模板 + 迁移 11 个 personal_doc_* 索引（与 16b / 21b 同类，别顺手做）。
            doc = {
                "doc_id": doc_id,
                "chunk_index": ci,
                "chunk_total": len(chunks),
                "title": title,
                "title_keyword": title,
                "description": desc,
                "section_path": c["section_path"],
                "content": c["content"],
                "source": "mnemon-document",
                "source_path": d.get("relativePath") or fn,
                "source_paths": d.get("sourcePaths") or [],
                "domain": infer_domain(d),
                "user_id": args.user,
                "content_sha256": hashlib.sha256(c["content"].encode()).hexdigest(),
                "created_at": d.get("createdAt"),
                "updated_at": d.get("updatedAt"),
                # 阶段 29：**必须显式给 status**。doc_search 默认只查 status=active，
                # 缺这个字段的老数据会「灌进去了但搜不到」——2026-11-08 首跑就踩了：
                # 149 篇写成功、容量统计却还是 537 篇，因为那批没有 status。
                "status": "active",
            }
            if vec:
                doc["embedding"] = vec
            try:
                http_json(f"{es}/{index}/_doc/{urllib.parse.quote(f'{doc_id}-{ci}', safe='')}?refresh=false",
                          method="PUT", body=doc, headers={"authorization": auth},
                          ctx=ctx, timeout=30)
                written += 1
            except urllib.error.HTTPError as exc:
                print(f"  写失败 {doc_id}#{ci}: HTTP {exc.code} {exc.read().decode(errors='replace')[:200]}",
                      file=sys.stderr)
                failed += 1
            except Exception as exc:  # noqa: BLE001
                print(f"  写失败 {doc_id}#{ci}: {exc}", file=sys.stderr)
                failed += 1
        if n % 20 == 0:
            print(f"  进度 {n}/{len(docs)} 篇，chunk 已写 {written}")

    if args.incremental:
        es_only = sorted(set(existing) - mnemon_ids)
        print("")
        print("== 差集报告（阶段 30）==")
        print(f"  新增（ES 没有）：{added} 篇")
        print(f"  变更（sha256 不同）：{changed} 篇")
        print(f"  未变（跳过）：{unchanged} 篇")
        print(f"  ES 已归档（跳过，不复活）：{skipped_archived} 篇")
        print(f"  ES 独有、mnemon 侧已无：{len(es_only)} 篇"
              + (f"（例：{', '.join(es_only[:3])}）" if es_only else ""))
        print("")
        print("  口径：『ES 独有』通常是 mnemon 侧改名/删除后留下的旧切片，"
              "或停写前的残留——要么手工归档，要么等停写后清一次。")

    print(f"完成：{total_chunks} 个 chunk" + ("（dry-run，未写）" if args.dry_run
          else f"，写入 {written}，失败 {failed}"))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
