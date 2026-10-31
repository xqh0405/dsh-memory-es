# dsh-memory-es

**当前版本：0.2.0**（`scripts/version.sh` 管理；升级见「打包与更新」）

自研 DSH 记忆插件：以 Docker 部署的 Elasticsearch 为存储与检索后端，实现**团队共享知识库**与**个人记忆库**的双层隔离、AI 读写、定期整理入库与语义增强检索。

## 前置条件

插件这一层只提供「工具 + 提示词」，记忆的实际存储在外部。装之前先确认这些都在：

| 依赖 | 要求 | 说明 |
|---|---|---|
| DSH | ≥ 0.2（开发与验证基于 0.2.1-rc.2） | 需要 `dsh.bundle` 支持 |
| Node.js | ≥ 20（构建）；跑测试需 ≥ 22.18 | 测试直接执行 `.ts`，依赖 type stripping |
| Elasticsearch | 8.x 单节点，开 security + TLS，装 IK 分词 | `scripts/es-up.sh` 会自动起容器、生成密码与证书、装 IK |
| embedding 服务 | Ollama + `bge-m3`（1024 维） | `ollama pull bge-m3` |
| Docker | 近期版本 | 只为跑 ES |

`es-up.sh` 生成的自签证书、密码与数据都落在 `deploy/es/`，已 gitignore，不会进仓库。

## 安装

**本仓库不提交构建产物**（`lib/` 在 `.gitignore` 里），所以安装分两步：先构建，再作为本地包装进 profile。

```bash
git clone https://github.com/xqh0405/dsh-memory-es.git
cd dsh-memory-es

# 1. 构建：装 devDeps → 链宿主 @deepseek-ai/* → tsdown 打 lib/
NPM_REGISTRY=https://mirrors.cloud.tencent.com/npm bash scripts/build.sh

# 2. 装进 profile（传绝对路径）
dsh plugin --profile web add "$PWD"
```

第 2 步只是装依赖，**还要把它挂进 profile 的 bundle 列表才算启用**：编辑 `~/.dsh/profiles/web/package.json`，在 `dsh.profile.bundles` 数组里加一行 `"dsh-memory-es"`，然后重启 dsh。

两个常见卡点：

- **报「找不到 dsh 宿主包目录」**：`scripts/link-deps.sh` 默认从全局安装位置 `/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai` 取宿主包。dsh 装在别处时用 `DSH_HOST_PKGS=/path/to/@deepseek-ai bash scripts/build.sh` 覆盖。
- **npm 直连超时**：构建要从 registry 装 devDeps，国内建议像上面那样带 `NPM_REGISTRY` 走镜像。

升级不用重装：装的是本地目录依赖，`git pull` 后重跑一次 `bash scripts/build.sh` 即可。⚠️ **`file:` 依赖是「拷贝」不是「硬链接」**：pnpm 把目录拷进 profile 的 `node_modules`，两份是独立副本——只构建仓库的话重启后跑的还是旧代码。本机用 `bash scripts/sync-local-plugin.sh` 同步两份（`--check` 校验），细节见「本机部署与同步」。

装好后的判据：重启的 dsh 里出现 `memory_save` / `memory_search` / `doc_search` / `memory_update_status` / `memory_promote` / `memory_review` / `memory_history` / `memory_traits` / `memory_persona` / `memory_journal` / `memory_distill` 这 11 个工具；设置里出现「记忆库」面板（面板是仓库内的独立 bundle `panel/`，需单独安装才启用）。

## 版本号

版本号只有一个来源：`package.json` 的 `version`（面板包 `panel/package.json` 由脚本同步，永远同号）。
**每次要让 114 / 125 重新加载插件时先 bump**，不要每 commit 都改（否则历史里全是版本噪声）：

```bash
scripts/version.sh                # 看当前版本（两处一致才通过）
scripts/version.sh bump patch     # 修 bug / 小改：0.2.0 → 0.2.1
scripts/version.sh bump minor     # 新能力：0.2.1 → 0.3.0
scripts/version.sh set 1.0.0      # 直接指定
```

运行态能看到的地方（部署后核对这四个，就知道加载的是哪一版）：

| 位置 | 长什么样 |
|---|---|
| 插件启动日志 | `ready: v0.2.0 user=…` |
| 面板自检行 | `[记忆库面板] 自检通过 v0.2.0 \| …` |
| 面板页脚 | `版本 0.2.0`（由 `/overview` 回传，所以一定是服务端真正加载的那份） |
| 部署日志 | `==> 打包（plugin + panel + …）版本 v0.2.0` |

`tests/version.test.ts` 会拦住「两处不一致」和「非 `X.Y.Z` 纯数字」的版本号。

## 打包与更新（给别的机器 / 容器）

改完并 bump 过版本之后，打一个**不需要仓库、不需要 npm、不需要构建**的包：

```bash
scripts/package.sh              # → dist/dsh-memory-es-<版本>.tar.gz
scripts/package.sh --build      # 顺手先 npm run build（lib 比源码旧时它会拒绝打包）
scripts/package.sh --no-stickers  # 不打表情包（7.3MB → 约 250KB）
```

目标机器上（本机或容器里都行）：

```bash
tar xzf dsh-memory-es-0.2.0.tar.gz
cd dsh-memory-es-0.2.0
./install.sh                          # 本机：DSH_HOME=~/.dsh，profile=web
./install.sh --dry-run                # 先看它要做什么

# 容器里（dsh 以 node 用户跑，必须用 -u node 或 --owner node，否则文件归 root、插件读不到）：
docker exec -u node -w /tmp/pkg dsh-xqh ./install.sh --dsh-home /data/dsh
# 或者以 root 执行、由脚本收尾改属主：
docker exec dsh-xqh ./install.sh --dsh-home /data/dsh --owner node
```

`install.sh` 做四件事，都是幂等的：

1. 主插件 → `$DSH_HOME/local-plugins/dsh-memory-es`
2. 面板（含面板内置的 CLI 源码）→ `$DSH_HOME/local-plugins/dsh-memory-es-panel`
3. `dsh plugin add file:…` 装进 profile，并确认 `dsh.profile.bundles` 含两个包名
   ——**只做前两步插件不会加载**（接口 404、日志静默），所以这一步不能省
4. 表情包 → `$DSH_HOME/stickers`（内容不同会先备份成 `stickers.bak-<时间>`）

装完重启 dsh-web，然后核对版本：`ready: v<版本>` / `自检通过 v<版本>` / 页脚「版本 <版本>」。

包里还带 `manifest.json`（版本、commit、构建时间、文件数）与 `SHA256SUMS`（`sha256sum -c SHA256SUMS`）。
`dist/` 不进仓库。

## 配置

插件配置写在 profile 的 `cordis.patch.yml` 里（`- id: dsh-memory-es` 那一行的 `config`）。必填只有一项 `identity.userId`，其余有默认值：

```yaml
- id: dsh-memory-es
  name: dsh-memory-es
  config:
    es:
      url: https://127.0.0.1:9200
      caCertPath: <仓库绝对路径>/deploy/es/certs/ca.crt
    identity:
      userId: <你的用户 id>          # 必填；个人索引名 = personal_memory_<userId>
      username: mem-user-<你的用户 id>  # 单账号模式：个人库读写 + 团队库按 teamWrite
      password: <从 deploy/es/.env 取>
      teamWrite: false               # true = 有团队库写权限（能审核）
    embedding:
      model: bge-m3
      dims: 1024
    # 以下都可省略，默认值即当前生产配置
    retrieval:
      topK: 20                     # 每一路（BM25 / kNN）取的候选数
      rrfK: 60                     # RRF 融合常数
      limit: 8                     # 返回给模型的最大条数
    confidence:                    # 分层置信：低置信时「返回 + 标注」，不返回空
      floorTop1: 0.6               # 低于此值判低置信
      autoPassTop1: 0.8            # 高于此值直接放行
      minMargin: 0.025             # 或 top1-top2 差距够大
      minBm25: 30                  # 或 BM25 足够强
    ranking:                       # 排序乘子，作用在跨库合并之后
      importanceWeight: 1          # critical ×1.1 / low ×0.9
      hitWeight: 0.2               # 命中次数加成
      recencyWeight: 0.1           # 时间新鲜度权重
      recencyHalfLifeDays: 30      # 未知 memory_type 的兜底半衰期
      reinforcementPerHit: 0.1     # 每次命中延长 10% 寿命
      reinforcementCap: 0.5        # 最多延长 50%
      agreementBonus: 0            # 两路一致加成（A/B 实测负收益，默认关）
```

不填 `userId` 或凭据缺失时插件会 fail-fast 拒绝启动——这是刻意的（不写匿名记忆）。`scripts/init-security.sh` 会把生成的账号密码写进 `deploy/es/.env`，照着填即可。

⚠️ **`es.url` / `es.caCertPath` 只能在 profile 配置里改，面板不提供写入口**（2026-10-31 收窄）：
这两个字段决定「Basic Auth 凭据发往哪个地址」，一旦可写，会话被盗就能把管理员的 ES 凭据导到任意主机。
改完本来也要重启 dsh 才生效，手改 `cordis.patch.yml` 并不更麻烦；面板只读展示当前连接与 CA。

## 现状（2026-10-31，v0.2.0）

| 部分 | 状态 |
|---|---|
| 设计文档 | v0.3（含实现方案 §15、开发步骤 §16、决策记录 §14） |
| Elasticsearch | **已部署**：8.19.23 单节点，security + TLS + IK，`127.0.0.1:9200` |
| 权限隔离 | **已验证**：`scripts/verify-isolation.sh` 11/11 PASS |
| embedding | **已就位**：`bge-m3`（1024 维，0.20 s/条） |
| 插件骨架（S1） | **已完成**：Config + fail-fast、`fragment.ts` 纯函数契约、tsdown 单产物 |
| ES 层（S2） | **已完成**：`es/http.ts`（TLS CA / Basic Auth / 超时 / 12 类错误映射 / 409·429 重试）、`es/dsl.ts`（BM25 + kNN + 去重 body） |
| 写入工具（S3） | **已完成**：`memory_save`（身份注入 / 幂等去重 / embedding 降级 / F3）、`embedding.ts`（Ollama `/api/embed`） |
| 检索工具（S4） | **已完成**：`memory_search`（BM25 + kNN 并发 / 库内 RRF / 跨库加权去重 / 分层置信判定 / 精简投影） |
| 提示与文案（S6） | **已完成**：系统提示片段（order=3200）+ 四条工具描述改成「时机 / 不要用」句式 |
| 治理工具（S5） | **已完成**：`memory_update_status`（supersede 双写 / expire / archive / restore / mark_private）、`memory_promote`（只标候选） |
| 检索质量（2026-10-29） | **已完成**：标识符精确匹配（`content_exact`，修 IK 把 `lot.bd_write_sync` 切碎导致的召回丢失）、分层置信判定、排序乘子（importance / 命中次数 / 新鲜度）、失效与过期过滤、按 `memory_type` 的半衰期与访问强化 |
| 遗忘口径 | **主插件不物理删除**（`EsClient` 没有 `delete`）：归档 / 过期 / 被取代都只是移出检索，任何一条都能按 id 查回。面板的「删除」是唯一物理删除入口，要求 `confirm:true`，且权限由 `_has_privileges` 现问（不认配置声明） |
| 阶段 5–9（2026-10-30 ~ 10-31） | **已完成**：联结与扩散激活、情绪维度（事件驱动）、自我迭代（identity/persona 候选 + 审核 + 版本回滚 + 锚点）、每日自动提炼与每日回顾、人格内核与表情包；工具从 4 个扩到 11 个。⚠️ 「非事实类型」（identity / persona / journal）默认不进 `memory_search`，要显式按 `memory_type` 查 |
| 进度 | S1~S10 + 阶段 5–9 完成：11 个工具 + 系统提示段（记忆/人格/心情/表情包）+ 整理任务（默认 dry-run）+ 治理（审核队列/冲突/审计）+ Markdown 镜像 + 每日回顾与自动提炼 |
| 部署形态 | **两套**：本机（`deploy/es`）+ DSH 跑在容器里时（`deploy/es-remote`，ES 与该容器同在 docker 网络）。后者已实际装进容器 web profile 并通过冒烟（模型自己调用 `memory_save` 落库、双路检索命中），详见开发文档 §5.7。本机自 2026-10-31 起只是 125 的客户端（本地 ES 已停），定时任务通过 `ES_URL` / `ES_CA` 指向 125 |
| 发布形态 | `scripts/package.sh` 打单包（plugin + panel + CLI + 表情包 + `install.sh`），目标机 `tar xzf && ./install.sh` 更新；版本号从 0.2.0 起随发布迭代 |
| 运行态核对 | 插件日志 `ready: vX.Y.Z`、面板自检 `自检通过 vX.Y.Z`、面板页脚「版本 X.Y.Z」——三处都该是同一个号 |

## 快速开始

```bash
./scripts/es-up.sh            # 起 ES（首次自动生成密码/证书、装 IK）
./scripts/init-indices.sh     # 索引模板 + 个人索引 + 团队索引
./scripts/init-security.sh    # 角色 / 用户（Basic Auth）
./scripts/verify-isolation.sh # M1 判据：11 项断言，必须全 PASS
./scripts/es-down.sh          # 停（保留数据）
# 脚本凭据：scripts/lib/curl-es.sh 用 600 临时配置文件传给 curl（密码不进 argv/ps）

# 老部署升级（新部署可跳过；都是幂等的「只加字段」）
# ⚠️ 顺序：先迁移 mapping，再上新代码。缺字段时 dynamic:strict 直接 400。
./scripts/migrate-mood-fields.sh         # 阶段 6：情绪 + 记忆情感 + 提炼字段
./scripts/migrate-journal-fields.sh      # 阶段 9.5：day / review_state（每日回顾要用）
./scripts/migrate-s9.sh                  # 团队库审核字段 + memory_audit

# 整理任务（S8）：个人记忆 → 团队库，默认 dry-run
node consolidate/cli.ts                     # 只出候选报告，一条不写
node consolidate/cli.ts --apply             # 真写团队库 + 回写个人库状态
node consolidate/cli.ts --auto              # 按 §9.1 阈值判断要不要跑
node consolidate/cli.ts --since 2026-10-01  # 只看这天之后创建的记忆

# 查看记忆（只读）
node consolidate/cli.ts --ls                    # 个人库 + 团队库列表
node consolidate/cli.ts --ls --scope team --show-pending   # 团队库含待裁决

# 审核台（S9）：pending 已落库但不进检索
node consolidate/cli.ts --review list               # 看待裁决队列
node consolidate/cli.ts --approve <doc_id>          # 通过 → 进入检索
node consolidate/cli.ts --reject <doc_id> --reason "结论与线上不符"
node consolidate/cli.ts --withdraw <doc_id> --reason "这条知识已作废"

# 设置面板（独立 bundle：Settings → 记忆库）
#   页签：概览 / 记忆浏览 / 审核台 / 自述 / 人格 / 日记
#   写操作：审核采纳、删除记忆、维护（整理/导出/镜像）、改配置、编辑人格内核——全部过权限探测
#   独立 bundle，装进 web profile 后重启 dsh 才生效
ls panel/            # client.js 客户端 / index.js 宿主 / cordis.patch.yml / cli（面板内置 CLI 源码）

# 定时任务（装好但默认关闭；开关在 .state/cron.env）
./scripts/memory-cron.sh status      # 开关 / 日志 / crontab 状态
./scripts/memory-cron.sh enable      # 打开（consolidate 默认仍只 dry-run）
./scripts/memory-cron.sh disable     # 关闭
# ⚠️ 如果 ES 不在本机（例如客户端机器连 125），cron 必须跟着指，否则会打在本地退役库上：
#   在 .state/cron.env 里加
#     ES_URL=https://192.168.1.125:9200
#     ES_CA=/home/user/.dsh/certs/dsh-es-lan-ca.crt
#     （以及确保 deploy/es/users/<uid>.env 的密码与 profile 里的一致）
#   判据：memory-cron.sh export 输出「共 N 条」而不是 0 条。
#   审计清理（prune-audit）需要 elastic 凭据，远端 ES 时本机会明确跳过并提示去哪跑。

# Markdown 镜像（S10）：只读导出，改 md 不会回流 ES
node consolidate/cli.ts --export              # 写 knowledge/<domain>.md + INDEX.md
node consolidate/cli.ts --export --dry-run    # 只看会写哪些文件

# 发布：版本号 + 单文件发行包（详见上面两节）
./scripts/version.sh bump patch     # 改完要发布时先迭代版本
./scripts/package.sh                # → dist/dsh-memory-es-<版本>.tar.gz

# 第二套：DSH 本身跑在容器里时用（ES 与 DSH 同在一个 docker 网络，按容器名互解析）
#   在目标主机上执行；路径与网络名按你自己的部署改
bash scripts/es-remote-up.sh  # 起 ES（加入 DSH 容器的网络、证书 SAN 带 ES 容器名）
ES_DIR=/path/to/es-memory/deploy/es-remote bash scripts/init-indices.sh
ES_DIR=/path/to/es-memory/deploy/es-remote bash scripts/init-security.sh

bash scripts/build.sh         # 装 devDeps → 链宿主 @deepseek-ai/* → tsdown 打 lib/
npm run typecheck             # src + tests 两份 tsconfig
npm test                      # 全部 264 例（Node ≥22.18：测试直接跑 .ts 依赖 type stripping）（集成测试要 ES 在跑；save/search/consolidate 集成还要 Ollama）
npm test -- es-integration    # 只跑真实 ES 的集成用例
npm test -- save-integration  # 只跑 memory_save 闭环（真 ES + 真 Ollama）
npm test -- search-integration # 只跑 memory_search 闭环（真 ES + 真 Ollama）
npm test -- status-integration # 只跑状态变更闭环（真 ES）
npm test -- prompt             # 只跑提示词内容与真实组装

# 字段迁移（幂等，跑一次即可；顺序必须是「先迁移、再上新代码」）
#   加了 content_exact / importance / hit_count / last_hit_at / superseded_at
bash scripts/migrate-identifier-field.sh <userId>
bash scripts/migrate-ranking-fields.sh <userId>

# 检索评测：排序口径 / 生产口径 / 阈值扫描（需要 tests/eval/queries.jsonl，见 queries.example.jsonl）
npm run eval                   # 只测排序质量（关掉置信判空），与基线逐条对比
npm run eval:prod              # 生产口径（含置信判定）
npm run eval:thresholds        # 网格扫描置信阈值，出帕累托前沿
```

密码在 `deploy/es/.env`（600，已 gitignore）；证书与数据在 `deploy/es/{certs,data}`（不提交）。

## 阶段进度（勾选）

> 已完成项保留作记录（含被实测否决的方案与原因）；未勾的是明确跳过或搁置的。
> 接 [优化路线](docs/优化路线.md) 阶段 4 之后。四条原则不变：**一次只改一层**、每层都要能用同一套评测对比、新能力默认关（乘子默认 0）、遗忘只改可见性不做物理删除。
> **勾选规则**：一项的验收指标在 `npm run eval` 上对 `tests/eval/baseline.json` 达标，且 `npm run typecheck` 与集成测试通过，才把 `- [ ]` 改成 `- [x]`，并在条目末尾补上落地版本号。

### 阶段 5 · 联结与激活

现状：排序乘子只作用于**单条**记忆（`importance` / `hit_count` / `last_hit_at` 已有），记忆之间**没有任何边**，也没有会衰减的连续强度。

- [x] **5.1 边与强度字段**：`related`（`[{id, weight}]`）+ `activation`（浮点）。`dynamic: strict` 下加字段免 reindex（阶段 0 已验证）。→ 2026-10-30
- [x] **5.2 写入建边**：写入后 kNN 取候选（排除自身），相似度落在 `[0.55, 0.85)` 的建边，权重取相似度，禁自环、合并而非覆盖。→ 2026-10-30
- [x] **5.3 扩散激活**：召回按 `own + α·Σ(neighbor·w)` 重排，`α` 可配、**默认 0**。→ 2026-10-30（实测无正收益，保持 0，见优化路线 5.3）
- [ ] **5.4 激活回写** ⏸ **跳过**：`activation` 没有消费者，且 `hit_count` 已覆盖同一信号（2026-10-30 定，见优化路线「阶段 5 收尾」）。
- [ ] **5.5 激活衰减** ⏸ **跳过**：现有 `recency` 乘子 + 类型半衰期已等价；库里 `hit_count` 总和只有 3，测不出差异（同上）。

### 阶段 6 · 情绪维度

现状：记忆没有情绪属性，检索也不看「当下状态」。

> ✅ **能自己感知（2026-10-30 更正）**：`ctx.on` 是 cordis 基座能力，**监听事件不需要写进 `inject`**——上一版把它当成能力边界，是错的。宿主 0.2.1-rc.3 提供 11 个 agent 事件，6.4 需要的两类都在：`agent/inbox/inserted`（用户消息原文）、`tools/result`（工具结果）、`agent/request-error`（请求失败）。代价：事件量大要节流；「夸奖/批评」是语义判断，关键词规则不可靠。

- [x] **6.1 记忆效价**：`valence`（-1~1）+ `arousal`（0~1），`memory_save` 的两个可选参数，不给就不写字段（缺失 ≠ 中性），越界直接拒绝。→ 2026-10-30
- [x] **6.2 状态存取**：离散情绪 + 强度（`mood_valence`/`mood_arousal`）+ 半衰期（3h），复用 `personal_memory_<uid>` 的固定文档 `__mood__`（`status=mood`，不进检索），**只由事件改，不由模型自述改**。→ 2026-10-30
- [x] **6.3 情绪一致召回**：`score × (1 + β × 相似度)`，相似度用 `1 - |v-m|/2`；只提权不降权，未标 valence 的条目**不参与**。`β` 可配、**默认 0**。→ 2026-10-30（库里 valence 覆盖 0 条，实测任意 β 都零影响，见优化路线）
- [x] **6.4 事件驱动与审计**：监听 `agent/inbox/inserted`（用户夸奖/批评，关键词规则）与 `tools/result`（工具成功/失败，排除自家记忆工具）→ 更新状态并留事件痕迹；同 agent 30 秒节流。→ 2026-10-30

### 阶段 7 · 自我迭代（人在环）

现状：有 `memory_promote`、pending 审核台、审计链，但没有「关于自己」的收敛路径。

- [x] **7.1 identity 类型**：新增 `memory_type=identity` 承载稳定自述；半衰期 3650 天（其它类型最长 365）；**默认不进普通检索**，显式 `memory_type: [identity]` 才返回。→ 2026-10-30
- [x] **7.2 夜间提炼**：`memory_traits` 读近 N 天 active 记忆（排除 identity）→ 模型归纳 → 写 `memory_type=identity` + `status=pending` 候选（带 `evidence_ids`）。**默认 dry_run**；模型不可用就跳过。→ 2026-10-30
- [x] **7.3 采纳闸门**：`memory_review`（list/approve/reject/history）——只有 `pending`+`identity` 能被采纳；采纳 → `active`、拒绝 → `archived`（不删）。**个人审计** `personal_audit_<uid>` 每个用户都能写，共享 `memory_audit` 尽力写；痕迹同时落在条目上。→ 2026-10-30
- [x] **7.4 版本与回滚**：`memory_history`（versions/rollback）——沿 `supersedes` / `superseded_by` 双向走完整条链（上限 10 跳防环）；回滚**不删内容**：新版置 `archived`、旧版恢复 `active` 并清 `superseded_by`。→ 2026-10-30
- [x] **7.5 锚点保护**：`anchor` 字段 + `memory_review action=anchor`（设/取消，只有生效中的 identity 能设）。锚点条目**退出提炼素材池**（`collectTraitSources` 用 `must_not term anchor:true` 排除），所以不会被重新归纳成一条差不多的候选。→ 2026-10-30

### 阶段 8：让它自己跑起来（2026-10-31 提出）

**背景**：阶段 5/6/7 的能力都有了，但**没有任何调度器在跑它们**。`crontab` 里只有
`consolidate`（整理）和 `export`（镜像）两条，`memory_traits`（身份归纳）从头到尾只能手动触发——
README 里叫「7.2 夜间提炼」，实际夜里跑的不是它。补上调度，这套东西才算闭环。

#### 凌晨的既有时间表（2026-10-31 实测，不是凭印象）

```
00:00  logrotate / dpkg-db-backup
00:20  DSH 快照 archive.sh --live
01:00  backup-server「文件全量备份」   实际跑约 7 分钟（01:00:00 → 01:06:49）
03:10  consolidate（memory-cron）
03:30  export（memory-cron）＋ ES SLM 快照（同一分钟，两者本来就撞着）
04:10  backup-server 元数据库自备份
04:30  backup-server 保留清理
04:40  backup-server 另一条内置任务
05:00  backup-server 存储巡检
```
证据：`backup-server` 的 `/data/backup-center.db`（policies.cron、backup_runs 起止时间）
与容器内 `app/scheduler.py` 的 `CronTrigger.from_crontab(...)`；ES 快照时间在
`scripts/init-snapshot.sh`（SLM 按 UTC 解释，写 `0 30 19 * * ?` = 北京 03:30）。

**结论：原定的 04:00 是全晚最挤的点**（前后十分钟内 04:10/04:30/04:40/05:00 连着四条）。
**02:30 是 01:00 备份结束到 03:10 整理之间唯一的整块空档**，所以 8.1 落在这里。

- [x] **8.1 提炼定时（traits）**：每天 **02:30** 自动跑一次 `memory_traits`，产出 `pending` 候选等早上审。→ 2026-10-31（9.6 改为插件内建）
  - 实现：`index.ts` 里每小时醒一次、判断「今天过点没」（启动 90 秒后也探一次），配置键
    `traits.{enabled,at,days}`（默认 02:30 / 回看 14 天）。**不占 crontab 槽位、也不依赖会话**——
    初版用的 `schedule_create` 已撤掉（它绑会话，归档/换会话就得重挂）。
  - 为什么必须插件内建：`runTraitsJob` 的 `summarize` 由插件层注入，用的是 `ctx.get('llm')`；
    模型凭据在 dsh 进程里，cron 环境拿不到（`dsh headless` 也救不了，本机没有那个 app 包）。
  - ⚠️ 精度是「整点」：实际执行可能比配置时间晚最多 1 小时（02:30 → 03:00 前）。
    进程内 `lastRunDate` 只防当天重复，重启当天最多重跑一次（多一次 kNN 判重，无害）。
  - 素材不足（`< TRAIT_MIN_EVIDENCE`）时 `runTraitsJob` 自己会跳过，不必在 prompt 里预判——省 token 的
    那道「先数条数」的前置检查，实测省不下什么，反而多一次检索。
- [x] **8.2 每日日记（diary）**：每天 23:30 写一篇当天回顾。→ 2026-10-31（9.5 落地为「每日回顾」）
  - 实现：`journal.ts`，`memory_type=journal`、`memory_id=journal-<YYYY-MM-DD>`，存个人索引；
    `config.journal.{enabled,at}`（默认 23:30）。素材只读本机本人的会话日志
    （多帧 zstd 必须用系统 `zstd -dc`，Node 只解第一帧）；少于 3 轮对话直接跳过。
  - 存储最终选「个人索引 + 面板日记栏」，没有另建独立索引；同一天重跑是覆盖而不是追加。
  - ⚠️ **检查粒度是 5 分钟，不是 1 小时**（2026-10-31 巡检发现死循环）：原先每小时醒一次，
    而 due=23:30 之后的下一个整点是 00:00（当天已过）→ 长进程**永远不会写当天回顾**
    （17:29 启动的进程：23:29 差一分钟、00:29 已跨天）。改 5 分钟后，23:30 之后 5 分钟内写。
    当日 23:30 之前不会打 ES 请求（不到点直接 return）。
  - 默认**不进检索**：已并入 `NON_FACT_MEMORY_TYPES`（2026-10-31 巡检补齐——此前只排了 identity，
    persona 会冒充事实排到第 1）。注意补看某天要用 `memory_type: ['journal']` 显式查。
  - 诚实边界：日记是「读记录之后的我」写的，不是连续意识；不写「我今天一直在想你」这类伪记忆。
- [x] **8.3 面板「日记」视图**：按日期翻看，能直接读。→ 2026-10-31（9.4 的 `/diary` + 人格页「日记」卡片）
  - ⚠️ 跨天重启不会自动补前一天的回顾（`maybeRunDailyJournal` 只认「今天」，00:10 重启时当天 23:30 还没到）。
    漏了就用 `memory_journal date=YYYY-MM-DD` 手动补。

#### 8.1 附带修掉的真 bug：推理模型的 reasoning 被当成答案

`memory_traits` 之前永远「0 条候选」，而模型明明在思考。根因不在 `maxTokens`（那是上次的判断），
而在 `index.ts` 的回落逻辑：

```
正文（text-delta）为空 → 回落到 reasoning-delta 的内容 → 拿思考过程去 parseTraitsOutput
```

`mimo-v2.6-flash` 是推理模型，只发 reasoning，于是每次喂给解析器的是「Let me identify stable
patterns…」这种思考文本，`parseTraitsOutput` 自然解析出 0 条。修法是**换路由而不是调参**：
`distill.provider/model` 改为 `deepseek-official/deepseek-flash`（纯输出模型，默认会话就用它）。
改完实测：80 条素材 → 8 条候选（干跑），`dry_run=false` 新写入 7 条 pending。

**教训**：`[诊断]` 前缀与「0 条候选」在结果上很容易混淆，区分二者要看 `rawPreview/rawLength`；
判断模型是否可用，不能只看「有没有返回字符」。

#### 8.1 补：同义候选判重（2026-10-31）

**症状**：第一次真写库后回头审，14 条 pending 里发现三对同义重复——
「自建 UI 用中文」「减少提交次数」「告警不重复」各出现了两次，措辞不同、意思一样。

**根因有两层**：

1. 幂等键是**精确内容哈希**（`trait-${hashContent(content)}`），模型每批换句措辞就当成新条目；
2. 更根本的是**候选压根没写 `embedding`**。`writeTraitCandidate` 只写了标量字段，
   而语义判重靠 kNN，kNN 只查得到有向量的文档 —— 所以连「判重」这件事都无从谈起
   （实测 14 条 pending 的 `has_vec` 计数为 0）。

**修法**：

- `writeTraitCandidate` 给候选补 `embedding`（失败只记日志，不阻断写入）；
- 新增 `findTraitDuplicate`：kNN 比对 `pending`/`active` 的 identity 条目，阈值
  `TRAIT_DEDUP_MIN_SCORE = 0.9`；`archived`（已拒绝）**不参与**——后来找到更强证据应当允许重新提出；
- `runTraitsJob` 逐条先判重再写，结果多一个 `duplicates` 计数（409 冲突也计入，避免"写了 0 条却不说为什么"）；
- embedding 不可用时**跳过判重、照常写入**：判重是省人工的手段，不能把提炼卡死。

**实测**（真实 ES + 真实向量）：

| 输入 | 结果 |
|---|---|
| 「界面、面板和日志统一用中文…」 | 命中 `trait-82ad203e`，score **0.9620** |
| 「少提交，文档和代码放进一个 commit」 | 命中 `trait-2c8911bd`，score **0.9791** |
| 「新增告警前先看有没有重复规则」 | 命中 `trait-a3158094`，score **0.9415** |
| 「变量名写得像动词，函数尽量短」（对照） | 不命中 ✓ |

存量补齐用 `node scripts/backfill-trait-embedding.ts --apply`（幂等，只补缺向量的），
本次补了 14 条、0 失败。

**前提是 Ollama 在跑**：判重失败时会静默降级（照写不判重）、`memory_save` 也会提示
「仅关键词可检索」——所以它不能是个"想起来才起"的进程。2026-10-31 已收进 systemd --user：

```ini
# ~/.config/systemd/user/ollama.service
ExecStart=%h/.local/ollama/bin/ollama serve
Environment=HTTP_PROXY=  HTTPS_PROXY=  ALL_PROXY=   # 旧启动命令写死过代理，Clash 没跑时拉模型会 refused
Environment=NO_PROXY=127.0.0.1,localhost
Restart=always
RestartSec=3
TimeoutStartSec=120        # bge-m3 1.16 GB，冷页缓存下加载要几秒
```

`loginctl enable-linger xqh` 已开（否则登出后 user manager 会把它一起收走）。
实测：`systemctl --user restart` 正常；`kill -9` 后 7 秒内自动拉起、PID 变化、接口恢复。

⚠️ **在 dsh 的 workspace-write 沙箱里操作它要提权**：沙箱内连不上 user bus
（`Failed to connect to bus: No medium found`），即使手动设了
`XDG_RUNTIME_DIR=/run/user/1000` + `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus`
也报 `No data available`。改 unit / restart / enable-linger 都要走 danger-full-access；
只读探活（`curl 127.0.0.1:11434/api/tags`）在沙箱内就够。

**一条时间线**（补完后的记忆的一天）：

```
02:30  traits     （8.1）  归纳稳定自述 → pending 等你审
03:10  consolidate（已有）  整理去重、改写、标团队候选
23:30  diary      （8.2）  写当天回顾
```

### 阶段 9：人格与 UI 内建（2026-10-31 定方案并施工，9.1–9.4 / 9.6 / 9.7 已完成）

**背景**：人格文本与表情包目前来自 `dsh-cyrene-theme`（另一个插件）。用户要求不依赖第三方插件——
「不可能每个人都装昔涟插件」，希望这套东西自己能长出人格。方案已定稿，见
[人格与 UI 内建方案](docs/人格与UI内建方案.md)。

三个要点先记在这里：

1. **人格拆两层**：内核 `seed` 由部署者写（不许模型改），表层 `learning` 由机器归纳且**必须人工审核**
   才生效——否则「我是谁」会被慢慢漂掉。
2. **表情包不需要客户端插件**：提示段在宿主侧生成（路径用 `import.meta.url` 动态拼，换机器自动跟着变），
   图片由前端按 markdown 渲染。客户端插件只在做设置页/皮肤时才需要。
3. **`identity` 与 `persona` 严格分开**：前者说的是**用户**（「你倾向于先给结论」），后者说的是**我**
   （「我习惯先给结论再解释」）。拿用户画像当人格，长出来的是用户的镜像。

- [x] **9.1 人格内核 + 注入段**：填 seed 即有人格，零第三方依赖。→ 2026-10-31
  - 配置在 profile：`config.persona.seed`（YAML 块标量）+ `enabled`；**空 seed 不注入**，
    不留只有标题的空壳（宿主对空段整段丢弃）。
  - 段 order **3199**，排在记忆段 3200 之前——先讲「我是谁」，再讲「我知道什么」。
  - seed 里的 `{{` / `}}` 会被换成全角：宿主对段文本做变量插值，未知引用会让**整个提示词组装失败**
    （失败方式是模型收不到任何提示词，不是少一句话）。
  - 验收：重启后系统提示里出现「# 我的人格」+ 种子正文，位置在「## 记忆库」之前（已确认）。
- [x] **9.2 表情包内建**：定义从**包外目录**读，图片不打包。→ 2026-10-31
  - 配置：`config.stickers.{enabled,dir,maxPerTurn}`，`dir` 默认 `~/.dsh/stickers`
    （支持 `~` 展开），目录里放 `stickers.json` + 图片。
  - **图片仍不打包进 npm 包**（`files` 字段不含 `stickers/`），但**进 git 仓库**：`stickers/` 是
    基础套，部署脚本从这里取，各容器自带、版本一致。起因是 2026-10-31 晚用户把 125 上配好的
    一套（11 张中文 + 12 张情绪图，共 23 张 7.1 MB）抽过来当基础套——"每个部署自己放图"的代价
    变成"部署漏了就没表情包"，比 7 MB 体积更贵。
  - 提示段 order **3202**（心情段之后），每条带 `label｜when → ![label](<绝对路径>)`，
    路径由 `dir + file` 现拼，换机器/换目录自动跟着变。
  - 健壮性：目录缺失、`stickers.json` 坏了、条目缺 `when` —— 一律只是「不注入」或丢弃那一条，
    **不报错、不刷日志**（装饰能力不能成为启动前置条件）。
  - 验收：系统提示里出现「## 表情包」段，11 条路径指向 `~/.dsh/stickers/…`（已确认）。
- [x] **9.3 人格表层学习**：从会话记录归纳「我自己的倾向」，pending 待审。→ 2026-10-31
  - 工具 `memory_persona`（默认 dry-run）。素材 = 最近 N 天会话里「我的回复 + 你随后的话」配对，
    只认 `source.kind === 'user'` 的真人消息；产出 `memory_type=persona` 的 pending 候选，
    带结构化证据（片段编号 + 双方原话摘录，存 `evidence_ids` 这个 `enabled:false` 字段）。
  - 审核复用 `memory_review`（已扩到 identity/persona 两类），approve 后进入人格段
    `## 我学到的倾向`（5 分钟缓存刷新，最迟 5 分钟进提示）。
  - ⚠️ 两个坑都记在代码注释里：**会话日志是多帧 zstd**（Node 只解第一帧，2.3 MB 只出 203 字节，
    实测改用系统 `zstd -dc`）；**模型固执地用「你」指代被描述者**（试过四版校验都会丢光候选，
    最终改成「人称归一」：代码把「你」换成「我」，判定交给人工审核）。
  - 验收：40 个片段 → 6 条候选 → 全部 approve → 系统提示出现「## 我学到的倾向」+ 6 条（已确认）。
- [x] **9.7 基础表情包随仓库分发**：23 张（11 中文 + 12 情绪），`stickers/` → 2026-10-31
  - 来源：用户在 125 的 `dsh-xqh` 里配的一套，抽出后并进仓库；本机 `~/.dsh/stickers` 同步为全集。
  - 新增 12 张补的情绪维度：疑惑 / 托腮 / 失望 / 惊讶 / 嫌弃 / 无语 / 坏笑 / 漠然 / 撒娇 / 生气 / 赌气 / 害羞。
  - `deploy-panel.sh` 与 `deploy-persona-pack.sh` 均改为**仓库优先**（`stickers/` 存在就用它，
    否则退回 `~/.dsh/stickers`）；解包到 `/data/dsh` 得到 `/data/dsh/stickers`，
    **不能加 `--strip-components`**（会散到 `/data/dsh` 根，2026-10-31 踩过一次）。
  - 校验：`stickers.json` 的 `items` 与目录里的图片必须一一对应（23↔23），部署脚本不校验，
    靠人工；面板「人格 → 表情包」卡片会显示每条的 `exists`，缺图能一眼看出。
- [x] **9.4 面板 UI**：人格 / 表情包 / 审核 / 日记。→ 2026-10-31
  - 宿主新增三个只读接口：`/persona`（内核 + 已采纳倾向）、`/stickers`（清单 + 文件是否存在）、
    `/diary`（人格与自述条目的 active/archived 变迁）。
  - 客户端新增「人格」tab：四块卡片（内核 / 学到的倾向 / 表情包 / 日记），中英文案齐全。
  - 审核闸门放开到 `identity + persona`：待采纳列表标注类型，采纳后人格条目 5 分钟内进提示段。
  - ⚠️ 两个面板坑（都记在代码注释里）：**`mergeConfig` 只遍历 DEFAULTS 的键**会静默丢弃
    `persona`/`stickers` 这类新组（插件读得到、面板显示为空）；**四个 `card(...)` 写在一个
    `h('div', null, a, b, c, d)` 里**时括号错位会让前三个变成逗号表达式，只返回最后一个
    （语法检查照样通过）。两处都补了结构守卫测试。
### 多容器部署（125 工作站）

两个脚本，分工不同：

| 脚本 | 装什么 | 用在哪儿 |
|---|---|---|
| `scripts/deploy-panel.sh` | 主插件 + 面板 + CLI，全套 | 主号容器（要有完整记忆库界面） |
| `scripts/deploy-persona-pack.sh` | 只主插件 lib + `persona`/`stickers` 段 + 表情包 | 其他成员容器（方案 A：各自 `mem-user-<uid>` 账号连共享 ES） |

```bash
./scripts/deploy-persona-pack.sh dsh-test    # 先拿测试容器验证
./scripts/deploy-persona-pack.sh             # 再跑其余（除 dsh-xqh / dsh-es）
```

两个坑记一下：`docker cp <容器>:<路径> -` 输出的是 **tar 流**不是文件内容（取配置用 `docker exec cat`）；
tar 解表情包时**别加** `--strip-components`，否则文件会散落到 `/data/dsh` 根目录。

- [ ] **9.5 可选**：皮肤与背景

### 本机部署与同步（2026-10-31 踩坑后补）

本机这份插件有**三层文件**，改完代码要同步前两层：

```
仓库 lib/                                                  ← npx tsdown 构建这里
  ↓ scripts/sync-local-plugin.sh
~/.dsh/local-plugins/dsh-memory-es/lib/                    ← profile 的 file: 依赖指向它
  ↓ 同一个脚本
~/.dsh/profiles/web/node_modules/dsh-memory-es/lib/        ← dsh 真正加载的是这份
```

坑在于 **`file:` 依赖并不等于链接**：profile 的 `package.json` 写的是
`"dsh-memory-es": "file:~/.dsh/local-plugins/dsh-memory-es"`，而 pnpm 又把目录**拷贝**进
`node_modules`。两份都是独立副本，只构建仓库的话，重启 dsh-web 后跑的还是旧代码——
2026-10-31 就这样白重启了一次：判重的 `skipped_duplicate` 在仓库 lib 里 grep 得到，
profile 那份却一行没有，日志上表现为「8 条候选全写、duplicates=0」。

**判据**（两条都要满足）：

1. `bash scripts/sync-local-plugin.sh --check` 两处都显示「一致」；
2. dsh-web 进程启动时间晚于 `lib/index.js` 的 mtime。

面板是另一条链：`scripts/sync-local-panel.sh`（`panel/*.js` + 面板内置的 CLI 源码）。
主插件和面板都改过，两个脚本都要跑。

**重启**：本机 `systemctl restart dsh-web` 会被 polkit 拦（`Interactive authentication required`），
实际可行的是给主进程发 SIGTERM，靠 unit 的 `Restart=always` 拉起；
沙箱内看不到宿主 PID，需要 danger-full-access。

### 推送约定（2026-10-31 起）

两个远端并存，**什么时候推不同**：

| 远端 | 地址 | 什么时候推 |
|---|---|---|
| `origin` | 自建 Gitea | **默认就推这个**，每次提交后推 |
| `github` | `xqh0405/dsh-memory-es`（公开） | **只在部署者明确说「推 github」时才推** |

理由：GitHub 是公开镜像，推一次就进历史。什么时候同步交给部署者明确决定，
比按固定频率自动推更可控——也不要为了「看起来自动」而去建一个每天跑的定时任务。

推 GitHub 之前统一做一遍脱敏自查（真实域名 / 内网 IP / 家目录 / 用户名）。

```bash
git push origin main          # 默认
git push github main          # 仅当部署者明确要求
```

### 边界

原先是「只记怎么想起来，不管用什么口吻说」。**阶段 9 起这条边界被部署者主动放宽了**：
人格内核（`config.persona.seed`）与表情包说明都由本插件自己注入，不再依赖
`dsh-cyrene-theme` 这类外部人格插件——理由是「不可能每个人都装它」。

但「两份真相」这条仍然守：口吻与边界的唯一来源是 `config.persona.seed`（人写、模型不改）；
记忆库里 `identity` 说的是**用户**（「你倾向于先给结论」），阶段 9.3 的 `persona` 说的是**我**
（「我习惯先给结论再解释」），两者不混用。

## 文档

- [开发文档](docs/开发文档.md) —— 索引与映射、权限模型、Docker 部署、插件工具契约、混合检索、整理管道、实现方案、施工清单、风险与里程碑。
- [优化路线](docs/优化路线.md) —— 五个阶段的实施记录、参数标定过程，以及**被实测否决的方案**（单一 margin 判空、自动 supersede、agreementBonus）与原因。
- [开源记忆项目调研](docs/开源记忆项目调研.md) —— 10 个同类项目的机制对比，附 Neo4j 分图可行性分析。
- [人格与UI内建方案](docs/人格与UI内建方案.md) —— 阶段 9 的设计：人格两层（seed/learning）、表情包数据模型、面板 UI、分阶段验收与未决问题。

## 三个已定的关键决策

1. **embedding = `bge-m3`（1024 维）**：不用本机 `nomic-embed-text`（768 维、偏英文）。
2. **个人库 = 一人一索引 `personal_memory_<user_id>` + 索引级 ACL**：ES 免费版没有 DLS（实测 403），所以隔离靠索引 ACL，不靠文档级过滤。
3. **写入 = 真实身份，不用共享写账号**：2026-10-26 起改成「一人一账号 `mem-user-<uid>`」单账号模式，个人库读写都由本人账号承担、团队库按角色授权；`mem_writer`（曾能写 `personal_memory_*` 通配）**已废弃并删除**，旧的三账号（read/writer/consolidator）只在未迁移的部署里作回落。工具参数里始终没有 `user_id`（F1），索引名也由 `identity.userId` 派生（F2）。

理由、代价与否决方案见开发文档 §14（D1–D6）。

## 一句话结论

没有现成插件覆盖这个闭环，需要自建；本仓库的起点是先验证环境与判据，再落代码。
