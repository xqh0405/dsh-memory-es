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
