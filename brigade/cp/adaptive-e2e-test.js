'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Scheduler } = require('./scheduler');

let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DECLARED = 0.3;
const NEED = 0.32;
const KEY_TASK = { id: 'slow', role: 'worker', type: 'implement' };

function build(root, tag) {
  return new Scheduler({
    runId: tag, root: path.join(root, tag), concurrency: 2, retryBudget: 99,
    worker: async () => { await sleep(NEED * 1000); return { verdict: 'done', summary: 'ok' }; },
  });
}

(async () => {
  console.log('=== 端到端：慢任务能否靠自适应预算被救回 ===');
  console.log(`  任务需要 ${NEED}s，声明预算 ${DECLARED}s\n`);
  const root = path.join(os.tmpdir(), 'ada-' + Date.now());
  try {

    const s1 = build(root, 'cold');
    s1.init('cold', [{ id: 'slow', ...KEY_TASK, type: 'implement', deps: [], budget: { timeoutSec: DECLARED, stallSec: DECLARED * 0.8, maxAttempts: 1 } }]);
    const r1 = await s1.run();
    const t1 = r1.tasks[0];
    check('冷启动时按声明预算被杀掉（复现旧行为）',
      t1.state === 'failed' && t1.outcome.failureType === 'timeout',
      `${t1.state}/${t1.outcome.failureType}`);

    const s2 = build(root, 'warm');
    s2.feedback.record(KEY_TASK, { verdict: 'fail', failureType: 'timeout', ms: 300 });
    s2.feedback.record(KEY_TASK, { verdict: 'fail', failureType: 'timeout', ms: 290 });
    s2.init('warm', [{ id: 'slow', ...KEY_TASK, type: 'implement', deps: [], budget: { timeoutSec: DECLARED, stallSec: DECLARED * 0.8, maxAttempts: 1 } }]);
    const r2 = await s2.run();
    const t2 = r2.tasks[0];
    check('有"慢"样本后，同一任务被救回', t2.state === 'done',
      `${t2.state}${t2.outcome && t2.outcome.failureType ? '/' + t2.outcome.failureType : ''}，耗时 ${Math.round(t2.ms || 0)}ms`);

    const s3 = build(root, 'fast');
    s3.feedback.record(KEY_TASK, { verdict: 'fail', failureType: 'crash', ms: 5 });
    s3.feedback.record(KEY_TASK, { verdict: 'fail', failureType: 'crash', ms: 6 });
    const adv = s3.feedback.advise({ ...KEY_TASK, budget: { timeoutSec: DECLARED, stallSec: 0.2, maxAttempts: 1 } }, {});
    check('对照：快速失败不会被误放宽（避免"什么都放行"）', adv.timeoutSec <= DECLARED, '预算 ' + adv.timeoutSec + 's');

    const s4 = build(root, 'cb');
    s4.feedback.record(KEY_TASK, { verdict: 'fail', failureType: 'crash', ms: 1 });
    s4.feedback.record(KEY_TASK, { verdict: 'fail', failureType: 'crash', ms: 1 });
    const open4 = s4.feedback.advise({ ...KEY_TASK, budget: { timeoutSec: DECLARED, stallSec: 0.2, maxAttempts: 1 } }, {});
    s4.feedback.record(KEY_TASK, { verdict: 'fail', failureType: 'crash', ms: 1 });
    const open5 = s4.feedback.advise({ ...KEY_TASK, budget: { timeoutSec: DECLARED, stallSec: 0.2, maxAttempts: 1 } }, {});
    check('对照：2 次失败不熔断、第 3 次才熔断（自适应没破坏熔断）',
      open4.allow === true && open5.allow === false, `2次=${open4.allow} 3次=${open5.allow}`);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
  console.log('\n' + (fail === 0 ? '端到端验证通过 ✅' : `${fail} 项失败 ❌`));
  process.exit(fail ? 1 : 0);
})();
