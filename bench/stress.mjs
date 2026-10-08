// 压力测试页：把一个真实项目的数据复制 N 份（换掉所有 uuid），生成 out/stress.html
// 用法：node bench/stress.mjs [项目] [份数]
import fs from 'node:fs';
import path from 'node:path';
import { resolveProject, parseProject } from '../src/parse.mjs';
import { renderHtml } from '../src/render.mjs';

const [arg = 'E--Projects-context-gateway', copies = '12'] = process.argv.slice(2);
const base = parseProject(resolveProject(arg));
const json = JSON.stringify({ turns: base.turns, lanes: base.lanes });
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const turns = [], lanes = [];
for (let k = 0; k < Number(copies); k++) {
  const c = JSON.parse(json.replace(UUID, (u) => `${u}x${k}`));
  turns.push(...c.turns);
  lanes.push(...c.lanes);
}
lanes.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
const data = {
  ...base, turns, lanes,
  project: { ...base.project, name: `压力测试 ×${copies}` },
  stats: { ...base.stats, sessions: lanes.filter((l) => l.kind === 'session').length, agents: lanes.filter((l) => l.kind === 'agent').length, turns: turns.length },
};
const out = path.resolve('out/stress.html');
fs.writeFileSync(out, renderHtml(data));
console.log(`${out}  ${turns.length} 轮  ${lanes.length} 条线路  ${(fs.statSync(out).size / 1048576).toFixed(1)} MB`);
