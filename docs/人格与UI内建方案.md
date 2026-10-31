# 人格与 UI 内建方案

> 2026-10-31 定稿（用户要求「不依赖第三方人格插件」）。本文是设计，不含实现。
> 阅读顺序：先看 §1 目标与 §2 现状，再看 §3 设计，最后按 §5 的阶段逐步施工。

## 1. 目标

把「人格」与「相关 UI」收进 `dsh-memory-es` 一个包，做到：

1. **零第三方依赖**：装一个记忆插件，人格与表情包就有，不需要再装 `dsh-cyrene-theme`。
2. **每人可不同**：人格由部署者给的种子决定，不是写死在代码里的某个角色。
3. **会长**：用起来之后，从「我说过什么、你纠正过什么」里归纳出可演化的表层，但**不自动生效**。
4. **可编辑**：种子与表层都能在面板里看、改、审。

非目标：不做皮肤/背景之外的花哨前端；不接管 dsh 的聊天渲染（模型贴 markdown 图片，渲染是宿主的事）。

## 2. 现状（证据，2026-10-31 实测）

### 2.1 `dsh-cyrene-theme` 到底提供了什么

| 能力 | 实现位置 | 机制 |
|---|---|---|
| 人格文本 | `lib/index.js`（宿主侧） | `ctx.systemPrompt` 注入，6 处 |
| 表情包说明 | 同上，41 处引用 `stickers.json` | 把结构化定义拼进系统提示 |
| 设置页 / 皮肤 | `lib/client.js`（88K，客户端） | `dsh.client.platform=web`、`inject: []`、`settings.*` |
| 图片资源 | `meme/`（11 张，2.9 MB） | 模型按提示贴 markdown 图片，前端渲染 |

`stickers.json` 的数据模型（可直接沿用）：

```json
{
  "version": 1,
  "dir": "meme",
  "maxPerTurn": 1,
  "items": [{ "id": "happy", "label": "超开心", "file": "meme/超开心.png",
              "when": "事情成了…", "note": "画面描述，供模型判断" }]
}
```

**结论**：人格文本与表情包提示**全在宿主侧完成**，只有设置页与皮肤才需要客户端插件。

### 2.2 `dsh-memory-es-panel` 怎么做 UI

```json
"dsh": { "client": { "platform": "web", "immediately": true,
                     "inject": ["@deepseek-ai/dsh-client-ui-settings",
                                "@deepseek-ai/dsh-client-locale"] } }
```

它已经是「注入设置面板」的现成先例：`client.js` + `locale/` + `icon.svg`。
新 UI 直接扩这个包，不另起炉灶。

### 2.3 一个必须解决的细节：图片路径

cyrene 的提示里是**绝对路径**：

```
~/.dsh/profiles/web/node_modules/dsh-cyrene-theme/meme/超开心.png
```

换成「每个人都装」就必须**运行时计算**：插件用 `import.meta.url` 推出自身安装目录，
再拼 `assets/stickers/<file>`，写进提示段。写死路径是最容易踩的坑。

## 3. 设计

### 3.1 人格两层

```
① 内核 seed   —— 人写，我不改
   config.persona.seed（profile 配置，随时可改）
   内容：名字、口吻、边界、"我是一个什么样的人"

② 表层 learning —— 我学，你审
   memory_type = persona，status = pending → approve 后 active
   内容：「解释习惯先给结论再补一句为什么」这类可操作的行为倾向
   素材：会话记录里的 assistant 消息 + 你对我的纠正
```

注入时 `seed + active 的 persona 条目` 合成一个 prompt 段（order 3200，排在记忆段 3200 之前），
`text` 写成函数（与 mood 段同样的机制），每轮求值。

**为什么必须是两层**：内核被自动改写就没人能约束它了；表层不学就永远只有种子。
分开之后，「我是谁」由你定，「我怎么说话更顺」我来长。

### 3.2 与现有 `identity` 的分工

| 类型 | 说的是谁 | 用途 | 是否进提示 |
|---|---|---|---|
| `identity`（已有，14 条 active） | **用户**（「你倾向于先给结论」） | 用户画像 | 现状：不进；计划按需查 |
| `persona`（新增） | **我**（「我习惯先给结论再解释」） | 我的人格表层 | 每轮注入 active 部分 |

两条线不能混：拿用户画像当人格，长出来的是用户的镜像。

### 3.3 表情包

- 资源：`assets/stickers/`（图片）+ `assets/stickers.json`（定义），随包分发。
- 提示段由 `stickers.json` 生成：有哪些、何时贴、一次最多几张、贴哪一行、路径怎么拼。
- 渲染：模型贴 markdown 图片，前端负责显示——**不需要客户端插件**。
- 可关：`config.stickers.enabled=false` 时整段不注入。

### 3.4 UI（扩 `dsh-memory-es-panel`）

| 页面 | 内容 |
|---|---|
| 人格 | 编辑 seed（热生效）、查看 active 的表层条目、一键停用 |
| 表情包 | 预览 11 张、看每张的 `when`、可禁用单张 |
| 审核 | persona 候选（pending）与 identity 候选（现有 `memory_review` 的可视化） |
| 日记 | 阶段 8.3 的日记视图（依赖 8.2） |

## 4. 数据模型（新增部分）

```ts
// persona 条目（存 personal_memory_<uid>，memory_type='persona'）
interface PersonaEntry {
  memory_id: string          // persona-<hash>
  content: string            // 「我习惯先给结论，再补一句为什么」
  memory_type: 'persona'
  status: 'pending' | 'active' | 'archived'
  evidence_ids: string[]     // 支撑它的会话/记忆片段
  learned_from: 'session'    // 素材来源，便于追溯
  confidence: number         // 0~1，模型自评（审核参考，不用于自动生效）
}
```

配置新增：

```yaml
persona:
  enabled: true
  seed: |
    我是……（部署者自己写）
  # 表层条目最多注入多少条，防止把提示词撑爆
  maxEntries: 12
stickers:
  enabled: true
  maxPerTurn: 1
```

## 5. 实现流程（分阶段，每阶段可独立验收）

### 9.1 人格内核 + 注入段（最小可用）

**改动**：`config.ts`（`persona.seed/enabled`）→ `prompt.ts`（`buildPersonaSection`）→
`index.ts`（`ctx.systemPrompt.section`）。

**验收**：
- seed 为空的部署**不注入**任何段（等于不存在，不能产生空段落）。
- 填了种子后，`dsh --dump-config` 之外还要能在实际会话里看到那段文本生效。
- 不依赖任何第三方插件。

### 9.2 表情包内建

**改动**：`assets/stickers/`（图片）+ `assets/stickers.json` → `prompt.ts`（生成说明段，
路径用 `import.meta.url` 动态拼）→ `index.ts`（条件注入）。

**验收**：
- 提示段里的图片路径**存在且可渲染**（用一次真实贴图验证）。
- 换一台机器/换安装路径，路径自动跟着变（不写死）。
- `enabled=false` 时整段消失。

### 9.3 人格表层学习

**改动**：新增 `src/memory/persona.ts`（归纳 + 写入 pending）→ 工具 `memory_persona` →
`memory_review` 支持 `persona` 类型。

**素材**：`~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd`，
抽 assistant 消息 + 紧随其后的用户纠正。

**验收**：
- 能产出带 `evidence_ids` 的候选，无证据的丢弃。
- 未 approve 的候选**不进提示**（用一次注入对比验证）。
- 素材不足时跳过，不报错。

### 9.4 面板 UI

**改动**：`panel/`（客户端）+ `locale/`（中英）。

**验收**：设置页出现「人格 / 表情包 / 审核」入口；改 seed 后下一轮生效；候选能 approve/reject。

### 9.5 可选：皮肤与背景

先把 cyrene 的 `Background/` 与主题能力评估清楚再决定要不要接；**不做也不影响前四步**。

## 6. 风险与边界

1. **漂移**：表层自动生效会让「我是谁」被模型慢慢改掉。→ 一律 pending + 人工 approve（复用 7.3 闸门）。
2. **提示词膨胀**：人格段 + 表情包段 + 记忆段 + 心情段会挤占上下文。→ `maxEntries` 与 `maxPerTurn` 设上限，段落总长要做阈值。
3. **图片体积**：11 张 2.9 MB 随包分发，npm 包会变大。→ 可考虑只带低分辨率版本，或首次使用时下载（后者引入网络依赖，暂不采）。
4. **不要把「用户画像」当人格**：`identity` 与 `persona` 严格分开（§3.2）。
5. **诚实边界**：人格段写的是「我倾向于……」，不是「我今天一直在想你」这类伪记忆。

## 7. 待定（需要部署者拍板）

1. seed 存 profile 配置（改完重启生效）还是存库里（能热改，多一个编辑入口）？
2. 表层的演化频率：跟 02:30 的提炼一起跑，还是单独一个人格复盘任务？
3. `dsh-memory-es` 与 `dsh-memory-es-panel` 要不要合并成一个包？（合并=一次安装，代价是包更大、构建更复杂）
4. 表情包是否沿用 cyrene 这 11 张（版权与风格问题由部署者决定），还是允许自定义目录。
