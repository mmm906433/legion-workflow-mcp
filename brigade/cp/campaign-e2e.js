'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Campaign, VERDICT } = require('./campaign');
const { makeCodexExecutor } = require('./executor-codex');
const { Workspace } = require('./workspace');
const { makeSquadExecutor } = require('./squad-executor');
const { FileStore } = require('./store');

const cwd = process.argv[2] || path.join(os.tmpdir(), 'campaign-e2e');
fs.mkdirSync(cwd, { recursive: true });

fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'campaign-demo', version: '1.0.0' }, null, 2));
fs.writeFileSync(path.join(cwd, 'README.txt'), 'demo project\n');

const wsCampaign = new Workspace({ base: cwd, runRoot: path.join(__dirname, '..', 'runs') });
const exec = makeCodexExecutor({ cwd, workspace: wsCampaign });

const runStore = new FileStore(path.join(os.tmpdir(), 'campaign-e2e-store'));

const call = async (args) => {
  const r = await exec({ ...args, store: runStore, runId: 'campaign-e2e' });
  if (r && (r.verdict === 'done' || r.verdict === 'PASS')) {
    const t = args.task || {};
    try { wsCampaign.publish(t); }
    catch (e) { console.log('[隔离] 发布失败：' + (e && e.message)); }
  }
  return r;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const planner = async ({ goal, previousGaps, artifacts, variant, agent }) => {
  const r = await call({
    task: {
      name: `规划:${goal}`,
      description:
        `你是规划者（方向 ${variant}）。目标：${goal}\n` +
        (previousGaps.length ? `上一轮未解决的问题：\n- ${previousGaps.join('\n- ')}\n请针对这些缺口设计方案。\n` : '') +
        `项目目录 ${cwd}。先读一下现有文件，然后给出 1-2 个实现步骤的方案（每步一句话说明要做什么）。`,
    },
    artifacts: [],
    context: agent ? agent.context : {},
    round: 1, stepIndex: variant,
  });

  const text = String(r.summary || r.body || r.text || '');

  const steps = text
    .split('\n')
    .map((l) => l.replace(/^[-*\d.、\s]+/, '').trim())
    .filter((l) => l.length > 6 && l.length < 160 && /[实现|创建|新建|写|添加|补|定义|修]/.test(l))
    .slice(0, 2)
    .map((d) => ({ name: d }));
  if (!steps.length) steps.push({ name: `实现 ${goal}` });
  return { approach: `方向${variant}：${steps.map((s) => s.name).join(' → ')}`, plan: steps };
};

const squadExec = makeSquadExecutor({
  base: cwd,
  runRoot: path.join(__dirname, '..', 'runs'),
  concurrency: 2,
  decompose: (step, gaps) => ([
    {
      id: 'impl', type: 'implement', role: 'worker', deps: [],
      budget: { timeoutSec: 600, stallSec: 240, maxAttempts: 1 },
      description:
        `在当前工作目录实现：${step.name}。\n` +
        `具体要求：\n` +
        `- 在 src/text.js 中实现并导出（文件不存在就创建，用 CommonJS module.exports）\n` +
        `- 必须同时导出 titleCase(str) 和 slugify(str)\n` +
        `- slugify 规则：转小写，空格和下划线转连字符，移除非字母数字连字符字符（连续的连字符合并为一个），去掉首尾连字符\n` +
        `- 写完后用 node 实际运行一次验证，把真实输出贴出来\n` +
        (gaps && gaps.length ? `特别注意上一轮的审核问题：\n- ${gaps.join('\n- ')}\n` : ''),
    },
    {
      id: 'verify', type: 'test', role: 'tester', deps: ['impl'],
      budget: { timeoutSec: 420, stallSec: 200, maxAttempts: 1 },
      description:
        `在当前工作目录真实运行验证 src/text.js：\n` +
        `node -e "const t=require('./src/text.js'); console.log(typeof t.titleCase, t.titleCase('hello world')); console.log(t.slugify('Hello World Foo'))"\n` +
        `如实贴出真实输出与结果判断，不要臆测。`,
    },
  ]),
  exec: async ({ task, cwd: taskCwd, workspace, store, runId, signal, heartbeat, byId }) => {
    const leaf = makeCodexExecutor({ cwd: taskCwd, workspace });
    return leaf({ task, store, runId, signal, heartbeat, byId });
  },
});
const executor = (args) => squadExec(args);

const reviewer = async ({ goal, artifacts, round, steps }) => {
  const probe = await call({
    task: {
      name: '审核',
      description:
        `你是审核者。在 ${cwd} 目录真实运行验证：\n` +
        `1) node -e "const t=require('./src/text.js'); console.log(typeof t.slugify, t.slugify('Hello World Foo'))"\n` +
        `2) 检查 titleCase 是否仍可用\n` +
        `如实报告运行结果。如果 slugify 缺失或行为不对（应输出 hello-world-foo），判 FAIL 并列出具体缺口；都通过才判 PASS。`,
    },
    artifacts: [], context: {}, round, stepIndex: 0,
  });
  const out = String(probe.summary || probe.body || probe.text || '');
  const slugOk = /hello-world-foo/.test(out);
  const titleOk = /titleCase/.test(out) && !/titleCase[^a-zA-Z]*[:：]?\s*(undefined|不存在|missing)/i.test(out);
  const passed = slugOk && titleOk;
  return {
    verdict: passed ? VERDICT.PASS : VERDICT.FAIL,
    quality: passed ? 1 : 0.3,
    gaps: passed ? [] : ['slugify 行为未达标（期望 hello-world-foo）', '需确认 titleCase 未被破坏'],
  };
};

(async () => {
  console.log('=== 长任务战役 · 真实链路（真实 codex 子智能体）===');
  console.log(`项目: ${cwd}\n`);

  const campaign = new Campaign('给项目实现 titleCase 与 slugify 两个文本工具函数', {
    planners: 2,
    maxRounds: 3,
    planner, executor, reviewer,
    progressFile: path.join(os.tmpdir(), 'campaign-progress-' + Date.now() + '.jsonl'),
    onEvent: (e) => { if (e.tag === 'start' || e.tag === 'finish' || e.tag === 'stage') console.log('  [obs] ' + (e.tag === 'stage' ? ('阶段 ' + e.stage + ' ' + (e.note||'')) : (e.tag==='start' ? '启动 '+e.id : (e.ok?'完成 ':'失败 ')+e.id+' '+(e.summary||'').slice(0,50)))); },
  });

  const t0 = Date.now();
  const rep = await campaign.run();
  const ms = Date.now() - t0;

  console.log(`\n=== 战役报告（${Math.round(ms / 1000)}s）===`);
  console.log(`状态: ${rep.status} | 轮次: ${rep.rounds} | 采用方案: ${rep.chosenApproach}`);
  if (rep.gaps.length) console.log(`遗留缺口: ${JSON.stringify(rep.gaps)}`);

  const textPath = path.join(cwd, 'src', 'text.js');
  let verified = false, detail = '';
  try {
    const t = require(textPath);
    const slug = t.slugify ? t.slugify('Hello World Foo') : '(slugify 缺失)';
    const title = t.titleCase ? t.titleCase('hello world') : '(titleCase 缺失)';
    detail = `slugify('Hello World Foo') = ${JSON.stringify(slug)} | titleCase('hello world') = ${JSON.stringify(title)}`;
    verified = slug === 'hello-world-foo' && title === 'Hello World';
  } catch (e) {
    detail = '加载失败: ' + e.message;
  }

  console.log(`\n=== 独立终验（不信任自述）===`);
  console.log('  ' + detail);
  console.log('  功能验证: ' + (verified ? '✅ 通过' : '❌ 不通过'));
  console.log(`\n  审计: ${JSON.stringify(rep.awarenessStats)}`);
  console.log(`  保留 Agent: ${JSON.stringify(rep.retainedAgents.map((a) => a.agentId))}`);
  console.log(`  报告: ${path.join(cwd, '..', 'campaign-e2e-report.md')}`);
  fs.writeFileSync(path.join(os.tmpdir(), 'campaign-e2e-report.md'), JSON.stringify(rep, null, 2).slice(0, 20000));

  const ok = verified;
  console.log('\n' + (ok ? '真实链路战役验证通过 ✅' : '真实链路战役验证未通过 ❌'));
  process.exit(ok ? 0 : 1);
})();
