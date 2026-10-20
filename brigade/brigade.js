'use strict';

const fs = require('fs');
const path = require('path');
const { makePlan } = require('./planner');
const { makePipeline } = require('./cp/pipeline');
const { ROLES } = require('./roles');
const { regRun, regHeartbeat, regUpdate, regUnregister } = require('./cp/brigade-redis');
const { checkCwd } = require('./cp/cwd-guard');

const RUNS_ROOT = process.env.BRIGADE_RUNS_ROOT || path.join(__dirname, 'runs');

const ROLE2TYPE = {
  explorer: 'explore', researcher: 'research', worker: 'implement',
  tester: 'test', reviewer: 'review', architect: 'implement', integrator: 'integrate',
};

function parseArgs(argv) {
  const o = {
    goal: null, cwd: process.cwd(), maxParallel: 3, timeoutSec: 900,
    maxRetries: 1, resume: null, list: false, hints: '', noReview: false, noTest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--goal') o.goal = argv[++i];
    else if (a === '--cwd') o.cwd = argv[++i];
    else if (a === '--max-parallel') o.maxParallel = Math.max(1, parseInt(argv[++i], 10) || 3);
    else if (a === '--timeout') o.timeoutSec = Math.min(7200, Math.max(60, parseInt(argv[++i], 10) || 900));
    else if (a === '--max-retries') o.maxRetries = Math.max(0, parseInt(argv[++i], 10) || 0);
    else if (a === '--resume') o.resume = argv[++i];
    else if (a === '--hints') o.hints = String(argv[++i] || '');
    else if (a === '--list') o.list = true;
    else if (a === '--no-review') o.noReview = true;
    else if (a === '--no-test') o.noTest = true;
    else if (!a.startsWith('--') && !o.goal) o.goal = a;
  }
  return o;
}

function log(...a) { console.log('[' + new Date().toISOString().slice(11, 19) + ']', ...a); }

function savePhase(runId, patch) {
  try {
    const dir = path.join(RUNS_ROOT, runId);
    fs.mkdirSync(dir, { recursive: true });
    const metaPath = path.join(dir, 'meta.json');
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) || {}; } catch {}

    const tmp = metaPath + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ ...meta, ...patch }, null, 2));
    fs.renameSync(tmp, metaPath);
  } catch (e) { log('⚠ 写运行元信息失败:', e.message); }
}

function listRunIds(root = RUNS_ROOT) {
  try {
    return fs.readdirSync(root)
      .filter((d) => /^\d{4}-\d{2}-\d{2}T/.test(d) && fs.statSync(path.join(root, d)).isDirectory())
      .sort()
      .reverse();
  } catch { return []; }
}

function sweep(keep = 40, shadowDays = 3, root = RUNS_ROOT) {
  try {
    const shadowRoot = path.join(root, 'shadow');
    const cutoff = Date.now() - shadowDays * 86400_000;
    const STALE_ACTIVE_MS = 3 * 86400_000;
    let swept = 0;
    if (fs.existsSync(shadowRoot)) {
      for (const d of fs.readdirSync(shadowRoot)) {
        const p = path.join(shadowRoot, d);
        try {
          if (fs.statSync(p).mtimeMs >= cutoff) continue;

          const rid = d.replace(/-p\d+$/, '');
          let meta = null;
          try { meta = JSON.parse(fs.readFileSync(path.join(root, rid, 'meta.json'), 'utf8')); } catch {}
          if (meta && (meta.phase === 'planning' || meta.phase === 'running')) {
            const anchor = Math.max(Date.parse(meta.startedAt) || 0, Date.parse(meta.resumedAt) || 0, fs.statSync(p).mtimeMs);
            if (Date.now() - anchor < STALE_ACTIVE_MS) continue;
          }
          fs.rmSync(p, { recursive: true, force: true }); swept++;
        } catch {}
      }
    }
    const ids = listRunIds(root);
    let pruned = 0;
    let skippedActive = 0;
    const INTERRUPTED_GRACE_MS = 7 * 86400_000;
    for (const id of ids.slice(keep)) {

      try {
        const meta = JSON.parse(fs.readFileSync(path.join(root, id, 'meta.json'), 'utf8'));
        if (meta.phase === 'planning' || meta.phase === 'running') {
          const st = fs.statSync(path.join(root, id));
          const anchor = Math.max(Date.parse(meta.startedAt) || 0, Date.parse(meta.resumedAt) || 0, st.mtimeMs);
          const age = Date.now() - anchor;
          if (age < STALE_ACTIVE_MS) { skippedActive++; continue; }
        }

        if (meta.phase === 'interrupted') {
          const st2 = fs.statSync(path.join(root, id));
          const anchor2 = Math.max(Date.parse(meta.interruptedAt) || 0, st2.mtimeMs);
          if (Date.now() - anchor2 < INTERRUPTED_GRACE_MS) { skippedActive++; continue; }
        }
      } catch (e) {
        if (e && e.code === 'ENOENT') {  }
        else { skippedActive++; continue; }
      }
      try { fs.rmSync(path.join(root, id), { recursive: true, force: true }); pruned++; } catch {}
    }
    const conflictRoot = path.join(root, 'conflicts');
    if (fs.existsSync(conflictRoot)) {
      for (const d of fs.readdirSync(conflictRoot)) {
        const p = path.join(conflictRoot, d);
        try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true }); } catch {}
      }
    }
    if (swept || pruned) log(`🧹 清理：${swept} 个过期影子子树，${pruned} 个超量历史运行${skippedActive ? `（跳过 ${skippedActive} 个疑似活跃）` : ''}`);
  } catch {}
}

function taskSpecsFromPlan(plan, o, extraHints) {
  return plan.tasks.map((t) => {
    const type = ROLE2TYPE[t.role] || 'implement';
    const hints = [t.web ? '（本任务允许联网调研）' : null, extraHints || null].filter(Boolean).join('\n') || undefined;
    return {
      id: t.id,
      name: t.id,
      type,
      role: t.role,
      title: t.title,
      deps: t.deps,
      input: { description: t.description, ...(hints ? { hints } : {}) },
      accept: t.accept,
      onUpstreamFail: (type === 'test' || type === 'review') ? 'skip' : undefined,
      budget: {
        timeoutSec: Math.max(120, o.timeoutSec),
        stallSec: Math.min(180, Math.max(60, Math.round(o.timeoutSec / 3))),
        maxAttempts: 3,
      },
    };
  });
}

function msOf(t) { return (t.outcome && t.outcome.ms) || (t.history && t.history.length && t.history[t.history.length-1].ms) || t.ms || 0; }

function reviewRejected(tasks) {
  return tasks.filter((t) =>
    (t.type === 'review' || t.role === 'reviewer') &&
    t.state === 'failed' &&
    t.outcome && t.outcome.failureType === 'acceptance_failed');
}

function buildSummary(goal, res, store, runId, msTotal, risks) {
  const lines = [];
  lines.push('# 军团工作流运行报告');
  lines.push('');
  lines.push(`- 目标：${goal}`);
  lines.push(`- runId：${runId}`);
  lines.push(`- 总耗时：${Math.round(msTotal / 1000)}s`);
  if (risks && risks.length) {
    lines.push('');
    lines.push('## 规划阶段识别的风险');
    risks.forEach((r) => lines.push('- ' + r));
  }
  lines.push('');
  lines.push('## 任务执行情况');
  lines.push('');
  lines.push('| 任务 | 角色 | 状态 | 尝试 | 审查 | 耗时 |');
  lines.push('|---|---|---|---|---|---|');
  for (const t of res.tasks) {
    const label = (ROLES[t.role] || {}).label || t.role || t.type;

    let verdictCol = '-';
    if (t.type === 'review' || t.role === 'reviewer') {
      if (t.state === 'done') verdictCol = 'PASS';
      else if (t.state === 'failed' && t.outcome && t.outcome.failureType === 'acceptance_failed') verdictCol = 'FAIL';
      else verdictCol = t.state;
    } else if (t.outcome && t.outcome.note) {
      verdictCol = String(t.outcome.note).slice(0, 60);
    } else if (t.outcome && t.outcome.failureType) {
      verdictCol = t.outcome.failureType;
    }
    lines.push(`| ${t.id} ${t.title} | ${label} | ${t.state} | ${t.attempts || 0} | ${verdictCol} | ${Math.round(msOf(t) / 1000)}s |`);
  }
  lines.push('');
  lines.push(`汇总：done=${res.done} failed=${res.failed} degraded=${res.degraded} skipped=${res.skipped} blocked=${res.blocked}`);
  lines.push('');
  for (const t of res.tasks) {
    let arts = [];
    try { arts = store.listArtifacts(runId, { taskId: t.id }); } catch {}
    if (!arts.length) continue;
    const a = arts.reduce((best, x) => ((Date.parse(x.ts) || 0) >= (Date.parse(best.ts) || 0) ? x : best), arts[0]);
    lines.push(`## ${t.id} · ${t.title}`);
    lines.push('');
    lines.push(String(a.body || '').slice(0, 1500));
    lines.push('');
  }
  return lines.join('\n');
}

async function runRound(runId, goal, specs, o, risks) {
  const pipe = makePipeline({ base: o.cwd, runRoot: RUNS_ROOT, runId, concurrency: o.maxParallel });
  const s = pipe.scheduler;
  const t0 = Date.now();
  try {
    s.init(goal, specs);
  } catch (e) {

    throw new Error('计划校验失败: ' + e.message);
  }

  savePhase(runId, { cwd: o.cwd, engine: 'opencode', phase: 'running', runId, pid: process.pid,
    retryOf: runId !== runId.split('-r')[0] ? runId.split('-r')[0] : undefined });
  log(`② 调度执行（${specs.length} 个任务，并发 ${o.maxParallel}）…`);
  const res = await s.run();
  const ms = Date.now() - t0;
  const sum = buildSummary(goal, res, s.store, runId, ms, risks);
  try { fs.mkdirSync(path.join(RUNS_ROOT, runId), { recursive: true }); fs.writeFileSync(path.join(RUNS_ROOT, runId, 'summary.md'), sum); } catch (e) { log('⚠ summary 写入失败:', e.message); }
  const failed = res.failed + res.blocked;
  savePhase(runId, { phase: failed ? 'failed' : 'done', finishedAt: new Date().toISOString() });
  log(`③ 本轮结束：done=${res.done} failed=${res.failed} degraded=${res.degraded} skipped=${res.skipped}（${Math.round(ms / 1000)}s）`);
  return { res, store: s.store, summaryText: sum };
}

module.exports = { sweep, listRunIds };

(async () => {
  if (require.main !== module) return;
  const o = parseArgs(process.argv.slice(2));
  if (!o.list) {
    const g = checkCwd(o.cwd);
    let st = null;
    try { st = g.ok ? fs.statSync(g.path) : null; } catch {}
    if (!g.ok || !st || !st.isDirectory()) {
      console.error(`非法 cwd: ${o.cwd}${g.ok ? '（不存在或不是目录）' : '（' + g.reason + '）'}`);
      process.exit(2);
    }
    o.cwd = g.path;
  }
  sweep();

  if (o.list) {
    const ids = listRunIds();
    if (!ids.length) return console.log('（没有历史运行）');
    console.log('军团历史运行（最新在前，最多 20 条）：');
    for (const id of ids.slice(0, 20)) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(RUNS_ROOT, id, 'meta.json'), 'utf8'));
        let counts = '（无快照）';
        try {
          const snap = JSON.parse(fs.readFileSync(path.join(RUNS_ROOT, id, 'snapshot.json'), 'utf8'));
          const done = (snap.tasks || []).filter((t) => t.state === 'done').length;
          counts = `${done}/${(snap.tasks || []).length}`;
        } catch {}
        console.log(`  ${id}  [${meta.phase || '?'}] ${counts}  ${String(meta.goal || '').slice(0, 60)}`);
      } catch { console.log(`  ${id}  (元信息不可读)`); }
    }
    return;
  }

  fs.mkdirSync(RUNS_ROOT, { recursive: true });

  if (o.resume) {

    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(o.resume) || o.resume.includes('..')) {
      console.error('非法的 runId: ' + o.resume); process.exit(1);
    }
    const runId = o.resume;
    const snapPath = path.join(RUNS_ROOT, runId, 'snapshot.json');
    if (!fs.existsSync(snapPath)) { console.error('找不到该运行的快照: ' + runId); process.exit(1); }

    const metaPre = (() => { try { return JSON.parse(fs.readFileSync(path.join(RUNS_ROOT, runId, 'meta.json'), 'utf8')); } catch { return null; } })() || {};
    if (metaPre.pid && /^\d+$/.test(String(metaPre.pid))) {
      let alive = false;
      try { process.kill(metaPre.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
      if (alive && metaPre.phase !== 'interrupted' && metaPre.pid !== String(process.pid)) {
        console.error(`原运行进程 ${metaPre.pid} 还活着（phase=${metaPre.phase}）——拒绝双活 resume。确属误判请先结束该进程或等其退出。`);
        process.exit(1);
      }
    }
    if (metaPre.cwd && path.resolve(metaPre.cwd) !== path.resolve(o.cwd)) {
      console.error(`--cwd(${o.cwd}) 与该运行记录的原始目录(${metaPre.cwd})不一致——拒绝续跑（防写错仓库）。`);
      process.exit(1);
    }
    const pipe = makePipeline({ base: o.cwd, runRoot: RUNS_ROOT, runId, concurrency: o.maxParallel });
    const s = pipe.scheduler;
    const tasks = s.load();
    let reset = 0;
    for (const t of tasks) {
      if (t.state === 'running' || t.state === 'leased') { s.transit(t, 'pending', { leasedBy: null, leaseUntil: 0 }); reset++; }
    }
    const meta0 = s.store.loadMeta(runId) || {};
    log(`续跑 ${runId}：${tasks.length} 个任务，重置 ${reset} 个中断任务`);
    savePhase(runId, { phase: 'running', resumedAt: new Date().toISOString(), pid: process.pid });
    const liveRec = { runId, goal: meta0.goal || '(续跑)', cwd: o.cwd, phase: 'running', pid: process.pid, startedAt: new Date().toISOString() };
    regRun({ ...liveRec });
    const hb = setInterval(() => regHeartbeat({ ...liveRec }), 60_000); hb.unref();

    const resumeMark = async (phase) => {

      if (phase === 'interrupted') {
        try {
          const cur = JSON.parse(fs.readFileSync(path.join(RUNS_ROOT, runId, 'meta.json'), 'utf8'));
          if (cur.phase !== 'planning' && cur.phase !== 'running') { await regUnregister(runId); return; }
        } catch {}
      }
      try { savePhase(runId, { phase, interruptedAt: phase === 'interrupted' ? new Date().toISOString() : undefined }); } catch {}
      if (phase === 'interrupted') await regUpdate(runId, { phase: 'interrupted' });
      await regUnregister(runId);
    };
    process.on('uncaughtException', async (e) => { log('✗ 未捕获异常:', e && e.message); await resumeMark('interrupted'); process.exit(1); });
    process.on('unhandledRejection', async (e) => { log('✗ 未处理的 Promise 拒绝:', (e && e.message) || e); await resumeMark('interrupted'); process.exit(1); });
    const t0 = Date.now();
    const res = await s.run();
    const sum = buildSummary(meta0.goal || '(未知目标)', res, s.store, runId, Date.now() - t0, null);

    try { fs.writeFileSync(snapPath.replace('snapshot.json', 'summary.md'), sum); }
    catch (e) { log('⚠ summary 写入失败（任务结果仍在 snapshot/artifacts）:', e.message); }
    const failed = res.failed + res.blocked;
    savePhase(runId, { phase: failed ? 'failed' : 'done', finishedAt: new Date().toISOString() });
    clearInterval(hb);
    await resumeMark(failed ? 'failed' : 'done');
    console.log('\n' + sum.slice(0, 2000));
    console.log(`\n[brigade] 报告: ${path.join(RUNS_ROOT, runId, 'summary.md')}`);
    process.exit(failed ? 1 : 0);
  }

  if (!o.goal) {
    console.log('用法: node brigade.js --goal "目标" [--cwd 目录] [--max-parallel 3] [--timeout 900] [--hints ...] [--resume <runId>]');
    console.log('      node brigade.js --list');
    process.exit(1);
  }

  const baseId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23) + '-' + process.pid;
  const activeRunIds = [baseId];
  savePhase(baseId, { goal: o.goal, cwd: o.cwd, phase: 'planning', startedAt: new Date().toISOString(), pid: process.pid });

  const liveRec = { runId: baseId, goal: o.goal, cwd: o.cwd, phase: 'planning', pid: process.pid, startedAt: new Date().toISOString() };
  regRun({ ...liveRec });
  const hbTimer = setInterval(() => regHeartbeat({ ...liveRec, runId: activeRunIds[activeRunIds.length - 1] }), 60_000);
  hbTimer.unref();

  const regPhase = async (phase) => { liveRec.phase = phase; await regUpdate(activeRunIds[activeRunIds.length - 1], { phase }); };

  const markInterrupted = async () => {
    for (const id of activeRunIds) {
      let wasActive = false;
      try {
        const metaPath = path.join(RUNS_ROOT, id, 'meta.json');
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        wasActive = meta.phase === 'planning' || meta.phase === 'running';
        if (wasActive) savePhase(id, { phase: 'interrupted', interruptedAt: new Date().toISOString() });
      } catch {}
      if (wasActive) await regUpdate(id, { phase: 'interrupted', endedAt: new Date().toISOString() });
      await regUnregister(id);
    }
  };
  process.on('exit', () => {  });
  process.on('uncaughtException', async (e) => {
    log('✗ 未捕获异常:', e && e.message);
    await markInterrupted();
    process.exit(1);
  });
  process.on('unhandledRejection', async (e) => {
    log('✗ 未处理的 Promise 拒绝:', (e && e.message) || e);
    await markInterrupted();
    process.exit(1);
  });

  log(`① 架构师拆解目标…（runId=${baseId}）`);
  const { plan, plannerError } = await makePlan(o.goal, { cwd: o.cwd, hints: o.hints, includeReview: !o.noReview, includeTest: !o.noTest });
  if (plannerError) log('   计划解析问题（已用兜底流水线）: ' + plannerError);
  log(`   计划: ${plan.tasks.length} 个任务 — ` + plan.tasks.map((t) => `${t.id}:${t.role}`).join(' '));

  let runId = baseId;
  let specs = taskSpecsFromPlan(plan, o);
  let out = await runRound(runId, o.goal, specs, o, plan.risks);
  await regPhase(out.res.failed + out.res.blocked ? 'failed' : 'done');
  for (let round = 2; round <= o.maxRetries + 1; round++) {
    const rejected = reviewRejected(out.res.tasks);
    if (!rejected.length) break;

    const fb = rejected.map((t) => {
      let arts = [];
      try { arts = out.store.listArtifacts(runId, { taskId: t.id }); } catch {}
      const body = arts.length ? String(arts[arts.length - 1].body || '').slice(0, 1200) : (t.outcome && t.outcome.note) || '';
      return `【${t.id} ${t.title} 的审查意见（上一轮未通过，本轮必须修复）】\n${body}`;
    }).join('\n\n');
    log(`⚠ 审查未通过（${rejected.map((t) => t.id).join(',')}），发起第 ${round} 轮重做`);
    runId = `${baseId}-r${round}`;
    activeRunIds.push(runId);
    savePhase(runId, { goal: o.goal, cwd: o.cwd, phase: 'planning', startedAt: new Date().toISOString(), retryOf: baseId, pid: process.pid });
    await regPhase('planning');
    specs = taskSpecsFromPlan(plan, o, fb);
    out = await runRound(runId, o.goal, specs, o, plan.risks);
    await regPhase(out.res.failed + out.res.blocked ? 'failed' : 'done');
  }

  console.log('\n' + out.summaryText.slice(0, 3000));
  console.log(`\n[brigade] runId=${runId}  报告: ${path.join(RUNS_ROOT, runId, 'summary.md')}`);
  const failedTotal = out.res.failed + out.res.blocked;
  if (failedTotal) console.log(`[brigade] 有 ${failedTotal} 个任务未通过，续跑: node brigade.js --resume ${runId} --cwd "${o.cwd}"`);
  clearInterval(hbTimer);

  await markInterrupted();
  process.exit(failedTotal ? 1 : 0);
})();
