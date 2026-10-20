'use strict';

const { isWindowsReservedName } = require('./store');

const STATES = ['pending', 'leased', 'running', 'done', 'failed', 'degraded', 'skipped', 'blocked'];

const FAILURE_TYPES = [

  'requirement_ambiguous',
  'scope_miss',

  'tool_miss',
  'format_violation',
  'premise_mismatch',

  'acceptance_failed',
  'gate_fail',
  'premature_stop',
  'untestable',

  'timeout',
  'stalled',
  'exec_blocked',
  'dependency_missing',
  'external_unavailable',
  'crash',
  'upstream_failed',
  'circuit_open',
  'lease_expired',
  'unknown',
];

const TRANSITIONS = {
  pending: ['leased', 'skipped', 'blocked', 'degraded'],
  leased: ['running', 'pending', 'blocked', 'leased'],
  running: ['done', 'failed', 'pending', 'degraded', 'blocked'],
  blocked: ['pending', 'skipped', 'degraded'],
  failed: ['pending', 'degraded', 'skipped'],
  done: [],
  degraded: [],
  skipped: [],
};

const isTerminal = (s) => s === 'failed' || (TRANSITIONS[s] || []).length === 0;
const TERMINAL = new Set(STATES.filter(isTerminal));

const VALID_ROLES = new Set(['architect', 'explorer', 'worker', 'tester', 'reviewer', 'researcher', 'integrator']);

const TASK_TYPES = {
  explore:  { label: '勘察',   parallel: true,  effort: 'medium', writable: false, hint: '只读摸清现状，产出文件/符号清单' },
  research: { label: '调研',   parallel: true,  effort: 'medium', writable: false, hint: '联网取证，产出带 URL 的结论' },
  plan:     { label: '设计',   parallel: false, effort: 'high',   writable: false, hint: '产出方案/步骤，通常独占' },
  implement:{ label: '实现',   parallel: true,  effort: 'high',   writable: true,  hint: '改代码，需独占文件/worktree' },
  test:     { label: '测试',   parallel: true,  effort: 'medium', writable: true,  hint: '真跑命令验证，产出真实输出' },
  review:   { label: '审查',   parallel: true,  effort: 'medium', writable: false, hint: '只读审查，给 PASS/FAIL' },
  integrate:{ label: '集成',   parallel: false, effort: 'high',   writable: true,  hint: '合并/收尾，独占且最后' },
  dep:      { label: '依赖',   parallel: true,  effort: 'low',    writable: true,  hint: '装依赖/环境准备' },
  docs:     { label: '文档',   parallel: true,  effort: 'low',    writable: true,  hint: '写说明/README' },
};
const DEFAULT_TYPE = 'implement';

const NON_RETRYABLE = new Set(['format_violation', 'tool_miss', 'gate_fail', 'blocked', 'acceptance_failed']);

function backoffDelay(attempt, baseMs = 2000, capMs = 128000) {
  const raw = Math.min(capMs, baseMs * Math.pow(2, attempt - 1));
  return Math.floor(raw * (0.5 + Math.random() * 0.5));
}

function makeTask(spec) {
  if (!spec.id) throw new Error('task 缺 id');

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(spec.id))) {
    throw new Error(`task id 非法字符: "${spec.id}"（只允许字母数字._-）`);
  }

  if (isWindowsReservedName(spec.id)) {
    throw new Error(`task id 是 Windows 保留设备名: "${spec.id}"（影子目录会落到设备）`);
  }
  if (!spec.type) throw new Error(`task ${spec.id} 缺 type`);

  if (!TASK_TYPES[spec.type]) {
    throw new Error(`task ${spec.id} 未知 type="${spec.type}"（合法：${Object.keys(TASK_TYPES).join('/')}）`);
  }
  if (spec.role != null && !VALID_ROLES.has(spec.role)) {
    throw new Error(`task ${spec.id} 未知 role="${spec.role}"（合法：${[...VALID_ROLES].join('/')}）`);
  }
  const deps = (Array.isArray(spec.deps) ? spec.deps : []).map((d) => String(d).trim()).filter(Boolean);
  if (deps.includes(String(spec.id))) throw new Error(`task ${spec.id} 自依赖`);
  return {
    id: String(spec.id),
    type: spec.type,
    role: spec.role || null,
    title: spec.title || spec.id,
    input: spec.input || {},
    accept: Array.isArray(spec.accept) ? spec.accept : [],
    deps: [...new Set(deps)],
    budget: {
      timeoutSec: spec.budget?.timeoutSec ?? 600,
      maxAttempts: Math.max(1, spec.budget?.maxAttempts ?? 1),
      stallSec: Math.min(spec.budget?.stallSec ?? 120, spec.budget?.timeoutSec ?? 600),

      backoffMs: (() => {
        const v = spec.budget?.backoffMs;
        return (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : 5000;
      })(),
    },
    allowRework: !!spec.allowRework,

    onUpstreamFail: (spec.onUpstreamFail === undefined || spec.onUpstreamFail === 'degraded') ? 'degraded' : (spec.onUpstreamFail === 'skip' ? 'skip' : (() => { throw new Error(`task ${spec.id} 非法 onUpstreamFail: "${spec.onUpstreamFail}"（合法：skip|degraded）`); })()),
    epoch: 0,
    state: 'pending',
    attempts: 0,
    attemptId: 0,
    leasedBy: null,
    leaseUntil: 0,
    lastHeartbeat: 0,
    startedAt: 0,
    notBefore: 0,
    priority: 0,
    degradedVia: null,
    taintFrom: [],
    name: (typeof spec.name === 'string' && spec.name.trim()) || null,
    outcome: null,
    history: [],
  };
}

const HISTORY_MAX = 20;

function validatePlan(tasks) {
  const seen = new Map();
  for (const t of tasks) {
    if (!t.name) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(t.name)) {
      throw new Error(`task ${t.id} 的 name 非法："${t.name}"（只允许字母数字 . _ -，最长 64）`);
    }
    if (seen.has(t.name)) throw new Error(`任务名重复："${t.name}"（${seen.get(t.name)} 与 ${t.id}）`);
    seen.set(t.name, t.id);
  }
  return validatePlanCore(tasks);
}

function validatePlanCore(tasks) {
  const ids = new Set();
  for (const t of tasks) {
    if (ids.has(t.id)) throw new Error(`重复任务 id: ${t.id}`);
    ids.add(t.id);
  }

  for (const t of tasks) {
    if (t.deps !== undefined && !Array.isArray(t.deps)) {
      throw new Error(`任务 ${t.id} 的 deps 必须是数组，实际是 ${typeof t.deps}（deps 类型错会让运行期的依赖判定静默失效）`);
    }
  }

  for (const t of tasks) { if (t.deps === undefined) t.deps = []; }
  for (const t of tasks) {
    for (const d of t.deps) if (!ids.has(d)) throw new Error(`任务 ${t.id} 依赖不存在: ${d}`);
  }

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const color = new Map();
  const stack = [];
  const visit = (id) => {
    const c = color.get(id) || 0;
    if (c === 2) return;
    if (c === 1) throw new Error(`依赖成环: ${stack.slice(stack.indexOf(id)).join(' -> ')} -> ${id}`);
    color.set(id, 1);
    stack.push(id);
    for (const d of byId.get(id).deps) visit(d);
    stack.pop();
    color.set(id, 2);
  };
  for (const t of tasks) visit(t.id);
  return true;
}

function canTransit(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

function depsSatisfied(task, byId) {
  for (const d of task.deps) {
    const s = byId.get(d);
    if (!s) return false;
    if (s.state === 'done' || s.state === 'degraded') continue;
    return false;
  }
  return true;
}

function depsHardFailed(task, byId) {
  for (const d of task.deps) {
    const s = byId.get(d);
    if (s && (s.state === 'failed' || s.state === 'skipped' || s.state === 'blocked')) return s;
  }
  return null;
}

function depsUnresolvable(task, byId) {
  for (const d of task.deps) if (!byId.has(d)) return d;
  return null;
}

function effectiveBudget(task) {
  const b = (task && task.budget) || {};
  const adv = (task && task._adv) || {};
  return {
    timeoutSec: Math.max(b.timeoutSec || 300, adv.timeoutSec || 0),
    stallSec: Math.max(b.stallSec || 120, adv.stallSec || 0),
  };
}

function shouldRetry(task, budgetLeft = Infinity, now = Date.now()) {
  if (!task) return false;
  if (budgetLeft <= 0) return false;
  if (task.attempts >= task.budget.maxAttempts) return false;
  if (task.outcome && task.outcome.failureType && !isRetryable(task.outcome.failureType)) return false;
  if (task.notBefore && task.notBefore > now) return false;
  return true;
}

function canRework(task) {
  if (!task.allowRework) return false;
  if (task.attempts >= task.budget.maxAttempts) return false;
  if (task.outcome && task.outcome.failureType && !isRetryable(task.outcome.failureType)) return false;
  return true;
}

function pushHistory(task, rec) {
  task.history.push(rec);
  if (task.history.length > HISTORY_MAX) task.history.shift();
}

function isSettled(task, now = Date.now()) {
  if (task.state === 'done' || task.state === 'degraded' || task.state === 'skipped') return true;
  if (task.state === 'failed') {
    if (canRework(task)) return false;
    if (task.notBefore && task.notBefore > now) return false;
    return true;
  }
  return false;
}

module.exports = {
  STATES, TERMINAL, FAILURE_TYPES, TRANSITIONS, VALID_ROLES, HISTORY_MAX, NON_RETRYABLE, TASK_TYPES, DEFAULT_TYPE,
  makeTask, canTransit, isSettled, shouldRetry, validatePlan, depsSatisfied, depsHardFailed, depsUnresolvable, canRework, pushHistory, effectiveBudget,
  backoffDelay, isRetryable, typeMeta,
};

function typeMeta(type) {
  return TASK_TYPES[type] || TASK_TYPES[DEFAULT_TYPE];
}

function isRetryable(failureType) {
  return !NON_RETRYABLE.has(failureType);
}
