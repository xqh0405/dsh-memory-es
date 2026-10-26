# .125 内网共享知识库（dsh-es）

容器 `dsh-es`，目录 `/docker/dsh-es`，集群 `dsh-memory-es`，ES 8.19.23 + IK。
给整个局域网（含 9 台成员的 DSH 容器）当统一知识库。

## 目录

```
/docker/dsh-es/
  docker-compose.yml     # 本目录这份
  .env                   # ELASTIC_PASSWORD / 各业务账号密码（600）
  certs/                 # ca.crt + p12（SAN 见下）
  users/<uid>.env        # 每人一份账号密码（600，由 scripts/init-user.sh 生成）
  data/  snapshots/      # 存储
  plugins/analysis-ik/   # 分词器（版本必须与 ES 一致）
  scripts/               # 仓库 scripts/ 的副本（init-* 用）
```

## 网络

| 用途 | 地址 |
|---|---|
| 局域网其它机器 | `https://192.168.1.125:9200` |
| 同宿主上的 dsh-<uid> 容器 | `https://dsh-es:9200`（容器名） |

**为什么容器不用宿主 IP**：容器访问宿主映射端口时，DNAT 的目标会变成 ES 容器 IP，
于是变成「跨 bridge 转发」，被 docker 的 `DOCKER-ISOLATION` 丢掉（实测超时 133s）。
而 11434 那种直接监听宿主的端口走 INPUT 链，是通的 —— 两条路径不同，别互相推断。

所以 ES 容器除了自己的 `dsh-es_default`，还加入了每个成员容器所在的网络
（compose 里的 `networks:` 列表）。**新增成员时必须在这里补一个网络**。

### 125 的防火墙补丁（改过 `/etc/ufw/after.rules`）

docker 给成员容器分的是 `192.168.16.0/20` 这类段，会命中 after.rules 里那条
「`-d 192.168.0.0/16` SYN DROP」（防扫描规则），导致同桥互访也被丢。
已在该文件里、`-s 192.168.1.0/24` 放行之后补一条：

```
-A DOCKER-USER -j RETURN -s 192.168.0.0/16 -d 192.168.0.0/16 -p tcp --dport 9200
```

只放行 docker 网段互访 9200，不碰其它目标。改完 `ufw reload` 生效，备份在
`/etc/ufw/after.rules.bak-eslan-*`。

## 证书

CA `certs/ca.crt`（分发给客户端，配 `NODE_EXTRA_CA_CERTS` / `--cacert`）。
节点证书 SAN：`dsh-es`、`es-host.local`、`localhost`、`127.0.0.1`、`192.168.1.125`、`10.9.0.10`，10 年。
重新生成要同时给 `--name --dns --ip`，否则 hostname 校验失败。

## 账号

一人一账号 `mem-user-<uid>`，靠「一人一索引 + 索引级 ACL」隔离（basic license 没有 DLS）：

| 档 | 角色 | 能力 |
|---|---|---|
| 普通成员 | `mem_personal_rw_<uid>` + `mem_team_read` | 个人库读写 + 团队库只读 |
| 管理员（xqh） | 上面 + `mem_team_write` | 团队库读写 + `memory_audit` 写 |

初始化顺序（全部幂等）：

```bash
export ES_DIR=/docker/dsh-es ES_URL=https://192.168.1.125:9200
bash scripts/init-indices.sh      # 模板 + 个人索引 + team_knowledge
bash scripts/migrate-s9.sh        # 审核字段 + memory_audit
bash scripts/init-security.sh     # 角色 + xqh(team-write)
bash scripts/init-user.sh <uid> --team-read   # 其余成员
```

⚠️ `init-user.sh` 只建角色和账号，**不建个人索引**，要先用 elastic 显式建
`personal_memory_<uid>`（空 body 继承模板）。

## 容器侧插件安装（关键）

装一个本地插件要让 dsh 真正加载，三步缺一不可：

1. `dsh plugin --profile web add file:/data/dsh/local-plugins/dsh-memory-es`
   （转发给 pnpm，更新 lockfile 与 node_modules；手工 cp 不算数）
2. `package.json` 的 `dependencies` 有该条目
3. **`package.json` 的 `dsh.profile.bundles` 加上插件名** —— 这才是加载清单，
   少了它插件装得再好也不会被加载（接口 404、日志无输出，很容易误判为装失败）

配置写在 `profiles/web/cordis.patch.yml` 的 `- id: dsh-memory-es` 段里，
`es.url` 用 `https://dsh-es:9200`，`caCertPath` 指 `/home/node/ca-memory-es.crt`
（CA 放在 home 卷 `dsh-home-<uid>` 里）。

`dsh-mnemon` 与本插件的工具名不冲突：本插件占 `memory_*`（search/save/promote/distill/
update_status），mnemon 占 `mnemon_*`。两个可以并存，迁移完成后 `memory_search` 查的是
ES 新库，`mnemon_recall` 还是旧库。

## 个人记忆迁移（从 dsh-mnemon）

⚠️ **一个容器的 `.mnemon` 里有三类东西，别只看其中一类就判「空库」**：

```
/docker/lib/docker/volumes/dsh-home-<uid>/_data/.mnemon/
  data/default/mnemon.db          # 记忆条目（insights 表）+ 关系图（edges，不迁）
  runtime/memories.json           # 热记忆【结构源】；MEMORY.md/USER.md 只是它的文本投影
  documents/active/<id>.md        # 项目文档（长文，不是"记忆条目"）
```

`insights` 空不代表没记忆——热记忆和 Documents 都在，2026-10-26 排查时就栽在这一步。

### 一、记忆条目（insights）

表 `insights` 是结构化记忆（`edges` 是关系图，本插件没有对应概念，不迁）。

```bash
cd /docker/dsh-es
ES_PW=$(grep '^MEM_PASSWORD=' users/<uid>.env | cut -d= -f2-)
python3 scripts/migrate-mnemon.py --source insights \
  --db /docker/lib/docker/volumes/dsh-home-<uid>/_data/.mnemon/data/default/mnemon.db \
  --user <uid> \
  --es https://192.168.1.125:9200 --ca /docker/dsh-es/certs/ca.crt \
  --username mem-user-<uid> --password-env ES_PW \
  --ollama http://127.0.0.1:11434 --model bge-m3
```

- 以 insight id 作 ES 文档 id，**幂等**
- 只迁 `deleted_at is null`；`content` 超 4000 字符截断
- `category` 映射：`insight`/`general` 并入 `fact`（mnemon 比本插件多两档）
- `semantic_keywords` 收 tags + entities

### 二、热记忆（runtime/memories.json）

**必须从 `memories.json` 读，不要解析 `MEMORY.md`**：后者是前者的投影（`§` 分隔 + 元数据行），
解析文本容易把 `[importance=...]` 行混进正文。结构源是
`{version, entries:[{content, created_at, updated_at, target, importance, origin, branches?}]}`。

```bash
python3 scripts/migrate-mnemon.py --source runtime \
  --runtime-file /docker/lib/docker/volumes/dsh-home-<uid>/_data/.mnemon/runtime/memories.json \
  --user <uid> --es https://192.168.1.125:9200 --ca /docker/dsh-es/certs/ca.crt \
  --username mem-user-<uid> --password-env ES_PW \
  --ollama http://127.0.0.1:11434 --model bge-m3
```

- 热记忆没有 id，用 `sha256(用户|归一化正文)` 派生成 `rt-<32hex>` 作文档 id → **幂等**
- `target=user`（用户画像）→ `memory_type=preference`；`target=memory` → `fact`
- 正文里的 `[DSH·环境]` 这类前缀，取第一段作 `domain`（`dsh`），**正文原样保留**
- `importance`（critical/normal/low）本插件的 mapping 没有对应字段，不迁

### 三、Documents（不迁，另行处理）

`documents/active/*.md` 是项目文档（xqh 361 篇 3.2M，多篇超过 4KB）。它们是"知识/文档"，
不是「一句可独立成立的事实」，硬塞进 `personal_memory_*` 要么截断丢信息、要么撑爆 4000 字符上限。
需要时另行决定去向（团队库 `team_knowledge` 或保留在 mnemon）。

### 通用要点

- **必须重算向量**：mnemon 是 nomic-embed-text（768 维），本库 mapping 是 bge-m3（1024 维），
  维度不同不能复用，强行写会 400。125 宿主 Ollama 已有 `bge-m3:latest`。
- 密码走环境变量（`--password-env`），不进 argv
- `distill_state` 直接写 `done`：旧记忆已整理过，再走后台蒸馏只会被重写
- 个人账号没有 `indices:admin/refresh` 权限，脚本末尾手动 refresh 会 403 —— 不是错误，
  等 `refresh_interval`（5s）自动可见
- 先 `--dry-run` 看条数，再 `--limit 5` 试点，最后全量

### 2026-10-26 实测

| 容器 | insights | 热记忆 | Documents | 迁入后索引 |
|---|---|---|---|---|
| xqh | 250 | 78 | 361 篇 | 328 |
| zhongjinqi | 0 | 12 | 20 篇 | 12 |
| zhongyuhang | 0 | 10 | 1 篇 | 10 |
| laoliu / liuxinling | 0 | 5 / 5 | 2 / 15 篇 | 5 / 5 |
| molijin / tanxu / chencan | 0 | 3 / 3 / 3 | 4 / 2 / 1 篇 | 3 / 3 / 3 |
| hongzhihui | 0 | 1 | 0 篇 | 1 |

热记忆合计 120 条全部带向量。


