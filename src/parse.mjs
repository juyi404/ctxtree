// 读取 Claude Code 的项目转录 (~/.claude/projects/<slug>/*.jsonl)，还原成「上下文树」数据。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker, isMainThread, workerData, receiveMessageOnPort, MessageChannel } from 'node:worker_threads';

export const PROJECTS_DIR = process.env.CLAUDE_CONFIG_DIR
  ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects')
  : path.join(os.homedir(), '.claude', 'projects');

const DEFAULTS = { maxTool: 4000, maxThinking: 20000, thinking: true, tools: true, agents: true };

// ---------- 项目定位 ----------

export function slugOf(p) {
  return path.resolve(p).replace(/[^a-zA-Z0-9]/g, '-');
}

function readHeadCwd(file) {
  // 只读文件开头一小段，找到第一条带 cwd 的记录。cwd 一般在前三行、几百字节处，开头是大段附件时才多读一些
  const fd = fs.openSync(file, 'r');
  try {
    for (const size of [16 * 1024, 256 * 1024]) {
      const buf = Buffer.alloc(size);
      const n = fs.readSync(fd, buf, 0, size, 0);
      const m = buf.toString('utf8', 0, n).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (m) return JSON.parse(`"${m[1]}"`);
      if (n < size) break;
    }
  } finally { fs.closeSync(fd); }
  return null;
}

export function listProjects(root = PROJECTS_DIR) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const id of fs.readdirSync(root)) {
    const dir = path.join(root, id);
    if (!fs.statSync(dir).isDirectory()) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    if (!files.length) continue;
    let last = 0, bytes = 0, cwd = null;
    for (const f of files) {
      const st = fs.statSync(path.join(dir, f));
      if (st.mtimeMs > last) last = st.mtimeMs;
      bytes += st.size;
      if (!cwd) cwd = readHeadCwd(path.join(dir, f));
    }
    out.push({ id, dir, cwd, sessions: files.length, bytes, lastModified: new Date(last).toISOString() });
  }
  return out.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
}

export function resolveProject(arg, root = PROJECTS_DIR) {
  const target = arg || process.cwd();
  const direct = [path.join(root, target), target];
  for (const d of direct) {
    if (fs.existsSync(d) && fs.statSync(d).isDirectory() && fs.readdirSync(d).some((f) => f.endsWith('.jsonl'))) {
      return path.resolve(d);
    }
  }
  const slug = slugOf(target);
  const projects = listProjects(root);
  const hit = projects.find((p) => p.id === slug)
    || projects.find((p) => p.id.toLowerCase() === slug.toLowerCase())
    || projects.find((p) => p.cwd && path.resolve(p.cwd).toLowerCase() === path.resolve(target).toLowerCase());
  if (hit) return hit.dir;
  throw new Error(`找不到项目 "${target}" 的转录目录（查找位置：${root}）。用 \`ctxtree list\` 查看可用项目。`);
}

// ---------- 通用小工具 ----------

// 转录里一大半字节用不上：工具结果的结构化副本 toolUseResult、附件快照、思考签名、图片 base64。
// 长行先在字节层面把这些值换成占位再 JSON.parse，省掉解码和解析它们的时间；
// 换完解析失败或缺字段就整行重新解析，所以最坏也只是慢一点，不会出错。
const SLIM_MIN = 2048;
const HEAD = 512; // 记录类型相关的键都在行首这么多字节以内
const bytes = (s) => Buffer.from(s);
const K_USER = bytes('"type":"user"'), K_ASSISTANT = bytes('"role":"assistant"'), K_ATTACH = bytes(',"attachment":{"type":"');
const K_TOOL_RESULT = bytes(',"toolUseResult":'), K_AGENT_ID = bytes('"agentId"'), K_SIDECHAIN = bytes('"isSidechain":true');
const K_SIGNATURE = bytes('"signature":"'), K_BASE64 = bytes('"type":"base64"'), K_DATA = bytes('"data":"');
const QUOTE = 34, BACKSLASH = 92, LBRACE = 123, LBRACKET = 91, RBRACE = 125, RBRACKET = 93;

const within = (p, e) => p >= 0 && p < e;

// 从 i（对象或数组的开头）往后跳过整个值，返回结束位置（不含）；字符串整段交给原生 indexOf 跳过，
// 循环只落在结构字符上。行不完整返回 -1
function valueEnd(line, i) {
  let depth = 0;
  for (const n = line.length; i < n; i++) {
    const c = line[i];
    if (c === QUOTE) {
      for (;;) {
        i = line.indexOf(QUOTE, i + 1);
        if (i < 0) return -1;
        let k = i - 1;
        while (line[k] === BACKSLASH) k--;
        if ((i - 1 - k) % 2 === 0) break;
      }
    } else if (c === LBRACE || c === LBRACKET) depth++;
    else if ((c === RBRACE || c === RBRACKET) && --depth === 0) return i + 1;
  }
  return -1;
}

// 收集 [起, 止, 替换] 区间和这行应有的记录类型；返回 null 表示这行不用瘦身。
// 所有搜索都在 line（当前行的视图）里做——在整个文件 buffer 上 indexOf 找不到时会一路扫到文件尾
function slimCuts(line) {
  const head = line.subarray(0, HEAD);
  const cuts = [];
  let type = null;
  const blankAll = (needle, to, after, minLen) => {
    for (let p = line.indexOf(needle); within(p, to); p = line.indexOf(needle, p + 1)) {
      let vs = p + needle.length;
      if (after) {
        const d = line.subarray(vs, vs + 64).indexOf(K_DATA);
        if (d < 0) continue;
        vs += d + K_DATA.length;
      }
      const ve = line.indexOf(QUOTE, vs);
      if (within(ve, to) && ve - vs >= minLen) cuts.push([vs, ve, '']);
    }
  };
  if (head.includes(K_USER)) {
    type = 'user';
    let end = line.length;
    const p = line.indexOf(K_TOOL_RESULT);
    if (p >= 0) {
      // 只用到 toolUseResult.agentId；带 agentId 的整段保留
      const v = p + K_TOOL_RESULT.length, x = line[v] === LBRACE ? valueEnd(line, v) : -1;
      if (x - v > 64 && !within(line.indexOf(K_AGENT_ID, v), x)) { cuts.push([v, x, '{}']); end = p; }
    }
    blankAll(K_BASE64, end, true, 64);
  } else if (head.includes(K_ASSISTANT)) {
    type = 'assistant';
    blankAll(K_SIGNATURE, line.length, false, 200);
  } else {
    const p = head.indexOf(K_ATTACH);
    if (p >= 0) {
      const ts = p + K_ATTACH.length, te = line.indexOf(QUOTE, ts);
      const kind = line.toString('latin1', ts, te);
      // 附件只用到中途插话（queued_command）
      const v = p + 14; // 14 = ',"attachment":'.length
      if (te - ts < 64 && kind !== 'queued_command') {
        const x = valueEnd(line, v);
        if (x - v > 64) cuts.push([v, x, `{"type":${JSON.stringify(kind)}}`]);
      }
      type = 'attachment';
    }
  }
  return cuts.length ? { type, cuts: cuts.sort((a, b) => a[0] - b[0]) } : null;
}

function parseSlim(line, { type, cuts }) {
  let text = '', at = 0;
  for (const [a, b, rep] of cuts) {
    if (a < at) continue;
    text += line.toString('utf8', at, a) + rep;
    at = b;
  }
  try {
    const rec = JSON.parse(text + line.toString('utf8', at));
    if (!rec?.uuid || rec.type !== type || !rec.timestamp) return undefined;
    return type === 'attachment' ? (rec.attachment ? rec : undefined) : (rec.message ? rec : undefined);
  } catch { return undefined; }
}

function readJsonl(file, { dropSidechain = false } = {}) {
  const buf = fs.readFileSync(file);
  const out = [];
  for (let s = 0; s < buf.length;) {
    let e = buf.indexOf(10, s);
    if (e < 0) e = buf.length;
    if (e - s > 1) {
      const line = buf.subarray(s, e);
      // 主会话文件里 isSidechain 的行是子代理的消息（子代理从 subagents/ 目录单独读），整行跳过，不解码不解析：
      // 带子代理的项目里这些行占到三成字节
      if (dropSidechain && line.subarray(0, HEAD).includes(K_SIDECHAIN)) { s = e + 1; continue; }
      const slim = line.length >= SLIM_MIN ? slimCuts(line) : null;
      let rec = slim ? parseSlim(line, slim) : undefined;
      if (rec === undefined) {
        try { rec = JSON.parse(line.toString('utf8')); } catch { /* 写到一半的行 */ }
      }
      if (rec != null) out.push(rec);
    }
    s = e + 1;
  }
  return out;
}

// ---------- 去掉密钥 ----------
// 转录会原样留下密钥（.env、请求头、配置文件、连接串）。写进导出文件的文字一律先过 redact，认出来的整段删掉，
// 原地什么都不留，不能关。removed 记本次 parseProject 删了几处，只报给命令行，不写进导出的文件
let removed = 0, mark = '';
const hide = () => { removed++; return mark; };
const alnumMix = (s) => /[A-Za-z]/.test(s) && /\d/.test(s);
// 随机串里总有一段 16 位以上字母数字混排的；sk-fragment-cache-v1、gamenet2-review-v1 这类标识符没有
const looksRandom = (s) => (s.match(/[A-Za-z0-9]{16,}/g) || []).some(alnumMix);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 文档和示例里的 user:password@host、${DB_PASS}、<your-key> 之类不算
const PLACEHOLDER = /^(?:\$|<|\{|%|x+$|\*+$|pass(?:word)?$|secret$|your)/i;
// 代码里的 options.secretAccessKey、process.env.API_KEY，和 PWD=/c/Users/… 这种路径
const CODE = /^[A-Za-z_$][A-Za-z_$]{2,}(?:\.[A-Za-z_$][\w$]*)+$/;
const PATH = /^(?:\.{1,2}\/|~\/|[A-Za-z]:[\\/]|\/[a-z][\w.-]*\/)/;
// 键名后面的值：口令是人起的，有字母有数字就算；key/token/secret 要像随机串，免得把存储键名、版本号当密钥
const assigned = (m, head, v) => {
  if (PLACEHOLDER.test(v) || CODE.test(v) || PATH.test(v) || /public/i.test(head)) return m;
  const secret = /pass|pwd/i.test(head) ? alnumMix(v) : looksRandom(v) || UUID.test(v);
  return secret ? head + hide() : m;
};
const NAME = String.raw`\w*?(?:key|token|secret|password|passwd|pwd)`;
const FLAG = String.raw`[\w-]*?(?:key|token|secret|password|passwd|pwd)`;
const VALUE = String.raw`([^\s"'\x60,;&<>(){}[\]]{6,})`;
// 规则 1–3 都以这批固定前缀开头，先决条件共用这一个正则：redact 里一次扫描抵三条规则各扫一遍
const PREFIX_HINT = /sk-|ak[-_]|k_(?:live|test)_|gh[pousr]_|github_pat_|hf_|AKIA|AIza|xox|eyJ/;
// [规则, 替换, 先决条件]。先决条件是规则能命中的必要条件，不满足就跳过这条规则，结果不变：
// 规则开头的 \b\w*? 会从每个词首试一遍，先决条件以字面量开头，引擎能直接跳着找
const SECRET_RULES = [
  // 私钥整块；被截断时一直删到结尾
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, hide,
    /-----BEGIN /],
  // 别处已经打过码的密钥（报错信息里 sk- 后面露着头几位、中间是星号或省略号、再露尾几位）：露出来的也是真字符，整段删掉。
  // 排在 sk- 那条前面，否则长的那截先被删，露出来的尾巴会留下。
  // 前缀后面只有省略号、星号的纯占位（sk-...、sk_live_****）不含真实字符，留着；
  // 要求前面不是字母数字（JSON 里的 \nsk- 除外），免得 risk-assessment... 这种词被截掉一半
  [/(?:(?<=\\[nrt])|(?<![A-Za-z0-9]))(?:sk-|ak[_-]|[sr]k_(?:live|test)_|gh[pousr]_|github_pat_|hf_|AKIA|AIza|xox[abposr]-)(?:[A-Za-z0-9_-]+(?:\*{3,}|•{3,}|\.{3,}|…)[A-Za-z0-9_-]*|(?:\*{3,}|•{3,}|\.{3,}|…)[A-Za-z0-9_-]+)/g, hide, PREFIX_HINT],
  // sk- 开头：OpenAI、Anthropic、DeepSeek 和各家中转；ak_：Cardinal；sk_live_ 这类：Stripe。
  // 前面不要求词边界，JSON 字符串里的 \nsk-… 也要认出来；sk-fragment-cache-v1 这种不像随机串的放过
  [/(?:sk-|ak[_-]|[sr]k_(?:live|test)_)[A-Za-z0-9_-]{16,}/g, (m) => (looksRandom(m) ? hide() : m), PREFIX_HINT],
  // 其他固定前缀：GitHub、AWS、Google、Slack、Hugging Face、JWT
  [/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[abposr]-[A-Za-z0-9-]{10,}|hf_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, hide, PREFIX_HINT],
  // 连接串里的密码：scheme://user:密码@host；postgres:postgres、root:root 这种用户名当密码的本地默认值不算
  [/(\b[a-z][a-z0-9+.-]*:\/\/([^\s:\/@]+):)([^\s@\/]{4,})(?=@)/gi, (m, head, user, v) => (PLACEHOLDER.test(v) || v === user ? m : head + hide()),
    /:\/\/[^\s:\/@]+:[^\s@\/]{4,}@/],
  // 请求头：Bearer xxx、Basic xxx
  [/(\b(?:Bearer|Basic)\s+)([A-Za-z0-9._~+\/=-]{16,})/g, (m, head, v) => (alnumMix(v) ? head + hide() : m)],
  // 赋值：api_key=xxx、"password": "xxx"、OPENAI_KEY: xxx、openaiApiKey = 'xxx'（冒号等号前后不跨行）
  [new RegExp(String.raw`(\b${NAME}["']?[ \t]*[:=][ \t]*["']?)${VALUE}`, 'gi'), assigned,
    /(?:key|token|secret|password|passwd|pwd)["']?[ \t]*[:=]/i],
  // 命令行参数：--api-key xxx、--password xxx
  [new RegExp(String.raw`((?:^|\s)--?${FLAG}[ \t]+["']?)${VALUE}`, 'gi'), assigned],
];
// 绝大多数文字一个规则都碰不上，先粗筛一遍。分支按首字母合并：引擎在每个位置只按一个字符分流，比平铺 20 个分支快四成。
// key/token/secret 这些词后面必须紧跟 ["' \t:=] 才可能命中赋值规则，Bearer/Basic 后面必须是空白——
// 把这个必要条件放进粗筛，工具输出里满篇的 tokens、keyboard 就不会进到逐条规则里
const MAYBE = /s(?:k-|ecret["' \t:=])|a(?:k[_-]|kia|iza)|k(?:_(?:live|test)_|ey["' \t:=])|g(?:h[pousr]_|ithub_pat_)|hf_|xox|eyj|private key|:\/\/|b(?:earer|asic)\s|token["' \t:=]|p(?:assw(?:or)?d|wd)["' \t:=]/i;

// 删掉的地方默认什么都不留；提交检查打印给人看时传一个 mark，看得出删在哪
export function redact(s, withMark = '') {
  if (!s || !MAYBE.test(s)) return s;
  mark = withMark;
  // 删掉一段后前后文字接到一起，可能凑出新的命中，反复做到不再变化
  for (let i = 0; i < 4; i++) {
    const before = s;
    // 共用 PREFIX_HINT 的三条规则这一轮只扫一次先决条件；中途有规则改了 s 也不要紧，下一轮会重测
    const pfx = PREFIX_HINT.test(s);
    for (const [re, fn, need] of SECRET_RULES) {
      if (need === PREFIX_HINT ? !pfx : need && !need.test(s)) continue;
      s = s.replace(re, fn);
    }
    if (s === before || !MAYBE.test(s)) break;
  }
  return s;
}

// ---------- 写文件前的检查 ----------
// 不计入 removed：检查只看有没有，不算解析时删掉的
function quietly(fn) {
  const n = removed;
  try { return fn(); } finally { removed = n; }
}
// 数据里还有几段文字（连同键名）能被 redact 改动。导出的数据都已经过 redact，正常是 0
export function countSecrets(v) {
  return quietly(() => {
    let n = 0;
    const walk = (x) => {
      if (typeof x === 'string') { if (redact(x) !== x) n++; } else if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === 'object') for (const k of Object.keys(x)) { walk(k); walk(x[k]); }
    };
    walk(v);
    return n;
  });
}
// 整份要写的文本只用不会误报的几条复查（私钥块、固定前缀、打过码的片段）：
// 赋值那条会把 JSON 里的 "key":"<会话 uuid>" 当成密钥，只能在 countSecrets 里逐段查。
// 这几条都以固定字面量开头：先用一个正则把候选位置都找出来，再只在候选附近跑完整规则，
// 不让四条规则各自扫一遍几 MB 的页面。令牌类的窗口往前带 4 个字符给打过码那条的后顾断言看，
// 往后盖住整段连写的令牌字符（JWT 可能有几 KB）；私钥块的窗口到 END 标记为止，没有 END 就到文末
const PEM_RULE = SECRET_RULES[0], TOKEN_RULES = SECRET_RULES.slice(1, 4);
const STRICT_AT = /sk-|ak[_-]|[sr]k_(?:live|test)_|gh[pousr]_|github_pat_|hf_|AKIA|AIza|xox[abposr]-|eyJ|-----BEGIN /g;
const TOKEN_RUN = /[A-Za-z0-9_.*•…-]*/y;
export function textHasSecret(text) {
  return quietly(() => {
    mark = '';
    for (const m of text.matchAll(STRICT_AT)) {
      if (m[0] === '-----BEGIN ') {
        const e = text.indexOf('-----END ', m.index);
        const w = text.slice(m.index, e < 0 ? text.length : e + 64);
        if (w.replace(PEM_RULE[0], PEM_RULE[1]) !== w) return true;
        continue;
      }
      TOKEN_RUN.lastIndex = m.index;
      const w = text.slice(Math.max(0, m.index - 4), m.index + TOKEN_RUN.exec(text)[0].length + 1);
      for (const [re, fn] of TOKEN_RULES) if (w.replace(re, fn) !== w) return true;
    }
    return false;
  });
}

function redactDeep(v) {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = redactDeep(v[k]);
    return o;
  }
  return v;
}

// 先删密钥再截断，免得密钥被截成半截认不出。长文本只对截断处往后多留的一截查密钥，不用扫完几 MB 的输出；
// 这一截末尾被切开的半个词（最多 512 字符）先去掉——前面的密钥删掉后，它可能被挪进保留范围。
// 半个词倒着找分隔符：写成 /[^…]{1,512}$/ 时引擎会从每个位置起试一遍，长输出上占掉解析的一半时间
const WORD_STOP = /[\s"'`,;<>(){}[\]]/;
function dropCutWord(w) {
  let i = w.length;
  for (const stop = Math.max(0, i - 512); i > stop && !WORD_STOP.test(w[i - 1]);) i--;
  return w.slice(0, i);
}
function clip(s, n) {
  if (s == null) return '';
  s = String(s);
  if (!(n > 0) || s.length <= n) return redact(s);
  let w = s.slice(0, n + 1024);
  if (s.length > w.length) w = dropCutWord(w);
  const r = redact(w);
  if (w.length === s.length && r.length <= n) return r;
  return `${r.slice(0, n)}\n…（已截断，原长 ${s.length} 字符）`;
}

function blocksOf(msg) {
  const c = msg?.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c : [];
}

function stripNoise(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .trim();
}

function promptText(msg) {
  const parts = [];
  for (const b of blocksOf(msg)) {
    if (b.type === 'text') parts.push(b.text);
    else if (b.type === 'image') parts.push('[图片]');
    else if (b.type === 'document') parts.push('[文档]');
  }
  let t = stripNoise(parts.join('\n'));
  const cmd = t.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (cmd) {
    const args = (t.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || '';
    t = `${cmd[1].trim()} ${args.trim()}`.trim();
  }
  return t;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content.map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[图片]' : `[${b.type}]`)).join('\n');
}

function toolSummary(name, input = {}) {
  const pick = input.description || input.command || input.file_path || input.path || input.pattern
    || input.url || input.query || input.prompt || input.skill || input.subject || '';
  return String(pick).split('\n')[0].slice(0, 160);
}

const NON_PROMPT_PREFIX = /^\s*<(local-command-stdout|local-command-stderr|task-notification|bash-stdout|bash-stderr)>/;

function isToolResult(rec) {
  return rec.toolUseResult !== undefined || blocksOf(rec.message).some((b) => b.type === 'tool_result');
}

function isPrompt(rec) {
  if (rec.type !== 'user' || rec.isMeta || rec.isCompactSummary || isToolResult(rec)) return false;
  const raw = blocksOf(rec.message).map((b) => (b.type === 'text' ? b.text : '')).join('');
  if (/^\[Request interrupted/.test(raw.trim())) return false;
  if (NON_PROMPT_PREFIX.test(raw)) return false;
  return promptText(rec.message).length > 0 || blocksOf(rec.message).some((b) => b.type === 'image');
}

// ---------- 单个转录 → 若干轮 ----------

/**
 * 解析一个转录文件（主会话或子代理）。
 * 每一轮 = 一条真实的用户输入 + 其后直到下一条输入的所有消息。
 * 归属按 parentUuid 祖先链判定（压缩边界沿 logicalParentUuid 继续），因此回退/分叉也能正确落位。
 */
function parseTranscript(records, laneKey, opts) {
  const msgs = records.filter((r) => r.uuid && ['user', 'assistant', 'system', 'attachment'].includes(r.type));
  const prompts = new Set(msgs.filter(isPrompt));
  const byUuid = new Map(msgs.map((r) => [r.uuid, r]));
  const turnOfCache = new Map();
  const externalParents = new Set();

  const parentOf = (r) => r.parentUuid ?? r.logicalParentUuid ?? null;
  const turnOf = (uuid) => {
    const chain = [];
    let cur = uuid, found = null;
    while (cur) {
      if (turnOfCache.has(cur)) { found = turnOfCache.get(cur); break; }
      const r = byUuid.get(cur);
      if (!r) { externalParents.add(cur); found = { external: cur }; break; }
      chain.push(cur);
      if (prompts.has(r)) { found = r.uuid; break; }
      cur = parentOf(r);
    }
    for (const c of chain) turnOfCache.set(c, found);
    return found;
  };

  const turns = new Map();
  const order = [];
  for (const r of msgs) {
    if (!prompts.has(r)) continue;
    const p = parentOf(r);
    const parent = p ? turnOf(p) : null;
    const t = {
      id: `${laneKey}:${r.uuid}`,
      lane: laneKey,
      parent: typeof parent === 'string' ? `${laneKey}:${parent}` : null,
      externalParent: parent && typeof parent === 'object' ? parent.external : null,
      prompt: redact(promptText(r.message)),
      t0: r.timestamp, t1: r.timestamp,
      model: null, models: [], ctx: 0, out: 0,
      items: [], tools: {}, compactions: [], interrupted: false, errors: 0, agents: [],
    };
    turns.set(r.uuid, t);
    order.push(t);
  }

  const steps = new Map(); // tool_use_id → step
  const usageByMsg = new Map();
  for (const r of msgs) {
    if (prompts.has(r)) continue;
    const owner = turnOf(r.uuid);
    const t = typeof owner === 'string' ? turns.get(owner) : null;
    if (!t) continue; // 首条输入之前的系统附件
    if (r.timestamp && r.timestamp > t.t1) t.t1 = r.timestamp;

    if (r.type === 'assistant') {
      const m = r.message || {};
      if (m.model && m.model !== '<synthetic>') {
        t.model = m.model;
        if (!t.models.includes(m.model)) t.models.push(m.model);
      }
      if (m.usage && m.id) usageByMsg.set(m.id, { t, u: m.usage });
      // 每轮的上下文占用 = 该轮最后一次请求的输入 token 总量（顺序遍历，后者覆盖前者）
      if (m.usage) t.ctx = (m.usage.input_tokens || 0) + (m.usage.cache_read_input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0);
      if (r.isApiErrorMessage) t.errors++;
      for (const b of blocksOf(m)) {
        if (b.type === 'text' && b.text.trim()) {
          const text = redact(b.text);
          const last = t.items[t.items.length - 1];
          if (last && last.k === 'text' && last.mid === m.id) last.text += `\n\n${text}`;
          else t.items.push({ k: 'text', text, mid: m.id, ts: r.timestamp });
        } else if (b.type === 'thinking' && opts.thinking && (b.thinking || '').trim()) {
          t.items.push({ k: 'think', text: clip(b.thinking, opts.maxThinking) });
        } else if (b.type === 'tool_use') {
          t.tools[b.name] = (t.tools[b.name] || 0) + 1;
          // 先逐个字符串删密钥再序列化：序列化后换行变成字面的 \n，粘在密钥前面会让词边界失效
          const input = redactDeep(b.input ?? {});
          const step = { k: 'tool', id: b.id, name: b.name, sum: toolSummary(b.name, input), ts: r.timestamp };
          if (opts.tools) step.input = clip(JSON.stringify(input, null, 2), opts.maxTool);
          steps.set(b.id, step);
          t.items.push(step);
        }
      }
    } else if (r.type === 'user') {
      for (const b of blocksOf(r.message)) {
        if (b.type === 'tool_result') {
          const s = steps.get(b.tool_use_id);
          if (!s) continue;
          s.err = !!b.is_error;
          if (opts.tools) s.result = clip(resultText(b.content), opts.maxTool);
          const tr = r.toolUseResult;
          if (tr && typeof tr === 'object' && tr.agentId) s.agentId = tr.agentId;
        } else if (b.type === 'text') {
          const txt = b.text.trim();
          if (/^\[Request interrupted/.test(txt)) t.interrupted = true;
          else if (/^<task-notification>/.test(txt)) {
            const sum = (txt.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1];
            t.items.push({ k: 'note', text: `后台任务通知：${redact((sum || txt).replace(/<[^>]+>/g, ' ').trim()).slice(0, 400)}` });
          } else if (/^<local-command-std(out|err)>/.test(txt)) {
            const body = stripNoise(txt.replace(/<\/?local-command-std(out|err)>/g, ''));
            if (body) t.items.push({ k: 'note', text: `命令输出：${redact(body).slice(0, 1200)}` });
          }
        }
      }
    } else if (r.type === 'attachment') {
      const a = r.attachment || {};
      if (a.type === 'queued_command' && a.prompt && a.origin?.kind !== 'system') {
        t.items.push({ k: 'queued', text: redact(stripNoise(String(a.prompt))), ts: r.timestamp });
      }
    } else if (r.type === 'system') {
      if (r.subtype === 'compact_boundary') {
        const cm = r.compactMetadata || {};
        const c = { ts: r.timestamp, trigger: cm.trigger, pre: cm.preTokens, post: cm.postTokens };
        t.compactions.push(c);
        t.items.push({ k: 'compact', ...c });
      } else if (r.subtype === 'api_error') {
        t.errors++;
      }
    }
  }

  for (const { t, u } of usageByMsg.values()) t.out += u.output_tokens || 0;
  for (const t of order) for (const it of t.items) delete it.mid;
  // 每条消息归哪一轮：别的会话从这里分叉时，父消息可能是这一轮里的任意一条（多半是回答）
  const owned = new Map();
  for (const r of msgs) {
    const owner = turnOf(r.uuid);
    if (typeof owner === 'string') owned.set(r.uuid, turns.get(owner));
  }
  return { turns: order, steps, externalParents, owned };
}

// ---------- 整个项目 ----------

// 解析一个文件（会话或子代理），这是并行的最小单位。会话文件顺带取标题、分支和首个 cwd。
// steps 不返回：parseProject 的 allSteps 从 items 重建，少跨线程克隆一份；
// removed 以增量返回、全局计数回滚——没有轮次的会话的子代理整个丢弃，计数由 parseProject 按「用上的结果」累加，主线程和 worker 口径一致
function parseFileJob(job, opts) {
  const n0 = removed;
  let out;
  if (job.kind === 'session') {
    const records = readJsonl(job.file, { dropSidechain: true });
    let title = null, aiTitle = null, agentName = null, branch = null, cwd = null;
    for (const r of records) {
      if (r.type === 'custom-title' && r.customTitle) title = r.customTitle;
      else if (r.type === 'ai-title' && r.aiTitle) aiTitle = r.aiTitle;
      else if (r.type === 'agent-name' && r.agentName) agentName = r.agentName;
      branch ||= r.gitBranch;
      cwd ||= r.cwd;
    }
    const { steps, ...res } = parseTranscript(records.filter((r) => !r.isSidechain), job.key, opts);
    out = { res, title: title || aiTitle || agentName, branch, cwd };
  } else {
    const { steps, ...res } = parseTranscript(readJsonl(job.file), job.key, opts);
    out = { res };
  }
  out.removed = removed - n0;
  removed = n0;
  return out;
}

// 文件之间互不依赖，大项目分给工作线程（入口就是本文件，见末尾），任务靠共享内存里的认领位自取，主线程自己也是工人：
// Windows 上一个线程要 ~30-50ms 才就绪，这段时间主线程先干着，不空等。
// parseProject 必须保持同步（bin 和测试都同步调），结果走 MessageChannel、主线程 Atomics.wait 原地等。
// 只在主线程开：bin 的 all 模式已按项目分线程，worker 里再开就超售；
// 但 all 的主线程自己也解析项目（最大的那个），库里看不出调用方，只能认命令行——argv 带 all 一律不开，
// 误判的代价只是少并行，输出不受影响。小项目也不开——8MB 单线程不到 100ms，摊不平线程启动
const CLI_ALL = process.argv.slice(2).includes('all');
const PAR_MIN_BYTES = 8 << 20, PAR_WORKERS = 7;
function runJobs(jobs, opts) {
  const results = new Array(jobs.length);
  let sizes = null, bytes = 0;
  if (isMainThread && !CLI_ALL && jobs.length >= 4) {
    sizes = jobs.map((j) => { try { return fs.statSync(j.file).size; } catch { return 0; /* 刚被删 */ } });
    bytes = sizes.reduce((a, b) => a + b, 0);
  }
  const cpu = os.availableParallelism?.() ?? os.cpus().length;
  const n = bytes >= PAR_MIN_BYTES ? Math.min(PAR_WORKERS, cpu - 1, jobs.length - 1) : 0;
  if (n < 1) {
    for (let i = 0; i < jobs.length; i++) results[i] = parseFileJob(jobs[i], opts);
    return results;
  }
  // 领取顺序按文件从大到小（结果仍按原下标归位，组装顺序不变），每个任务一个认领位（CAS），恰好一人做：
  // worker 从大头往下扫，主线程先抢最大的那个——它最拖进度、而且主线程不用等线程就绪——然后从小头往回扫，
  // worker 全没起来（或起得慢）主线程也能把活干完，不会卡死
  const order = jobs.map((_, i) => i).sort((a, b) => sizes[b] - sizes[a]);
  const shared = new Int32Array(new SharedArrayBuffer(4 + 4 * jobs.length)); // [0] 已回传的结果数；[1+k] 第 k 个任务的认领位
  const workers = [], ports = [];
  for (let i = 0; i < n; i++) {
    const { port1, port2 } = new MessageChannel();
    const w = new Worker(new URL(import.meta.url), { workerData: { ctxtreeJobs: jobs, order, opts, shared, port: port2 }, transferList: [port2] });
    w.unref(); // 不拖住进程退出；做完任务 worker 自己退出
    workers.push(w);
    ports.push(port1);
  }
  let done = 0;
  const drain = () => {
    for (const p of ports) for (let m; (m = receiveMessageOnPort(p));) {
      const { i, out, err } = m.message;
      if (err) throw new Error(err);
      results[i] = out;
      done++;
    }
  };
  const claim = (k) => Atomics.compareExchange(shared, 1 + k, 0, 1) === 0;
  const run = (k) => { const i = order[k]; results[i] = parseFileJob(jobs[i], opts); done++; };
  try {
    if (claim(0)) run(0);
    // 顺手收已到的结果：反序列化和解析重叠，不积到最后
    for (let k = jobs.length - 1; k > 0; k--) { if (claim(k)) run(k); drain(); }
    while (done < jobs.length) {
      const seen = Atomics.load(shared, 0);
      drain();
      if (done >= jobs.length) break;
      // 计数器一直没动说明有线程死了（正常一个文件远用不了这么久），报错比挂死好
      if (Atomics.wait(shared, 0, seen, 60000) === 'timed-out' && Atomics.load(shared, 0) === seen) throw new Error('解析线程 60 秒没有进展');
    }
  } finally { for (const w of workers) w.terminate(); }
  return results;
}

export function parseProject(dir, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const lanes = [];
  const turns = [];
  const allSteps = new Map(); // tool_use_id → { step, turn }
  const uuidOwner = new Map(); // 原始消息 uuid → 所在的轮（跨会话分叉用）
  let cwd = null;
  removed = 0;

  const addTurns = (res) => {
    for (const t of res.turns) {
      turns.push(t);
      for (const it of t.items) if (it.k === 'tool') allSteps.set(it.id, { step: it, turn: t });
    }
    for (const [uuid, t] of res.owned) if (!uuidOwner.has(uuid)) uuidOwner.set(uuid, t);
  };
  const laneBase = (res, title) => ({
    title: title ? redact(title) : res.turns[0].prompt.slice(0, 40),
    start: res.turns[0].t0,
    end: res.turns.reduce((m, t) => (t.t1 > m ? t.t1 : m), ''),
    turnCount: res.turns.length,
  });

  // 任务一次列全（会话 + 子代理），并行只跑一轮。没有轮次的会话原本不读它的子代理，
  // 这里先解析了也只是丢弃（结果、计数都不用），输出不变；meta 和归属留在主线程，不进任务
  const jobs = files.map((f) => ({ kind: 'session', key: f.replace(/\.jsonl$/, ''), file: path.join(dir, f) }));
  const agents = [];
  if (opts.agents) for (const s of [...jobs]) {
    const subDir = path.join(dir, s.key, 'subagents');
    if (!fs.existsSync(subDir)) continue;
    for (const af of fs.readdirSync(subDir).filter((x) => x.endsWith('.jsonl'))) {
      const agentId = af.replace(/^agent-/, '').replace(/\.jsonl$/, '');
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(subDir, af.replace(/\.jsonl$/, '.meta.json')), 'utf8')); } catch { /* 旧版本无 meta */ }
      agents.push({ i: jobs.length, sid: s.key, agentId, meta });
      jobs.push({ kind: 'agent', key: `${s.key}/agent-${agentId}`, file: path.join(subDir, af) });
    }
  }
  const results = runJobs(jobs, opts);

  const withTurns = new Set();
  for (let i = 0; i < files.length; i++) {
    const { res, title, branch, cwd: c, removed: n } = results[i];
    removed += n;
    cwd ||= c;
    if (!res.turns.length) continue;
    const sid = jobs[i].key;
    withTurns.add(sid);
    addTurns(res);
    lanes.push({
      key: sid, kind: 'session', sessionId: sid,
      ...laneBase(res, title),
      branch: branch || null,
      externalParents: [...res.externalParents],
    });
  }
  for (const a of agents) {
    if (!withTurns.has(a.sid)) continue;
    const { res, removed: n } = results[a.i];
    removed += n;
    if (!res.turns.length) continue;
    addTurns(res);
    lanes.push({
      key: jobs[a.i].key, kind: 'agent', sessionId: a.sid, agentId: a.agentId,
      ...laneBase(res, a.meta.description),
      agentType: a.meta.agentType || 'agent', toolUseId: a.meta.toolUseId || null,
    });
  }

  // 子代理挂到发起它的那一轮上
  for (const lane of lanes) {
    if (lane.kind !== 'agent') continue;
    let hit = lane.toolUseId ? allSteps.get(lane.toolUseId) : null;
    if (!hit) {
      for (const v of allSteps.values()) if (v.step.agentId === lane.agentId) { hit = v; break; }
    }
    lane.parentTurn = hit ? hit.turn.id : null;
    if (hit) {
      hit.step.agentLane = lane.key;
      hit.turn.agents.push(lane.key);
    }
  }

  // 跨会话分叉：会话首轮的父消息落在另一个会话里
  for (const t of turns) {
    if (!t.externalParent) continue;
    const owner = uuidOwner.get(t.externalParent);
    if (owner && owner.lane !== t.lane) t.parent = owner.id;
  }
  for (const t of turns) delete t.externalParent;
  for (const l of lanes) delete l.externalParents;

  lanes.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  const sessions = lanes.filter((l) => l.kind === 'session');
  const sessionKeys = new Set(sessions.map((l) => l.key));
  const data = {
    version: 1,
    generatedAt: new Date().toISOString(),
    project: {
      id: path.basename(dir), dir, cwd,
      name: cwd ? path.basename(cwd) || cwd : path.basename(dir),
    },
    stats: {
      sessions: sessions.length,
      agents: lanes.length - sessions.length,
      turns: turns.filter((t) => sessionKeys.has(t.lane)).length,
      start: sessions[0]?.start || null,
      end: sessions.reduce((m, s) => (s.end > m ? s.end : m), ''),
    },
    lanes,
    turns,
  };
  // 删了几处只给命令行看：不可枚举，JSON.stringify 和 structuredClone 都带不走，不会写进文件
  Object.defineProperty(data, 'removed', { value: removed });
  return data;
}

// ---------- 工作线程入口 ----------
// runJobs 拿本文件自身当 worker 入口，只认自己 workerData 里的任务标记：
// bin 的 all 线程把本模块当库 import 时 workerData 是 null，这里不执行
if (!isMainThread && workerData?.ctxtreeJobs) {
  const { ctxtreeJobs: jobs, order, opts, shared, port } = workerData;
  for (let k = 0; k < jobs.length; k++) {
    if (Atomics.compareExchange(shared, 1 + k, 0, 1) !== 0) continue; // 被别人抢了
    const i = order[k];
    let msg;
    try { msg = { i, out: parseFileJob(jobs[i], opts) }; }
    catch (e) { msg = { i, err: `${jobs[i].file}：${e.message}` }; }
    port.postMessage(msg);
    Atomics.add(shared, 0, 1);
    Atomics.notify(shared, 0);
  }
}
