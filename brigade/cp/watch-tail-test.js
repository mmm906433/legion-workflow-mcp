'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const NL = String.fromCharCode(10);
const file = path.join(os.tmpdir(), 'watchtail-' + Date.now() + '.jsonl');
const ts0 = Date.now();
const evts = [
  { ts: ts0, kind: 'stage', stage: 'planning', note: '第一轮' },
  { ts: ts0, kind: 'start', id: 't1', title: '任务一' },
  { ts: ts0, kind: 'beat', id: 't1', note: '执行中' },
];
fs.writeFileSync(file, evts.map((e) => JSON.stringify(e)).join(NL) + NL);

const child = spawn(process.execPath, [path.join(__dirname, 'watch.js'), file, '--follow'],
  { stdio: ['ignore', 'pipe', 'inherit'] });
let out = '';
child.stdout.on('data', (d) => { out += d.toString('utf8'); });

const timer = setTimeout(() => {

  const add = [
    { ts: ts0, kind: 'finish', id: 't1', ok: true, summary: '完成一' },
    { ts: ts0 + 1, kind: 'start', id: 't2', title: '任务二' },
  ];
  fs.appendFileSync(file, add.map((e) => JSON.stringify(e)).join(NL) + NL);
}, 500);

setTimeout(() => {
  clearTimeout(timer);
  child.kill();
  const lines = out.split(NL).filter((l) => l.startsWith('['));
  let fail = 0;
  const check = (n, c, x = '') => { console.log(`${c ? '  ✓' : '  ✗'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
  check('恰好渲染 5 条事件（3 初始 + 2 追加）', lines.length === 5, `实际 ${lines.length} 条`);
  check('旧 3 条未被重复打印（增量而非全量）', lines.filter((l) => l.includes('任务一')).length === 1);
  check('同毫秒追加事件未丢失', lines.some((l) => l.includes('完成一')));
  check('第二条追加事件已渲染', lines.some((l) => l.includes('任务二')));
  console.log(fail ? ('\n' + fail + ' 项失败 ❌') : '\nwatch 增量读回归通过 ✅');
  try { fs.unlinkSync(file); } catch {}
  process.exit(fail ? 1 : 0);
}, 2600);
