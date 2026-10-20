'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createObservability, STAGE } = require('./observability');

let fail = 0;
const check = (n, c, extra = '') => { console.log(`  ${c ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); if (!c) fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('=== 可观测层：谁在干什么，随时可查 ===');
  const logFile = path.join(os.tmpdir(), 'obs-test-' + Date.now() + '.jsonl');
  const seen = [];
  const obs = createObservability({ logFile, onEvent: (e) => seen.push(e) });

  obs.start('worker-1', { title: '实现 slugify', role: 'worker', stage: STAGE.EXECUTING });
  obs.start('worker-2', { title: '实现 titleCase', role: 'worker', stage: STAGE.EXECUTING });
  obs.beat('worker-1', '正在写代码');
  obs.stage('campaign', STAGE.PLANNING, '第1轮规划');

  check('注册表能看到运行中的 Agent', obs.summary().active === 2, JSON.stringify(obs.summary().byStage));
  check('能看到每个 Agent 在干什么', obs.snapshot().every((x) => x.title), JSON.stringify(obs.snapshot().map((x) => x.title)));

  obs.stage('worker-1', STAGE.VERIFYING, '自测中');
  check('阶段流转可被外部感知', obs.snapshot().find((x) => x.id === 'worker-1').stage === STAGE.VERIFYING);

  obs.finish('worker-1', { ok: true, summary: 'slugify 完成' });
  check('完成的任务从活动列表移除', obs.summary().active === 1);
  check('完成事件被广播', seen.some((e) => e.tag === 'finish' || e.kind === 'finish'));

  obs.start('stuck-1', { title: '会卡住的任务' });
  const snapNow = obs.registry.snapshot(Date.now() + 10 * 60 * 1000);
  check('长时间无心跳被判卡住', snapNow.some((x) => x.stalled), JSON.stringify(snapNow.map((x) => ({ id: x.id, stalled: x.stalled }))));

  const { ProgressLog } = require('./observability');
  const log = new ProgressLog(logFile);
  const events = log.read(100);
  check('事件已落盘可被外部进程读取', events.length >= 5, `${events.length} 条`);
  check('落盘含 stage/start 关键事件', events.some((e) => (e.kind === 'stage' || e.tag === 'plan')) && events.some((e) => e.kind === 'start'));

  const got = [];
  const off = obs.bus.on((e) => got.push(e.kind));
  obs.bus.emit({ kind: 'test-event' });
  check('订阅者实时收到事件', got.includes('test-event'));
  off();

  fs.appendFileSync(logFile, '{坏行\n');
  check('日志含坏行时仍能读出有效事件', log.read(100).length >= 5);

  try { fs.rmSync(logFile, { force: true }); } catch {}
  console.log('\n' + (fail === 0 ? '可观测层全部通过 ✅' : `${fail} 项失败 ❌`));
  process.exit(fail ? 1 : 0);
})();
