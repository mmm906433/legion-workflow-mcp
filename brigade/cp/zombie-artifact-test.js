'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { FileStore } = require('./store');

let fails = 0;
const check = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${x ? '  — ' + x : ''}`); if (!c) fails++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zombie-'));
const store = new FileStore(tmp);

(async () => {
  console.log('=== 僵尸工件回归 ===\n');

  {
    const task = { id: 'T', attemptId: 1 };

    const zombieTask = task;
    task.attemptId = 2;

    const wrong = store.saveArtifact('r1', { taskId: 'T', attemptId: zombieTask.attemptId, body: '僵尸产物', ok: true });
    check('缺陷复现：僵尸产物被标成 attempt 2',
      wrong.attemptId === 2, 'attemptId=' + wrong.attemptId + ' ← 冒充了 attempt#2');

    const filtered = store.listArtifacts('r1', { taskId: 'T', okOnly: true })
      .filter((a) => a.attemptId === 2);
    check('缺陷复现：僵尸产物通过了 attemptId 过滤',
      filtered.some((a) => a.body === '僵尸产物'),
      `过滤后 ${filtered.length} 个工件，含僵尸=${filtered.some((a) => a.body === '僵尸产物')}`);
  }

  {

    const task = { id: 'T2', attemptId: 1 };
    const myAttemptId = task.attemptId;
    task.attemptId = 2;

    const art = store.saveArtifact('r1', { taskId: 'T2', attemptId: myAttemptId, body: '僵尸产物2', ok: true });
    check('修复生效：僵尸产物仍标 attempt 1（不冒充）',
      art.attemptId === 1, 'attemptId=' + art.attemptId);

    const filtered = store.listArtifacts('r1', { taskId: 'T2', okOnly: true })
      .filter((a) => a.attemptId === 2);
    check('修复生效：僵尸产物被下游过滤拦下',
      !filtered.some((a) => a.body === '僵尸产物2'),
      `过滤后 ${filtered.length} 个工件（应为 0）`);
  }

  {
    const src = fs.readFileSync(path.join(__dirname, 'executor-codex.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    check('执行器不再把 task.attemptId 直接写进 saveArtifact',
      !/attemptId:\s*task\.attemptId/.test(code),
      '必须是派发时的快照值');
    check('执行器接受 attemptId 参数',
      /codexWorker\(\{\s*task,\s*attemptId/.test(src));
    const schedCode = fs.readFileSync(path.join(__dirname, 'scheduler.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    check('调度器把 myAttemptId 传给 worker',
      /this\.worker\(\{[^\n]*attemptId:\s*myAttemptId/.test(schedCode),
      '注意要读 scheduler.js 自己的源码，不能复用 executor 的 code 变量');
  }

  {

    const src = fs.readFileSync(path.join(__dirname, 'executor-codex.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    check('collectContext 不再取数组末位（依赖 readdir 顺序）',
      !/okArts\[okArts\.length\s*-\s*1\]/.test(code),
      '改为按 ts 取最新');
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
  process.exit(fails === 0 ? 0 : 1);
})();
