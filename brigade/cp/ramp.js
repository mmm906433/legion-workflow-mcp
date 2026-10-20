'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Scheduler } = require('./scheduler');
const { Command, syncSquads, flattenSquads, makeWriteGate } = require('./hierarchy');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeWorker({ chaosRate = 0, latencyMs = 1 } = {}) {
  return async ({ task, signal, heartbeat }) => {
    const r = Math.random();
    if (chaosRate > 0 && r < chaosRate * 0.4) {

      await new Promise(() => {});
    }
    await sleep(latencyMs);
    if (chaosRate > 0 && r < chaosRate * 0.6) {
      return { verdict: 'fail', failureType: 'crash', summary: '注入的瞬时失败' };
    }
    if (task.heartbeatHook) heartbeat();
    return { verdict: 'done', summary: `ok ${task.id}` };
  };
}

async function ramp(level, opts = {}) {
  const { squads, perSquad, concurrency, chaosRate = 0, root } = opts;
  const worker = makeWorker({ chaosRate, latencyMs: 1 });
  const cmd = new Command({ difficulty: 'hard', globalConcurrency: concurrency });
  cmd.goal = `爬坡档位 ${level}：${squads} 个小队`;
  const cards = [];
  for (let i = 0; i < squads; i++) {
    const pipeline = i % 4 === 3;
    const b = { timeoutSec: 2, stallSec: 1, maxAttempts: 2, backoffMs: 200 };
    const tasks = [];
    if (pipeline) {
      for (let k = 0; k < Math.max(3, perSquad); k++) {
        tasks.push({
          id: `s${i}p${k}`, type: k === 0 ? 'explore' : k === 1 ? 'implement' : 'test',
          deps: k === 0 ? [] : [`s${i}p${k - 1}`], budget: b,
        });
      }
    } else {
      for (let k = 0; k < perSquad; k++) {
        tasks.push({ id: `s${i}w${k}`, type: 'implement', deps: [], budget: b });
      }
    }
    cards.push({ id: `c${i}`, title: `小队${i}${pipeline ? '(递进)' : ''}`, goal: `目标${i}`, pipeline });
  }
  cmd.deploy(cmd.goal, cards, (card) => (card.pipeline
    ? [{ id: card.id + 'p0', type: 'explore', deps: [], budget: { timeoutSec: 2, stallSec: 1, maxAttempts: 2 } },
       { id: card.id + 'p1', type: 'implement', deps: [card.id + 'p0'], budget: { timeoutSec: 2, stallSec: 1, maxAttempts: 2 } },
       { id: card.id + 'p2', type: 'test', deps: [card.id + 'p1'], budget: { timeoutSec: 2, stallSec: 1, maxAttempts: 2 } }]
    : Array.from({ length: perSquad }, (_, k) => ({ id: `${card.id}w${k}`, type: 'implement', deps: [], budget: { timeoutSec: 2, stallSec: 1, maxAttempts: 2 } }))));

  const tasks = flattenSquads(cmd);
  const s = new Scheduler({
    runId: 'ramp' + level, root, worker, concurrency,
    onProgress: (ts) => syncSquads(cmd, ts), admission: makeWriteGate(cmd),
  });
  s.init(cmd.goal, tasks);

  const t0 = Date.now();

  const res = await Promise.race([s.run(), sleep(120000).then(() => ({ hang: true, tasks: [], done: 0, failed: 0, degraded: 0, skipped: 0 }))]);
  const wall = Date.now() - t0;
  const st = cmd.status();

  const problems = [];
  if (res.hang) problems.push('hang');

  const total = tasks.length;
  const settledCount = res.done + (res.failed || 0) + (res.degraded || 0) + (res.skipped || 0);
  if (!res.hang) {
    if (settledCount !== total) problems.push('完成度不守恒 ' + settledCount + '/' + total);
    const successRate = res.done / total;

    const minRate = chaosRate > 0 ? 0.25 : 1.0;
    if (successRate < minRate) problems.push('成功率 ' + (successRate * 100).toFixed(0) + '% < ' + (minRate * 100).toFixed(0) + '%');
  }

  const stuck = (res.tasks || []).filter((t) => !['done', 'failed', 'degraded', 'skipped'].includes(t.state));
  if (stuck.length) problems.push(`残留非终态 ${stuck.length}`);

  const disk = s.store.loadTasks('ramp' + level);
  const memMap = new Map((res.tasks || []).map((t) => [t.id, t.state]));
  const mismatch = disk.filter((t) => memMap.get(t.id) !== t.state);
  if (mismatch.length) problems.push(`内存/磁盘不一致 ${mismatch.length}（例 ${mismatch[0] && mismatch[0].id}）`);

  if (disk.length !== total) problems.push('任务数漂移 磁盘' + disk.length + '≠预期' + total);

  const activeStuck = st.squads.filter((sq) => sq.status === 'active');
  if (activeStuck.length && !res.hang) problems.push(`小队卡 active ${activeStuck.length}`);

  const ep = s.store.currentEpoch('ramp' + level);
  if (!(ep > 0)) problems.push('epoch 未推进');

  const thr = res.done / (wall / 1000);
  console.log(
    `档${String(level).padStart(4)} | 小队${String(squads).padStart(3)} 并发${String(concurrency).padStart(3)} | ` +
    `完成${String(res.done).padStart(4)}/${tasks.length} 受阻${String(res.blocked).padStart(3)} | ` +
    `${String(wall).padStart(6)}ms ${thr.toFixed(0)}/s | ${problems.length ? '❌ ' + problems.join('; ') : '✅ 无异常'}`
  );
  return { level, squads, concurrency, tasks: tasks.length, done: res.done, wall, thr, problems, st, cmd, s, res };
}

(async () => {
  const from = parseInt(process.argv[2] || '1', 10);
  const to = parseInt(process.argv[3] || '64', 10);
  const root = path.join(os.tmpdir(), 'ramp-' + Date.now());
  const mode = process.env.MODE || 'clean';

  console.log(`=== 阶梯爬坡（${mode === 'chaos' ? '恶劣条件：注入卡死+失败' : '正常条件'}）===\n`);

  const levels = [];
  for (let s = from; s <= to; s = s < 8 ? s + 1 : s < 32 ? s + 4 : s * 2) levels.push(s);
  if (levels[levels.length - 1] !== to) levels.push(to);

  const chaosRate = mode === 'chaos' ? 0.35 : 0;
  const rows = [];
  for (const squads of levels) {
    const perSquad = squads < 8 ? 2 : squads < 32 ? 3 : 4;
    const concurrency = Math.min(Math.max(4, Math.round(squads * perSquad * 0.6)), 200);
    rows.push(await ramp(squads, { squads, perSquad, concurrency, chaosRate, root }));
    await sleep(500);
  }

  const firstBad = rows.find((r) => r.problems.length);
  console.log('\n=== 结论 ===');
  if (!firstBad) {
    console.log(`✅ 全部 ${rows.length} 档无异常，最高验证到 ${rows[rows.length - 1].squads} 个小队 / ${rows[rows.length - 1].concurrency} 并发`);
  } else {
    console.log(`⚠ 首个异常档位：${firstBad.squads} 小队 / ${firstBad.concurrency} 并发 — ${firstBad.problems.join('; ')}`);
    const prevIdx = rows.indexOf(firstBad) - 1;
    console.log(`  （上一档 ${prevIdx >= 0 ? rows[prevIdx].squads : 'N/A'} 小队是干净的）`);
  }

  let best = rows[0], ceiling = rows[0];
  for (const r of rows) { if (r.thr > best.thr) best = r; if (r.problems.length) { ceiling = rows[rows.indexOf(r) - 1] || r; break; } }
  console.log(`吞吐峰值: ${best.thr.toFixed(0)}/秒（${best.squads} 小队 / ${best.concurrency} 并发）`);
  console.log(`无异常并发上限: ${ceiling.squads} 小队 / ${ceiling.concurrency} 并发`);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  process.exit(0);
})();
