'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { Scheduler } = require('./scheduler');
const { makePipeline } = require('./pipeline');

const cwd = process.argv[2] || process.cwd();

const ATTEMPTS = Math.max(1, parseInt(process.env.E2E_ATTEMPTS || '3', 10));
const RUNS = path.join(__dirname, '..', 'runs');
const runId = 'e2e-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

if (!fs.existsSync(path.join(cwd, 'data.txt'))) {
  fs.writeFileSync(path.join(cwd, 'data.txt'), 'alice,10\nbob,20\ncarol,30\n');
  console.log('（目标目录无 data.txt，已自举种子数据 alice/bob/carol）');
}
let expectSum = null, expectList = null;
try {
  const rows = fs.readFileSync(path.join(cwd, 'data.txt'), 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const nums = [], names = [];
  for (const line of rows) {
    const m = line.trim().match(/^([^,]+)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (m) { names.push(m[1].trim()); nums.push(parseFloat(m[2])); }
  }
  expectSum = nums.reduce((a, b) => a + b, 0);
  expectList = names;
} catch (e) {
  console.log('（读不到 data.txt，期望值留空）', e.message);
}
const sumDesc = expectSum === null ? '所有数字之和' : String(expectSum);
const listDesc = expectList === null ? '所有名字数组' : JSON.stringify(expectList);

(async () => {
  fs.mkdirSync(RUNS, { recursive: true });
  const pipe = makePipeline({ base: cwd, runRoot: RUNS, runId, concurrency: 2 });
  const s = pipe.scheduler;

  s.init('e2e 验证：读取 data.txt 写解析脚本、跑测试、审查', [
    {
      id: 'impl',
      type: 'implement',
      role: 'worker',
      title: '实现 CSV 解析脚本',
      deps: [],
      input: { description: `在 ${cwd} 目录下：\n1) 读 data.txt（格式：名字,数字 每行一条）\n2) 创建 parse.js，导出 sum() 返回所有数字之和，并导出 list() 返回名字数组\n3) 直接用 node 运行验证一次\n注意：只做这一个文件，不要建测试框架。完成后说明你创建的文件和验证输出。` },

      accept: [
        'parse.js 存在且可被 require',
        `exec:node -e "const p=require('./parse.js');if(p.sum()!==${expectSum === null ? 0 : expectSum})process.exit(1)"`,
        `exec:node -e "const p=require('./parse.js');if(p.list().join(',')!=='${expectList ? expectList.join(',') : ''}')process.exit(1)"`,
      ],
      budget: { timeoutSec: 300, stallSec: 120, maxAttempts: ATTEMPTS },
    },
    {
      id: 'test',
      type: 'test',
      onUpstreamFail: 'skip',
      role: 'tester',
      title: '验证实现正确',
      deps: ['impl'],
      input: { description: `在 ${cwd} 目录下真实运行：node -e "const p=require('./parse.js'); console.log(p.sum(), JSON.stringify(p.list()))"。检查输出是否为 ${sumDesc} 和 ${listDesc}。如实报告真实输出，不符就明确说不符。` },
      accept: ['贴出真实命令与输出', '结论明确：通过/不通过'],
      budget: { timeoutSec: 240, stallSec: 90, maxAttempts: ATTEMPTS },
    },
    {
      id: 'review',
      type: 'review',
      onUpstreamFail: 'skip',
      role: 'reviewer',
      title: '审查产出',
      deps: ['test'],
      input: { description: `审查 ${cwd}/parse.js 的实现质量：是否符合需求、是否有边界问题。给出 PASS 或 FAIL 结论。` },
      accept: ['明确 PASS 或 FAIL'],
      budget: { timeoutSec: 240, stallSec: 90, maxAttempts: ATTEMPTS },
    },
  ]);

  console.log(`=== 端到端真实验证（真实 codex 子智能体）===\n项目: ${cwd}\nrun: ${runId}\n`);
  const res = await s.run();

  console.log('\n=== 结果 ===');
  res.tasks.forEach((t) => {
    console.log(`${t.id} [${t.role}] ${t.state} (${Math.round((t.ms || 0) / 1000)}s) ${t.outcome && t.outcome.note ? '— ' + String(t.outcome.note).slice(0, 80) : ''}`);
  });
  console.log('汇总:', JSON.stringify({ done: res.done, failed: res.failed, degraded: res.degraded, skipped: res.skipped }));

  const parseExists = fs.existsSync(path.join(cwd, 'parse.js'));
  let actual = null;
  if (parseExists) {
    try { actual = require(path.join(cwd, 'parse.js')); } catch (e) { actual = 'load error: ' + e.message; }
  }
  console.log('parse.js 存在:', parseExists);
  let funcOk = false;
  if (actual && typeof actual.sum === 'function') {
    console.log('实际 sum() =', actual.sum(), '| 实际 list() =', JSON.stringify(actual.list()));
    const okSum = actual.sum() === expectSum;
    console.log(okSum ? '✅ 功能验证通过' : `❌ 功能验证不通过（期望 ${sumDesc}）`);
    funcOk = okSum;
  }

  const chainOk = res.tasks.length > 0 && res.tasks.every((t) => t.state === 'done');
  console.log(`任务链判定: ${res.tasks.length} 个任务，全部 done = ${chainOk}` +
    `（${res.tasks.map((t) => `${t.id}:${t.state}`).join(', ')}）`);
  if (!chainOk) {
    const bad = res.tasks.filter((t) => t.state !== 'done')
      .map((t) => `${t.id}[${t.state}]${t.outcome && t.outcome.failureType ? '/' + t.outcome.failureType : ''}`);
    console.log('❌ 任务链未全部成功：' + bad.join(', '));
  }

  const verifiedOk = funcOk && chainOk;
  console.log('工件目录:', path.join(RUNS, runId, 'artifacts'));
  process.exit(verifiedOk ? 0 : 1);
})();
