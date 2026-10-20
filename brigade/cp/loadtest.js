'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Scheduler } = require('./scheduler');
const { FileStore } = require('./store');

const ROOT = path.join(os.tmpdir(), 'cp-loadtest-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
};

async function steady(n, concurrency, latencyMs = 3) {
  let peak = 0, active = 0;
  const worker = async () => {
    active++; if (active > peak) peak = active;
    await sleep(latencyMs);
    active--;
    return { verdict: 'done' };
  };
  const s = new Scheduler({ runId: 'steady-' + n, root: ROOT, worker, concurrency });
  const specs = [];
  for (let i = 0; i < n; i++) specs.push({ id: 't' + i, type: 'explore', deps: i < 3 ? [] : ['t' + (i % 3)], budget: { timeoutSec: 60, stallSec: 30, maxAttempts: 1 } });
  s.init('压测 ' + n, specs);
  const t0 = Date.now();
  const res = await s.run();
  const ms = Date.now() - t0;

  const onDisk = s.store.loadTasks('steady-' + n);
  const epochOk = s.store.currentEpoch('steady-' + n) > 0;
  check(`N=${n} 全部完成`, res.done === n, `${res.done}/${n}`);
  check(`N=${n} 并发不超限`, peak <= concurrency, `峰值=${peak} 上限=${concurrency}`);
  check(`N=${n} 状态可持久化`, onDisk.length === n && epochOk, `磁盘任务数=${onDisk.length}`);
  check(`N=${n} 无残留非终态`, res.tasks.every((t) => ['done', 'failed', 'degraded', 'skipped'].includes(t.state)));
  console.log(`    耗时 ${ms}ms，吞吐 ${(n / (ms / 1000)).toFixed(0)} 任务/秒`);
  return { ms, peak, res };
}

async function chaos(n, concurrency) {
  let peak = 0, active = 0, stalled = 0, flaky = 0;
  const worker = async ({ task, signal }) => {
    active++; if (active > peak) peak = active;
    const r = Math.random();
    try {
      if (r < 0.2) {
        stalled++;

        await new Promise(() => {});
      }
      if (r < 0.35) {
        flaky++;
        await sleep(2);
        return { verdict: 'fail', failureType: 'crash' };
      }
      await sleep(3);
      return { verdict: 'done' };
    } finally { active--; }
  };
  const s = new Scheduler({
    runId: 'chaos-' + n, root: ROOT, worker, concurrency,
    feedback: { meldThreshold: 5 },
  });
  const specs = [];
  for (let i = 0; i < n; i++) specs.push({ id: 'c' + i, type: i % 3 === 0 ? 'explore' : 'implement', deps: [], budget: { timeoutSec: 2, stallSec: 1, maxAttempts: 2, backoffMs: 300 } });
  s.init('混沌 ' + n, specs);
  let maxInflightPlusZombie = 0;
  const probe = setInterval(() => {
    const inflight = s.all().filter((t) => t.state === 'running' || t.state === 'leased').length;
    maxInflightPlusZombie = Math.max(maxInflightPlusZombie, inflight + s.zombieCount());
  }, 20);
  const t0 = Date.now();
  const res = await Promise.race([s.run(), new Promise((r) => setTimeout(() => r({ hang: true }), 120000))]);
  clearInterval(probe);
  const ms = Date.now() - t0;
  check(`混沌N=${n} 不 hang`, !res.hang, `耗时=${ms}ms 卡死任务=${stalled} 瞬时失败=${flaky}`);
  if (!res.hang) {
    const stuck = res.tasks.filter((t) => !['done', 'failed', 'degraded', 'skipped'].includes(t.state));
    check(`混沌N=${n} 无卡死残留`, stuck.length === 0, stuck.map((t) => t.id + ':' + t.state).join(' '));

    check(`混沌N=${n} 调度账本并发不超限`, maxInflightPlusZombie <= concurrency, `账本峰值=${maxInflightPlusZombie} 上限=${concurrency} (raw worker 峰值=${peak} 含僵尸)`);
    const doneRate = res.done / n;
    console.log(`    完成率 ${(doneRate * 100).toFixed(0)}%，失败 ${res.failed}，降级 ${res.degraded}，跳过 ${res.skipped}`);
  }
}

(async () => {
  const max = parseInt(process.argv[2] || '200', 10);
  console.log('=== 控制平面阶梯压测（假执行器）===');
  console.log('临时目录:', ROOT);

  console.log('\n[A] 稳态阶梯');
  for (const [n, c] of [[10, 4], [50, 10], [100, 20], [max, 50], [max * 2, 80]]) {
    await steady(n, c);
  }

  console.log('\n[B] 混沌压测（20% 卡死 + 15% 瞬时失败）');
  await chaos(60, 10);
  await chaos(200, 30);

  console.log('\n[C] 状态文件完整性');
  const st = new FileStore(ROOT);
  let parseOk = true, eventOk = true;
  for (const d of fs.readdirSync(ROOT)) {
    const dp = path.join(ROOT, d);
    let isDir = false;
    try { isDir = fs.statSync(dp).isDirectory(); } catch {}
    if (!isDir) continue;
    if (!fs.existsSync(path.join(dp, 'events'))) continue;
    try {
      const tasks = st.loadTasks(d);
      if (!Array.isArray(tasks)) { parseOk = false; console.log(`    [' + d + '] 分片读取异常: ${typeof tasks}`); }
    } catch (e) {
      parseOk = false;
      console.log(`    [' + d + '] 分片读取失败: ${e.message.slice(0, 100)}`);
      try {
        const raw = fs.readdirSync(path.join(ROOT,d,'tasks')).map(f=>fs.readFileSync(path.join(ROOT,d,'tasks',f),'utf8')).join('');
        console.log(`      长度=${raw.length} 末尾=${JSON.stringify(raw.slice(-80))}`);
      } catch (e2) { console.log(`      读取也失败: ${e2.message}`); }
    }
    try {
      const raw = fs.readFileSync(path.join(ROOT, d, 'events', 'log.jsonl'), 'utf8');
      for (const line of raw.split('\n').filter(Boolean)) JSON.parse(line);
    } catch (e) { eventOk = false; console.log(`    [${d}] 事件日志损坏: ${e.message.slice(0, 80)}`); }
  }
  check('所有 tasks.json 可解析', parseOk);
  check('所有事件日志无损坏', eventOk);

  console.log('\n' + (failures === 0 ? '压测全部通过 ✅' : failures + ' 项失败 ❌'));
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
})();
