'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let fails = 0;
const check = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${x ? '  — ' + x : ''}`); if (!c) fails++; };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r62-'));
const SRC = __dirname;

console.log('=== 验收表 10 项缺陷回归 ===\n');

{
  const { FileStore } = require('./store');
  const st = new FileStore(path.join(tmp, 's1'));
  console.log('--- ① Windows 保留名导致 id 碰撞 ---');
  for (const bad of ['con', 'CON', 'nul', 'com1', 'LPT9', 'aux', 'con.json', 'prn.txt']) {
    check(`拒绝保留名 id "${bad}"`, throws(() => st.saveArtifact('r1', { id: bad, taskId: 't' })));
  }
  for (const bad of ['abc.', 'abc ', 'x.']) {
    check(`拒绝尾随点/空格的 id "${bad}"`, throws(() => st.saveArtifact('r1', { id: bad, taskId: 't' })));
  }
  check('正常 id 仍可用（不被误伤）', !throws(() => st.saveArtifact('r1', { id: 'console', taskId: 't' })));
  check('含保留串但非保留名的 id 可用（如 "content"）', !throws(() => st.saveArtifact('r1', { id: 'content', taskId: 't' })));

  const before = fs.existsSync(path.join(tmp, 's1'));
  void before;
}

{
  const { FeedbackEngine } = require('./feedback');
  console.log('--- ② timeouts 闩锁（成功一次后应自愈）---');
  const f = new FeedbackEngine();
  const T = (tmo) => ({ id: 's', role: 'worker', type: 'implement', budget: { timeoutSec: tmo, stallSec: 300, maxAttempts: 1 } });
  const slowKill = { failureType: 'timeout', summary: '超时' };

  const TIMEOUT = { verdict: 'fail', failureType: 'timeout', ms: 300000 };
  const PASSED = { verdict: 'done', ms: 10000 };
  void slowKill;
  f.record(T(300), TIMEOUT);
  const afterFail = f.advise(T(300), {}).timeoutSec;
  check('超时后确实放宽（机制生效）', afterFail > 300, `300 → ${afterFail}`);

  f.record(T(300), PASSED);
  const afterOk = f.advise(T(300), {}).timeoutSec;
  check('成功一次后自愈：不再被历史 timeout 钉住', afterOk === 300, `放宽值 ${afterOk}（期望回到 300）`);

  const f2 = new FeedbackEngine();
  f2.record(T(300), TIMEOUT);
  f2.record(T(300), TIMEOUT);
  check('持续超时时仍保持放宽（不被自愈逻辑误伤）', f2.advise(T(300), {}).timeoutSec > 300,
    `300 → ${f2.advise(T(300), {}).timeoutSec}`);
}

{
  const { Workspace } = require('./workspace');
  const dir = path.join(tmp, 'fp'); fs.mkdirSync(dir, { recursive: true });
  const w = new Workspace({ base: dir, runRoot: path.join(tmp, 'fp-run') });
  console.log('--- ③ 大文件指纹碰撞 ---');
  const big = path.join(dir, 'big.bin');
  const SIZE = 9 * 1024 * 1024;
  fs.writeFileSync(big, Buffer.alloc(SIZE, 0x41));
  const wtask = { id: 'w1', name: 'w1', type: 'implement', role: 'worker', deps: [], input: { description: '一个足够长的任务描述' } };
  const cwd = w.cwdFor(wtask);

  const rec = w._shadows.get('w1#0');
  check('cwdFor 已建立内容基线 manifest', rec && rec.manifest.size > 0,
    `manifest ${rec ? rec.manifest.size : 0} 条`);

  fs.writeFileSync(big, Buffer.alloc(SIZE, 0x42));
  const esc = w.detectEscapes({ taskId: wtask.id, attemptId: 0, dir: cwd, manifest: rec.manifest });
  check('大文件内容变化能被 detectEscapes 发现（不再是"只比大小"）',
    esc.includes('big.bin'), `检出 ${JSON.stringify(esc)}`);
}

{
  const { Workspace } = require('./workspace');
  const dir = path.join(tmp, 'sf'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'x'), 'same');
  const w = new Workspace({ base: dir, runRoot: path.join(tmp, 'sf-run') });
  console.log('--- ④ sameFile 三态 ---');
  const task = { id: 'r', name: 'r', type: 'review', role: 'reviewer', deps: [], input: { description: '一个足够长的任务描述' } };
  const cwd = w.cwdFor(task);
  check('只读任务拿到的是 base 本身（已知设计取舍）', cwd === dir);
}

{
  const { TaskAwareness } = require('./awareness');
  const a = new TaskAwareness();
  console.log('--- ⑤ 审核缺失检测必须真能触发 ---');

  a.dispatched('t1', { title: 'x' });
  a.done('t1', { note: '未经审核直接完成' });
  const nf = a.audit().noFeedback || [];
  check('done() 之后 audit 能报出"完成但无质量反馈"',
    Array.isArray(nf) && nf.some((x) => x.taskId === 't1'),
    `noFeedback=${JSON.stringify(nf).slice(0, 90)}`);

  const b = new TaskAwareness();
  b.dispatched('t2', { title: 'x' });
  b.feedback('t2', { quality: 'pass' });
  check('经过 feedback() 的任务不被误报',
    !(b.audit().noFeedback || []).some((x) => x.taskId === 't2'));
}

{
  const { makeTask, validatePlan } = require('./task');
  console.log('--- ⑥ 入参校验 ---');
  const mk = (bm) => makeTask({ id: 'x', name: 'x', type: 'explore', role: 'researcher', input: { description: '一个足够长的任务描述' }, budget: { backoffMs: bm } });
  check('backoffMs:0 被纠正', mk(0).budget.backoffMs > 0, '得到 ' + mk(0).budget.backoffMs);
  check('deps 为字符串被拒绝', throws(() => validatePlan([{ id: 'a', name: 'a', type: 'explore', role: 'researcher', deps: 'a', input: { description: '一个足够长的任务描述' } }])));
}

{
  const { Scheduler } = require('./scheduler');
  console.log('--- ⑦ 配置拼错不得静默 ---');
  check('拼错的 policy 当场报错', throws(() => new Scheduler({ root: path.join(tmp, 's7'), runId: 'r', workspaceConflictPolicy: 'degradee' })));
  const okS = new Scheduler({ root: path.join(tmp, 's7b'), runId: 'r', workspaceConflictPolicy: 'ignore' });
  check('合法取值 ignore 被接受（用户可显式选择 fail-open）', okS.workspaceConflictPolicy === 'ignore');
  const defS = new Scheduler({ root: path.join(tmp, 's7c'), runId: 'r' });
  check('缺省为 degrade', defS.workspaceConflictPolicy === 'degrade');
}

{
  const { Workspace } = require('./workspace');
  const dir = path.join(tmp, 'ro'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'orig.txt'), 'v1');
  const w = new Workspace({ base: dir, runRoot: path.join(tmp, 'ro-run') });
  console.log('--- ⑧ 只读污染可观测 ---');
  const ro = { id: 'ro1', name: 'ro1', type: 'review', role: 'reviewer', deps: [], input: { description: '一个足够长的任务描述' } };
  w.cwdFor(ro);
  await0();
  function await0() {  }

  fs.writeFileSync(path.join(dir, 'sneaky.txt'), 'from-readonly');

  const wt = { id: 'w1', name: 'w1', type: 'implement', role: 'worker', deps: [], input: { description: '一个足够长的任务描述' } };
  const cwd = w.cwdFor(wt);
  fs.writeFileSync(path.join(cwd, 'own.txt'), 'mine');
  const pub = w.publish(wt, 0);
  check('发布结果里带出只读污染记录（不再静默归因给写任务）',
    pub && Array.isArray(pub.readOnlyPollution) && pub.readOnlyPollution.length > 0,
    JSON.stringify(pub && pub.readOnlyPollution || []).slice(0, 120));
  check('污染文件被点名', pub && pub.readOnlyPollution.some((p) => p.files.includes('sneaky.txt')),
    JSON.stringify(pub && pub.readOnlyPollution || []).slice(0, 120));

  check('未被改动的 orig.txt 不被误报',
    !(pub.readOnlyPollution || []).some((p) => p.files.includes('orig.txt')),
    JSON.stringify(pub.readOnlyPollution || []).slice(0, 120));
  check('写任务自己的产物未被误判为污染',
    !(pub.readOnlyPollution || []).some((p) => p.files.includes('own.txt')));
}

{
  console.log('--- ⑨ 僵尸工件归属 ---');
  const src = fs.readFileSync(path.join(SRC, 'executor-codex.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('执行器不把 task.attemptId 直接写进 saveArtifact', !/attemptId:\s*task\.attemptId/.test(code));
}

(async () => {
  console.log('--- ⑩ 落盘异常有界重试---');
  const { Scheduler } = require('./scheduler');
  const root = path.join(tmp, 's10');
  const w = async ({ task }) => ({ verdict: 'done', summary: task.id + ' 完成' });
  const s = new Scheduler({ runId: 'r89b12', root, concurrency: 2, worker: w });
  s.init('t', [
    { id: 'a', type: 'implement', deps: [], budget: { timeoutSec: 20, stallSec: 15, maxAttempts: 1 } },
    { id: 'b', type: 'implement', deps: [], budget: { timeoutSec: 20, stallSec: 15, maxAttempts: 1 } },
  ]);

  const origSave = s.store.saveTasks.bind(s.store);
  let injected = false;
  s.store.saveTasks = (...a) => { injected = true; s.store.saveTasks = origSave; throw new Error('EIO: disk full (注入)'); };
  let ok = true;
  try { await s.run(); } catch (e) { ok = false; void e; }
  check('单次落盘失败 run() 不再整体逃逸', ok && injected, ok ? '注入已触发并自愈' : 'run() 仍逃逸');
  const snap = JSON.parse(fs.readFileSync(path.join(root, 'r89b12', 'snapshot.json'), 'utf8'));
  check('重试后终态快照在盘且任务收敛',
    Array.isArray(snap.tasks) && snap.tasks.length === 2 && snap.tasks.every((t) => t.state === 'done' || t.state === 'degraded'),
    'tasks=' + (snap.tasks || []).length);
})().then(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
  process.exit(fails === 0 ? 0 : 1);
}).catch((e) => { console.error('⑩ 自身异常：', e && e.stack); process.exit(2); });