'use strict';

const assert = require('assert');

let fails = 0;
const check = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${x ? '  — ' + x : ''}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const br = require('./brigade-redis');

  const r = await br.ensureRedis();
  check('专属实例在 6390 可用（独立本地实例，不与其他 Redis 数据共用）', !!r && br.PORT === 6390);
  await br.regRun({ runId: 't-r1', goal: 'g1', cwd: 'D:/proj', phase: 'running', pid: 111 });
  await br.regRun({ runId: 't-r2', goal: 'g2', cwd: 'D:/proj', phase: 'running', pid: 222 });
  let live = await br.listLiveRuns();
  check('注册表 roundtrip（2 批在飞）', live.length === 2 && live.some((x) => x.runId === 't-r1'));
  check('同 cwd 过滤（排除自己）', (await br.liveRunsForCwd('D:/proj', 't-r1')).length === 1);
  check('cwd 归一化（斜杠/大小写/尾斜杠）', (await br.liveRunsForCwd('d:/PROJ/', 'other')).length === 2);
  check('在飞计数=注册表推导值（无计数器漂移）', (await br.inflightCount()) === 2);

  const rr = await br.ensureRedis();
  await rr.cmd('DEL', 'brigade:run:t-r2');
  live = await br.listLiveRuns();
  check('条目消失后 SET 成员被惰性清理', live.length === 1 && live[0].runId === 't-r1');

  rr.close();
  await sleep(50);
  const r2 = await br.ensureRedis();
  check('死连接自动重建', !!r2 && r2 !== rr);
  await rr.cmd('SET', 'x', '1').catch(() => {});
  const afterCrash = await r2.cmd('PING');
  check('重建后命令可用', afterCrash === 'PONG');

  await r2.cmd('DEL', 'brigade:run:t-r1', 'brigade:live');
  check('实例清空后条目确实没了', (await br.listLiveRuns()).length === 0);
  await br.regHeartbeat({ runId: 't-r1', goal: 'g1', cwd: 'D:/proj', phase: 'running', pid: 111 });
  check('全量重写心跳重建条目（不是只续 EXPIRE）', (await br.listLiveRuns()).length === 1);

  await br.regUnregister('t-r1');
  check('注销后不在飞', (await br.inflightCount()) === 0);

  {
    const net = require('net');
    const { RedisMin } = require('./redis-min');
    const slow = net.createServer((sock) => {  });
    await new Promise((res) => slow.listen(0, '127.0.0.1', res));
    const port = slow.address().port;
    const r5 = await RedisMin.connect({ host: '127.0.0.1', port, timeoutMs: 1500 });
    check('慢服务端连接建立', !!r5);
    const t0 = Date.now();
    let rejected = false;
    try { await r5.cmd('PING'); } catch (e) { rejected = true; }
    const took = Date.now() - t0;
    check('命令超时被 reject（~5s）', rejected && took >= 4500 && took < 8000, took + 'ms');
    check('超时后连接已废弃（dead=true，防错位投毒）', r5.dead === true);
    slow.close();
  }

  const { spawnSync } = require('child_process');
  const path = require('path');
  const deg = spawnSync(process.execPath, ['-e', `
    process.env.BRIGADE_REDIS = '0';
    const br = require(${JSON.stringify(path.join(__dirname, 'brigade-redis'))});
    (async () => {
      const r = await br.ensureRedis();
      await br.regRun({ runId: 'x', cwd: 'D:/y' });
      const live = await br.listLiveRuns();
      console.log(r === null && live.length === 0 ? 'DEGRADED-OK' : 'DEGRADED-FAIL');
      process.exit(0);
    })();`], { encoding: 'utf8', timeout: 30000 });
  check('显式关闭时全链路降级为 no-op', String(deg.stdout).includes('DEGRADED-OK'), String(deg.stdout).trim().slice(0, 60));

  {
    const os2 = require('os');
    const fs2 = require('fs');
    const fakeBin = path.join(os2.tmpdir(), 'brigade-redis-fake-' + Date.now() + '.txt');
    fs2.writeFileSync(fakeBin, 'not an executable');
    const code = `
      const br = require(${JSON.stringify(path.join(__dirname, 'brigade-redis'))});
      (async () => {
        await br.regHeartbeat({ runId: 'probe1', cwd: 'D:/x' });   // 第 1 次：连死端口失败→spawn .txt 失败→_client=null
        await br.regHeartbeat({ runId: 'probe1', cwd: 'D:/x' });   // 第 2 次：修复前被 60s null 退避吞掉；修复后立即重试
        console.log('ATTEMPTS=' + br.getEnsureAttempts());
        process.exit(0);
      })();`;
    const res = spawnSync(process.execPath, ['-e', code], {
      encoding: 'utf8', timeout: 25000,
      env: { ...process.env, BRIGADE_REDIS_PORT: '6399', BRIGADE_REDIS_BIN: fakeBin },
    });
    const m = /ATTEMPTS=(\d+)/.exec(String(res.stdout));
    check('心跳第二次调用立即重试（旁路 60s null 退避）',
      !!m && m[1] === '2', m ? 'attempts=' + m[1] : ('stdout=' + String(res.stdout).trim().slice(0, 60) + ' err=' + String(res.stderr).trim().slice(0, 60)));
    try { fs2.unlinkSync(fakeBin); } catch {}
  }

  console.log(fails === 0 ? '\nRedis 协调层全部通过 ✅' : `\n${fails} 项失败 ❌`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('异常:', e); process.exit(1); });
