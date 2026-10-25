# dsh-memory-es

自研 DSH 记忆插件：以 Docker 部署的 Elasticsearch 为存储与检索后端，实现**团队共享知识库**与**个人记忆库**的双层隔离、AI 读写、定期整理入库与语义增强检索。

## 现状（2026-10-25）

| 部分 | 状态 |
|---|---|
| 设计文档 | v0.3（含实现方案 §15、开发步骤 §16、决策记录 §14） |
| Elasticsearch | **已部署**：8.19.23 单节点，security + TLS + IK，`127.0.0.1:9200` |
| 权限隔离 | **已验证**：`scripts/verify-isolation.sh` 11/11 PASS |
| embedding | **已就位**：`bge-m3`（1024 维，0.20 s/条） |
| 插件代码 | **未开始**，按开发文档 §16 从 S1 起 |

## 快速开始

```bash
./scripts/es-up.sh            # 起 ES（首次自动生成密码/证书、装 IK）
./scripts/init-indices.sh     # 索引模板 + 个人索引 + 团队索引
./scripts/init-security.sh    # 角色 / 用户 / API key
./scripts/verify-isolation.sh # M1 判据：11 项断言，必须全 PASS
./scripts/es-down.sh          # 停（保留数据）
```

密码与 API key 在 `deploy/es/.env`（600，已 gitignore）；证书与数据在 `deploy/es/{certs,data}`（不提交）。

## 文档

- [开发文档](docs/开发文档.md) —— 索引与映射、权限模型、Docker 部署、插件工具契约、混合检索、整理管道、实现方案、施工清单、风险与里程碑。

## 三个已定的关键决策

1. **embedding = `bge-m3`（1024 维）**：不用本机 `nomic-embed-text`（768 维、偏英文）。
2. **个人库 = 一人一索引 `personal_memory_<user_id>` + 索引级 ACL**：ES 免费版没有 DLS（实测 403），所以隔离靠索引 ACL，不靠文档级过滤。
3. **写入 = 单一入口**：个人 key 只读，所有写与状态变更只走 `mem_writer`；团队库只允许整理服务写。

理由、代价与否决方案见开发文档 §14（D1–D5）。

## 一句话结论

没有现成插件覆盖这个闭环，需要自建；本仓库的起点是先验证环境与判据，再落代码。
