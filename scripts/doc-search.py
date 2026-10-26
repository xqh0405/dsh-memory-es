#!/usr/bin/env python3
"""在宿主侧检索 `personal_doc_<uid>`（关键词 + 向量 → RRF 融合 → 按文档聚合）。

为什么需要它：插件目前只有 `memory_search`（查记忆/团队库），没有查文档索引的工具。
在插件补上 `doc_search` 之前，用它证明"入库后能被方便地调用"，也给运维一个直查通道。

融合方式与插件一致：BM25 与 kNN 各取前 N，按 `Σ 1/(k+rank)` 融合（RRF，k=60），
再做**文档级聚合**——同一篇命中多个 chunk 时，用户要的是"哪篇相关 + 命中片段"，
而不是一屏同一标题的碎片。

用法：
    python3 doc-search.py "GC 风暴 根因" --user xqh \
      --es https://192.168.1.125:9200 --ca certs/ca.crt \
      --username mem-user-xqh --password-env ES_PW \
      --ollama http://127.0.0.1:11434 --model bge-m3 --top 5
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import ssl
import sys
import urllib.request

RRF_K = 60


def http_json(url, *, method="GET", body=None, headers=None, ctx=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("content-type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, context=ctx, timeout=timeout) as resp:
        raw = resp.read()
        return resp.status, (json.loads(raw) if raw else None)


def embed(ollama, model, text):
    st, payload = http_json(f"{ollama.rstrip('/')}/api/embed", method="POST",
                            body={"model": model, "input": [text]}, timeout=120)
    if st != 200 or not payload.get("embeddings"):
        raise RuntimeError(f"Ollama 异常：{st} {str(payload)[:200]}")
    return payload["embeddings"][0]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("query")
    ap.add_argument("--user", required=True)
    ap.add_argument("--es", required=True)
    ap.add_argument("--ca", required=True)
    ap.add_argument("--username", required=True)
    ap.add_argument("--password-env", required=True)
    ap.add_argument("--ollama", default="http://127.0.0.1:11434")
    ap.add_argument("--model", default="bge-m3")
    ap.add_argument("--top", type=int, default=5, help="返回前 N 篇文档")
    ap.add_argument("--domain", help="按业务域过滤")
    ap.add_argument("--json", action="store_true", help="输出 JSON 而不是文本")
    args = ap.parse_args()

    password = os.environ.get(args.password_env, "")
    if not password:
        print(f"缺少环境变量 {args.password_env}", file=sys.stderr)
        return 2
    auth = "Basic " + base64.b64encode(f"{args.username}:{password}".encode()).decode()
    ctx = ssl.create_default_context(cafile=args.ca)
    es = args.es.rstrip("/")
    index = f"personal_doc_{args.user}"
    filter_clause = [{"term": {"domain": args.domain}}] if args.domain else []

    # 1) 关键词路：标题/摘要权重高于正文
    _, kw = http_json(f"{es}/{index}/_search", method="POST",
                      headers={"authorization": auth}, ctx=ctx,
                      body={"size": 20, "_source": ["doc_id", "title", "section_path", "content"],
                            "query": {"bool": {
                                "must": [{"multi_match": {
                                    "query": args.query,
                                    "fields": ["title^3", "description^2", "content^2", "section_path"],
                                }}],
                                "filter": filter_clause,
                            }}})
    kw_hits = kw["hits"]["hits"]

    # 2) 向量路
    vec = embed(args.ollama, args.model, args.query)
    try:
        # 注意：knn.filter 不能传 null（ES 回 400），没有过滤条件时**整个字段都不给**
        knn = {"field": "embedding", "query_vector": vec, "k": 20, "num_candidates": 100}
        if filter_clause:
            knn["filter"] = {"bool": {"filter": filter_clause}}
        _, kn = http_json(f"{es}/{index}/_search", method="POST",
                          headers={"authorization": auth}, ctx=ctx,
                          body={"size": 20, "_source": ["doc_id", "title", "section_path", "content"],
                                "knn": knn})
        kn_hits = kn["hits"]["hits"]
    except Exception as exc:  # noqa: BLE001 - 向量路挂了不该让关键词结果也丢掉
        print(f"警告：向量检索失败，只用关键词（{exc}）", file=sys.stderr)
        kn_hits = []

    # 3) RRF 融合到 chunk，再按 doc 聚合
    scores: dict[str, float] = {}
    docs: dict[str, dict] = {}
    for hits in (kw_hits, kn_hits):
        for rank, h in enumerate(hits, 1):
            src = h["_source"]
            cid = h["_id"]
            scores[cid] = scores.get(cid, 0.0) + 1.0 / (RRF_K + rank)
            docs[cid] = src

    per_doc: dict[str, dict] = {}
    for cid, sc in scores.items():
        src = docs[cid]
        did = src.get("doc_id") or cid
        entry = per_doc.setdefault(did, {"title": src.get("title"), "score": 0.0, "chunks": []})
        entry["score"] += sc
        entry["chunks"].append((sc, src.get("section_path") or "", src.get("content") or ""))
    ranked = sorted(per_doc.items(), key=lambda kv: -kv[1]["score"])[: args.top]

    out = []
    for did, e in ranked:
        e["chunks"].sort(key=lambda t: -t[0])
        best = e["chunks"][0]
        out.append({
            "doc_id": did,
            "title": e["title"],
            "score": round(e["score"], 5),
            "hits": len(e["chunks"]),
            "section_path": best[1],
            "snippet": best[2][:400],
        })

    if args.json:
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0

    if not out:
        print(f"没有命中（{index}）")
        return 0
    print(f"{index}：{len(out)} 篇相关文档")
    for i, d in enumerate(out, 1):
        print(f"\n[{i}] {d['title']}  (score {d['score']}, 命中 {d['hits']} 块)")
        if d["section_path"]:
            print(f"    位置：{d['section_path']}")
        print("    " + d["snippet"].replace("\n", "\n    "))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
