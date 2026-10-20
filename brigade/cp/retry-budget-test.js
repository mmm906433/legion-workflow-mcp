'use strict';

const fs = require('fs');
const path = require('path');

let fails = 0;
const check = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${x ? '  — ' + x : ''}`); if (!c) fails++; };
const SRC = __dirname;
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

console.log('=== 重试预算不得被写死 ===\n');

for (const f of ['e2e.js', 'isolation-e2e.js']) {
  const code = strip(fs.readFileSync(path.join(SRC, f), 'utf8'));
  check(`${f} 不含写死的 maxAttempts: 1`, !/maxAttempts:\s*1\b/.test(code),
    '写死 1 = 重试机制永不触发');
  check(`${f} 用可配置常量`, /maxAttempts:\s*ATTEMPTS/.test(code));
  check(`${f} 的 ATTEMPTS 来自环境变量`, /process\.env\.\w*ATTEMPTS/.test(code),
    '必须可配置，否则又是一枚写死的雷');
}

{
  const { isRetryable, NON_RETRYABLE } = require('./task');

  const execCode = strip(fs.readFileSync(path.join(SRC, 'executor-codex.js'), 'utf8'));
  const m = execCode.match(/failureType:\s*r\.aborted\s*\?\s*'(\w+)'\s*:\s*'(\w+)'/);
  check('执行器对 !r.ok 用了具体 failureType（不是硬编码）', !!m,
    m ? `${m[1]} / ${m[2]}` : '未匹配到 !r.ok 分支的 failureType');
  if (m) {
    const [, abortedType, plainType] = m;
    check(`非中止失败类型 "${plainType}" 是可重试的`, isRetryable(plainType),
      '不可重试 ⇒ 重试机制对它无效');
    check(`中止失败类型 "${abortedType}" 是可重试的`, isRetryable(abortedType));
  }
  check("NON_RETRYABLE 不含 'unknown'（丢 turn 的归类）", !NON_RETRYABLE.has('unknown'),
    [...NON_RETRYABLE].join(','));
}

{
  const { Scheduler } = require('./scheduler');
  const os = require('os');
  const fsx = require('fs');
  const tmp = fsx.mkdtempSync(path.join(os.tmpdir(), 'retry-'));
  let calls = 0;
  const MAX = 3;
  const s = new Scheduler({
    root: tmp, runId: 'retry', concurrency: 1,
    worker: async () => {
      calls++;

      if (calls < 2) {
        return { verdict: 'fail', failureType: 'unknown', summary: '子会话正常结束但没有任何输出', artifacts: [] };
      }
      return { verdict: 'done', summary: '第 ' + calls + ' 次成功', artifacts: [] };
    },
  });
  s.init('丢 turn 重试验证', [{
    id: 't1', name: 't1', type: 'explore', role: 'researcher', deps: [],
    budget: { timeoutSec: 30, stallSec: 20, maxAttempts: MAX },
    input: { description: '一个足够长的任务描述用于通过 fail-closed 守卫' },
  }]);
  s.run().then((res) => {
    const t = res.tasks[0];
    check('丢 turn 后确实重试了（调用次数 > 1）', calls > 1, `worker 被调用 ${calls} 次`);
    check('重试后成功，任务最终 done', t.state === 'done', `state=${t.state} 调用 ${calls} 次`);
    check('重试次数未超过 maxAttempts', calls <= MAX, `调用 ${calls} 次（上限 ${MAX}）`);
    try { fsx.rmSync(tmp, { recursive: true, force: true }); } catch {}
    console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
    process.exit(fails === 0 ? 0 : 1);
  }).catch((e) => { console.error('异常：', e && e.message); process.exit(2); });
}
