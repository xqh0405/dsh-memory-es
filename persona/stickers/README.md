# persona/stickers/ —— 三套表情包（与人格一一对应）

> 每套是一个独立目录：`stickers.json`（清单）+ 图片文件。
> 目录名与 `persona/presets/` 的人格名一致，切换人格时一起切。

## 目录

| 目录 | 对应人格 | 张数 | 体积 |
|---|---|---|---|
| `xilian/` | 昔涟（Cyrene）· **默认** | 23 | ~7.0 MB |
| `hutao/` | 胡桃（原神） | 14 | ~1.1 MB |
| `dafeiyu/` | 大肥鱼（DeepSeek 鲸鱼娘） | 23 | ~0.8 MB |

清单结构（插件只认这四个字段，缺一个这张就不进提示段）：

```json
{ "id": "happy", "label": "超开心", "file": "happy.png", "when": "事情成了、好消息、折腾很久终于跑通" }
```

## 怎么切

```bash
scripts/use-persona.sh hutao     # 人格与贴图一起切（推荐）
scripts/use-persona.sh hutao --stickers-only  # 只换贴图，不动人格
```

脚本会把配置里的 `stickers.dir` 指到 `<贴图根>/<人格名>`；本机根默认 `~/.dsh/stickers`，
容器是 `/data/dsh/stickers`。手工切就是改这一行，不需要重启（配置监听热生效）。

## 来源与许可

- **xilian/**：自建表情包（用户提供），无外部来源。
- **hutao/**：Telegram 贴纸包 `PyroHuTao`（chpic.su）10 张 + 通用原神表情包 `JustGIEmote` 中胡桃的 2 张
  + GitHub `yxxt448/hutao-emoji` 3 张（思考 / 有想法 / 暗中观察 / 笑开花）。
  角色版权归米哈游，图片版权归各自作者；**仅个人非商业使用**。
- **dafeiyu/**：蓝色大肥鱼档案馆（<https://fisharchive.cc/>，GitHub `EDMOK/blue-fish-archive`），
  许可 **CC BY-NC-SA 4.0**；角色为社区二次设计，单张作品版权归各自创作者。
  取的是站点的 `previews/`（480×480 webp），未作二次修改。

> 三套都只用 `previews` 级别的小图：贴图是聊天里的装饰，480px 足够，几百 KB 一套比原图几十 MB 现实。

## 加新一套的规范

1. 建 `persona/stickers/<人格名>/`，`<人格名>` 必须与 `persona/presets/<人格名>.md` 同名。
2. 图片统一用情绪 id 命名（`happy.webp` / `cry.png`），清单里 `file` 写实际文件名。
3. `id` / `label` / `when` 沿用 `xilian/stickers.json` 的同一套语义——换人格只换图，**判断依据不换**，
   否则模型贴图时机就会随人格漂移。
4. 每张 ≤ 500KB；宁可少几张，也不要塞语义不贴的图（模型会照着 `when` 乱贴）。
