'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { makePipeline } = require('./pipeline');

let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('=== 可观测接线回归===');

  {
    const base = path.join(os.tmpdir(), 'obsw-' + Date.now());
    fs.mkdirSync(base, { recursive: true });
    const rr1 = path.join(os.tmpdir(), 'obsw1r-' + Date.now());
    const p = makePipeline({ base, runRoot: rr1, runId: 'obsw1', concurrency: 3, worker: async () => ({ verdict: 'done', summary: 'ok' }) });
    p.scheduler.init('g', [{ id: 'a', type: 'implement' }, { id: 'b', type: 'test' }]);
    await p.scheduler.run();
    check('1 默认产出进度文件（不传 progressFile 也有）', fs.existsSync(p.progressFile), p.progressFile);
    const ev = fs.readFileSync(p.progressFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    check('2 有 start 事件（watch.js 能显示"开始"）', ev.some((e) => e.kind === 'start'), `start=${ev.filter((e) => e.kind === 'start').length}`);
    check('3 有 finish 事件', ev.some((e) => e.kind === 'finish'));
    check('4 每个任务都有 start', ev.filter((e) => e.kind === 'start').length === 2, `实际 ${ev.filter((e) => e.kind === 'start').length}`);
    check('5 事件带时间戳（watch.js 排序/跟随靠它）', ev.every((e) => typeof e.ts === 'number'));
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  }

  {
    const base = path.join(os.tmpdir(), 'obsw2-' + Date.now());
    fs.mkdirSync(base, { recursive: true });
    const p = makePipeline({
      base, runRoot: path.join(os.tmpdir(), 'obsw2r-' + Date.now()), runId: 'obsw2', concurrency: 3,
      worker: async ({ task }) => task.id === 'bad'
        ? { verdict: 'fail', failureType: 'crash', summary: '炸了' }
        : { verdict: 'done', summary: '好' },
    });
    p.scheduler.init('g', [{ id: 'g1', type: 'implement' }, { id: 'g2', type: 'test' }, { id: 'bad', type: 'implement' }]);
    await p.scheduler.run();
    const ev = fs.readFileSync(p.progressFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    const fin = ev.filter((e) => e.kind === 'finish');
    check('6 成功任务 finish.ok=true', fin.filter((f) => f.id === 'g1' || f.id === 'g2').every((f) => f.ok === true),
      JSON.stringify(fin.map((f) => f.id + ':' + f.ok)));
    check('7 失败任务 finish.ok=false', (fin.find((f) => f.id === 'bad') || {}).ok === false);
    check('8 ok 字段永远是布尔（不出现 undefined）', fin.every((f) => typeof f.ok === 'boolean'));
    check('9 有阶段事件（用户要"感知执行阶段"）', ev.some((e) => e.kind === 'stage'));
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  }

  {
    const base = path.join(os.tmpdir(), 'obsw3-' + Date.now());
    fs.mkdirSync(base, { recursive: true });
    const p = makePipeline({
      base, runRoot: path.join(os.tmpdir(), 'obsw3r-' + Date.now()), runId: 'obsw3', concurrency: 2,
      worker: async ({ task }) => task.id === 'd'
        ? { verdict: 'degraded', summary: '部分完成' }
        : { verdict: 'done' },
    });
    p.scheduler.init('g', [{ id: 'ok', type: 'explore' }, { id: 'd', type: 'implement' }]);
    await p.scheduler.run();
    const ev = fs.readFileSync(p.progressFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    const fin = ev.filter((e) => e.kind === 'finish');
    check('10 降级任务不显示成完成', (fin.find((f) => f.id === 'd') || {}).ok === false,
      `d.ok=${(fin.find((f) => f.id === 'd') || {}).ok}`);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (fail === 0 ? '可观测接线回归通过 ✅' : `${fail} 项失败 ❌`));
  process.exit(fail ? 1 : 0);
})();
