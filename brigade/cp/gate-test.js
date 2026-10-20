'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Scheduler } = require('./scheduler');
const { Command, syncSquads, flattenSquads, makeWriteGate } = require('./hierarchy');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fail++;
};

const WRITE_TYPES = new Set(['implement', 'dep', 'docs']);

async function scenario(name, { squads, perSquad, gate, expectPeak }) {
  const ROOT = path.join(os.tmpdir(), 'gate-' + Date.now() + '-' + squads);
  const cmd = new Command({ writeSquadGate: gate, globalConcurrency: 40 });
  const cards = [];
  for (let i = 0; i < squads; i++) cards.push({ id: 'S' + i, title: '写队' + i, goal: 'g' });
  cmd.deploy('g', cards, (card) =>
    Array.from({ length: perSquad }, (_, k) => ({
      id: card.id + 'x' + k, type: 'implement', deps: [],
      budget: { timeoutSec: 9, stallSec: 5, maxAttempts: 1 },
    }))
  );

  let inflightWrites = 0, peakWrites = 0;
  const worker = async ({ task }) => {
    if (WRITE_TYPES.has(task.type)) { inflightWrites++; peakWrites = Math.max(peakWrites, inflightWrites); }
    await sleep(25);
    if (WRITE_TYPES.has(task.type)) inflightWrites--;
    return { verdict: 'done', summary: 'ok' };
  };

  const s = new Scheduler({
    runId: 'gate', root: ROOT, worker, concurrency: 40,
    onProgress: (ts) => syncSquads(cmd, ts),
    admission: makeWriteGate(cmd),
  });
  s.init('g', flattenSquads(cmd));
  const t0 = Date.now();
  await s.run();
  const wall = Date.now() - t0;
  const st = cmd.status();
  const total = squads * perSquad;

  console.log(`\n=== ${name}（${squads} 队 × ${perSquad} 写任务，gate=${gate}）===`);
  check('写并发峰值 = 期望值', peakWrites === expectPeak, `实际 ${peakWrites}，期望 ${expectPeak}`);
  check('所有任务完成', st.progress === 100, st.progress + '%');
  check('无任务卡死残留', st.squads.every((sq) => sq.status === 'done'), JSON.stringify(st.squads.map((sq) => sq.status)));
  const minWall = (total * 25) / Math.max(gate, 1);
  check('总时长符合串行预期', wall >= minWall * 0.8, `耗时 ${wall}ms ≥ 理论 ${Math.round(minWall)}ms`);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
}

function contractScenarios() {
  console.log('\n=== flattenSquads 契约断言（fail-closed）===');

  const okCmd = new Command({});
  okCmd.deploy('g', [{ id: 'K', title: 'k', goal: 'g' }], (card) => [
    { id: card.id + 'a', type: 'implement', deps: [], budget: {} },
  ]);
  let okThrew = false;
  try { flattenSquads(okCmd); } catch { okThrew = true; }
  check('契约完整时正常通过', !okThrew);

  const badCmd = new Command({});
  badCmd.deploy('g', [{ id: 'B', title: 'b', goal: 'g' }], () => [
    { type: 'implement', deps: [], budget: {} },
  ]);
  let badThrew = false;
  try { flattenSquads(badCmd); } catch { badThrew = true; }
  check('任务缺 id 时 fail-closed 抛错', badThrew, '安全契约不容静默降级');
}

(async () => {
  console.log('=== 写闸门 · 真实调用链回归 ===');

  await scenario('默认串行写', { squads: 3, perSquad: 3, gate: 1, expectPeak: 1 });

  await scenario('放宽到 2', { squads: 5, perSquad: 2, gate: 2, expectPeak: 2 });

  await scenario('单队队内串行', { squads: 1, perSquad: 4, gate: 1, expectPeak: 1 });

  contractScenarios();

  console.log('\n=== 场景5：闸门持续阻塞时看门狗不得误杀 ===');
  {
    const ROOT2 = path.join(os.tmpdir(), 'gatesat-' + Date.now());
    const t0 = Date.now();

    const gate = () => Date.now() - t0 > 18000;
    const worker2 = async () => { await sleep(20); return { verdict: 'done' }; };
    const s2 = new Scheduler({
      runId: 'gatesat', root: ROOT2, worker: worker2, concurrency: 4, admission: gate, gateGraceMs: 60000,
    });
    s2.init('gate', Array.from({ length: 6 }, (_, i) => ({
      id: 'g' + i, type: 'implement', deps: [], budget: { timeoutSec: 40, stallSec: 30, maxAttempts: 1 },
    })));
    const r2 = await Promise.race([s2.run(), sleep(60000).then(() => ({ hang: true }))]);
    const states = r2.tasks ? r2.tasks.map((t) => t.state) : [];
    const done = states.filter((x) => x === 'done').length;
    check('闸门阻塞 18s 期间未被看门狗误杀', done === 6, `完成 ${done}/6，状态=${states.join(',')}`);
    check('闸门放行后全部完成（未 hang）', !r2.hang);
    try { fs.rmSync(ROOT2, { recursive: true, force: true }); } catch {}
  }

  console.log('\n=== 场景6：二次阻塞必须重新计时===');
  {
    const ROOT3 = path.join(os.tmpdir(), 'gate2nd-' + Date.now());
    const t0 = Date.now();

    const gate = () => {
      const d = Date.now() - t0;
      if (d < 5000 || (d >= 8000 && d < 11000)) return false;
      return true;
    };
    const worker3 = async () => { await sleep(30); return { verdict: 'done' }; };
    const s3 = new Scheduler({
      runId: 'gate2nd', root: ROOT3, worker: worker3, concurrency: 1, admission: gate, gateGraceMs: 8000,
    });
    s3.init('gate2', Array.from({ length: 3 }, (_, i) => ({
      id: 'h' + i, type: 'implement', deps: [], budget: { timeoutSec: 60, stallSec: 40, maxAttempts: 1 },
    })));
    const r3 = await Promise.race([s3.run(), sleep(45000).then(() => ({ hang: true }))]);
    const states3 = r3.tasks ? r3.tasks.map((t) => t.state) : [];
    const done3 = states3.filter((x) => x === 'done').length;
    check('二次阻塞未触发强杀（计时重新开始）', done3 === 3, `完成 ${done3}/3，状态=${states3.join(',')}`);
    try { fs.rmSync(ROOT3, { recursive: true, force: true }); } catch {}
  }

  console.log('\n=== 场景7：多 continue 路径 × 闸门计时===');
  {
    const ROOT4 = path.join(os.tmpdir(), 'multipath-' + Date.now());
    const t0 = Date.now();

    const gate4 = () => Date.now() - t0 > 6000;

    const flakyUpstream = { id: 'u', type: 'implement', deps: [], budget: { timeoutSec: 9, stallSec: 8, maxAttempts: 1 } };
    let n = 0;
    const worker4 = async ({ task }) => {
      if (task.id === 'u') { n++; return { verdict: 'fail', failureType: 'crash' }; }
      await sleep(20);
      return { verdict: 'done' };
    };
    const s4 = new Scheduler({
      runId: 'multipath', root: ROOT4, worker: worker4, concurrency: 3, admission: gate4, gateGraceMs: 8000,
    });
    s4.init('multipath', [
      flakyUpstream,

      { id: 'd1', type: 'test', deps: ['u'], budget: { timeoutSec: 30, stallSec: 20, maxAttempts: 1 } },
      { id: 'd2', type: 'test', deps: ['u'], budget: { timeoutSec: 30, stallSec: 20, maxAttempts: 1 } },

      { id: 'ok1', type: 'implement', deps: [], budget: { timeoutSec: 30, stallSec: 20, maxAttempts: 1 } },
      { id: 'ok2', type: 'implement', deps: [], budget: { timeoutSec: 30, stallSec: 20, maxAttempts: 1 } },
    ]);
    const r4 = await Promise.race([s4.run(), sleep(45000).then(() => ({ hang: true }))]);
    const st4 = r4.tasks ? r4.tasks.map((t) => t.id + ':' + t.state) : ['hang'];
    const okDone = st4.filter((x) => x.startsWith('ok') && x.endsWith('done')).length;
    const degraded = st4.filter((x) => x.endsWith('degraded') || x.endsWith('skipped')).length;
    check('多 continue 交替下正常任务仍完成（未被误杀）', okDone === 2, st4.join(' '));
    check('上游失败的下游被降级而非空转', degraded >= 2, st4.join(' '));
    check('整体未 hang', !r4.hang);
    void n;
    try { fs.rmSync(ROOT4, { recursive: true, force: true }); } catch {}
  }

  console.log('\n=== 场景8：applyTripped + markUnresolvable continue 路径 ===');
  {
    const ROOT5 = path.join(os.tmpdir(), 'tripped-' + Date.now());
    let failed = 0;
    const worker5 = async ({ task }) => {
      if (task.id === 'z0') { await sleep(200); return { verdict: 'done' }; }
      if (task.role === 'worker') { failed++; return { verdict: 'fail', failureType: 'crash' }; }
      await sleep(20);
      return { verdict: 'done' };
    };
    const s5 = new Scheduler({
      runId: 'tripped', root: ROOT5, worker: worker5, concurrency: 1, admission: () => true, gateGraceMs: 8000,
    });
    s5.init('trip', [
      { id: 'a1', role: 'worker', type: 'implement', deps: [], budget: { timeoutSec: 20, stallSec: 15, maxAttempts: 1 } },
      { id: 'a2', role: 'worker', type: 'implement', deps: [], budget: { timeoutSec: 20, stallSec: 15, maxAttempts: 1 } },
      { id: 'a3', role: 'worker', type: 'implement', deps: [], budget: { timeoutSec: 20, stallSec: 15, maxAttempts: 1 } },
      { id: 'z0', role: 'tester', type: 'test', deps: [], budget: { timeoutSec: 20, stallSec: 15, maxAttempts: 1 } },

      { id: 'z1', role: 'worker', type: 'implement', deps: ['z0'], budget: { timeoutSec: 20, stallSec: 15, maxAttempts: 1 } },
      { id: 'g1', role: 'tester', type: 'docs', deps: [], budget: { timeoutSec: 20, stallSec: 15, maxAttempts: 1 } },
    ]);
    const r5 = await Promise.race([s5.run(), sleep(45000).then(() => ({ hang: true }))]);
    const map5 = new Map((r5.tasks || []).map((t) => [t.id, t]));
    const st5 = (id) => (map5.get(id) ? map5.get(id).state + '/' + ((map5.get(id).outcome || {}).failureType || '-') : 'missing');
    check('熔断攒满（3 个同类失败）', failed === 3, '实际失败 ' + failed);
    check('z1 被熔断跳过（applyTripped 路径）', st5('z1') === 'skipped/circuit_open', st5('z1'));
    check('正常任务未被 applyTripped 误杀', st5('z0') === 'done/-' && st5('g1') === 'done/-', `z0=${st5('z0')} g1=${st5('g1')}`);
    check('整体未 hang', !r5.hang);
    try { fs.rmSync(ROOT5, { recursive: true, force: true }); } catch {}
  }

  console.log('\n=== 场景8b：续跑时上游消失 → markUnresolvable 兜底 ===');
  {
    const ROOT7 = path.join(os.tmpdir(), 'resume-' + Date.now());
    const worker7 = async () => { await sleep(20); return { verdict: 'done' }; };
    const s7a = new Scheduler({ runId: 'rs', root: ROOT7, worker: worker7, concurrency: 2 });
    s7a.init('resume', [
      { id: 'up', role: 'worker', type: 'implement', deps: [], budget: { timeoutSec: 20, stallSec: 15, maxAttempts: 1 } },
      { id: 'down', role: 'tester', type: 'test', deps: ['up'], budget: { timeoutSec: 20, stallSec: 15, maxAttempts: 1 } },
      { id: 'other', role: 'tester', type: 'test', deps: [], budget: { timeoutSec: 20, stallSec: 15, maxAttempts: 1 } },
    ]);
    await Promise.race([s7a.run(), sleep(30000)]);

    const snapPath = path.join(ROOT7, 'rs', 'snapshot.json');
    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    snap.tasks = snap.tasks.filter((t) => t.id !== 'up').map((t) => ({ ...t, state: 'pending', outcome: null }));
    fs.writeFileSync(snapPath, JSON.stringify(snap));
    const s7b = new Scheduler({ runId: 'rs', root: ROOT7, worker: worker7, concurrency: 2, admission: () => true });
    const r7 = await Promise.race([s7b.load() && s7b.run(), sleep(40000).then(() => ({ hang: true }))]);
    const map7 = new Map((r7.tasks || []).map((t) => [t.id, t]));
    const st7 = (id) => (map7.get(id) ? map7.get(id).state + '/' + ((map7.get(id).outcome || {}).failureType || '-') : 'missing');
    check('上游消失的下游被 markUnresolvable 跳过', st7('down') === 'skipped/unknown', st7('down'));
    check('无悬空依赖的任务照常完成', st7('other') === 'done/-', st7('other'));
    check('续跑未 hang', !r7.hang);
    try { fs.rmSync(ROOT7, { recursive: true, force: true }); } catch {}
  }

  console.log('\n=== 场景9：闸门抛错时立即强制收场（不拿排队豁免）===');
  {
    const ROOT6 = path.join(os.tmpdir(), 'gateerr-' + Date.now());
    let probes = 0;
    const badGate = () => { probes++; throw new Error('闸门内部故障'); };
    const worker6 = async () => { await sleep(20); return { verdict: 'done' }; };
    const s6 = new Scheduler({
      runId: 'gateerr', root: ROOT6, worker: worker6, concurrency: 2, admission: badGate,
      gateGraceMs: 120000,
    });
    s6.init('gateerr', Array.from({ length: 4 }, (_, i) => ({
      id: 'e' + i, type: 'implement', deps: [], budget: { timeoutSec: 30, stallSec: 20, maxAttempts: 1 },
    })));
    const t6 = Date.now();
    const r6 = await Promise.race([s6.run(), sleep(40000).then(() => ({ hang: true }))]);
    const wall6 = Date.now() - t6;
    check('坏闸门未 hang', !r6.hang, `耗时 ${wall6}ms，闸门被咨询 ${probes} 次`);
    check('坏闸门不空转', probes < 500, `15s 内闸门探测 ${probes} 次（修复前 3996 次）`);
    check('坏闸门未被当成排队而白等 120s', wall6 < 30000, `耗时 ${wall6}ms`);
    check('任务未被静默算作完成', !(r6.tasks || []).some((t) => t.state === 'done'), (r6.tasks || []).map((t) => t.state).join(','));
    try { fs.rmSync(ROOT6, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (fail === 0 ? '写闸门真实链路验证通过 ✅' : `${fail} 项失败 ❌`));
  process.exit(fail ? 1 : 0);
})();
