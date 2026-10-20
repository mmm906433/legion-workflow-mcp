'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

let fails = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) fails++;
  console.log(`${ok ? '✅' : '❌'} ${name}${extra !== undefined ? '  — ' + extra : ''}`);
}

const SRC = __dirname;

{
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.js'));
  const offenders = [];
  for (const f of files) {
    if (/(^|-)test\.js$|selftest|sweep|probe|bench|runall|guard\.js$/.test(f)) continue;
    const src = fs.readFileSync(path.join(SRC, f), 'utf8');

    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    if (/timeoutSec\s*:\s*\(?\s*task\.budget\s*&&\s*task\.budget\.timeoutSec/.test(code)) offenders.push(f);

    if (/(const|let)\s+\w*[Tt]imeoutSec\w*\s*=\s*\(?\s*task\.budget\s*&&\s*task\.budget\.timeoutSec/.test(code)) offenders.push(f);
  }
  check('无生产文件绕过 effectiveBudget 直接读 task.budget.timeoutSec',
    offenders.length === 0, offenders.length ? offenders.join(', ') : '');
}

{
  const { effectiveBudget } = require('./task');
  const mk = (declared, adv) => ({ budget: { timeoutSec: declared, stallSec: declared }, _adv: adv });

  check('无 _adv 时回落到声明预算', effectiveBudget(mk(240)).timeoutSec === 240, effectiveBudget(mk(240)).timeoutSec);
  check('_adv 放宽后被采纳', effectiveBudget(mk(240, { timeoutSec: 420 })).timeoutSec === 420,
    effectiveBudget(mk(240, { timeoutSec: 420 })).timeoutSec);
  check('自适应只放宽：_adv 更小时仍取声明值',
    effectiveBudget(mk(240, { timeoutSec: 100 })).timeoutSec === 240,
    effectiveBudget(mk(240, { timeoutSec: 100 })).timeoutSec);
  check('_adv.timeoutSec=0 视为未设置（falsy 陷阱）',
    effectiveBudget(mk(240, { timeoutSec: 0 })).timeoutSec === 240,
    effectiveBudget(mk(240, { timeoutSec: 0 })).timeoutSec);
  check('stallSec 同样走 _adv', effectiveBudget(mk(120, { stallSec: 400 })).stallSec === 400,
    effectiveBudget(mk(120, { stallSec: 400 })).stallSec);
  check('budget 整体缺失时有兜底（不返回 NaN）',
    Number.isFinite(effectiveBudget({}).timeoutSec) && effectiveBudget({}).timeoutSec > 0,
    effectiveBudget({}).timeoutSec);
}

{
  const { FeedbackEngine } = require('./feedback');
  const T = { id: 't', role: 'r', type: 'implement', budget: { timeoutSec: 300, stallSec: 240, maxAttempts: 3 } };
  const f = new FeedbackEngine();
  for (let i = 0; i < 2; i++) f.record(T, { verdict: 'fail', failureType: 'crash', ms: 1200 });
  for (let i = 0; i < 2; i++) f.record(T, { verdict: 'fail', failureType: 'stalled', ms: 5000 });
  const adv = f.advise(T, {});
  check('advise().timeoutSec 不低于声明值（fastFail ×0.6 收紧已删）',
    adv.timeoutSec >= T.budget.timeoutSec, 'adv=' + adv.timeoutSec);
  check('advise().stallSec 不低于声明值（stallRate ×0.5 收紧已删）',
    adv.stallSec >= T.budget.stallSec, 'adv=' + adv.stallSec);
  check('advise().maxAttempts 保持声明值（收紧无消费方，已删）',
    adv.maxAttempts === T.budget.maxAttempts, 'adv=' + adv.maxAttempts);
}

{

  const subPath = require.resolve('../subagent');
  let captured = null;
  const realSub = require(subPath);
  const patched = { ...realSub, runSubagent: async (a) => { captured = a.timeoutSec; return { ok: true, text: 'ok', ms: 1 }; } };

  const execPath = require.resolve('./executor-codex');
  const realExec = require.cache[execPath];
  const realSubCache = require.cache[subPath];

  const stub = new Module(execPath, null);
  stub.filename = execPath;
  stub.loaded = true;
  stub.paths = Module._nodeModulePaths(SRC);
  const src = fs.readFileSync(execPath, 'utf8')
    .replace("require('../subagent')", '__RT_SUB__');

  const factory = new Function('require', 'module', 'exports', '__RT_SUB__', src + '\n;return module.exports;');
  const mod = { exports: {} };
  const localRequire = (id) => (id === '../subagent' ? patched : require(id));
  factory(localRequire, mod, mod.exports, patched);

  const codex = mod.exports.makeCodexExecutor({});
  const store = { saveArtifact: () => ({}), appendEvent: () => {} };
  const mkTask = (adv) => ({
    id: 't1', type: 'implement', role: 'worker', title: 'x',
    description: '一个足够长的可执行任务描述，用于通过 fail-closed 守卫',
    input: { description: '一个足够长的可执行任务描述，用于通过 fail-closed 守卫' },
    budget: { timeoutSec: 240, stallSec: 120, maxAttempts: 2 },
    _adv: adv,
  });
  const run = (task) => codex({
    task, signal: new AbortController().signal, heartbeat: () => {}, store, runId: 'r', byId: () => null,
  });

  return run(mkTask({ timeoutSec: 900, stallSec: 900 }))
    .then(() => {
      check('执行器把 _adv.timeoutSec(900) 传到了 runSubagent，而非声明值(240)',
        captured === 900, 'runSubagent 实收 timeoutSec=' + captured);
    })
    .then(() => { captured = null; return run(mkTask(undefined)); })
    .then(() => {
      check('执行器 _adv 缺失时回落到声明预算(240)', captured === 240, 'runSubagent 实收 timeoutSec=' + captured);
    })
    .then(() => { captured = null; return run(mkTask({ timeoutSec: 5 })); })
    .then(() => {
      check('执行器不会因 _adv 过小而缩到声明值以下(仍 240)', captured === 240, 'runSubagent 实收 timeoutSec=' + captured);
    })
    .then(() => {
      console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
      process.exit(fails === 0 ? 0 : 1);
    })
    .catch((e) => { console.error('守卫自身异常：', e && e.stack); process.exit(2); });
}
