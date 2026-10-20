'use strict';

const { resolveTurnOutcome } = require('../subagent');

let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fail++;
};

console.log('=== 子会话裁决回归===');

{
  const r = resolveTurnOutcome(
    { turn: { status: 'failed', error: { message: 'Missing environment variable: `LEGION_API_KEY`.' } } },
    null, []
  );
  check('turn 失败被如实报告为失败（不再冒充成功）', r.ok === false, `ok=${r.ok}`);
  check('错误原文透出，能直接定位病因', /LEGION_API_KEY/.test(r.text), r.text.slice(0, 60));
}

{
  const r = resolveTurnOutcome({ turn: { status: 'failed' } }, 'transport closed', []);
  check('仅有 error 通知时也能定位病因', r.ok === false && /transport closed/.test(r.text), r.text.slice(0, 60));
}

{
  const r = resolveTurnOutcome({ turn: { status: 'completed' } }, null, ['干完了']);
  check('正常完成返回成功与末条文本', r.ok === true && r.text === '干完了', `${r.ok} / ${r.text}`);
}

{
  const r = resolveTurnOutcome({ turn: { status: 'completed' } }, null, []);
  check('零输出不再冒充成功', r.ok === false, r.text.slice(0, 50));
}

{
  const r = resolveTurnOutcome({ turn: { status: 'interrupted' } }, null, ['部分']);
  check('interrupted 按失败处理', r.ok === false, r.text.slice(0, 50));
}

{
  const r = resolveTurnOutcome({}, null, ['x']);
  check('畸形通知不抛错且有结论', typeof r.ok === 'boolean', `ok=${r.ok}`);
}

(async () => {
  const { makeUnlinkLadder } = require('../subagent');

  {
    let tries = 0;
    const fake = () => { tries++; if (tries < 3) throw new Error('EPERM'); };
    makeUnlinkLadder(fake, [5, 5, 5])('x.tmp');
    await new Promise((r) => setTimeout(r, 70));
    check('重试链最终删除成功（3 次尝试）', tries === 3, 'tries=' + tries);
  }

  {
    let tries = 0;
    const fake = () => { tries++; throw new Error('EPERM'); };
    makeUnlinkLadder(fake, [5, 5, 5])('x.tmp');
    await new Promise((r) => setTimeout(r, 90));
    check('恒失败时 1+3 次后有界停止', tries === 4, 'tries=' + tries);
  }
  console.log('\n' + (fail === 0 ? '子会话裁决回归通过 ✅' : `${fail} 项失败 ❌`));
  process.exit(fail ? 1 : 0);
})();
