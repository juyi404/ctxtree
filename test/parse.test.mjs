import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseProject } from '../src/parse.mjs';
import { renderHtml } from '../src/render.mjs';
import { toMarkdown } from '../src/export-md.mjs';

// 构造一个最小的转录目录：一个会话、两轮提问（中间有一次压缩）、一个子代理
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtree-'));
  const sid = 's1';
  let n = 0;
  const ts = () => new Date(Date.UTC(2026, 8, 1, 0, 0, n++)).toISOString();
  const base = { sessionId: sid, cwd: 'E:\demo', gitBranch: 'main' };
  const user = (uuid, parentUuid, content, extra = {}) => ({ ...base, type: 'user', uuid, parentUuid, timestamp: ts(), message: { role: 'user', content }, ...extra });
  const asst = (uuid, parentUuid, id, content, usage) => ({ ...base, type: 'assistant', uuid, parentUuid, timestamp: ts(), message: { id, role: 'assistant', model: 'claude-opus-5-5', content, usage } });
  const usage = (i) => ({ input_tokens: i, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 });
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
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), main.map((r) => JSON.stringify(r)).join('\n'));
  const sub = path.join(dir, sid, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const agent = [
    user('g1', null, '去查', { isSidechain: true }),
    asst('g2', 'g1', 'gm1', [{ type: 'text', text: '子代理的结论' }], usage(40)),
  ];
  fs.writeFileSync(path.join(sub, 'agent-x1.jsonl'), agent.map((r) => JSON.stringify(r)).join('\n'));
  fs.writeFileSync(path.join(sub, 'agent-x1.meta.json'), JSON.stringify({ agentType: 'Explore', description: '查资料', toolUseId: 'tu1' }));
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
