'use strict';

const { Command, flattenSquads, syncSquads, makeWriteGate } = require('./hierarchy');
const { makePipeline } = require('./pipeline');

function makeSquadExecutor(o = {}) {
  if (!o.base) throw new Error('makeSquadExecutor 缺 base');
  if (typeof o.exec !== 'function') throw new Error('makeSquadExecutor 缺 exec（叶节点执行器）');

  const decompose = o.decompose || ((step) => ([{
    id: 'only',
    type: 'implement',
    deps: [],
    description: step.description || step.name || step.title || '(无描述)',
  }]));
  const concurrency = o.concurrency ?? 4;
  let seq = 0;

  return async function squadExecutor({ task: step, goal, round, gaps }) {
    const subs = decompose(step, gaps) || [];
    if (!subs.length) return { ok: false, summary: '步骤没有可分解的任务', artifacts: [] };

    const stepId = step.id || step.workId || ('s' + (++seq));
    const cardId = 'c-' + String(stepId).replace(/[^\w.-]/g, '_');
    const cmd = new Command({
      difficulty: o.difficulty || 'moderate',
      globalConcurrency: concurrency,
      writeSquadGate: o.writeSquadGate ?? 1,
    });
    cmd.goal = step.name || step.title || goal || '';

    cmd.deploy(cmd.goal || step.name || cardId, [{
      id: cardId, title: step.name || stepId, goal: step.description || cmd.goal,
      difficulty: o.difficulty || 'moderate',
      mode: o.mode || (subs.some((s) => (s.deps || []).length) ? 'pipeline' : 'parallel'),
    }], () => subs.map((s, i) => ({
      id: String(s.id || ('t' + i)),
      type: s.type || 'implement',
      role: s.role,
      deps: Array.isArray(s.deps) ? s.deps : [],
      budget: s.budget || { timeoutSec: 600, stallSec: 240, maxAttempts: 1 },
      input: { description: s.description || s.name || '(无描述)' },
    })));

    const holder = {};
    const worker = async (args) => {
      const cwd = holder.workspace ? holder.workspace.cwdFor(args.task) : o.base;
      return o.exec({ ...args, cwd, workspace: holder.workspace, squadId: cardId });
    };

    const runId = `${o.runIdPrefix || 'sqex'}-${cardId}-${round ?? 0}-${++seq}`;
    const pipe = makePipeline({
      base: o.base, runRoot: o.runRoot, runId, concurrency,
      worker,
      onProgress: (ts) => syncSquads(cmd, ts),
      admission: makeWriteGate(cmd),
    });
    holder.workspace = pipe.workspace;

    pipe.scheduler.init(cmd.goal, flattenSquads(cmd));
    const res = await pipe.scheduler.run();
    const tasks = res.tasks || [];
    const done = tasks.filter((t) => t.state === 'done');
    const degraded = tasks.filter((t) => t.state === 'degraded');
    const failed = tasks.filter((t) => t.state === 'failed');
    const st = cmd.status();

    const ok = tasks.length > 0 && done.length === tasks.length;
    const lines = [
      `小队 ${cardId}（${subs.length} 个任务）收场：完成 ${done.length}，降级 ${degraded.length}，失败 ${failed.length}`,
      `小队进度 ${st.progress}%（完工 ${st.done} / 进行 ${st.active} / 受阻 ${st.blocked}）`,
    ];
    if (!ok) {
      const notDone = tasks.filter((t) => t.state !== 'done')
        .map((t) => `${t.id}:${t.state}${t.outcome && t.outcome.failureType ? '(' + t.outcome.failureType + ')' : ''}`);
      lines.push('未完成任务：' + (notDone.join('、') || '无'));
    }

    return {
      ok,
      summary: lines.join(' | '),
      artifacts: [],
      squad: { id: cardId, progress: st.progress, total: tasks.length, done: done.length },
      isolation: pipe.isolationStats(),
    };
  };
}

module.exports = { makeSquadExecutor };
