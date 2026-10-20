'use strict';

const { runSubagent } = require('./subagent');
const { buildTask } = require('./roles');
const { isWindowsReservedName } = require('./cp/store');

const PLAN_SCHEMA_HINT = `输出格式（严格只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块以外的其它内容）：
{
  "risks": ["主要风险，0-3 条"],
  "tasks": [
    {
      "id": "t1",
      "title": "短标题",
      "role": "explorer|researcher|worker|tester|reviewer",
      "deps": ["其它任务 id，没有就空数组"],
      "description": "这个任务要做什么，写给执行者看的完整说明（自包含）",
      "accept": ["可验证的验收标准 1", "验收标准 2"],
      "web": false
    }
  ]
}
规则：
- id 用 t1 t2 t3…；deps 只能引用已存在的 id；必须无环
- 先勘察(explorer)/调研(researcher)，再实现(worker)，再测试(tester)，最后审查(reviewer)
- 任务数量：简单目标 2-4 个，复杂目标最多 8 个；每个任务都要能被一个人/一个会话独立完成
- description 里要写清涉及的文件或目录（如果已知）`;

function buildPlanPrompt(goal, opts) {
  const lines = [];
  lines.push('# 你是团队架构师');
  lines.push('');
  lines.push('把下面的目标拆成可执行的工程任务 DAG。不要写任何代码。');
  lines.push('');
  lines.push('## 目标');
  lines.push('```');
  lines.push(goal);
  lines.push('```');
  lines.push('');
  lines.push('## 工作区');
  lines.push('- 项目目录：' + opts.cwd);
  if (opts.hints) {
    lines.push('- 已知信息：' + opts.hints);
  }
  if (opts.includeReview !== false) {
    lines.push('- 必须包含一个 reviewer 任务做最终审查，deps 指向所有实现类任务。');
  }
  if (opts.includeTest !== false) {
    lines.push('- 必须包含一个 tester 任务真跑验证命令。');
  }
  lines.push('');
  lines.push(PLAN_SCHEMA_HINT);
  return lines.join('\n');
}

function extractJson(text) {
  if (!text) return null;
  const attempts = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) attempts.push(fence[1]);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) attempts.push(text.slice(first, last + 1));
  attempts.push(text);
  for (const a of attempts) {
    try {
      const cleaned = a.replace(/,\s*([}\]])/g, '$1');
      const j = JSON.parse(cleaned);
      if (j && (Array.isArray(j.tasks) || Array.isArray(j))) return j;
    } catch {}
  }
  return null;
}

function normalizePlanSafe(plan) {

  let i = 0;
  const seen = new Set();
  const idMap = new Map();
  for (const t of (plan && plan.tasks) || []) {
    if (!t) continue;
    i++;
    const orig = String(t.id || '');

    if (!t.id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(orig) || seen.has(orig)
        || isWindowsReservedName(orig)) {
      let nid = 'task' + i;
      while (seen.has(nid)) nid += 'x';
      t.id = nid;
      if (orig) idMap.set(orig, nid);
    }
    seen.add(String(t.id));
  }
  for (const t of (plan && plan.tasks) || []) {
    if (t && Array.isArray(t.deps)) {
      t.deps = t.deps
        .map((d) => idMap.get(String(d)) || String(d))
        .filter((d) => seen.has(d));
    }
  }
  return plan;
}
function normalizePlan(parsed, goal) {
  let tasks = [];
  let risks = [];
  if (Array.isArray(parsed)) tasks = parsed;
  else if (parsed && Array.isArray(parsed.tasks)) {
    tasks = parsed.tasks;
    risks = Array.isArray(parsed.risks) ? parsed.risks : [];
  }
  const VALID = new Set(['architect', 'explorer', 'worker', 'tester', 'reviewer', 'researcher']);
  const out = [];
  const seen = new Set();
  for (const raw of tasks.slice(0, 12)) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id || '').trim() || 't' + (out.length + 1);
    if (seen.has(id)) continue;
    seen.add(id);
    let role = String(raw.role || '').trim().toLowerCase();
    if (!VALID.has(role)) role = 'worker';
    const deps = (Array.isArray(raw.deps) ? raw.deps : []).map(String).filter((d) => d !== id);
    out.push({
      id,
      title: String(raw.title || id).slice(0, 120),
      role,
      deps,
      description: String(raw.description || raw.title || '').slice(0, 4000),
      accept: (Array.isArray(raw.accept) ? raw.accept : []).map(String).slice(0, 8),
      web: !!raw.web,
    });
  }

  const ids = new Set(out.map((t) => t.id));
  for (const t of out) t.deps = t.deps.filter((d) => ids.has(d));
  const color = new Map();
  const byId = new Map(out.map((t) => [t.id, t]));
  const visit = (id, stack) => {
    if (color.get(id) === 2) return;
    if (color.get(id) === 1) {
      for (const t of out) t.deps = t.deps.filter((d) => d !== id);
      color.set(id, 2);
      return;
    }
    color.set(id, 1);
    for (const d of byId.get(id).deps) visit(d, stack);
    color.set(id, 2);
  };
  for (const t of out) visit(t.id);
  return { goal, risks, tasks: out };
}

function fallbackPlan(goal) {

  return normalizePlan(
    {
      risks: ['计划器未产出结构化计划，使用默认流水线兜底'],
      tasks: [
        { id: 't1', title: '勘察项目现状', role: 'explorer', deps: [], description: '勘察 ' + goal + ' 相关的代码结构、现有模式、可复用模块，给出实现切入点建议。', accept: ['列出相关文件与符号', '给出实现切入点'] },
        { id: 't2', title: '实现目标', role: 'worker', deps: ['t1'], description: '基于勘察结果实现：' + goal, accept: ['功能可用', '改动最小化'] },
        { id: 't3', title: '运行真实验证', role: 'tester', deps: ['t2'], description: '运行项目真实测试/检查命令，报告真实结果。', accept: ['贴出真实命令与输出'] },
        { id: 't4', title: '最终审查', role: 'reviewer', deps: ['t3'], description: '审查本次全部改动，给出 PASS/FAIL。', accept: ['明确结论'] },
      ],
    },
    goal
  );
}

async function makePlan(goal, { cwd, hints, effort = 'high', timeoutSec = 600, includeReview, includeTest } = {}) {

  const prompt = buildPlanPrompt(goal, { cwd, hints, includeReview, includeTest });
  const r = await runSubagent({ task: prompt, cwd, timeoutSec, isShadow: false });
  if (!r.ok) return { plan: fallbackPlan(goal), plannerError: r.text };
  const parsed = extractJson(r.text);
  if (!parsed) return { plan: fallbackPlan(goal), plannerError: '未解析出 JSON' };
  const plan = normalizePlanSafe(normalizePlan(parsed, goal));
  if (!plan.tasks.length) return { plan: fallbackPlan(goal), plannerError: '任务列表为空' };
  return { plan, plannerRaw: r.text };
}

module.exports = { makePlan, extractJson, normalizePlan, normalizePlanSafe, fallbackPlan, buildPlanPrompt };
