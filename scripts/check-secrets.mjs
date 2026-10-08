#!/usr/bin/env node
// 提交、推送前查密钥：用 parse.mjs 导出脱敏的同一套规则扫新增的行，命中就拦下。
// 只打印文件、行号和脱敏后的那一行，不打印密钥本身。
//   --staged  暂存区（pre-commit）
//   --push    这次要推送的所有提交（pre-push，从标准输入读引用）
//   --all     全部历史
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { redact } from '../src/parse.mjs';

const git = (...args) => execFileSync('git', ['-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 1 << 30 });
const ZERO = /^0+$/;

// 把 diff 按块切开，块里连续新增的行合在一起查（私钥块跨多行）
function scanDiff(diff, where, found) {
  let file = null, line = 0, block = [];
  const flush = () => {
    if (!block.length) return;
    const text = block.map((b) => b.text).join('\n');
    if (redact(text) !== text) {
      const lines = block.filter((b) => redact(b.text) !== b.text);
      for (const b of lines.length ? lines : [block[0]]) found.push({ where, file, line: b.line, text: redact(b.text) });
    }
    block = [];
  };
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) { flush(); file = l.slice(4).replace(/^b\//, ''); continue; }
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { flush(); line = Number(h[1]); continue; }
    if (l.startsWith('+')) { block.push({ line, text: l.slice(1) }); line++; continue; }
    flush();
    if (l.startsWith(' ')) line++;
  }
  flush();
}

const show = (sha) => git('show', '--format=', '-U0', '--no-color', '--no-ext-diff', sha);
const found = [];
const mode = process.argv[2];

if (mode === '--staged') {
  scanDiff(git('diff', '--cached', '-U0', '--no-color', '--no-ext-diff'), '暂存区', found);
} else if (mode === '--push' || mode === '--all') {
  let shas = [];
  if (mode === '--all') shas = git('rev-list', '--all').split('\n');
  else {
    // 每行：<本地引用> <本地 sha> <远端引用> <远端 sha>；远端还没有这个分支时远端 sha 全是 0
    for (const l of fs.readFileSync(0, 'utf8').split('\n')) {
      const [, local, , remote] = l.trim().split(/\s+/);
      if (!local || ZERO.test(local)) continue;
      const range = ZERO.test(remote) ? [local, '--not', '--remotes'] : [`${remote}..${local}`];
      shas.push(...git('rev-list', ...range).split('\n'));
    }
  }
  for (const sha of new Set(shas.filter(Boolean))) scanDiff(show(sha), sha.slice(0, 7), found);
} else {
  console.error('用法：node scripts/check-secrets.mjs --staged | --push | --all');
  process.exit(2);
}

if (!found.length) process.exit(0);
console.error(`\n发现 ${found.length} 处疑似密钥，已拦下：`);
for (const f of found) console.error(`  ${f.where}  ${f.file}:${f.line}  ${f.text.trim().slice(0, 120)}`);
console.error('\n把密钥移出文件（放环境变量或被忽略的本地配置）后再提交。已经提交进历史的，要改写那次提交，光删掉再提交一次没用。');
process.exit(1);
