import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// 浏览器解析时会把 CRLF 折成 LF，CSP 哈希按折过的文本算；Windows 上检出的模板可能是 CRLF，先统一
const lf = (s) => s.replace(/\r\n?/g, '\n');
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('base64');

// 标志：一条主线带一条支线，和页面里的线路图一个意思。页面顶栏和标签页图标共用
const BRAND_SHAPES = '<g fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.5h14" stroke="#F0475A"/><path d="M7 6.5V10a3.5 3.5 0 0 0 3.5 3.5H17" stroke="#3B9BE0"/></g>'
  + '<g fill="#fff"><circle cx="3" cy="6.5" r="2.3"/><circle cx="12.5" cy="6.5" r="1.7"/><circle cx="17" cy="6.5" r="1.7"/><circle cx="17" cy="13.5" r="1.7"/></g>';
const BRAND = `<svg viewBox="0 0 20 20" aria-hidden="true">${BRAND_SHAPES}</svg>`;
const ICON = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 28 28"><rect x="-4" y="-4" width="28" height="28" rx="6" fill="#17202B"/>${BRAND_SHAPES}</svg>`)}`;

// JSON 放进 <script type="application/json">：转义 < 防止提前闭合标签，顺带转义 JS 行分隔符。
// 三个字符并进一个字符类一趟扫完（replaceAll 加 includes 要扫三遍，几 MB 的串上更慢）
const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029), BS = String.fromCharCode(92);
const UNSAFE = new RegExp(`[<${LS}${PS}]`, 'g');
const uEscape = (c) => `${BS}u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
const embedJson = (data) => JSON.stringify(data).replace(UNSAFE, uEscape);
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 工具输入输出占整包体积的七到九成，但页面只在展开折叠块时才用到——
// 每一轮拆成一段 JSON（条目上记段号 b 和段内下标 iv/rv），所有段首尾相接放进同一个 <script>，
// 段的起止位置记在 bulk 里。启动时不解析，展开折叠块时只切出那一轮解析。
// 不能一轮一个 <script>：几百个 script 标签会让浏览器建 DOM 慢几十倍
function splitBulk(data) {
  const chunks = [];
  const turns = data.turns.map((t) => {
    let chunk = null;
    const items = t.items.map((it) => {
      if (it.k !== 'tool' || (it.input == null && it.result == null)) return it;
      if (!chunk) chunk = [];
      const c = { ...it, b: chunks.length };
      if (c.input != null) { c.iv = chunk.push(c.input) - 1; delete c.input; }
      if (c.result != null) { c.rv = chunk.push(c.result) - 1; delete c.result; }
      return c;
    });
    if (chunk) chunks.push(chunk);
    return { ...t, items };
  });
  const texts = chunks.map(embedJson);
  const bulk = [0];  // 偏移按转义后的段长算，页面按它切段，必须和最终拼出的文本逐字符对齐
  for (const s of texts) bulk.push(bulk[bulk.length - 1] + s.length);
  return { core: { ...data, turns, bulk }, text: texts };  // 各段不先 join，摊进最终拼接，省一次几 MB 的中间串
}

// home：总目录相对本页的路径；给了才显示顶栏的「全部项目」链接（单项目导出没有总目录）
let template = null, exportMd = null;  // all 模式里一个线程要连着导出几个项目，模板只读一次
export function renderHtml(data, { home } = {}) {
  template ??= lf(fs.readFileSync(path.join(here, 'template.html'), 'utf8'));
  exportMd ??= lf(fs.readFileSync(path.join(here, 'export-md.mjs'), 'utf8')).replace(/^export\s+/gm, '');
  const { core, text } = splitBulk(data);
  // 用函数形式替换，避免 $& 等特殊替换序列
  const html = template
    .replace('__TITLE__', () => escHtml(`${data.project.name} · 上下文树`))
    .replace('__ICON__', () => ICON)
    .replace('<!--__BRAND__-->', () => BRAND)
    .replace('href="__HOME__" title="回到总目录，看全部项目" hidden', () => (home ? `href="${escHtml(home)}" title="回到总目录，看全部项目"` : 'hidden'))
    .replace('/*__EXPORT_MD__*/', () => exportMd);
  // 主脚本定稿后再算哈希；数据块是 application/json，不执行，不受 script-src 管
  const main = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  // 剩下三个占位符先在小模板上定位（填进去的内容都不含后面的占位符），再按位置切开拼接，
  // 避免对越拼越大的多 MB 字符串反复扫描拷贝；bulk 各段也不先 join，直接拼进结果
  const a = html.indexOf('__CSP__'), b = html.indexOf('__DATA__'), c = html.indexOf('<!--__BULK__-->');
  let out = html.slice(0, a)
    + `default-src 'none'; script-src 'sha256-${sha256(main)}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`
    + html.slice(a + '__CSP__'.length, b) + embedJson(core) + html.slice(b + '__DATA__'.length, c)
    + '<script id="ctx-bulk" type="application/json">';
  for (const s of text) out += s;
  return out + '</script>' + html.slice(c + '<!--__BULK__-->'.length);
}

const LINE_COLORS = ['#D7263D', '#1B7FC4', '#2A9D5C', '#E08A00', '#8E44AD', '#00989A', '#D6457A', '#6B7F2A', '#C0561E', '#3D5A98', '#7A5C3E', '#0F7B6C']; // 和 template.html 一致
const num = (x) => Number(x) || 0;
const fmtTime = (iso) => {
  const d = new Date(iso);
  if (!iso || Number.isNaN(+d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// 总目录：纯静态页，没有脚本
export function renderIndex(entries) {
  const list = [...entries].sort((a, b) => String(b.end || '').localeCompare(String(a.end || '')));
  const sum = (k) => list.reduce((a, e) => a + num(e[k]), 0);
  const cards = list.map((e, i) => `<a class="p" href="${escHtml(e.href)}" style="--c:${LINE_COLORS[i % LINE_COLORS.length]}">
<div class="h"><i></i><b title="${escHtml(e.name)}">${escHtml(e.name)}</b></div>
<code title="${escHtml(e.cwd || '')}">${escHtml(e.cwd || '')}</code>
<div class="m"><span><b>${num(e.sessions)}</b>个会话</span><span><b>${num(e.turns)}</b>轮对话</span></div>
<div class="t"><span>最近活动 ${escHtml(fmtTime(e.end))}</span><span class="go">打开线路图 →</span></div>
</a>`).join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>上下文树 · 全部项目</title>
<link rel="icon" href="${ICON}">
<style>
:root{--paper:#EEF1F0;--paper-2:#F5F7F6;--ink:#17202B;--ink-2:#4E5B68;--ink-3:#8A96A2;--rule:#DCE2E0;--sign:"Bahnschrift","DIN Alternate","Barlow","Segoe UI",sans-serif;--body:"HarmonyOS Sans SC","MiSans","PingFang SC","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;--mono:"Cascadia Code","JetBrains Mono",Consolas,monospace}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;color:var(--ink);font:14px/1.5 var(--body);background:radial-gradient(1200px 600px at 75% -15%,#F8FAF9,rgba(248,250,249,0) 70%) fixed,var(--paper)}
::selection{background:#FFE38A}
:focus-visible{outline:2px solid var(--ink);outline-offset:3px}
svg.i{width:14px;height:14px;flex:none;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.top{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:14px;height:60px;padding:0 max(24px,calc(50% - 572px));background:#fff;border-bottom:1px solid var(--rule)}
.brand{flex:none;width:32px;height:32px;border-radius:9px;background:var(--ink);display:grid;place-items:center}
.brand svg{width:21px;height:21px;display:block}
h1{margin:0;display:flex;align-items:center;gap:10px;font:600 20px/1 var(--sign);white-space:nowrap}
h1 small{font:500 12px/1 var(--body);letter-spacing:.06em;color:var(--ink-3);padding:4px 7px;border:1px solid var(--rule);border-radius:6px}
.tot{margin-left:auto;display:flex;gap:6px;font-size:12px;color:var(--ink-2);white-space:nowrap;overflow:hidden}
.tot span,.m span{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 9px;background:var(--paper-2);border:1px solid var(--rule);border-radius:8px}
.tot b,.m b{font:600 14px/1 var(--sign);color:var(--ink)}
main{max-width:1192px;margin:0 auto;padding:28px 24px 56px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.p{display:flex;flex-direction:column;gap:10px;min-width:0;padding:18px 18px 14px;color:inherit;text-decoration:none;background:#fff;border:1px solid #DDE3E1;border-radius:14px;box-shadow:inset 0 4px 0 var(--c),0 1px 2px rgba(23,32,43,.06);transition:transform .15s,box-shadow .15s,border-color .15s}
.p:hover{transform:translateY(-2px);border-color:#C4CDCA;box-shadow:inset 0 4px 0 var(--c),0 14px 30px -16px rgba(23,32,43,.4)}
.h{display:flex;align-items:center;gap:10px;min-width:0}
.h i{flex:none;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:inset 0 0 0 4.5px var(--c)}
.h b{font:600 18px/1.2 var(--sign);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
code{display:block;padding:5px 9px;font:12px/1.4 var(--mono);color:var(--ink-2);background:var(--paper-2);border:1px solid var(--rule);border-radius:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
code:empty{display:none}
.m{display:flex;flex-wrap:wrap;gap:6px;font-size:12px;color:var(--ink-2)}
.m span{height:24px;padding:0 8px;border-radius:7px}
.t{display:flex;justify-content:space-between;gap:10px;margin-top:auto;padding-top:11px;border-top:1px dashed var(--rule);font-size:12px;color:var(--ink-3)}
.go{font-weight:600;color:var(--ink-2)}
.p:hover .go{color:var(--c)}
.empty{padding:40px;text-align:center;color:var(--ink-2);background:#fff;border:1px solid var(--rule);border-radius:14px}
@media (max-width:720px){.tot{display:none}}
@media (prefers-reduced-motion:reduce){.p{transition:none}.p:hover{transform:none}}
</style>
</head>
<body>
<header class="top"><div class="brand" aria-hidden="true">${BRAND}</div><h1>上下文树<small>全部项目</small></h1>
<div class="tot"><span><b>${list.length}</b>个项目</span><span><b>${sum('sessions')}</b>个会话</span><span><b>${sum('turns')}</b>轮对话</span></div></header>
<main>
${list.length ? `<div class="grid">\n${cards}\n</div>` : '<div class="empty">没有找到可显示的项目。先用 Claude Code 聊几轮，再重新生成。</div>'}
</main>
</body>
</html>
`;
}
