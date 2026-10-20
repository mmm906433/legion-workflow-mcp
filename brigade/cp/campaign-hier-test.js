'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Campaign } = require('./campaign');
const { makeSquadExecutor } = require('./squad-executor');

let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('=== 战役 × 层级 组合回归===');

  const base = path.join(os.tmpdir(), 'ch-' + Date.now());
  fs.mkdirSync(base, { recursive: true });
  const runRoot = path.join(os.tmpdir(), 'chr-' + Date.now());

  {
    const peak = { n: 0, max: 0 };
    const inflight = new Set();
    const exec = async ({ task, cwd }) => {
      inflight.add(task.id); peak.n++; peak.max = Math.max(peak.max, peak.n);
      await sleep(30);
      fs.writeFileSync(path.join(cwd, 'out-' + task.id + '.txt'), 'x');
      inflight.delete(task.id);
      return { verdict: 'done', summary: task.id + ' ok' };
    };
    const squadExec = makeSquadExecutor({
      base, runRoot, exec, concurrency: 4,
      decompose: () => [
        { id: 'a', description: '实现模块 a' },
        { id: 'b', description: '实现模块 b' },
        { id: 'c', description: '实现模块 c' },
      ],
    });

    let rounds = 0;
    const c = new Campaign('造三个模块', {
      planners: 2,
      maxRounds: 2,
      planner: async ({ variant, goal }) => ({
        approach: '方向' + variant,
        plan: [{ name: '并行造三个模块-' + variant, description: '并行实现 a/b/c' }],
        agentId: 'planner-' + variant,
      }),
      executor: (args) => squadExec(args),
      reviewer: async ({ gaps }) => {
        rounds++;

        return { pass: rounds > 1, gaps: rounds > 1 ? [] : ['三个模块还没都被验证'], summary: '审核' };
      },
    });
    const r = await c.run();
    check('场景1 战役多轮真的跑了多轮（审核打回后重规划）', c.round >= 2,
      `round=${c.round}，run() 返回字段=${Object.keys(r || {}).join(',') || '(无)'}`);
    check('场景2 小队内并行（并行峰值 > 1）', peak.max > 1, `峰值 ${peak.max}`);
  }

  {
    const exec = async ({ task, cwd }) => {
      if (task.id === 'bad') return { verdict: 'fail', failureType: 'crash', summary: '炸了' };
      fs.writeFileSync(path.join(cwd, 'ok-' + task.id + '.txt'), 'x');
      return { verdict: 'done', summary: 'ok' };
    };
    const squadExec = makeSquadExecutor({
      base, runRoot, exec, concurrency: 4,
      decompose: () => [
        { id: 'good1', description: '好的任务一' },
        { id: 'bad', description: '会失败的任务' },
        { id: 'good2', description: '好的任务二' },
      ],
    });
    const out = await squadExecutorCall(squadExec, { task: { id: 's1', name: '混合小队' }, round: 1 });
    check('场景4 小队部分失败时 ok=false（不冒充全成功）', out.ok === false, `ok=${out.ok}`);
    check('场景5 失败任务在摘要里点名', /未完成任务/.test(out.summary) && /bad/.test(out.summary), out.summary.slice(0, 90));
    check('场景6 成功的任务仍已落地（不因同伴失败而丢弃）', fs.existsSync(path.join(base, 'ok-good1.txt')));
    check('场景7 小队进度如实汇报', out.squad && out.squad.total === 3 && out.squad.done === 2,
      JSON.stringify(out.squad));
  }

  {
    const seen = [];
    const exec = async ({ task, cwd }) => {
      seen.push({ id: task.id, dir: cwd });
      fs.writeFileSync(path.join(cwd, 'iso-' + task.id + '.txt'), 'x');
      return { verdict: 'done', summary: 'ok' };
    };
    const sq = makeSquadExecutor({
      base, runRoot, exec, concurrency: 2,
      decompose: () => [
        { id: 'w1', type: 'implement', description: '写任务一' },
        { id: 'r1', type: 'review', description: '只读任务一' },
      ],
    });
    await squadExecutorCall(sq, { task: { id: 's2', name: '隔离小队' }, round: 1 });
    const w = seen.find((x) => x.id === 'w1');
    const rd = seen.find((x) => x.id === 'r1');
    check('场景8 写任务在影子目录执行', w && w.dir !== base, w ? path.basename(w.dir) : '');
    check('场景9 只读任务读 base', rd && rd.dir === base, rd ? 'base' : '');
    check('场景10 写任务的产出已发布回 base', fs.existsSync(path.join(base, 'iso-w1.txt')));
  }

  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch {}
  console.log('\n' + (fail === 0 ? '战役 × 层级 组合回归通过 ✅' : `${fail} 项失败 ❌`));
  process.exit(fail ? 1 : 0);
})();

async function squadExecutorCall(fn, args) {
  return fn({ ...args, goal: 'test' });
}
