'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { Scheduler } = require('./scheduler');
const { makePipeline } = require('./pipeline');
const { Command, syncSquads, flattenSquads, makeWriteGate } = require('./hierarchy');

const cwd = process.argv[2] || process.cwd();
const RUNS = path.join(__dirname, '..', 'runs');
const runId = 'hier-e2e-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

let expectSum = 0, expectNames = [];
try {
  const rows = fs.readFileSync(path.join(cwd, 'seed.txt'), 'utf8').split(/\r?\n/).filter((l) => l.trim());
  for (const line of rows) {
    const m = line.trim().match(/^([^,]+)\s*,\s*(-?\d+)$/);
    if (m) { expectNames.push(m[1].trim()); expectSum += parseInt(m[2], 10); }
  }
} catch (e) { console.log('读 seed.txt 失败:', e.message); }
const sumDesc = String(expectSum);
const listDesc = JSON.stringify(expectNames);

(async () => {
  fs.mkdirSync(RUNS, { recursive: true });

  const cmd = new Command({ difficulty: 'hard', globalConcurrency: 4 });
  cmd.goal = '两条并行攻坚线（各产出一个工具模块）+ 一条串行递进流水线（读码→实现→验证）';

  const cards = [

    {
      id: 'A', title: '攻坚线甲：sumlist 工具', goal: `在 ${cwd} 实现 sumlist.js，导出 sumTotal() 返回 seed.txt 所有数字之和、names() 返回名字数组`, accept: [`sumTotal()=${sumDesc}`, `names()=${listDesc}`], difficulty: 'hard',
    },

    {
      id: 'B', title: '攻坚线乙：count工具', goal: `在 ${cwd} 实现 countmod.js，导出 lines() 返回 seed.txt 行数`, accept: ['lines() 返回正确行数'], difficulty: 'hard',
    },

    {
      id: 'C', title: '攻坚线丙：串行流水线', goal: '串行：先勘察 seed.txt，再实现 main.js 组合两个模块，最后真跑验证', pipeline: true, accept: ['main.js 存在且可运行'], difficulty: 'hard',
    },
  ];

  const taskFactory = (card) => {
    const b = { timeoutSec: 300, stallSec: 120, maxAttempts: 1 };
    if (card.pipeline) {
      return [
        { id: 'c1', type: 'explore', role: 'explorer', title: '勘察 seed.txt 与已有模块', deps: [], accept: ['读出 seed.txt 内容与行数'], budget: b, input: { description: `读 ${cwd}/seed.txt，报告内容和行数，并列出目录里已有哪些 .js 模块。` } },
        { id: 'c2', type: 'implement', role: 'worker', title: '实现 main.js 组合模块', deps: ['c1'], accept: ['main.js 存在'], budget: b, input: { description: `在 ${cwd} 创建 main.js：require sumlist 和 countmod，导出 run() 返回 {sum, names, lines} 汇总对象。用 node 跑一次确认不报错。` } },
        { id: 'c3', type: 'test', role: 'tester', title: '真跑验证', deps: ['c2'], accept: ['贴出真实运行输出'], budget: b, input: { description: `在 ${cwd} 真实运行：node -e "console.log(JSON.stringify(require('./main.js').run()))"。如实报告输出，sum 应为 ${sumDesc}、names 应为 ${listDesc}。` } },
      ];
    }
    return [
      { id: card.id + '1', type: 'implement', role: 'worker', title: card.title, deps: [], accept: card.accept, budget: b,
        input: { description: card.goal + '\n只做这一个文件，做完用 node 实际跑一次验证，并在回复里贴出验证输出。' } },
    ];
  };

  console.log(`=== 层级调度 · 真实链路验证 ===\n项目: ${cwd}\n期望: sum=${sumDesc} names=${listDesc}\nrun: ${runId}\n`);
  cmd.deploy(cmd.goal, cards, taskFactory);
  for (const sq of cmd.squads.values()) console.log(`[部署] ${sq.id} [${sq.mode}] ${sq.tasks.length} 任务 — ${sq.card.title}`);

  const pipe = makePipeline({
    base: cwd, runRoot: RUNS, runId, concurrency: 4,
    onProgress: (ts) => syncSquads(cmd, ts), admission: makeWriteGate(cmd),
  });
  const s = pipe.scheduler;
  s.init(cmd.goal, flattenSquads(cmd));
  const t0 = Date.now();
  const res = await s.run();
  const ms = Date.now() - t0;

  const st = cmd.status();
  console.log(`\n=== 指挥视图（${Math.round(ms / 1000)}s）===`);
  console.log(`总进度 ${st.progress}%（${st.doneTasks}/${st.totalTasks}）| 完工 ${st.done} 受阻 ${st.blocked} 消息 ${st.messages}`);
  st.squads.forEach((sq) => console.log(`  ${sq.id} [${sq.mode}] ${sq.status} ${sq.progress}% — ${sq.card.title}`));

  console.log('\n=== 各任务结果 ===');
  res.tasks.forEach((t) => console.log(`${t.id} [${t.role}] ${t.state} (${Math.round((t.ms || 0) / 1000)}s) ${t.outcome && t.outcome.note ? '— ' + String(t.outcome.note).slice(0, 70) : ''}`));

  console.log('\n=== 真实功能验证 ===');
  let verified = 0;
  for (const [file, fn, want] of [['sumlist.js', 'sumTotal', expectSum], ['countmod.js', 'lines', null]]) {
    const p = path.join(cwd, file);
    if (!fs.existsSync(p)) { console.log(`  ${file}: ❌ 不存在`); continue; }
    try {
      const m = require(p);
      const got = m[fn]();
      const ok = want === null ? typeof got === 'number' : got === want;
      console.log(`  ${file}.${fn}() = ${JSON.stringify(got)} ${ok ? '✅' : '❌ 期望 ' + JSON.stringify(want)}`);
      if (ok) verified++;
    } catch (e) { console.log(`  ${file}: 加载失败 ${e.message}`); }
  }
  const mainP = path.join(cwd, 'main.js');
  if (fs.existsSync(mainP)) {
    try {
      const out = require(mainP).run();
      const ok = out && out.sum === expectSum;
      console.log(`  main.js run() = ${JSON.stringify(out).slice(0, 120)} ${ok ? '✅' : '❌'}`);
      if (ok) verified++;
    } catch (e) { console.log(`  main.js 运行失败: ${e.message}`); }
  }

  console.log(`\n汇总: done=${res.done} failed=${res.failed} degraded=${res.degraded} | 功能验证通过 ${verified}/3`);
  const allOk = verified === 3;
  console.log(allOk ? '真实链路层级调度通过 ✅' : '部分验证未通过（见上）');

  if (!allOk) {
    console.log(`
⚠ 被超时判死的写任务，其产出可能仍留在影子目录（未发布到 base）：`);
    const sh = path.join(RUNS, 'shadow');
    if (fs.existsSync(sh)) {
      for (const d of fs.readdirSync(sh).slice(0, 8)) {
        const files = fs.readdirSync(path.join(sh, d)).filter((f) => !/\.(md|txt|log|json)$/.test(f));
        if (files.length) console.log(`   ${d}/ → ${files.join(', ')}`);
      }
    }
  }
  process.exit(allOk ? 0 : 1);
})();
