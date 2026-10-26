#!/usr/bin/env python3
"""把 dsh-mnemon 的 SQLite 个人记忆迁到 dsh-memory-es（Elasticsearch）。

为什么需要重算向量：mnemon 用的是 nomic-embed-text（768 维），ES 的 mapping
是 bge-m3（1024 维）。维度不同**不能复用**，必须重新算，否则写入直接 400。

字段映射按 `src/memory/save.ts` 的 buildMemoryDoc（写入契约）来：
只写契约里出现的字段，且**不写空串**——索引是 dynamic: strict，
多余字段会 400，而"有值但为空"会让检索误判。

幂等：以 mnemon 的 insight id 作 ES 文档 id（memory_id），重复跑覆盖同一条，
不会产生第二份。

用法（在 ES 所在机上跑）：

    python3 migrate-mnemon.py --dry-run \\
      --db /path/mnemon.db --user xqh \\
      --es https://192.168.1.125:9200 \\
      --ca /docker/dsh-es/certs/ca.crt \\
      --username mem-user-xqh --password-env ES_PW \\
      --ollama http://127.0.0.1:11434 --model bge-m3

密码从环境变量读（`--password-env` 给变量名），不走 argv，避免进 `ps`。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import ssl
import sys
import time
import base64
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

# 与 src/memory/save.ts 的 MEMORY_TYPES 一致；mnemon 的 category 有 insight/general
# 两个不在枚举里的值，按语义并入最接近的档。
MEMORY_TYPES = {"preference", "fact", "task_progress", "decision", "context"}
CATEGORY_MAP = {
    "preference": "preference",
    "decision": "decision",
    "fact": "fact",
    "insight": "fact",
    "context": "context",
    "general": "fact",
}
MAX_CONTENT_CHARS = 4000


def normalize_content(s: str) -> str:
    """等价于 JS 的 `input.normalize('NFKC').replace(/\\s+/g,' ').trim()`。"""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", s)).strip()


def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def http_json(url: str, *, method="GET", body=None, headers=None, ctx=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("content-type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, context=ctx, timeout=timeout) as resp:
        raw = resp.read()
        return resp.status, (json.loads(raw) if raw else None)


def embed_batch(ollama: str, model: str, texts: list[str], timeout: int = 180) -> list[list[float]]:
    """调 Ollama 的 /api/embed。失败重试一次（CPU 推理偶发超时）。"""
    last = None
    for attempt in range(2):
        try:
            st, payload = http_json(
                f"{ollama.rstrip('/')}/api/embed",
                method="POST",
                body={"model": model, "input": texts},
                timeout=timeout,
            )
            if st != 200 or "embeddings" not in (payload or {}):
                raise RuntimeError(f"Ollama 返回异常：{st} {str(payload)[:200]}")
            return payload["embeddings"]
        except Exception as exc:  # noqa: BLE001 - 逐条降级比整批失败好
            last = exc
            if attempt == 0:
                time.sleep(2)
    raise RuntimeError(f"embedding 失败：{last}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["insights", "runtime"], default="insights",
                    help="insights=SQLite 的记忆条目；runtime=热记忆 MEMORY/USER（memories.json）")
    ap.add_argument("--db", help="mnemon.db 路径（source=insights 时必填）")
    ap.add_argument("--runtime-file", help="memories.json 路径（source=runtime 时必填）")
    ap.add_argument("--user", required=True, help="user_id（也是索引名后缀 personal_memory_<user>）")
    ap.add_argument("--es", required=True, help="ES 地址，如 https://192.168.1.125:9200")
    ap.add_argument("--ca", required=True, help="CA 证书路径（ca.crt）")
    ap.add_argument("--username", required=True, help="ES 账号，如 mem-user-xqh")
    ap.add_argument("--password-env", required=True, help="保存密码的环境变量名")
    ap.add_argument("--ollama", default="http://127.0.0.1:11434")
    ap.add_argument("--model", default="bge-m3")
    ap.add_argument("--dry-run", action="store_true", help="只读库并打印将要写的文档数，不写 ES")
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 条（0=全部）")
    ap.add_argument("--batch", type=int, default=8, help="每次请求 Ollama 的条数")
    args = ap.parse_args()

    password = os.environ.get(args.password_env, "")
    if not args.dry_run and not password:
        print(f"缺少环境变量 {args.password_env}（ES 密码）", file=sys.stderr)
        return 2

    auth = "Basic " + base64.b64encode(f"{args.username}:{password}".encode()).decode()
    ctx = ssl.create_default_context(cafile=args.ca)
    index = f"personal_memory_{args.user}"
    es = args.es.rstrip("/")

    if args.source == "insights":
        if not args.db:
            print("source=insights 需要 --db", file=sys.stderr)
            return 2
        con = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        rows = con.execute(
            """
            select id, content, category, importance, tags, entities,
                   created_at, updated_at
            from insights
            where deleted_at is null and content is not null and trim(content) <> ''
            order by created_at
            """
        ).fetchall()
    else:
        if not args.runtime_file:
            print("source=runtime 需要 --runtime-file", file=sys.stderr)
            return 2
        # 热记忆的结构化源；MEMORY.md 只是它的文本投影，不解析 Markdown
        with open(args.runtime_file, encoding="utf-8") as fh:
            payload = json.load(fh)
        entries = payload.get("entries", [])
        rows = [e for e in entries if isinstance(e.get("content"), str) and e["content"].strip()]
        rows.sort(key=lambda e: e.get("created_at") or "")

    if args.limit > 0:
        rows = rows[: args.limit]
    print(f"待迁移 {len(rows)} 条 → {index}" + ("（dry-run，不写）" if args.dry_run else ""))

    ok = skipped = failed = 0
    degraded = 0
    for start in range(0, len(rows), args.batch):
        chunk = rows[start : start + args.batch]
        docs = []
        for r in chunk:
            content = r["content"] or ""
            if len(content) > MAX_CONTENT_CHARS:
                content = content[:MAX_CONTENT_CHARS]
                skipped += 1
            norm = normalize_content(content)
            if not norm:
                skipped += 1
                continue

            if args.source == "insights":
                category = (r["category"] or "fact").strip()
                mtype = CATEGORY_MAP.get(category, "fact")
                mem_id = r["id"]
                keywords: list[str] = []
                for key in ("tags", "entities"):
                    try:
                        val = json.loads(r[key]) if r[key] else []
                    except (json.JSONDecodeError, TypeError):
                        val = []
                    if isinstance(val, list):
                        keywords.extend(str(x) for x in val)
                created, updated = r["created_at"], r["updated_at"]
            else:
                # 热记忆没有 id，用「用户 + 归一化正文」派生稳定 id，保证重跑幂等
                mem_id = "rt-" + hashlib.sha256(f"{args.user}|{norm}".encode()).hexdigest()[:32]
                # target=user 是用户画像（偏好），target=memory 是项目/环境事实
                mtype = "preference" if (r.get("target") == "user") else "fact"
                keywords = []
                created, updated = r.get("created_at"), r.get("updated_at")

            # 热记忆常带 `[DSH·环境]` 这类分类前缀：取第一段当 domain，正文保持原样
            domain = "general"
            m = re.match(r"^\[([^\]]{1,40})\]", content)
            if m:
                domain = m.group(1).split("·")[0].strip().lower() or "general"

            doc = {
                "memory_id": mem_id,
                "user_id": args.user,
                "content": content,
                "memory_type": mtype,
                "domain": domain,
                # 已整理过的旧记忆：直接标 done，避免后台蒸馏重复改写
                "promote_state": "none",
                "distill_state": "done",
                "status": "active",
                "privacy": "normal",
                "content_sha256": sha256_hex(norm),
                "created_at": created,
                "updated_at": updated,
            }
            if keywords:
                doc["semantic_keywords"] = " ".join(dict.fromkeys(keywords))
            docs.append(doc)

        if not docs:
            continue

        if args.dry_run:
            ok += len(docs)
            continue

        try:
            vectors = embed_batch(args.ollama, args.model, [d["content"] for d in docs])
        except Exception as exc:  # noqa: BLE001
            # 向量算不出就**降级**：只写关键词可检索的那部分，并在报告里明确计数
            degraded += len(docs)
            vectors = [None] * len(docs)
            print(f"  警告：批 {start} embedding 失败，降级为无向量（{exc}）", file=sys.stderr)

        for doc, vec in zip(docs, vectors):
            if vec:
                doc["embedding"] = vec
            try:
                http_json(
                    f"{es}/{index}/_doc/{urllib.parse.quote(doc['memory_id'], safe='')}?refresh=false",
                    method="PUT",
                    body=doc,
                    headers={"authorization": auth},
                    ctx=ctx,
                    timeout=30,
                )
                ok += 1
            except urllib.error.HTTPError as exc:
                body = exc.read().decode(errors="replace")[:300]
                print(f"  失败 {doc['memory_id']}: HTTP {exc.code} {body}", file=sys.stderr)
                failed += 1
            except Exception as exc:  # noqa: BLE001
                print(f"  失败 {doc['memory_id']}: {exc}", file=sys.stderr)
                failed += 1

        print(f"  进度 {min(start + len(chunk), len(rows))}/{len(rows)}（成功 {ok} 失败 {failed}）")

    if not args.dry_run:
        # 让新写入立刻可搜。个人账号只有 index 权限、没有 indices:admin/refresh，
        # 这一步通常会 403——不是错误，等 refresh_interval（模板里 5s）自动可见。
        try:
            http_json(f"{es}/{index}/_refresh", method="POST", headers={"authorization": auth}, ctx=ctx)
            print("已刷新索引，立即可搜")
        except Exception as exc:  # noqa: BLE001
            print(f"提示：手动 refresh 未成功（{exc}）；5 秒后自动可见，可用 --dry-run 之外再查一次确认")

    print(f"完成：成功 {ok}，跳过 {skipped}，失败 {failed}" + (f"，降级无向量 {degraded}" if degraded else ""))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
