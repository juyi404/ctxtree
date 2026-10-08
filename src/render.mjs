import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// JSON 放进 <script type="application/json">：转义 < 防止提前闭合标签，顺带转义 JS 行分隔符
const UNSAFE = new RegExp(`[<${String.fromCharCode(0x2028, 0x2029)}]`, 'g');
const uEscape = (c) => `${String.fromCharCode(92)}u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
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
  const bulk = [0];
  for (const s of texts) bulk.push(bulk[bulk.length - 1] + s.length);
  return { core: { ...data, turns, bulk }, text: texts.join('') };
}

export function renderHtml(data) {
  const template = fs.readFileSync(path.join(here, 'template.html'), 'utf8');
  const exportMd = fs.readFileSync(path.join(here, 'export-md.mjs'), 'utf8').replace(/^export\s+/gm, '');
  const { core, text } = splitBulk(data);
  // 用函数形式替换，避免 $& 等特殊替换序列
  return template
    .replace('__TITLE__', () => escHtml(`${data.project.name} · 上下文树`))
    .replace('/*__EXPORT_MD__*/', () => exportMd)
    .replace('__DATA__', () => embedJson(core))
    .replace('<!--__BULK__-->', () => `<script id="ctx-bulk" type="application/json">${text}</script>`);
}

export function renderIndex(entries) {
  const rows = entries.map((e) => `<a class="p" href="${escHtml(e.href)}"><b>${escHtml(e.name)}</b><span>${escHtml(e.cwd || '')}</span><em>${e.sessions} 个会话　${e.turns} 轮　${escHtml((e.end || '').slice(0, 10))}</em></a>`).join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>上下文树 · 全部项目</title>
<style>
body{margin:0;background:#EEF1F0;color:#17202B;font:14px/1.5 "HarmonyOS Sans SC","Microsoft YaHei UI",system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:48px 24px}
h1{font:600 30px/1.1 Bahnschrift,"DIN Alternate","Segoe UI",sans-serif;margin:0 0 24px}
.p{display:grid;grid-template-columns:1fr auto;gap:2px 16px;padding:14px 16px;margin:0 0 8px;background:#fff;border:1px solid #D3DAD8;border-left:6px solid #17202B;border-radius:4px;color:inherit;text-decoration:none}
.p:hover{border-color:#4E5B68}.p b{font-size:16px}.p span{grid-column:1;color:#4E5B68;font:12px Consolas,monospace}
.p em{grid-row:1/span 2;grid-column:2;align-self:center;font:normal 13px Bahnschrift,sans-serif;color:#4E5B68}
</style></head><body><main><h1>全部项目的上下文树</h1>${rows}</main></body></html>`;
}
