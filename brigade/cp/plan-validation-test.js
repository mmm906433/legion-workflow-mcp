'use strict';

const { makeTask, validatePlan } = require('./task');

let fails = 0;
const check = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${x ? '  — ' + x : ''}`); if (!c) fails++; };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

console.log('=== 入参校验回归 ===\n');

{
  const mk = (bm) => makeTask({ id: 'x', name: 'x', type: 'explore', role: 'researcher',
    input: { description: '一个足够长的任务描述' }, budget: { backoffMs: bm } });

  check('backoffMs: 0 被纠正为默认值', mk(0).budget.backoffMs > 0,
    '得到 ' + mk(0).budget.backoffMs);
  check('backoffMs: NaN 被纠正', Number.isFinite(mk(NaN).budget.backoffMs),
    '得到 ' + mk(NaN).budget.backoffMs);
  check('backoffMs: -100 被纠正', mk(-100).budget.backoffMs > 0,
    '得到 ' + mk(-100).budget.backoffMs);
  check('backoffMs: "abc"（字符串）被纠正', typeof mk('abc').budget.backoffMs === 'number'
    && mk('abc').budget.backoffMs > 0, '得到 ' + mk('abc').budget.backoffMs);
  check('backoffMs: null/undefined 回落到默认值', mk(null).budget.backoffMs > 0
    && mk(undefined).budget.backoffMs > 0, '得到 ' + mk(undefined).budget.backoffMs);
  check('合法值原样保留（不被误伤）', mk(1234).budget.backoffMs === 1234,
    '得到 ' + mk(1234).budget.backoffMs);
}

{
  const t = makeTask({ id: 'y', name: 'y', type: 'explore', role: 'researcher',
    input: { description: '一个足够长的任务描述' }, budget: { backoffMs: 0 } });
  t.attempts = 1;
  const { backoffDelay } = require('./task');

  const d = backoffDelay(t.attempts, t.budget.backoffMs);
  check('backoffDelay 用纠正后的 backoffMs 返回正延迟（不会热自旋）',
    Number.isFinite(d) && d > 0, '得到 ' + d + 'ms');
  check('backoffMs:0 的任务不会被立刻重试（延迟非 0）',
    backoffDelay(t.attempts, t.budget.backoffMs) >= Math.floor(t.budget.backoffMs * 0.5),
    '至少 ' + Math.floor(t.budget.backoffMs * 0.5) + 'ms');
}

{
  const base = { id: 'a', name: 'a', type: 'explore', role: 'researcher', input: { description: '一个足够长的任务描述' } };
  check('deps 为字符串时被拒绝', throws(() => validatePlan([{ ...base, deps: 'b' }])));
  check('deps 为数字时被拒绝', throws(() => validatePlan([{ ...base, deps: 123 }])));
  check('deps 为对象时被拒绝', throws(() => validatePlan([{ ...base, deps: { x: 1 } }])));
  check('deps 为 null 时被拒绝（不是被当成"无依赖"）', throws(() => validatePlan([{ ...base, deps: null }])));
  check('deps 缺省时按无依赖处理（合法）', !throws(() => validatePlan([{ ...base }])));
  check('deps 为合法数组时通过', !throws(() => validatePlan([
    { ...base, deps: [] },
    { id: 'b', name: 'b', type: 'explore', role: 'researcher', input: { description: '一个足够长的任务描述' }, deps: ['a'] },
  ])));
}

{

  const t = { id: 'a', name: 'a', type: 'explore', role: 'researcher', deps: 'a', input: { description: '一个足够长的任务描述' } };
  check('自依赖经字符串伪装时被拒绝（不构成环绕过）', throws(() => validatePlan([t])));
}

{
  check('makeTask 拒绝 id="nul.x"（多扩展保留名）', throws(() => makeTask({
    id: 'nul.x', name: 'x', type: 'explore', role: 'researcher',
    input: { description: '一个足够长的任务描述' } })));
  check('makeTask 拒绝 id="con"（裸保留名，旧行为不回归）', throws(() => makeTask({
    id: 'con', name: 'x', type: 'explore', role: 'researcher',
    input: { description: '一个足够长的任务描述' } })));
  const { normalizePlanSafe } = require('../planner');
  const p = normalizePlanSafe({ tasks: [
    { id: 'con', type: 'explore', deps: [] },
    { id: 'ok1', type: 'explore', deps: ['con'] },
  ] });
  check('normalizePlanSafe 把保留名 id "con" 重映射为安全 id', p.tasks[0].id !== 'con'
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p.tasks[0].id), p.tasks[0].id);
  check('deps 同步重映射到新 id', p.tasks[1].deps[0] === p.tasks[0].id,
    JSON.stringify(p.tasks[1].deps));
  check('合法 id 不被误改', p.tasks[1].id === 'ok1', p.tasks[1].id);
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
