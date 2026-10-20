'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Scheduler } = require('./scheduler');

let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) fail++;
};

async function runChain(runId, tasks, verdicts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-'));
  const executed = [];
  const worker = async ({ task }) => {
    executed.push(task.id);
    return verdicts[task.id] || { verdict: 'done', summary: 'ok' };
  };
  const s = new Scheduler({ runId, root, worker, concurrency: 4 });
  s.init(runId, tasks.map((t) => ({
    budget: { timeoutSec: 8, stallSec: 4, maxAttempts: 1 }, ...t,
  })));
  const res = await s.run();
  return { res, executed };
}

(async () => {
  console.log('=== 上游失败传播回归 ===\n');

  console.log('场景 1：默认语义——下游 degraded，孙任务带 taint 继续');
  {
    const { res, executed } = await runChain('cascade-s1', [
      { id: 'A', type: 'implement', role: 'worker', deps: [], input: { description: '任务 A 的可执行描述' } },
      { id: 'B', type: 'test', role: 'tester', deps: ['A'], input: { description: '任务 B 的可执行描述' } },
      { id: 'C', type: 'review', role: 'reviewer', deps: ['B'], input: { description: '任务 C 的可执行描述' } },
    ], { A: { verdict: 'fail', summary: 'A 挂了' }, C: { verdict: 'done', summary: 'C 成' } });
    const st = Object.fromEntries(res.tasks.map((t) => [t.id, t.state]));
    const c = res.tasks.find((t) => t.id === 'C');
    check('A = failed', st.A === 'failed', JSON.stringify(st));
    check('B = degraded（默认：不空等也不跳过）', st.B === 'degraded', JSON.stringify(st));
    check('C 仍执行（不级联崩，哲学）', st.C === 'done' && executed.includes('C'), JSON.stringify({ st, executed }));
    check('C 打了 taint 标（输入含降级产出）', (c.taintFrom || []).includes('B'), JSON.stringify(c.taintFrom));
  }

  console.log('\n场景 2：显式 skip——级联跳过，不再空跑');
  {
    const { res, executed } = await runChain('cascade-s2', [
      { id: 'A', type: 'implement', role: 'worker', deps: [], input: { description: '任务 A 的可执行描述' } },
      { id: 'B', type: 'test', role: 'tester', deps: ['A'], onUpstreamFail: 'skip', input: { description: '任务 B 的可执行描述' } },
      { id: 'C', type: 'review', role: 'reviewer', deps: ['B'], onUpstreamFail: 'skip', input: { description: '任务 C 的可执行描述' } },
    ], { A: { verdict: 'fail', summary: 'A 挂了' } });
    const st = Object.fromEntries(res.tasks.map((t) => [t.id, t.state]));
    check('A = failed', st.A === 'failed', JSON.stringify(st));
    check('B = skipped（声明了 skip）', st.B === 'skipped', JSON.stringify(st));
    check('C = skipped（级联传播）', st.C === 'skipped', JSON.stringify(st));
    check('B/C 从未执行（不空跑）', !executed.includes('B') && !executed.includes('C'), JSON.stringify(executed));
  }

  console.log('\n场景 3：部分依赖失败（默认）——仍有 done 依赖时照常 degraded 继续');
  {
    const { res, executed } = await runChain('cascade-s3', [
      { id: 'A', type: 'implement', role: 'worker', deps: [], input: { description: '任务 A 的可执行描述' } },
      { id: 'B', type: 'implement', role: 'worker', deps: [], input: { description: '任务 B 的可执行描述' } },
      { id: 'C', type: 'review', role: 'reviewer', deps: ['A', 'B'], input: { description: '任务 C 的可执行描述' } },
    ], { A: { verdict: 'done', summary: 'A 成' }, B: { verdict: 'fail', summary: 'B 挂' } });
    const st = Object.fromEntries(res.tasks.map((t) => [t.id, t.state]));
    check('A = done', st.A === 'done', JSON.stringify(st));
    check('B = failed', st.B === 'failed', JSON.stringify(st));
    check('C = degraded（默认语义）', st.C === 'degraded', JSON.stringify(st));
    check('C 未执行', !executed.includes('C'), JSON.stringify(executed));
  }

  console.log(fail === 0 ? '\n全部通过 ✅' : `\n${fail} 项失败 ❌`);
  process.exit(fail === 0 ? 0 : 1);
})();
