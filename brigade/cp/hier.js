'use strict';

const path = require('path');
const os = require('os');
const { Scheduler } = require('./scheduler');
const { Command, Message, squadBudget, syncSquads, flattenSquads, makeWriteGate } = require('./hierarchy');

const ROOT = path.join(os.tmpdir(), 'hier-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const trace = [];
const worker = async ({ task }) => {
  const t0 = Date.now();
  trace.push({ id: task.id, t0, t1: -1 });
  await sleep(20);
  if (task.input.fail) {
    const e = trace.find((x) => x.id === task.id); e.t1 = Date.now();
    return { verdict: 'fail', failureType: 'crash', summary: '模拟失败' };
  }
  const e = trace.find((x) => x.id === task.id); e.t1 = Date.now();
  return { verdict: 'done', summary: `完成 ${task.id}` };
};

(async () => {
  console.log('=== 层级调度演示：指挥部 → 小队 → 任务 ===\n');

  const cmd = new Command({ difficulty: 'moderate', globalConcurrency: 6 });
  cmd.goal = '演示复杂目标：三条攻坚线同时推进';
  const cards = [
    { id: 'c1', title: '攻坚线甲', goal: '完成 A 方向', accept: ['A 交付'], difficulty: 'moderate' },
    { id: 'c2', title: '攻坚线乙', goal: '完成 B 方向', accept: ['B 交付'], difficulty: 'moderate' },
    { id: 'c3', title: '攻坚线丙（串行递进）', goal: 'C 流水线', accept: ['C 交付'], difficulty: 'moderate', pipeline: true },
  ];

  const taskFactory = (card) => {
    if (card.pipeline) {
      return [
        { id: card.id + '-p1', type: 'explore', role: 'explorer', title: '设计', deps: [], budget: { timeoutSec: 30, stallSec: 10, maxAttempts: 1 } },
        { id: card.id + '-p2', type: 'implement', role: 'worker', title: '实现', deps: [card.id + '-p1'], budget: { timeoutSec: 30, stallSec: 10, maxAttempts: 1 } },
        { id: card.id + '-p3', type: 'test', role: 'tester', title: '验证', deps: [card.id + '-p2'], budget: { timeoutSec: 30, stallSec: 10, maxAttempts: 1 } },
      ];
    }
    return [
      { id: card.id + '-w1', type: 'explore', role: 'explorer', title: '勘察', deps: [], budget: { timeoutSec: 30, stallSec: 10, maxAttempts: 1 } },
      { id: card.id + '-w2', type: 'implement', role: 'worker', title: '实施', deps: [], budget: { timeoutSec: 30, stallSec: 10, maxAttempts: 1 } },
    ];
  };

  cmd.deploy(cmd.goal, cards, taskFactory);
  console.log(`\n【部署】${cmd.squads.size} 个小队，${flattenSquads(cmd).length} 个任务，预算档：${JSON.stringify(cmd.budget)}\n`);

  const tasks = flattenSquads(cmd);
  const s = new Scheduler({
    runId: 'hier', root: ROOT, worker, concurrency: 6,
    onProgress: (ts) => syncSquads(cmd, ts), admission: makeWriteGate(cmd),
  });
  s.init(cmd.goal, tasks);
  const res = await s.run();

  const st = cmd.status();
  console.log('\n【指挥视图】');
  console.log(`总进度 ${st.progress}%（${st.doneTasks}/${st.totalTasks} 任务）| 小队：完工 ${st.done} 进行 ${st.active} 受阻 ${st.blocked} | 消息 ${st.messages}`);
  for (const sq of st.squads) {
    console.log(`  ${sq.id} [${sq.mode}] ${sq.status} ${sq.progress}% — ${sq.card.title}`);
  }

  console.log('\n【消息传递】');
  const assigns = cmd.bus.to('sq-c3');
  const reports = cmd.bus.from('sq-c3');
  console.log(`  指挥部 → sq-c3 派发消息: ${assigns.length} 条（载荷含目标与验收: ${JSON.stringify(assigns[0] && assigns[0].payload.goal)}）`);
  console.log(`  sq-c3 → 指挥部 完工汇报: ${reports.length} 条`);

  const order = trace.map((x) => x.id);
  const pipeline = order.filter((id) => id.startsWith('c3-'));
  const okOrder = pipeline.join(',') === 'c3-p1,c3-p2,c3-p3';
  console.log(`\n【串行递进】c3 执行顺序: ${pipeline.join(' → ')} ${okOrder ? '✅ 递进正确' : '❌ 顺序错误'}`);

  const ab = trace.filter((x) => x.id.startsWith('c1-') || x.id.startsWith('c2-'));
  const overlaps = (a, b) => a.t0 < b.t1 && b.t0 < a.t1;
  const crossOverlap = ab.some((a, i) => ab.some((b, j) => a.id[1] !== b.id[1] && overlaps(a, b)));
  console.log(`【并行】甲乙两队 ${ab.length} 个任务存在跨队时间重叠: ${crossOverlap ? '✅ 真并行' : '❌ 串行'}`);

  let fail = 0;
  const check = (n, c) => { console.log(`${c ? '  ✓' : '  ✗'} ${n}`); if (!c) fail++; };
  console.log('\n=== 断言 ===');
  check('3 个小队全部完工', st.done === 3, `done=${st.done}`);
  check('总进度 100%', st.progress === 100, `${st.progress}%`);
  check('串行小队严格递进', okOrder, pipeline.join(','));
  check('并行小队真并发（时间重叠）', crossOverlap, ab.map((x) => x.id).join(','));
  check('派发消息含显式载荷', assigns.length === 1 && !!assigns[0].payload.accept, JSON.stringify(assigns[0] && assigns[0].payload));
  check('完工有显式汇报', reports.length === 1 && reports[0].kind === 'report');
  check('全部任务成功', res.done === flattenSquads(cmd).length, `${res.done}`);

  console.log(fail === 0 ? '\n层级调度全部通过 ✅' : `\n${fail} 项失败 ❌`);
  process.exit(fail ? 1 : 0);
})();
