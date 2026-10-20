'use strict';

const { resolveTurnOutcome, pickSubstantive, looksSubstantive } = require('../subagent');

let fails = 0;
const check = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${x ? '  — ' + x : ''}`); if (!c) fails++; };

console.log('=== 子代理结论提取回归 ===\n');

{
  const texts = [
    '我已创建 parse.js，导出 sum() 与 list()。',
    '验证输出：sum=15，list=["a","b","c"]。',
    'Now let me verify by running it with node',
  ];
  const r = resolveTurnOutcome({ turn: { status: 'completed' } }, null, texts);
  check('不会把末条叙述句当成结论', !/Now let me verify/.test(r.text),
    '实际返回：' + JSON.stringify(r.text.slice(0, 60)));
  check('返回的是含结论的那条（含数字/验证信息）', /15/.test(r.text),
    r.text.slice(0, 80));
}

{
  const texts = ['Let me check the file first'];
  const r = resolveTurnOutcome({ turn: { status: 'completed' } }, null, texts);
  check('单条叙述句不会被丢弃（信息保留）', r.text.includes('Let me check'),
    JSON.stringify(r.text));
}

{
  const texts = ['前置叙述', '完成：已创建 parse.js 并验证通过 ✅ sum=15'];
  const r = resolveTurnOutcome({ turn: { status: 'completed' } }, null, texts);
  check('末条是结论时原样返回', r.text === texts[1], r.text);
}

{
  const r1 = resolveTurnOutcome({ turn: { status: 'failed' } }, null, ['看起来做完了']);
  check('status=failed 仍判失败（不受本次改动影响）', r1.ok === false);
  const r2 = resolveTurnOutcome({ turn: { status: 'completed' } }, 'Missing environment variable', ['x']);
  check('有 error 仍判失败', r2.ok === false);
  const r3 = resolveTurnOutcome({ turn: { status: 'completed' } }, null, []);
  check('无输出仍判失败', r3.ok === false);
}

{
  check('叙述句被判为非结论', !looksSubstantive('Now let me verify by running it with node'));
  check('含数字的判为结论', looksSubstantive('sum=15'));
  check('含勾叉的判为结论', looksSubstantive('✅ 验证通过'));
  check('含路径的判为结论', looksSubstantive('已创建 D:\\a\\parse.js'));
  check('长文本判为结论', looksSubstantive('x'.repeat(200)));
  check('空串判为非结论', !looksSubstantive(''));
}

{
  const r = pickSubstantive(['叙述A', '结论：sum=15 ✅', 'Now let me check']);
  check('跳过末条叙述取到结论', r === '结论：sum=15 ✅', r);
  const r2 = pickSubstantive(['Now let me check', 'Let me verify']);
  check('全是叙述时拼接全部', r2.includes('Now let me check') && r2.includes('Let me verify'),
    JSON.stringify(r2));
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);

(async () => {
  const { runSubagent } = require('../subagent');
  const ac = new AbortController(); ac.abort();
  const r = await runSubagent({ task: 'x'.repeat(50), cwd: __dirname, timeoutSec: 30, signal: ac.signal });
  const ok1 = r.ok === false && /启动前/.test(r.text) && r.ms === 0;
  console.log((ok1 ? '✅' : '❌') + ' 预中止：立即结算（启动前）/ 不崩宿主');
  const t = setTimeout(() => { console.log('❌ 中途中止超时未结算'); process.exit(1); }, 15000);
  const ac2 = new AbortController();
  const p = runSubagent({ task: '只回答：ok', cwd: __dirname, timeoutSec: 60, signal: ac2.signal });
  setTimeout(() => ac2.abort(), 800);
  const r2 = await p;
  clearTimeout(t);
  const ok2 = r2.ok === false && /中止/.test(r2.text);
  console.log((ok2 ? '✅' : '❌') + ' 中途中止：正常结算 ' + JSON.stringify(r2.text).slice(0, 50));
  if (!(ok1 && ok2) || fails > 0) process.exit(1);
  process.exit(0);
})();
