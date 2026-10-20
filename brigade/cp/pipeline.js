'use strict';

const fs = require('fs');
const path = require('path');
const { Scheduler } = require('./scheduler');
const { makeCodexExecutor } = require('./executor-codex');
const { Workspace } = require('./workspace');
const { createObservability, STAGE } = require('./observability');

function makePipeline(o = {}) {
  if (!o.base) throw new Error('makePipeline 缺 base（共享工作区目录）');
  const runRoot = o.runRoot || path.join(__dirname, '..', 'runs');
  const useIsolation = o.isolation !== false;

  const workspace = useIsolation
    ? new Workspace({
        base: o.base, runRoot,
        runId: o.runId,
        exclusiveReads: !!o.exclusiveReads,
        strictIsolation: !!o.strictIsolation,
        onEscape: o.onEscape,
      })
    : null;

  const rawWorker = o.worker || makeCodexExecutor({ workspace, cwd: o.base });
  const worker = async (args) => {

    const args2 = workspace
      ? { ...args, workspace, cwd: await workspace.allocate(args.task, { onTick: args.heartbeat }) }
      : args;
    const out = await rawWorker(args2);

    if (workspace && workspace.isWriter(args.task)) {
      const verdict = out && (out.verdict || (out.ok ? 'done' : 'fail'));
      if (verdict !== 'done' && verdict !== 'PASS') {
        const stranded = workspace.stranded(args.task);
        if (stranded.length) {
          const msg = `⚠ ${args.task.id} 未完成（${verdict}），但影子目录里已产出 ${stranded.length} 个文件未发布到 base：${stranded.slice(0, 5).join(', ')}${stranded.length > 5 ? ' …' : ''}`;
          workspace.stats.stranded += stranded.length;
          try { obs.bus.emit({ kind: 'stranded', id: args.task.id, files: stranded, summary: msg }); } catch {}
          if (typeof console !== 'undefined') console.error('[搁浅产出] ' + msg);
        }
      }
    }
    return out;
  };

  const scheduler = new Scheduler({
    runId: o.runId || 'run-' + Date.now().toString(36),
    root: runRoot,
    worker,
    concurrency: o.concurrency ?? 4,

    admission: workspace
      ? workspace.gate(o.admission || workspace.defaultWriteGate())
      : o.admission,
    onProgress: o.onProgress,
    workspaceConflictPolicy: o.workspaceConflictPolicy,
    onPublish: workspace ? (t) => workspace.publish(t) : null,
  });

  const progressFile = o.progressFile || path.join(runRoot, `${scheduler.runId}.progress.jsonl`);

  let obs;
  let progressDegraded = false;
  try {
    obs = createObservability({ logFile: progressFile, onEvent: o.onEvent });
  } catch (e) {
    progressDegraded = true;
    console.error(`[pipeline] 进度日志初始化失败，降级为内存观测: ${e && e.message}`);
    obs = createObservability({ onEvent: o.onEvent });
  }

  const transcriptDir = path.join(path.dirname(progressFile), 'transcripts');
  const nameById = new Map();
  {

    const prev = scheduler.onProgress;
    scheduler.onProgress = (tasks) => {
      try { for (const t of tasks) if (t && t.name) nameById.set(t.id, t.name); } catch {}
      if (prev) { try { prev(tasks); } catch {} }
    };
  }
  try {
    obs.bus.on((evt) => {
      if (!evt || !evt.id) return;
      const nm = nameById.get(evt.id);
      if (!nm) return;
      try {
        fs.mkdirSync(transcriptDir, { recursive: true });
        fs.appendFileSync(path.join(transcriptDir, nm + '.jsonl'),

          JSON.stringify({ ts: evt.ts || Date.now(), ...evt, agent: nm }) + String.fromCharCode(10));
      } catch {  }
    });
  } catch {  }
  wireObservability(scheduler, obs, scheduler.runId);

  return {
    scheduler, workspace, worker, runRoot, base: o.base, obs, progressFile,

    isolationStats: () => (workspace ? workspace.stats : null),

    capabilities: () => ({
      runId: scheduler.runId,
      读写隔离: !!workspace,
      严格隔离: !!(workspace && workspace.strictIsolation),
      读者排斥写者: !!(workspace && workspace.exclusiveReads),
      写并发闸门: workspace ? workspace.stats : null,
      逃逸次数: workspace ? workspace.stats.escapes : 0,
      冲突未落地: workspace ? workspace.stats.conflicts : null,
      发布失败: workspace ? workspace.stats.publishFailures : null,
      准入闸门: typeof scheduler.admission === 'function' ? '已接' : '无',
      进度日志: progressFile,
      进度降级: progressDegraded,
    }),
  };
}

function wireObservability(scheduler, obs, runId) {
  const lastState = new Map();
  const started = new Set();
  const beatTimers = new Map();

  const prevProgress = scheduler.onProgress;
  scheduler.onProgress = (tasks) => {
    if (prevProgress) { try { prevProgress(tasks); } catch {} }
    for (const t of tasks) {
      const prev = lastState.get(t.id);
      if (prev === t.state) continue;
      lastState.set(t.id, t.state);

      if ((t.state === 'running' || t.state === 'leased') && !started.has(t.id)) {

        started.add(t.id);
        obs.start(t.id, { title: t.title, stage: STAGE.EXECUTING, role: t.role, type: t.type, runId });
        if (!beatTimers.has(t.id)) {
          beatTimers.set(t.id, setInterval(() => {
            try { obs.beat(t.id, (t.type || '') + ' 执行中'); } catch {}
          }, 20000));
        }
      } else if (t.state === 'done' || t.state === 'failed' || t.state === 'degraded' || t.state === 'skipped') {
        const timer = beatTimers.get(t.id);
        if (timer) { clearInterval(timer); beatTimers.delete(t.id); }

        try { obs.stage(t.id, STAGE.VERIFYING, t.state); } catch {}

        obs.finish(t.id, {
          ok: t.state === 'done',
          summary: (t.outcome && t.outcome.note) || t.state +
            (t.outcome && t.outcome.failureType ? '(' + t.outcome.failureType + ')' : ''),
        });
      }
    }
  };
  return obs;
}

module.exports = { makePipeline };
