'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Scheduler } = require('./scheduler');
const { makeCodexExecutor } = require('./executor-codex');
const { Workspace } = require('./workspace');

const RUNS = path.join(__dirname, '..', 'runs');

const ATTEMPTS = Math.max(1, parseInt(process.env.ISO_ATTEMPTS || '3', 10));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MARKER = 'REAL-SHADOW-' + Date.now().toString(36);
const SEED = 'SEED-' + MARKER;

(async () => {

  const base = path.join(os.tmpdir(), 'iso-e2e-base-' + Date.now());
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'seed.txt'), SEED);

  const runRoot = path.join(RUNS, 'iso-e2e-' + Date.now());
  const runId = path.basename(runRoot);
  const ws = new Workspace({ base, runRoot });

  console.log('=== 真实子代理 · 影子工作区端到端 ===');
  console.log('base     =', base);
  console.log('runRoot  =', runRoot);
  console.log('（每个真实子任务约 60-140s，耐心等）\n');

  const worker = makeCodexExecutor({ workspace: ws });
  const readLog = [];

  const wrapped = async (args) => {
    const t = args.task;
    const r = await worker(args);
    try {
      const seen = fs.readFileSync(path.join(base, 'out.txt'), 'utf8');
      readLog.push({ id: t.id, type: t.type, seen });
    } catch { readLog.push({ id: t.id, type: t.type, seen: null }); }
    return r;
  };

  const s = new Scheduler({
    runId, root: runRoot, worker: wrapped, concurrency: 3,
    onPublish: (t) => ws.publish(t),
  });

  s.init('真实子代理在影子工作区写文件', [
    {
      id: 'w', type: 'implement', role: 'worker', deps: [],
      budget: { timeoutSec: 300, stallSec: 240, maxAttempts: ATTEMPTS },
      input: { description:
        `在当前工作目录里创建文件 out.txt，内容就写这一行：${MARKER}\n` +
        `然后运行 cat out.txt 确认内容。完成后简短汇报。` },
    },
    {
      id: 'r1', type: 'review', role: 'reviewer', deps: [],
      budget: { timeoutSec: 300, stallSec: 240, maxAttempts: ATTEMPTS },
      input: { description:
        '检查当前工作目录里是否存在 out.txt。' +
        '如果不存在，直接汇报"不存在"即可（不要创建它）。如果存在，汇报它的完整内容。' },
    },
  ]);

  const t0 = Date.now();
  const r = await Promise.race([s.run(), sleep(600000).then(() => ({ hang: true }))]);
  const wall = Math.round((Date.now() - t0) / 1000);

  console.log('\n--- 结果 ---');
  const st = (r.tasks || []).map((t) => t.id + ':' + t.state);
  console.log('任务状态:', st.join(' '), `（耗时 ${wall}s）`);

  const baseOut = fs.existsSync(path.join(base, 'out.txt'))
    ? fs.readFileSync(path.join(base, 'out.txt'), 'utf8') : null;

  let bad = 0;
  const say = (ok, msg) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}`); if (!ok) bad++; };

  say(baseOut !== null, baseOut !== null
    ? `base 里已发布 out.txt：${JSON.stringify(baseOut.slice(0, 60))}`
    : 'base 里没有 out.txt —— 影子工作区的改动没有发布回来');
  say(baseOut !== null && baseOut.includes(MARKER), '发布回来的内容确实是子代理写的内容');
  say(!r.hang, '未 hang');

  const allDone = (r.tasks || []).length > 0 && r.tasks.every((t) => t.state === 'done');
  say(allDone, `全部 ${(r.tasks || []).length} 个任务状态为 done（实际：${st.join(' ')}）`);

  for (const e of readLog) {
    if (e.type !== 'review') continue;
    const torn = e.seen !== null && e.seen.length > 0 && !e.seen.includes(MARKER) && !e.seen.includes(SEED);
    say(!torn, `只读子代理 ${e.id} 读到的是完整状态：${e.seen === null ? 'out.txt 不存在（正确，尚未发布）' : JSON.stringify(e.seen.slice(0, 40))}`);
  }

  console.log('\n工作区统计:', JSON.stringify(ws.stats));
  console.log(bad === 0 ? '\n真实端到端通过 ✅' : `\n${bad} 项失败 ❌`);

  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch {}
  process.exit(bad ? 1 : 0);
})();
