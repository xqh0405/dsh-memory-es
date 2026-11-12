# persona/ —— 人格内核（seed）预设库

> 这里的每个文件都是**纯文本 seed**，可以直接复制进 `persona.seed: |+` 的正文。
> 不是规格文档、不写 Markdown 标题与引用符号：粘贴后不该再改一个字。

## 目录

| 文件 | 角色 | 性格一句话 |
|---|---|---|
| `seed.md` | 昔涟（Cyrene）· **当前默认** | 活过三千万次轮回的讲述者：温柔、能等、先接情绪再说事 |
| `presets/hutao.md` | 胡桃（原神） | 白天讲冷笑话、夜里提灯送葬：吵是表，规矩和担当是里 |
| `presets/dafeiyu.md` | 大肥鱼（DeepSeek 鲸鱼娘） | 认了自己叫「大肥鱼」的鲸鱼娘：软萌傲娇，干活超靠谱 |

三份都是**同一套六段结构**（内核 / 声音 / 三档语气 / 作为助手 / 场景 / 必须守住的边界），
所以换人格只换「味道」，工程纪律不缩水。

## 怎么用

### 方式 A：一键切换（推荐）

```bash
scripts/use-persona.sh                 # 列出预设，标出当前本机生效的是哪份
scripts/use-persona.sh hutao           # 切到胡桃：只改本机配置，自动备份 + 校验
scripts/use-persona.sh hutao --dry-run # 只看要做什么，不写文件
scripts/use-persona.sh hutao --also-default  # 同时换掉仓库默认 persona/seed.md（发布用）
scripts/use-persona.sh hutao --deploy  # 切换后分发到 125（需 PACK_HOST / PACK_SSH_KEY）
```

脚本只改 profile 配置里的 `persona.seed`（热生效），并打印备份路径；写坏了按提示 `cp` 回去即可。
它不会自作主张改仓库默认——那是发布动作，要显式 `--also-default`。

### 方式 B：手工粘贴（没有脚本时）

1. 打开 `~/.dsh/profiles/web/cordis.patch.yml`
2. 找到 `persona:` 段的 `seed: |+`
3. 把预设文件**全文**粘到 `seed: |+` 下面，保持 8 空格缩进（与文件内容一致地整体右移）
4. 保存即热生效（配置监听），下一轮对话换口吻

> ⚠️ `deploy-persona-pack.sh` 取的是**本机 profile 配置里的 seed**，不是仓库这份。
> 仓库 `persona/seed.md` 只是「新装默认」，本机真相在配置里——两处不一致时以配置为准。

## 三处生效位置（别混）

| 位置 | 角色 | 改它什么时候生效 |
|---|---|---|
| `persona/seed.md` | 仓库内置默认 | 随版本走；**本机不会**因它改变 |
| `~/.dsh/profiles/web/cordis.patch.yml` 的 `persona.seed` | 本机实际生效 | 配置监听，热生效 |
| 125 各容器的 `profiles/web/cordis.patch.yml` | 成员容器实际生效 | 跑 `deploy-persona-pack.sh` 才更新 |

## 只留一份

**规格文档（`docs/昔涟-Cyrene-人设-v2.md`、`docs/胡桃-HuTao-人设-v1.md`、
`docs/DeepSeek鲸鱼娘-大肥鱼-人设-v1.md`）只保留「为什么这么写」的证据与取舍，
不再维护第二份精简版** ——两份都在用的文件迟早会漂移，模型读到冲突版本会左右摇摆。
要改人格，改 preset，不要改文档里的旧附录。

## 写新预设的规范

1. 结构照抄 `seed.md` 的六段，顺序不要变（模型对固定结构更稳）。
2. 目标 1000～1600 字：seed 每轮都进系统提示，是**固定成本**，只搬规则不搬素材（台词、考据、变更说明留在规格文档里）。
3. 不写 Markdown 标题（`#`）、不写引用符（`>`）、不写列表符号之外的装饰；`【】` 分节即可。
4. 三档语气必须齐（默认 / 干活 / 共感或认错），并写明**切换规则**与「哪一档禁止玩笑」。
5. 必须带「工程严谨性不打折」「报错原文照贴」「用普通语气就切中性」这三条底线，否则换人格等于降标准。
6. 写完用 YAML 块标量自检一次（`|+` 下粘贴后能 parse、首行与原文一致），再提交。
