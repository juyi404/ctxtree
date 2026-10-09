import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseProject, redact } from '../src/parse.mjs';
import { renderHtml, renderIndex } from '../src/render.mjs';
import { toMarkdown } from '../src/export-md.mjs';
import { checkData, writeExport, SecretLeftError } from '../src/write-guard.mjs';

// 记录构造器：时间戳全局递增，保证各会话先后有序
let n = 0;
const ts = () => new Date(Date.UTC(2026, 8, 1, 0, 0, n++)).toISOString();
const usage = (i) => ({ input_tokens: i, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 });
function builders(sid) {
  const base = { sessionId: sid, cwd: 'E:\\demo', gitBranch: 'main' };
  const user = (uuid, parentUuid, content, extra = {}) => ({ ...base, type: 'user', uuid, parentUuid, timestamp: ts(), message: { role: 'user', content }, ...extra });
  const asst = (uuid, parentUuid, id, content, u = usage(10)) => ({ ...base, type: 'assistant', uuid, parentUuid, timestamp: ts(), message: { id, role: 'assistant', model: 'claude-opus-5-5', content, usage: u } });
  return { base, user, asst };
}
const writeJsonl = (file, records) => fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

// 构造一个最小的转录目录：一个会话、两轮提问（中间有一次压缩）、一个子代理；extra(dir) 可以再写别的会话
function fixture(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtree-'));
  const sid = 's1';
  const { base, user, asst } = builders(sid);
  const main = [
    { type: 'ai-title', sessionId: sid, aiTitle: '示例会话' },
    user('u1', null, '第一个问题 <b>&</b>'),
    asst('a1', 'u1', 'm1', [{ type: 'text', text: '先看一下。' }], usage(100)),
    asst('a2', 'a1', 'm1', [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { description: '查资料', prompt: '去查' } }], usage(100)),
    user('r1', 'a2', [{ type: 'tool_result', tool_use_id: 'tu1', content: '查完了' }], { toolUseResult: { agentId: 'x1' } }),
    asst('a3', 'r1', 'm2', [{ type: 'text', text: '第一轮的回答' }], usage(500)),
    { ...base, type: 'system', subtype: 'compact_boundary', uuid: 'c1', parentUuid: null, logicalParentUuid: 'a3', timestamp: ts(), compactMetadata: { trigger: 'auto', preTokens: 500 } },
    user('sum', 'c1', '摘要……', { isCompactSummary: true }),
    user('u2', 'sum', '第二个问题'),
    asst('a4', 'u2', 'm3', [{ type: 'text', text: '第二轮的回答' }], usage(80)),
  ];
  writeJsonl(path.join(dir, `${sid}.jsonl`), main);
  const sub = path.join(dir, sid, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const agent = [
    user('g1', null, '去查', { isSidechain: true }),
    asst('g2', 'g1', 'gm1', [{ type: 'text', text: '子代理的结论' }], usage(40)),
  ];
  writeJsonl(path.join(sub, 'agent-x1.jsonl'), agent);
  fs.writeFileSync(path.join(sub, 'agent-x1.meta.json'), JSON.stringify({ agentType: 'Explore', description: '查资料', toolUseId: 'tu1' }));
  extra?.(dir);
  return dir;
}

test('按用户提问切分轮次，压缩后仍接在同一条线上', () => {
  const data = parseProject(fixture());
  const sess = data.turns.filter((t) => t.lane === 's1');
  assert.equal(sess.length, 2);
  assert.equal(data.stats.turns, 2);
  const [t1, t2] = sess;
  assert.equal(t1.prompt, '第一个问题 <b>&</b>');
  assert.equal(t2.parent, t1.id);
  assert.equal(t1.ctx, 500);
  assert.equal(t1.compactions.length, 1);
  assert.deepEqual(t1.items.filter((i) => i.k === 'text').map((i) => i.text), ['先看一下。', '第一轮的回答']);
  assert.equal(data.lanes.find((l) => l.key === 's1').title, '示例会话');
});

test('子代理挂到发起它的那一轮', () => {
  const data = parseProject(fixture());
  const lane = data.lanes.find((l) => l.kind === 'agent');
  assert.equal(lane.agentType, 'Explore');
  assert.equal(lane.parentTurn, 's1:u1');
  const step = data.turns.find((t) => t.id === 's1:u1').items.find((i) => i.k === 'tool');
  assert.equal(step.agentLane, lane.key);
  assert.equal(step.result, '查完了');
});

test('嵌入 HTML 的数据不会提前闭合 script 标签', () => {
  const data = parseProject(fixture());
  data.turns[0].prompt = '</script><script>alert(1)</script>';
  const html = renderHtml(data);
  const json = html.match(/<script id="ctx-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
  assert.equal(JSON.parse(json).turns[0].prompt, data.turns[0].prompt);
});

test('工具正文拆到 ctx-bulk 里，按偏移切出来和原文一致；页面脚本能编译', () => {
  const data = parseProject(fixture());
  data.turns[0].items.push({ k: 'tool', name: 'Bash', sum: 'x', input: '含 </script> 和 分隔符', result: '中文结果' });
  const html = renderHtml(structuredClone(data));
  const core = JSON.parse(html.match(/<script id="ctx-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  const bulk = html.match(/<script id="ctx-bulk" type="application\/json">([\s\S]*?)<\/script>/)[1];
  for (const [ti, t] of core.turns.entries()) {
    for (const [ii, it] of t.items.entries()) {
      if (it.b == null) continue;
      const chunk = JSON.parse(bulk.slice(core.bulk[it.b], core.bulk[it.b + 1]));
      const orig = data.turns[ti].items[ii];
      if (it.iv != null) assert.equal(chunk[it.iv], orig.input);
      if (it.rv != null) assert.equal(chunk[it.rv], orig.result);
    }
  }
  const code = html.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(code));
});

test('Markdown 导出包含每一轮的提问和回答', () => {
  const md = toMarkdown(parseProject(fixture()));
  for (const s of ['第一个问题', '第一轮的回答', '第二轮的回答', '子代理的结论']) assert.ok(md.includes(s), s);
});

const mainScript = (html) => html.match(/<script>([\s\S]*?)<\/script>/)[1];

test('页面带 CSP：只放行自己那一段主脚本，不许外链和联网', () => {
  const html = renderHtml(parseProject(fixture()));
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)[1];
  assert.ok(csp.includes("default-src 'none'") && !csp.includes('unsafe-eval'));
  assert.equal(html.match(/<script>/g).length, 1);
  assert.ok(!/<script[^>]*\ssrc=/i.test(html));
  const hash = crypto.createHash('sha256').update(mainScript(html), 'utf8').digest('base64');
  assert.ok(csp.includes(`script-src 'sha256-${hash}'`));
});

test('回复里的链接只放行 http(s)、mailto 和锚点，属性闭合不了', () => {
  const main = mainScript(renderHtml(parseProject(fixture())));
  const pick = (re) => main.match(re)[0];
  const lib = [/^const esc = .*$/m, /^function inline\(s\) \{[\s\S]*?^\}$/m].map(pick).join('\n');
  const inline = new Function(`${lib}\nreturn inline;`)();
  const ctrl = String.fromCharCode(1);
  for (const s of ['[a](javascript:alert(1))', `[a](${ctrl}javascript:alert(1))`, '[a](JavaScript:x)', '[a](data:text/html,x)', '[a](//evil.example)', '[a](vbscript:x)']) {
    assert.ok(!inline(s).includes('<a '), s);
  }
  assert.equal(inline('[a](https://x.example/?p=1&q=2)'), '<a href="https://x.example/?p=1&amp;q=2" target="_blank" rel="noopener noreferrer">a</a>');
  assert.equal(inline('[a](https://x.example/"onmouseover=alert(1))'), '<a href="https://x.example/&quot;onmouseover=alert(1" target="_blank" rel="noopener noreferrer">a</a>)');
  assert.equal(inline('[foo.ts](src/foo.ts:42)'), '<span class="lk" title="src/foo.ts:42">foo.ts</span>');
  assert.ok(!/href="[^"]*<code/.test(inline('[a](`x`) 和 [b](https://x.example/`y`)')));
});

test('总目录转义项目名和路径，没有脚本', () => {
  const html = renderIndex([{ href: 'a"b.html', name: '<img src=x onerror=alert(1)>', cwd: 'E:/x', sessions: '3', turns: 'oops', end: '2026-09-01T00:00:00Z' }]);
  assert.ok(!html.includes('<img') && !html.includes('a"b'));
  assert.ok(!/<script/i.test(html) && html.includes("default-src 'none'"));
  assert.ok(html.includes('<b>3</b>个会话') && html.includes('<b>0</b>轮对话'));
});

test('从别的会话分叉出来的会话接到父消息所在的那一轮，父消息是回答也行', () => {
  const data = parseProject(fixture((dir) => {
    const s2 = builders('s2');
    writeJsonl(path.join(dir, 's2.jsonl'), [
      s2.user('f1', 'a4', '换个思路'),
      s2.asst('f2', 'f1', 'fm1', [{ type: 'text', text: '好' }]),
    ]);
    const s3 = builders('s3');
    writeJsonl(path.join(dir, 's3.jsonl'), [s3.user('h1', 'u1', '从第一个问题重来')]);
  }));
  const first = (lane) => data.turns.find((t) => t.lane === lane);
  assert.equal(first('s2').parent, 's1:u2');
  assert.equal(first('s3').parent, 's1:u1');
  assert.ok(!('uuid' in first('s2')) && !('externalParent' in first('s2')));
});

test('总览按分叉关系给会话分组：分叉出来的会话和源头一组，组名取最早那条', () => {
  const data = parseProject(fixture((dir) => {
    const s2 = builders('s2');
    writeJsonl(path.join(dir, 's2.jsonl'), [s2.user('f1', 'a4', '换个思路'), s2.asst('f2', 'f1', 'fm1', [{ type: 'text', text: '好' }])]);
    const s3 = builders('s3');
    writeJsonl(path.join(dir, 's3.jsonl'), [s3.user('h1', 'f2', '接着 s2 往下')]);
    const s4 = builders('s4');
    writeJsonl(path.join(dir, 's4.jsonl'), [s4.user('k1', null, '另起一个话题'), s4.asst('k2', 'k1', 'km1', [{ type: 'text', text: '行' }])]);
  }));
  const main = mainScript(renderHtml(data));
  const src = main.match(/^function sessionFamilies\(lanes, turns\) \{[\s\S]*?^\}$/m)[0];
  const fam = new Function(`${src}\nreturn sessionFamilies;`)()(data.lanes, data.turns);
  assert.deepEqual(Object.fromEntries(fam), { s1: 's1', s2: 's1', s3: 's1', s4: 's4' });
});

// 假密钥在运行时拼出来，源码里不出现完整的密钥形状
const fake = (prefix, n) => prefix + 'Q7mZ2xK9pL4w'.repeat(Math.ceil(n / 12)).slice(0, n);
const SK = fake('sk-', 48);
const UUID = ['123e4567', 'e89b', '12d3', 'a456', '426614174000'].join('-');
const pem = (edge) => `-----${edge} RSA PRIVATE KEY-----`;

test('认得出常见密钥，普通标识符和文档里的示例占位不动', () => {
  const hit = [
    `key 是 ${SK}，别外传`,
    `参考一下这个 ${fake('ak_', 64)} 做一款游戏`,
    `stripe 用 ${fake('sk_live_', 24)}`,
    `OPENAI_API_KEY=${SK}`,
    `Authorization: Bearer ${fake('', 40)}`,
    `postgres://app:${fake('', 20)}@db:5432/main`,
    `{"api_key": "${fake('', 32)}"}`,
    `DEEPSEEK_TOKEN: '${fake('', 24)}'`,
    `const openaiApiKey = "${fake('', 32)}";`,
    `npx some-cli --api-key ${fake('', 32)} --verbose`,
    `DB_PASSWORD=${fake('', 10)}`,
    `X-Api-Key: ${UUID}`,
    `git clone https://${fake('ghp_', 36)}@github.com/a/b`,
    fake('AKIA', 16).toUpperCase(),
    `${pem('BEGIN')}\n${fake('', 64)}\n${pem('END')}`,
  ];
  for (const s of hit) {
    const out = redact(s);
    assert.ok(!/Q7mZ2x|Q7MZ2X|426614174000/.test(out), s.slice(0, 24));
    // 删掉的地方什么都不留；给了标记才看得出删在哪，一处命中只删一段
    const marked = redact(s, '¤');
    assert.equal(marked.split('¤').length - 1, 1, s.slice(0, 24));
    assert.equal(out, marked.replace('¤', ''), s.slice(0, 24));
  }
  const keep = [
    'sk-fragment-cache-v1',
    '<task-notification> 和 risk-assessment-report',
    'max_tokens: 4096, tokens=128000',
    'password = hash_password(raw_password)',
    'postgres://user:password@localhost/db',
    'postgresql://postgres:postgres@localhost:5432/app',
    'API_KEY=$OPENAI_API_KEY',
    'Bearer token 要放在 Authorization 头里',
    "const LOCAL_REVIEW_STORAGE_KEY = 'gamenet2-review-v1';",
    'TLS_CERTIFICATE_KEY=\n./certs/dev-key.pem',
    'PWD=/c/Users/demo/project2',
    'secretAccessKey: options.uploadS3SecretAccessKey,',
    `public_key=${fake('', 32)}`,
  ];
  for (const s of keep) assert.equal(redact(s), s);
});

// 别处打过码的密钥，露出来的头尾也是真字符
const masked = (head, dots, tail) => head + dots + tail;

test('打过码的半截密钥整段删掉，只有前缀和省略号的占位不动', () => {
  const hit = [
    `报错：Incorrect API key provided: ${masked('sk-Q7m', '***', 'xK9')}`,
    `用的是 ${masked('sk-proj-Q7mZ2', '...', 'pL4wQ7')} 这个`,
    `${masked('ghp_', '****', 'pL4wQ7mZ')}`,
    `"command": "echo\\n${masked('sk-Q7m', '…', 'xK9')}"`,
    `key=${masked('sk-Q7mZ2', '*'.repeat(55), 'pL4w')}`,
  ];
  for (const s of hit) assert.ok(!/Q7m|pL4w/.test(redact(s)), s.slice(0, 30));
  const keep = ['sk-...', 'sk_live_****', '把 sk-*** 换成你自己的', 'risk-assessment... 写完了', 'ghp_…'];
  for (const s of keep) assert.equal(redact(s), s);
});

test('导出的 JSON、HTML、Markdown 里都不留密钥，截断处的密钥也不留半截', () => {
  const data = parseProject(fixture((dir) => {
    const { user, asst } = builders('s4');
    writeJsonl(path.join(dir, 's4.jsonl'), [
      user('k1', null, `帮我配上 ${SK}`),
      asst('k2', 'k1', 'km1', [
        { type: 'thinking', thinking: `用户贴了 ${SK}`, signature: 'x' },
        { type: 'text', text: `已写入，${SK} 别外传` },
        { type: 'tool_use', id: 'kt1', name: 'Bash', input: { command: `cd app\nOPENAI_API_KEY=${SK} npm start` } },
      ]),
      // 密钥正好跨在默认的 4000 字截断处
      user('k3', 'k2', [{ type: 'tool_result', tool_use_id: 'kt1', content: `${'x'.repeat(3990)} ${SK} ${'后面还有'.repeat(30)}` }]),
    ]);
  }));
  // 删了几处只给命令行看：不可枚举，序列化、复制都带不走
  assert.equal(data.removed, 5);
  assert.ok(!Object.keys(data).includes('removed') && !('redacted' in data.stats));
  const step = data.turns.find((t) => t.lane === 's4').items.find((i) => i.k === 'tool');
  assert.equal(step.sum, 'cd app');
  assert.ok(step.input.includes('OPENAI_API_KEY= npm start'));
  assert.ok(step.result.startsWith(`${'x'.repeat(3990)}  后面还有`) && step.result.includes('原长 4163 字符'));
  for (const out of [JSON.stringify(data), renderHtml(structuredClone(data)), toMarkdown(data, { thinking: true })]) {
    assert.ok(!out.includes(SK.slice(0, 9)));
    assert.ok(!/密钥已隐藏|隐藏了|删掉了/.test(out));
  }
});

test('写文件前再查一遍：还有像密钥的内容就一个文件都不写，报错里也不带密钥', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtree-out-'));
  const file = path.join(dir, 'sub', 'a.html');
  const data = parseProject(fixture());
  data.turns[0].prompt = `漏网的 ${SK}`;
  assert.throws(() => checkData(data, 'demo'), (e) => e instanceof SecretLeftError && !e.message.includes(SK.slice(3, 9)));
  data.lanes[0].title = `漏网的 ${fake('ghp_', 36)}`;
  assert.throws(() => writeExport(file, renderHtml(data)), SecretLeftError);
  assert.throws(() => writeExport(file, `<p>${masked('sk-Q7m', '***', 'xK9')}</p>`), SecretLeftError);
  assert.throws(() => writeExport(file, `${pem('BEGIN')}\n${fake('', 64)}`), SecretLeftError);
  assert.ok(!fs.existsSync(path.dirname(file)));
  // 会话 uuid 挂在 key 上不算密钥，干净的数据照常写
  const clean = parseProject(fixture());
  checkData(clean, 'demo');
  writeExport(file, renderHtml(clean, { home: 'index.html' }));
  assert.ok(fs.statSync(file).size > 0);
});
