# 上下文树 ctxtree

把一个项目下所有 Claude Code 对话（`~/.claude/projects/<项目>/*.jsonl`）整理成一张横向的“线路图”：

- 每个会话是一条横线，线上每一站是一轮对话（你的一次提问 + Claude 的全部回复）。
- 从别的会话分叉、继续出来的会话，会从分叉点接出一条支线。
- 子代理画成虚线支线，挂在派出它的那一轮下面。默认收起，点卡片上的「子代理 N」展开。
- 上下文被压缩的那一轮带虚线圈；卡片上的细条是这一轮结束时的上下文占用。

生成的是单个 HTML 文件，不联网、不依赖别的文件，双击就能打开。

## 用法

需要 Node 18 以上，无第三方依赖。

```bash
node bin/ctxtree.mjs E:\PaM --open
```

```bash
node bin/ctxtree.mjs list
```

```bash
node bin/ctxtree.mjs all --open
```

- `[项目]` 可以是项目路径（`E:\PaM`）、转录目录名（`E--PaM`）或转录目录的完整路径；不写就取当前目录。
- 默认输出到 `./out/`，`-o` 可以改。`all` 会给每个项目各生成一份，外加总目录 `index.html`。
- `--md`、`--json` 同时导出 Markdown / JSON。
- 文件太大时用 `--no-tools`（不保存工具输入输出）、`--no-thinking`、`--max-tool 1000`。

## 页面里的操作

| 操作 | 作用 |
| --- | --- |
| 滚轮 / Shift+滚轮 / Ctrl+滚轮 | 横向移动 / 纵向移动 / 缩放（都带缓动；触控板双指直接二维平移，捏合缩放） |
| 拖动画布（卡片上也能拖）、点缩略图 | 平移，松手后带惯性滑动；跳到某处 |
| 点卡片 | 右侧打开这一轮的完整回复，包括工具调用、思考、插话、压缩 |
| ← → ↑ ↓ | 沿线路切到上一轮/下一轮，或切到上下相邻的线路 |
| `/` | 搜索；Enter / Shift+Enter 在命中之间切换，收起的子代理里的命中也会自动展开 |
| 导出 | 整个项目的 Markdown、选中这一轮的上下文链（从起点到这一轮）、树数据 JSON |

## 结构

- `src/parse.mjs`：读取转录，切分轮次，接上压缩、分叉和子代理。
- `src/template.html`：查看器页面，数据以 JSON 内嵌。
- `src/export-md.mjs`：Markdown 导出，CLI 和页面共用同一份代码。
- `src/render.mjs`：把数据和导出代码塞进模板；工具输入输出单独放进一个 `ctx-bulk` 块，展开时才解析。
- `bench/stress.mjs`：压力测试页。

```bash
npm test
```

```bash
npm run stress
```

`npm run stress` 把一个真实项目的数据复制 12 份生成 `out/stress.html`（上千轮、几百条线路、约 30 MB），用来检查大项目下的流畅度。
