# dsh-memory-es

自研 DSH 记忆插件：以 Docker 部署的 Elasticsearch 为存储与检索后端，实现**团队共享知识库**与**个人记忆库**的双层隔离、AI 读写、定期整理入库与语义增强检索。

## 现状（2026-10-25）

| 部分 | 状态 |
|---|---|
| 设计文档 | v0.3（含实现方案 §15、开发步骤 §16、决策记录 §14） |
| Elasticsearch | **已部署**：8.19.23 单节点，security + TLS + IK，`127.0.0.1:9200` |
| 权限隔离 | **已验证**：`scripts/verify-isolation.sh` 11/11 PASS |
| embedding | **已就位**：`bge-m3`（1024 维，0.20 s/条） |
| 插件骨架（S1） | **已完成**：Config + fail-fast、`fragment.ts` 纯函数契约、tsdown 单产物 |
| ES 层（S2） | **已完成**：`es/http.ts`（TLS CA / Basic Auth / 超时 / 12 类错误映射 / 409·429 重试）、`es/dsl.ts`（BM25 + kNN + 去重 body） |
| 写入工具（S3） | **已完成**：`memory_save`（身份注入 / 幂等去重 / embedding 降级 / F3）、`embedding.ts`（Ollama `/api/embed`） |
| 检索工具（S4） | **已完成**：`memory_search`（BM25 + kNN 并发 / 库内 RRF / 跨库加权去重 / cosine margin 判空 / 精简投影） |
| 提示与文案（S6） | **已完成**：系统提示片段（order=3200）+ 四条工具描述改成「时机 / 不要用」句式 |
| 治理工具（S5） | **已完成**：`memory_update_status`（supersede 双写 / expire / mark_private）、`memory_promote`（只标候选） |

## 快速开始

```bash
./scripts/es-up.sh            # 起 ES（首次自动生成密码/证书、装 IK）
./scripts/init-indices.sh     # 索引模板 + 个人索引 + 团队索引
./scripts/init-security.sh    # 角色 / 用户（Basic Auth）
./scripts/verify-isolation.sh # M1 判据：11 项断言，必须全 PASS
./scripts/es-down.sh          # 停（保留数据）

bash scripts/build.sh         # 装 devDeps → 链宿主 @deepseek-ai/* → tsdown 打 lib/
npm run typecheck             # src + tests 两份 tsconfig
npm test                      # 全部 158 例（集成测试要 ES 在跑；save/search 集成还要 Ollama）
npm test -- es-integration    # 只跑真实 ES 的集成用例
npm test -- save-integration  # 只跑 memory_save 闭环（真 ES + 真 Ollama）
npm test -- search-integration # 只跑 memory_search 闭环（真 ES + 真 Ollama）
npm test -- status-integration # 只跑状态变更闭环（真 ES）
npm test -- prompt             # 只跑提示词内容与真实组装
```

密码在 `deploy/es/.env`（600，已 gitignore）；证书与数据在 `deploy/es/{certs,data}`（不提交）。

## 文档

- [开发文档](docs/开发文档.md) —— 索引与映射、权限模型、Docker 部署、插件工具契约、混合检索、整理管道、实现方案、施工清单、风险与里程碑。

## 三个已定的关键决策

1. **embedding = `bge-m3`（1024 维）**：不用本机 `nomic-embed-text`（768 维、偏英文）。
2. **个人库 = 一人一索引 `personal_memory_<user_id>` + 索引级 ACL**：ES 免费版没有 DLS（实测 403），所以隔离靠索引 ACL，不靠文档级过滤。
3. **写入 = 单一入口**：个人身份只读，所有写与状态变更只走 `mem_writer`；团队库只允许整理服务写。

理由、代价与否决方案见开发文档 §14（D1–D6）。

## 一句话结论

没有现成插件覆盖这个闭环，需要自建；本仓库的起点是先验证环境与判据，再落代码。
