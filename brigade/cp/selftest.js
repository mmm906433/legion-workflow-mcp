'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Scheduler } = require('./scheduler');

const ROOT = path.join(os.tmpdir(), 'cp-selftest-' + Date.now());
let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scenario1() {
  console.log('\n[场景1] 依赖顺序 / 并发上限 / 优先级');
  let peak = 0, active = 0;
  const worker = async ({ task }) => {
    active++; peak = Math.max(peak, active);
    await sleep(120);
    active--;
    return { verdict: 'done' };
  };
  const s = new Scheduler({ runId: 's1', root: ROOT, worker, concurrency: 2 });
  s.init('测试1', [
    { id: 'a', type: 'explore', title: 'A', deps: [] },
    { id: 'b', type: 'explore', title: 'B', deps: ['a'] },
    { id: 'c', type: 'explore', title: 'C', deps: ['a'] },
    { id: 'd', type: 'explore', title: 'D', deps: ['b', 'c'] },
  ]);
  const t0 = Date.now();
  const res = await s.run();
  const ms = Date.now() - t0;
  check('全部完成', res.done === 4, JSON.stringify(res.tasks.map((t) => t.id + ':' + t.state)));
  check('并发未超上限(2)', peak <= 2, '峰值=' + peak);
  check('依赖顺序正确（D 在 B/C 之后）', ms > 240, '耗时=' + ms + 'ms（4 任务/并发2/每个120ms 应 ≥240ms）');

  const ev = s.store.listEvents('s1').filter((e) => e.kind === 'exec_start').map((e) => e.id);
  check('D 最后启动', ev[ev.length - 1] === 'd', '启动顺序=' + ev.join('→'));
}

async function scenario2() {
  console.log('\n[场景2] 失败快速传播');
  const t0 = Date.now();
  const worker = async ({ task }) => {
    if (task.id === 'root') return { verdict: 'fail', failureType: 'exec_blocked', summary: '模拟失败' };
    await sleep(50);
    return { verdict: 'done' };
  };
  const s = new Scheduler({ runId: 's2', root: ROOT, worker, concurrency: 4 });
  s.init('测试2', [
    { id: 'root', type: 'implement', title: '会失败的任务', deps: [] },
    { id: 'kid1', type: 'test', title: '下游1', deps: ['root'], budget: { maxAttempts: 1 } },
    { id: 'kid2', type: 'review', title: '下游2', deps: ['root'], budget: { maxAttempts: 1 } },
  ]);
  const res = await s.run();
  const ms = Date.now() - t0;
  check('root 失败', res.tasks.find((t) => t.id === 'root').state === 'failed');
  check('下游被降级而非空等', res.tasks.filter((t) => t.id !== 'root').every((t) => t.state === 'degraded'),
    res.tasks.map((t) => t.id + ':' + t.state).join(' '));
  check('快速结束(<1.5s)', ms < 1500, '耗时=' + ms + 'ms');
}

async function scenario3() {
  console.log('\n[场景3] 卡死检测（心跳）');
  const t0 = Date.now();
  const worker = async ({ task, signal }) => {
    if (task.id === 'hang') {

      await new Promise((resolve) => signal.addEventListener('abort', resolve));
      return { verdict: 'fail', summary: '被回收' };
    }
    return { verdict: 'done' };
  };
  const s = new Scheduler({ runId: 's3', root: ROOT, worker, concurrency: 2 });
  s.init('测试3', [
    { id: 'hang', type: 'research', title: '会卡死的任务', deps: [], budget: { timeoutSec: 60, stallSec: 1, maxAttempts: 1 } },
    { id: 'after', type: 'test', title: '卡死后应该还能跑', deps: ['hang'], budget: { maxAttempts: 1 } },
  ]);
  const res = await s.run();
  const ms = Date.now() - t0;
  const hang = res.tasks.find((t) => t.id === 'hang');
  check('卡死被判定为 stalled', hang.outcome && hang.outcome.failureType === 'stalled', JSON.stringify(hang.outcome));
  check('卡死任务被回收（60s 超时未等到）', ms < 8000, '耗时=' + ms + 'ms');
  check('下游降级（没空等 60s）', res.tasks.find((t) => t.id === 'after').state === 'degraded');
}

async function scenario4() {
  console.log('\n[场景4] 正负反馈（放大 / 熔断）');
  const worker = async ({ task }) => {
    if (task.id.startsWith('good')) return { verdict: 'done' };
    return { verdict: 'fail', failureType: 'tool_miss' };
  };
  const s = new Scheduler({ runId: 's4', root: ROOT, worker, concurrency: 8, feedback: { meldThreshold: 3 } });

  s.init('测试4', []);
  const fb = s.feedback;
  const mk = (id, type, role) => ({ id, type, role, budget: { timeoutSec: 10, maxAttempts: 1, stallSec: 5 } });
  for (let i = 0; i < 3; i++) fb.record(mk('g', 'explore', 'explorer'), { verdict: 'done', ms: 100 });
  for (let i = 0; i < 3; i++) fb.record(mk('b', 'implement', 'worker'), { verdict: 'fail', ms: 100, failureType: 'tool_miss' });
  const goodAdv = fb.advise(mk('x', 'explore', 'explorer'));
  const badAdv = fb.advise(mk('y', 'implement', 'worker'));
  check('成功组合被放大(优先级>0)', goodAdv.priority > 0, 'priority=' + goodAdv.priority);
  check('失败组合被降权(优先级<0)', badAdv.priority < 0, 'priority=' + badAdv.priority);
  check('失败组合被熔断(不放行)', badAdv.allow === false, badAdv.reason);

  const zt = require('./task').makeTask({ id: 'z', type: 'implement', role: 'worker', deps: [] });
  s.store.saveTasks('s4', [zt], s.store.currentEpoch('s4') + 1);
  s.load();
  const { ready, tripped } = s.readySet(s.all());
  check('熔断组合不出现在就绪队列', !ready.some((t) => t.id === 'z'));
  check('熔断任务进入 tripped 待提交', tripped.some((x) => x.task.id === 'z'));
  s.applyTripped(tripped);
  check('提交后熔断任务被标记 skipped', (s.all().find((t) => t.id === 'z') || {}).state === 'skipped');
}

async function scenario5() {
  console.log('\n[场景5] 20 任务 / 并发 5');
  let peak = 0, active = 0;
  const worker = async () => {
    active++; peak = Math.max(peak, active);
    await sleep(60);
    active--;
    return { verdict: 'done' };
  };
  const s = new Scheduler({ runId: 's5', root: ROOT, worker, concurrency: 5 });
  const specs = [];
  for (let i = 0; i < 20; i++) {
    specs.push({ id: 'w' + i, type: 'explore', title: 'W' + i, deps: i < 4 ? [] : ['w' + (i % 4)] });
  }
  s.init('测试5', specs);
  const t0 = Date.now();
  const res = await s.run();
  const ms = Date.now() - t0;
  check('20 个全完成', res.done === 20, res.done + '/20');
  check('并发峰值=5', peak === 5, '峰值=' + peak);
  check('吞吐合理(≤1.5s)', ms < 1500, '耗时=' + ms + 'ms');
}

async function scenario6() {
  console.log('\n[场景6] 环依赖与悬空依赖');
  const { validatePlan, makeTask } = require('./task');

  let threw = false;
  try {
    validatePlan([
      makeTask({ id: 'A', type: 'explore', deps: ['B'] }),
      makeTask({ id: 'B', type: 'explore', deps: ['A'] }),
    ]);
  } catch { threw = true; }
  check('环依赖被拒绝(抛错)', threw);

  threw = false;
  try { validatePlan([makeTask({ id: 'A', type: 'explore', deps: ['GHOST'] })]); } catch { threw = true; }
  check('悬空依赖被拒绝(抛错)', threw);

  threw = false;
  try { validatePlan([makeTask({ id: 'A', type: 'explore', deps: ['A'] })]); } catch { threw = true; }
  check('自依赖被拒绝(抛错)', threw);

  const worker = async () => ({ verdict: 'done' });
  const s = new Scheduler({ runId: 's6', root: ROOT, worker, concurrency: 2 });
  s.init('测试6', [{ id: 'X', type: 'explore', deps: [] }]);
  const t = s.all()[0];
  t.deps = ['GHOST'];
  s.persist();
  const t0 = Date.now();
  const res = await Promise.race([s.run(), new Promise((r) => setTimeout(() => r({ watchdog: true }), 35000))]);
  const ms = Date.now() - t0;
  check('运行期悬空依赖不导致无限 hang', !res.watchdog, '耗时=' + ms + 'ms ' + JSON.stringify(res.tasks && res.tasks.map((x) => x.id + ':' + x.state)));
}

async function scenario7() {
  console.log('\n[场景7] fencing token（僵尸 attempt 结果被丢弃）');
  let call = 0;
  const worker = async () => {
    call++;
    if (call === 1) { await new Promise((r) => setTimeout(r, 400)); return { verdict: 'done', summary: '僵尸 attempt 1 的迟到结果' }; }
    return { verdict: 'done', summary: 'attempt 2 的结果' };
  };
  const s = new Scheduler({ runId: 's7', root: ROOT, worker, concurrency: 2 });
  s.init('测试7', [{ id: 'z', type: 'explore', deps: [], budget: { timeoutSec: 30, stallSec: 15, maxAttempts: 3 } }]);
  const t = s.all()[0];

  const p1 = s.execute(t);
  await new Promise((r) => setTimeout(r, 60));
  s.transit(t, 'pending', { leasedBy: null, leaseUntil: 0 });
  const p2 = s.execute(t);
  await Promise.all([p1, p2]);
  check('僵尸 attempt 的结果被丢弃', t.outcome && t.outcome.note === 'attempt 2 的结果', JSON.stringify(t.outcome));
  check('丢弃事件已记录', s.store.listEvents('s7').some((e) => e.kind === 'stale_result_discarded'));
  check('最终状态为 done', t.state === 'done', t.state);
}

async function scenario8() {
  console.log('\n[场景8] 重试退避');
  let flakyCalls = 0, firstFailAt = 0, secondOkAt = 0, otherRanDuringBackoff = false;
  const worker = async ({ task }) => {
    if (task.id === 'flaky') {
      flakyCalls++;
      if (flakyCalls === 1) { firstFailAt = Date.now(); return { verdict: 'fail', failureType: 'crash' }; }
      secondOkAt = Date.now();
      return { verdict: 'done' };
    }

    if (firstFailAt && !secondOkAt && Date.now() - firstFailAt < 1900) otherRanDuringBackoff = true;
    return { verdict: 'done' };
  };
  const s = new Scheduler({ runId: 's8', root: ROOT, worker, concurrency: 1 });
  s.init('测试8', [
    { id: 'flaky', type: 'implement', deps: [], budget: { maxAttempts: 2, backoffMs: 2000, timeoutSec: 30, stallSec: 10 } },
    { id: 'other', type: 'explore', deps: [] },
  ]);
  await s.run();
  const gap = secondOkAt - firstFailAt;
  check('重试有退避间隔(≥900ms，含 jitter)', gap >= 900, '间隔=' + gap + 'ms（基准2000ms，jitter 后落在 1000-2000 区间）');
  check('两个任务最终都完成', s.all().every((t) => t.state === 'done'), s.all().map((t) => t.id + ':' + t.state).join(' '));
  check('other 在退避期间被调度(槽位未霸占)', otherRanDuringBackoff);
}

async function scenario9() {
  console.log('\n[场景9] 硬超时（worker 不响应 signal）');
  const worker = async () => {

    await new Promise(() => {});
  };
  const s = new Scheduler({ runId: 's9', root: ROOT, worker, concurrency: 1 });
  s.init('测试9', [{ id: 'stubborn', type: 'implement', deps: [], budget: { timeoutSec: 2, stallSec: 30, maxAttempts: 1 } }]);
  const t0 = Date.now();
  const res = await Promise.race([s.run(), new Promise((r) => setTimeout(() => r({ hang: true }), 15000))]);
  const ms = Date.now() - t0;
  check('无视 signal 的 worker 也会被裁决', !res.hang, '耗时=' + ms + 'ms');
  const t = (res.tasks || [])[0];
  check('判定为 timeout 失败', t && t.state === 'failed' && t.outcome.failureType === 'timeout', JSON.stringify(t && t.outcome));
}

async function scenario10() {
  console.log('\n[场景10] 资源侧 fencing / 确定性失败 / 指数退避');
  const { FileStore } = require('./store');
  const { isRetryable, backoffDelay } = require('./task');

  const st = new FileStore(path.join(ROOT, 'storetest'));
  const shard = (v, ep) => st.saveTasks('r', [{ id: 'a', v }], ep);
  shard('v1', 5);
  const okNewer = shard('new', 6);
  const okStale = shard('stale', 3);
  const loaded = st.loadTasks('r');
  check('新 epoch 写入成功', okNewer === true);
  check('陈旧 epoch 写入被拒绝', okStale === false);
  check('陈旧写入未污染数据', loaded[0] && loaded[0].v === 'new', JSON.stringify(loaded[0]));
  check('拒绝事件已记录', st.listEvents('r').some((e) => e.kind === 'stale_write_rejected'));

  check('format_violation 不重试', isRetryable('format_violation') === false);
  check('tool_miss 不重试', isRetryable('tool_miss') === false);
  check('acceptance_failed 不重试', isRetryable('acceptance_failed') === false);
  check('gate_fail 不重试(交给rework)', isRetryable('gate_fail') === false);
  check('stalled 可重试', isRetryable('stalled') === true);
  check('timeout 可重试(降effort/拆分后有意义)', isRetryable('timeout') === true);
  check('crash 可重试', isRetryable('crash') === true);

  let calls = 0;
  const worker = async () => { calls++; return { verdict: 'fail', failureType: 'tool_miss' }; };
  const s = new Scheduler({ runId: 's10', root: ROOT, worker, concurrency: 1 });
  s.init('测试10', [{ id: 'det', type: 'implement', deps: [], budget: { maxAttempts: 5, backoffMs: 1000, timeoutSec: 30, stallSec: 10 } }]);
  await s.run();
  check('确定性失败只尝试一次', calls === 1, 'calls=' + calls);
  check('任务判定为 failed', s.all()[0].state === 'failed', s.all()[0].state);

  const d1 = backoffDelay(1, 2000), d2 = backoffDelay(2, 2000), d3 = backoffDelay(3, 2000);
  check('退避随尝试次数增长', d2 > d1 && d3 > d2, `${d1}/${d2}/${d3}`);
  const samples = Array.from({ length: 20 }, () => backoffDelay(3, 2000));
  check('退避带 jitter(有抖动)', Math.max(...samples) !== Math.min(...samples));
  check('退避有上限', backoffDelay(50, 2000) <= 128000, String(backoffDelay(50, 2000)));
}

async function scenario11() {
  console.log('\n[场景11] r2 修复回归');
  const { FileStore } = require('./store');

  const st = new FileStore(path.join(ROOT, 'sec'));
  let inj = false;
  try { st.saveArtifact('r1', { id: '../../../evil', summary: 'x' }); } catch { inj = true; }
  check('artifactId 路径注入被拒', inj);
  inj = false;
  try { st.runDir('../../../escape'); } catch { inj = true; }
  check('runId 路径注入被拒', inj);

  const sh = (v, ep) => st.saveTasks('r2', [{ id: 'a', v }], ep);
  sh('x', 10);
  const same = sh('stale-same', 10);
  const older = sh('older', 5);
  const newer = sh('newer', 11);
  check('同 epoch 写入被拒(GC暂停场景)', same === false);
  check('更旧 epoch 写入被拒', older === false);
  check('更新 epoch 写入成功', newer === true);
  check('fencing 未被污染', st.loadTasks('r2')[0].v === 'newer', JSON.stringify(st.loadTasks('r2')[0]));

  st.appendEvent('r2', { kind: 'ok1' });
  const logPath = path.join(st.runDir('r2'), 'events', 'log.jsonl');
  fs.appendFileSync(logPath, '{坏行不完整\n');
  st.appendEvent('r2', { kind: 'ok2' });
  const evs = st.listEvents('r2');
  check('坏行被隔离不报废日志', evs.filter((e) => e.kind === 'ok1').length === 1 && evs.filter((e) => e.kind === 'ok2').length === 1, `读到 ${evs.length} 条`);

  const worker = async ({ heartbeat }) => {
    const iv = setInterval(() => heartbeat(), 200);
    await sleep(6000);
    clearInterval(iv);
    return { verdict: 'done' };
  };
  const s = new Scheduler({ runId: 's11', root: ROOT, worker, concurrency: 2 });
  s.init('测试11', [{ id: 'slow', type: 'implement', deps: [], budget: { timeoutSec: 60, stallSec: 30, maxAttempts: 1 } }]);
  const res = await Promise.race([s.run(), new Promise((r) => setTimeout(() => r({ hang: true }), 20000))]);
  check('长任务(6s持续心跳)不被看门狗误杀', !res.hang && res.tasks && res.tasks[0].state === 'done', res.hang ? '被误杀' : (res.tasks && res.tasks[0].state));

  let failOnce = true;
  const worker2 = async ({ task }) => {
    if (task.id === 'rw' && failOnce) { failOnce = false; return { verdict: 'fail', failureType: 'crash' }; }
    return { verdict: 'done' };
  };
  const s2 = new Scheduler({ runId: 's11b', root: ROOT, worker: worker2, concurrency: 1 });
  s2.init('测试11b', [{ id: 'rw', type: 'implement', deps: [], allowRework: true, budget: { maxAttempts: 2, backoffMs: 100, timeoutSec: 30, stallSec: 10 } }]);
  const res2 = await Promise.race([s2.run(), new Promise((r) => setTimeout(() => r({ hang: true }), 20000))]);
  const rw = res2.tasks && res2.tasks[0];
  check('rework 任务最终完成(经历失败后重做)', !res2.hang && rw && rw.state === 'done', rw ? rw.state + ' attempts=' + rw.attempts : 'hang');
}

(async () => {
  console.log('=== 中心调度器内核自测（假执行器，与模型无关）===');
  console.log('临时目录:', ROOT);
  await scenario1();
  await scenario2();
  await scenario3();
  await scenario4();
  await scenario5();
  await scenario6();
  await scenario7();
  await scenario8();
  await scenario9();

  console.log('\n=== 场景12：worker 契约归一化 ===');
  const contract = [
    ['verdict 形态', { verdict: 'done' }, 'done'],
    ['ok 形态', { ok: true }, 'done'],
    ['verdict=fail', { verdict: 'fail' }, 'failed'],
    ['ok=false', { ok: false }, 'failed'],
    ['空对象(默认失败)', {}, 'failed'],
    ['未知值(默认失败)', { verdict: 'weird' }, 'failed'],
  ];
  for (const [label, ret, expect] of contract) {
    const sc = new Scheduler({ runId: 'ct', root: path.join(ROOT, 'ct' + expect + label), concurrency: 1, worker: async () => ret });
    sc.init('x', [{ id: 'a', type: 'explore', deps: [] }]);
    const r = await sc.run();
    check('契约 ' + label + ' → ' + expect, r.tasks[0].state === expect, '实得 ' + r.tasks[0].state);
  }

  console.log('\n=== 场景13：watchdog 不可复活 + degraded 路径 ===');
  {

    const s1 = new Scheduler({
      runId: 'deg', root: path.join(ROOT, 'deg'), concurrency: 1,
      worker: async () => ({ verdict: 'degraded', summary: '降级完成' }),
    });
    s1.init('x', [{ id: 'd', type: 'explore', deps: [] }]);
    const r1 = await s1.run();
    check('worker 返回 degraded → 状态为 degraded（不落成 failed）', r1.tasks[0].state === 'degraded', r1.tasks[0].state);
  }
  {

    let calls = 0;
    const s2 = new Scheduler({
      runId: 'wdog', root: path.join(ROOT, 'wdog'), concurrency: 1, retryBudget: 99,
      worker: async () => { calls++; return { verdict: 'fail', failureType: 'stalled' }; },
    });
    s2.init('x', [{
      id: 'w', type: 'implement', deps: [], allowRework: true,
      budget: { timeoutSec: 1, stallSec: 1, maxAttempts: 99, backoffMs: 10 },
    }]);
    const r2 = await Promise.race([s2.run(), new Promise((r) => setTimeout(() => r({ hang: true }), 30000))]);
    check('反复失败的任务最终收敛（未无限复活）', !r2.hang, 'hang=' + !!r2.hang);
    check('worker 调用次数受重试预算约束(<40)', calls < 40, 'calls=' + calls);
  }

  console.log('\n=== 场景14：崩溃续跑不重做已完成任务===');
  {
    const root = path.join(ROOT, 'crash');
    const specs = Array.from({ length: 12 }, (_, i) => ({ id: 'k' + i, type: 'explore', deps: [] }));

    const s1 = new Scheduler({
      runId: 'crash', root, concurrency: 4, flushIntervalMs: 20,
      worker: async () => ({ verdict: 'done' }),
    });
    s1.init('x', specs);
    await s1.run();
    const snapPath = path.join(root, 'crash', 'snapshot.json');
    const full = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    check('完整一轮后全部落盘为 done', full.tasks.every((t) => t.state === 'done'), `${full.tasks.length} 个任务`);

    const rolledBack = full.tasks.filter((t) => t.state === 'done').slice(6);
    for (const t of rolledBack) { t.state = 'pending'; t.outcome = null; t.attempts = 0; t.attemptId = 0; t.leaseUntil = 0; t.leasedBy = null; }
    const persistedDone = full.tasks.filter((t) => t.state === 'done').length;
    fs.writeFileSync(snapPath, JSON.stringify(full));

    const redone = new Set();
    const s2 = new Scheduler({
      runId: 'crash', root, concurrency: 4, flushIntervalMs: 20,
      worker: async ({ task }) => { redone.add(task.id); return { verdict: 'done' }; },
    });
    s2.load();
    const resumed = await Promise.race([
      s2.run(), new Promise((r) => setTimeout(() => r({ hang: true }), 20000)),
    ]);
    check('续跑未 hang', !resumed.hang);
    check('已落盘的完成任务零重做', ![...redone].some((id) => full.tasks.find((t) => t.id === id && t.state === 'done')),
      `落盘完成 ${persistedDone} 个，重做集合大小 ${redone.size}`);
    const doneNow = (resumed.tasks || []).filter((t) => t.state === 'done').length;
    check('续跑后全部任务收敛到 done', (resumed.tasks || []).length === 12 && doneNow === 12,
      `tasks=${(resumed.tasks || []).length} done=${doneNow}`);
    check('未落盘的任务被重做并补上', rolledBack.every((t) => redone.has(t.id)),
      `应重做 ${rolledBack.length} 个，实际重做 ${rolledBack.filter((t) => redone.has(t.id)).length} 个`);
  }

  await scenario10();
  await scenario11();
  console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'));
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
})();
