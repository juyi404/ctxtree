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

## 密钥脱敏

解析时就把密钥换成 `[密钥已隐藏]`，HTML、Markdown、JSON 和压力页都只拿到脱敏后的文本，没有开关可以关掉。命令行会报告这次隐藏了几处。

- 认得出的：`sk-` / `ak_` / `sk_live_` 开头的 API key，GitHub、AWS、Google、Slack、Hugging Face 这类固定前缀的令牌，JWT，私钥块，连接串里的密码，`Bearer` 后面的令牌，以及 `xxx_API_KEY=`、`"token": "…"`、`--api-key …` 这类赋值里看起来随机的值。
- 放过的：`$VAR`、`<your-key>` 这类占位，路径，代码里的属性引用，`public_key`，以及 `sk-fragment-cache-v1` 这种不像随机串的标识符。
- 按规则识别，不保证一个不漏；不认识格式的密钥（比如纯数字、很短的口令）可能留在页面里，外发前自己再看一眼。
- 只处理导出的文件。`~/.claude/projects/` 下的原始转录和项目里的配置文件不会动，密钥还在那里。
- 页面里被隐藏的位置显示成绿色的「密钥已隐藏」标签；顶栏和总目录会标出隐藏了几处。

页面本身也收紧了：

- 带内容安全策略（CSP）：只允许执行页面自带的那一段脚本（按哈希放行），不加载任何外部脚本、样式、字体、图片，也不发网络请求。转录里混进的 HTML 就算没被转义也执行不了。
- 回复里的 Markdown 链接只有 `http(s)://`、`mailto:` 和页内锚点会变成可点的链接，在新标签页打开且不带来源页地址；`javascript:`、`file:`、相对路径之类只显示文字，地址放在悬停提示里。
- 总目录 `index.html` 是纯静态页，没有脚本。

仓库本身也有一道检查：`.githooks/` 里的提交前、推送前钩子用同一套规则扫新增的内容，发现密钥就拒绝提交或推送，只打印文件、行号和脱敏后的那一行。克隆下来后执行一次 `npm install`（或 `git config core.hooksPath .githooks`）启用；`npm run secrets` 扫全部历史。`.env`、`*.pem`、`*.key`、`.claude/settings.local.json` 已经在 `.gitignore` 里。

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
- `src/template.html`：查看器页面，数据以 JSON 内嵌。CSP 按主脚本的哈希放行，所以页面里不能写内联事件（`onclick=`）、`eval` 或第二段 `<script>`，事件一律在主脚本里绑定。
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
