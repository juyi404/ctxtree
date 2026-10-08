// 上下文树 → Markdown。此文件会被原样内联进 HTML 查看器，保持无 import、纯函数。

export function toMarkdown(data, opts = {}) {
  const { turnIds = null, tools = true, thinking = false, title = null } = opts;
  const byId = new Map(data.turns.map((t) => [t.id, t]));
  const laneOf = new Map(data.lanes.map((l) => [l.key, l]));
  const fmt = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '');
  const kfmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n || 0));
  const quote = (s) => String(s || '').split('\n').map((l) => `> ${l}`).join('\n');

  const out = [];
  out.push(`# ${title || `上下文树 · ${data.project.name}`}`, '');
  out.push(`- 项目目录：\`${data.project.cwd || data.project.dir}\``);
  out.push(`- 导出时间：${fmt(new Date().toISOString())}`);
  out.push(`- 会话 ${data.stats.sessions} 个 · 子代理 ${data.stats.agents} 个 · 用户轮次 ${data.stats.turns}`, '');

  const selected = turnIds ? turnIds.map((id) => byId.get(id)).filter(Boolean) : data.turns;
  const groups = [];
  for (const t of selected) {
    let g = groups[groups.length - 1];
    if (!g || g.lane !== t.lane) groups.push((g = { lane: t.lane, turns: [] }));
    g.turns.push(t);
  }
  const indexInLane = new Map();
  for (const l of data.lanes) {
    data.turns.filter((t) => t.lane === l.key).forEach((t, i) => indexInLane.set(t.id, i + 1));
  }

  for (const g of groups) {
    const lane = laneOf.get(g.lane) || { title: g.lane, kind: 'session' };
    const head = lane.kind === 'agent' ? `子代理 · ${lane.agentType} · ${lane.title}` : `会话 · ${lane.title}`;
    out.push(`## ${head}`, '');
    out.push(`<sub>${lane.sessionId || lane.key}${lane.branch ? ` · 分支 ${lane.branch}` : ''} · ${fmt(lane.start)}</sub>`, '');
    for (const t of g.turns) {
      const tl = Object.entries(t.tools || {}).map(([k, v]) => `${k}×${v}`).join(' ');
      out.push(`### #${indexInLane.get(t.id)} · ${fmt(t.t0)}`, '');
      out.push(`<sub>${t.model || ''} · 上下文 ${kfmt(t.ctx)} · 输出 ${kfmt(t.out)}${tl ? ` · ${tl}` : ''}${t.interrupted ? ' · 已中断' : ''}</sub>`, '');
      out.push('**用户**', '', quote(t.prompt), '');
      out.push('**Claude**', '');
      for (const it of t.items) {
        if (it.k === 'text') out.push(it.text, '');
        else if (it.k === 'think' && thinking) out.push('<details><summary>思考</summary>', '', it.text, '', '</details>', '');
        else if (it.k === 'tool' && tools) {
          out.push(`- 🔧 **${it.name}** ${it.sum ? `— ${it.sum.replace(/\n/g, ' ')}` : ''}${it.err ? ' ⚠️' : ''}${it.agentLane ? `（→ 子代理：${laneOf.get(it.agentLane)?.title || it.agentLane}）` : ''}`);
        } else if (it.k === 'queued') out.push(`> 💬 用户插话：${it.text}`, '');
        else if (it.k === 'note') out.push(`> ℹ️ ${it.text.split('\n')[0]}`, '');
        else if (it.k === 'compact') out.push(`> ✂️ 上下文压缩（${it.trigger || ''}）${kfmt(it.pre)} → ${kfmt(it.post)}`, '');
      }
      out.push('');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}
