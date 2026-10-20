'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let fail = 0;
const results = [];
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fail++;
  results.push({ name, ok: !!cond });
};

function runConformance(makeStore, label, opts = {}) {
  console.log(`\n=== 后端一致性：${label} ===`);
  const root = path.join(os.tmpdir(), 'conf-' + label.replace(/\W/g, '') + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  const s = makeStore(root);
  const cleanup = () => { try { (opts.cleanup || ((r) => fs.rmSync(r, { recursive: true, force: true })))(root); } catch {} };

  try {

    check('1 必备方法齐全', ['ensureRun', 'saveTasks', 'loadTasks', 'currentEpoch', 'saveMeta', 'loadMeta',
      'saveArtifact', 'getArtifact', 'listArtifacts', 'appendEvent', 'listEvents']
      .every((m) => typeof s[m] === 'function'), '少一个方法整个后端就不能用');

    s.ensureRun('r1');
    const tasks = [{ id: 'a', state: 'pending' }, { id: 'b', state: 'done' }];
    const ok1 = s.saveTasks('r1', tasks, 5);
    check('2 首次写入被接受', ok1 !== false);
    const loaded = s.loadTasks('r1');
    check('3 任务往返一致', Array.isArray(loaded) && loaded.length === 2 && loaded[1].id === 'b',
      `读回 ${loaded && loaded.length} 条`);
    check('4 currentEpoch 反映已提交代号', s.currentEpoch('r1') === 5, `实际 ${s.currentEpoch('r1')}`);

    const stale = s.saveTasks('r1', [{ id: 'zombie', state: 'done' }], 4);
    check('5 陈旧 epoch 写入被拒（fencing 生效）', stale === false, `返回 ${JSON.stringify(stale)}`);
    const afterStale = s.loadTasks('r1');
    check('6 被拒的写入没有污染数据', afterStale.length === 2 && !afterStale.some((t) => t.id === 'zombie'),
      `数据变成 ${JSON.stringify(afterStale.map((t) => t.id))}`);
    const sameEpoch = s.saveTasks('r1', [{ id: 'x' }], 5);
    check('7 同 epoch 写入同样被拒（必须用 < 不是 <= 的反面）', sameEpoch === false, `返回 ${JSON.stringify(sameEpoch)}`);
    check('8 更新的 epoch 被接受', s.saveTasks('r1', tasks, 6) !== false);

    let threwNoEpoch = false;
    try { s.saveTasks('r1', tasks); } catch { threwNoEpoch = true; }
    check('9 缺 epoch 时抛错（漏传要立刻暴露，不能静默取 cur+1）', threwNoEpoch,
      threwNoEpoch ? '' : '静默兜底会让 fencing 形同虚设');

    let threwId = false;
    try { s.saveTasks('../../evil', [], 9); } catch { threwId = true; }
    check('10 runId 含路径分隔符被拒（防任意文件写）', threwId);
    let threwArt = false;
    try { s.saveArtifact('r1', { id: '../escape', type: 'x' }); } catch { threwArt = true; }
    check('11 artifactId 含 .. 被拒', threwArt);

    {
      const s2 = makeStore(path.join(root, 'multi'));
      s2.ensureRun('r');
      s2.saveTasks('r', [{ id: 'a' }], 10);

      const sp = path.join(s2.runDir('r'), 'snapshot.json');
      const raw = JSON.parse(fs.readFileSync(sp, 'utf8'));
      fs.writeFileSync(sp, JSON.stringify({ epoch: 99, tasks: [{ id: 'from-other-process' }] }));
      const seen = s2.currentEpoch('r');
      check('12 代号校准能看到其他进程写入的更高 epoch', seen === 99, '实际 ' + seen);
      check('13 据此拒绝陈旧写入（不覆盖别人的数据）', s2.saveTasks('r', [{ id: 'mine' }], 11) === false);
      check('14 被拒后数据未被覆盖', JSON.parse(fs.readFileSync(sp, 'utf8')).tasks[0].id === 'from-other-process');
      check('15 更高的 epoch 可以写入', s2.saveTasks('r', [{ id: 'mine' }], 100) !== false);
    }

    s.saveMeta('r1', { goal: 'g1', concurrency: 4 });
    check('12 元信息往返一致', s.loadMeta('r1').goal === 'g1');
    check('13 未初始化元信息返回空对象而非抛错', JSON.stringify(s.loadMeta('nope')) === '{}');

    const a1 = s.saveArtifact('r1', { type: 'implement', taskId: 'a', summary: 'S1', body: 'B1', ok: true });
    const a2 = s.saveArtifact('r1', { type: 'review', taskId: 'a', summary: 'S2', body: 'B2', ok: false });
    const a3 = s.saveArtifact('r1', { type: 'implement', taskId: 'b', summary: 'S3', body: 'B3', ok: true });
    check('14 工件自动生成 id 并可按 id 取回', !!a1.id && s.getArtifact('r1', a1.id).summary === 'S1');
    check('15 按 type 过滤', s.listArtifacts('r1', { type: 'implement' }).length === 2);
    check('16 按 taskId 过滤', s.listArtifacts('r1', { taskId: 'b' }).length === 1);
    check('17 okOnly 过滤掉失败产出', s.listArtifacts('r1', { okOnly: true }).length === 2);
    check('18 keyword 过滤（大小写不敏感）', s.listArtifacts('r1', { keyword: 's2' }).length === 1);
    check('19 取不存在的工件返回 null', s.getArtifact('r1', 'nope') === null);

    s.appendEvent('r1', { kind: 'e1', n: 1 });
    s.appendEvent('r1', { kind: 'e2', n: 2 });
    s.appendEvent('r1', { kind: 'e3', n: 3 });
    const mine = () => s.listEvents('r1').filter((e) => /^e[123]$/.test(e.kind));
    check('20 事件按序追加', mine().map((e) => e.n).join(',') === '1,2,3',
      `实际 ${mine().map((e) => e.n).join(',')}`);
    check('21 事件自动带时间戳', typeof mine()[0].ts === 'number');
    check('22 空 run 的事件返回空数组', JSON.stringify(s.listEvents('empty-run')) === '[]');
    check('22b fencing 拒绝也有事件留痕（可审计）',
      s.listEvents('r1').filter((e) => e.kind === 'stale_write_rejected').length === 2,
      `stale 事件 ${s.listEvents('r1').filter((e) => e.kind === 'stale_write_rejected').length} 条`);

    s.ensureRun('r2');
    s.saveTasks('r2', [{ id: 'other' }], 1);
    s.appendEvent('r2', { kind: 'x' });
    check('23 多 run 之间任务互不串', s.loadTasks('r2')[0].id === 'other' && s.loadTasks('r1').length === 2);
    check('24 多 run 之间事件互不串',
      s.listEvents('r2').filter((e) => e.kind === 'x').length === 1 && mine().length === 3,
      `r2=${s.listEvents('r2').length} r1=${s.listEvents('r1').length}`);

    s.saveMeta('r1', { goal: 'g2' });
    check('25 元信息是覆盖语义', s.loadMeta('r1').goal === 'g2' && s.loadMeta('r1').concurrency === undefined);
  } catch (e) {
    check('后端在一致性检查中抛出未捕获异常', false, e && e.message);
  } finally {
    cleanup();
  }
  return results;
}

module.exports = { runConformance };

if (require.main === module) {
  const { FileStore, assertId } = require('./store');
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  check('assertId 拒绝 con.js.md（多扩展保留名）', throws(() => assertId('con.js.md')));
  check('assertId 拒绝 com1.a.b', throws(() => assertId('com1.a.b')));
  check('assertId 拒绝裸 nul（旧行为不回归）', throws(() => assertId('nul')));
  check('assertId 拒绝 con.json（单扩展，旧行为不回归）', throws(() => assertId('con.json')));
  check('assertId 放行 config.json（首个段 config 非保留名）', !throws(() => assertId('config.json')));
  check('assertId 放行 connect.js', !throws(() => assertId('connect.js')));

  const only = process.argv[2];
  const backends = [];
  if (!only || only === 'file') backends.push({ label: 'FileStore', make: (r) => new FileStore(r) });

  let total = 0;
  for (const b of backends) {
    const before = fail;
    runConformance(b.make, b.label);
    total += 1;
  }
  console.log('\n' + (fail === 0
    ? `状态层后端一致性通过（${total} 个后端）✅`
    : `${fail} 项失败 ❌`));
  process.exit(fail ? 1 : 0);
}
