#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { listProjects, resolveProject, parseProject, PROJECTS_DIR } from '../src/parse.mjs';
import { renderHtml, renderIndex } from '../src/render.mjs';
import { toMarkdown } from '../src/export-md.mjs';

const HELP = `ctxtree — 把一个项目下所有 Claude Code 对话导出成横向的上下文树

用法
  ctxtree [项目]            生成该项目的 HTML（默认取当前目录）
  ctxtree list              列出所有有对话记录的项目
  ctxtree all               给每个项目各生成一份，并生成总目录 index.html

[项目] 可以是项目路径（E:\\PaM）、转录目录名（E--PaM）或转录目录的完整路径。

选项
  -o, --out <路径>    输出文件（单项目）或输出目录（all），默认 ./out
  --md                同时导出 Markdown
  --json              同时导出 JSON
  --no-tools          不保存工具调用的输入和输出（文件会小很多）
  --no-thinking       不保存思考过程
  --no-agents         不解析子代理
  --max-tool <n>      单个工具输入/输出最多保留的字符数，默认 4000，0 表示不截断
  --open              生成后用默认浏览器打开
  -h, --help          显示帮助

转录目录：${PROJECTS_DIR}`;

function parseArgs(argv) {
  // opts 只收显式传入的覆盖项，默认值统一由 parse.mjs 的 DEFAULTS 提供
  const a = { _: [], opts: {} };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '-h' || v === '--help') a.help = true;
    else if (v === '-o' || v === '--out') a.out = argv[++i];
    else if (v === '--md') a.md = true;
    else if (v === '--json') a.json = true;
    else if (v === '--no-tools') a.opts.tools = false;
    else if (v === '--no-thinking') a.opts.thinking = false;
    else if (v === '--no-agents') a.opts.agents = false;
    else if (v === '--max-tool') a.opts.maxTool = Number(argv[++i]);
    else if (v === '--open') a.open = true;
    else if (v.startsWith('-')) throw new Error(`未知选项 ${v}，用 --help 查看可用选项。`);
    else a._.push(v);
  }
  return a;
}

function openInBrowser(file) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]]
    : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
  spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
}

const size = (f) => `${(fs.statSync(f).size / 1024 / 1024).toFixed(1)} MB`;

function exportOne(dir, htmlFile, args) {
  const data = parseProject(dir, args.opts);
  fs.mkdirSync(path.dirname(htmlFile), { recursive: true });
  fs.writeFileSync(htmlFile, renderHtml(data));
  const written = [htmlFile];
  const base = htmlFile.replace(/\.html?$/i, '');
  if (args.md) { fs.writeFileSync(`${base}.md`, toMarkdown(data, { tools: args.opts.tools })); written.push(`${base}.md`); }
  if (args.json) { fs.writeFileSync(`${base}.json`, JSON.stringify(data, null, 2)); written.push(`${base}.json`); }
  return { data, written };
}

const safeName = (s) => s.replace(/[<>:"/\\|?*\s]+/g, '_');

const hiddenNote = (data, sep = '，') => (data.stats.redacted ? `${sep}隐藏了 ${data.stats.redacted} 处密钥` : '');

// all 里的一个项目：导出后返回总目录条目和要打印的那一行；没有对话的项目不留文件
function exportEntry(dir, file, args) {
  const { data } = exportOne(dir, file, args);
  if (!data.turns.length) { fs.rmSync(file); return {}; }
  return {
    entry: { href: path.basename(file), name: data.project.name, cwd: data.project.cwd, sessions: data.stats.sessions, turns: data.stats.turns, end: data.stats.end, redacted: data.stats.redacted },
    line: `✓ ${data.project.name.padEnd(28)} ${data.stats.sessions} 个会话 ${data.stats.turns} 轮  ${size(file)}${hiddenNote(data, '  ')}`,
  };
}

// 项目之间互不依赖，分给几个工作线程并行导出（工作线程跑的也是这个文件，见末尾）。
// 大项目先发，免得最后剩一个大项目单独跑；每个线程同时只拿一个项目，内存跟着线程数走，所以封顶
const MAX_WORKERS = 8;
function exportAll(projects, outDir, args) {
  const jobs = [...projects].sort((a, b) => b.bytes - a.bytes);
  const n = Math.min(jobs.length, MAX_WORKERS, Math.max(1, (os.availableParallelism?.() ?? os.cpus().length) - 1));
  const entries = [];
  const take = (r) => { if (r.entry) { entries.push(r.entry); console.log(r.line); } };
  if (n <= 1) {
    for (const p of jobs) take(exportEntry(p.dir, path.join(outDir, `${safeName(p.id)}.html`), args));
    return Promise.resolve(entries);
  }
  return new Promise((resolve, reject) => {
    let next = 0, running = n;
    const workers = [];
    const feed = (w) => {
      if (next < jobs.length) {
        const p = jobs[next++];
        w.postMessage({ dir: p.dir, file: path.join(outDir, `${safeName(p.id)}.html`), args });
        return;
      }
      w.terminate();
      if (--running === 0) resolve(entries);
    };
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL(import.meta.url));
      workers.push(w);
      w.on('message', (r) => { take(r); feed(w); });
      w.on('error', (e) => { for (const x of workers) x.terminate(); reject(e); });
      feed(w);
    }
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }
  const [cmd] = args._;

  if (cmd === 'list') {
    const ps = listProjects();
    if (!ps.length) { console.log(`在 ${PROJECTS_DIR} 下没有找到对话记录。`); return; }
    for (const p of ps) console.log(`${p.lastModified.slice(0, 16).replace('T', ' ')}  ${String(p.sessions).padStart(3)} 个会话  ${p.cwd || '(未知路径)'}  [${p.id}]`);
    return;
  }

  if (cmd === 'all') {
    const outDir = path.resolve(args.out || 'out');
    const entries = await exportAll(listProjects(), outDir, args);
    const index = path.join(outDir, 'index.html');
    fs.writeFileSync(index, renderIndex(entries));
    console.log(`\n总目录：${index}`);
    if (args.open) openInBrowser(index);
    return;
  }

  const dir = resolveProject(cmd);
  const t0 = Date.now();
  const guessName = path.basename(dir);
  const out = path.resolve(args.out || path.join('out', `${safeName(guessName)}.html`));
  const { data, written } = exportOne(dir, out, args);
  console.log(`项目 ${data.project.name}（${data.project.cwd || dir}）`);
  console.log(`  ${data.stats.sessions} 个会话，${data.stats.turns} 轮对话，${data.stats.agents} 个子代理，用时 ${Date.now() - t0} ms${hiddenNote(data)}`);
  for (const f of written) console.log(`  → ${f}  ${size(f)}`);
  if (args.open) openInBrowser(out);
}

if (isMainThread) main().catch((e) => { console.error(`出错了：${e.message}`); process.exit(1); });
else parentPort.on('message', ({ dir, file, args }) => parentPort.postMessage(exportEntry(dir, file, args)));
