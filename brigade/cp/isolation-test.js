'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { Scheduler } = require('./scheduler');
const { Command, flattenSquads, makeWriteGate } = require('./hierarchy');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fail++;
};

const GEN1 = 'A'.repeat(200);
const GEN2 = 'B'.repeat(200);
const isComplete = (s) => s === GEN1 || s === GEN2;

const tornReads = (log) => log.filter((r) => r.seen != null && !isComplete(r.seen));

function makeBase(tag) {
  const base = path.join(os.tmpdir(), 'iso-base-' + tag + '-' + Date.now());
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'shared.js'), GEN1);
  return base;
}

function makeFakeWorker({ base, resolveCwd, holdMs = 400, log }) {
  return async ({ task }) => {
    const dir = resolveCwd ? resolveCwd(task) : base;
    const file = path.join(dir, 'shared.js');
    if (task.type === 'implement') {
      if (log) log.push({ id: task.id, seen: null, dir });

      fs.writeFileSync(file, GEN2.slice(0, 100));
      await sleep(holdMs);
      fs.writeFileSync(file, GEN2);
      return { verdict: 'done', summary: '写完' };
    }

    await sleep(Math.floor(holdMs / 2));
    const seen = fs.readFileSync(file, 'utf8');
    if (log) log.push({ id: task.id, seen, dir });
    return { verdict: 'done', summary: '读到 ' + seen.length + ' 字节' };
  };
}

function deployCombo(cmd) {
  cmd.deploy('g', [{ id: 'I', title: '改代码', goal: 'g' }], () => [
    { id: 'w', type: 'implement', role: 'worker', deps: [],
      budget: { timeoutSec: 30, stallSec: 20, maxAttempts: 1 },
      description: '把 shared.js 从 A 代改成 B 代' },
    { id: 'r1', type: 'review', role: 'reviewer', deps: [],
      budget: { timeoutSec: 30, stallSec: 20, maxAttempts: 1 },
      description: '审查 shared.js 当前内容' },
    { id: 'r2', type: 'review', role: 'reviewer', deps: [],
      budget: { timeoutSec: 30, stallSec: 20, maxAttempts: 1 },
      description: '审查 shared.js 当前内容' },

    { id: 'r3', type: 'review', role: 'reviewer', deps: ['w'],
      budget: { timeoutSec: 30, stallSec: 20, maxAttempts: 1 },
      description: '审查 shared.js 最新内容' },
  ]);
}

(async () => {
  console.log('=== 读写隔离回归（M5：只读任务不得读到半写工作区）===');

  console.log('\n=== 场景A：共享工作区（当前行为）——预期暴露半写读取 ===');
  let hazardFound = false;
  {
    const base = makeBase('shared');
    const readLog = [];
    const cmd = new Command({ writeSquadGate: 1, globalConcurrency: 8 });
    deployCombo(cmd);
    const s = new Scheduler({
      runId: 'isoA', root: path.join(os.tmpdir(), 'isoA-' + Date.now()),
      worker: makeFakeWorker({ base, log: readLog }),
      concurrency: 4, onProgress: (ts) => require('./hierarchy').syncSquads(cmd, ts),
      admission: makeWriteGate(cmd),
    });
    s.init('g', flattenSquads(cmd));
    await Promise.race([s.run(), sleep(30000).then(() => ({ hang: true }))]);
    const torn = tornReads(readLog);
    hazardFound = torn.length > 0;
    console.log(`  只读任务读到 ${readLog.length} 次，其中半写 ${torn.length} 次`);
    check('A1 复现出半写读取（缺口真实存在）', hazardFound,
      torn.length ? `r1 读到 ${torn[0].seen.length} 字节的中间态` : '未复现——若此项失败说明缺口已不存在');
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  }

  let Workspace = null;
  try { Workspace = require('./workspace').Workspace; } catch { Workspace = null; }
  check('B0 workspace 模块存在', !!Workspace, Workspace ? '' : '未实现，场景B/C/D/E 将被跳过');
  if (Workspace) {
    console.log('\n=== 场景B：影子工作区——只读任务只应看到完整版本 ===');
    {
      const base = makeBase('shadow');
      const readLog = [];
      const ws = new Workspace({ base, runRoot: path.join(os.tmpdir(), 'isoB-' + Date.now()) });
      const cmd = new Command({ writeSquadGate: 1, globalConcurrency: 8 });
      deployCombo(cmd);
      const s = new Scheduler({
        runId: 'isoB', root: ws.runRoot,
        worker: makeFakeWorker({ base, resolveCwd: (t) => ws.cwdFor(t), log: readLog }),
        concurrency: 4, onProgress: (ts) => require('./hierarchy').syncSquads(cmd, ts),
        admission: makeWriteGate(cmd),
        onPublish: (t) => ws.publish(t),
      });
      s.init('g', flattenSquads(cmd));
      const r = await Promise.race([s.run(), sleep(30000).then(() => ({ hang: true }))]);
      const torn = tornReads(readLog);
      const wRec = readLog.find((r2) => r2.id === 'w');
      check('B1 写任务确实在影子目录执行（不在 base 里写）',
        wRec && wRec.dir !== base, wRec ? `w 的 cwd = ${path.basename(wRec.dir)}` : '未记录到写任务');
      check('B2 只读任务无一次读到半写', torn.length === 0,
        torn.length ? `${torn.length} 次半写：${torn[0].seen.length} 字节` : `${readLog.length} 次读取全部完整`);
      check('B3 未 hang', !r.hang);
      try { fs.rmSync(base, { recursive: true, force: true }); } catch {} try { fs.rmSync(ws.runRoot, { recursive: true, force: true }); } catch {}
    }

    console.log('\n=== 场景C：发布后 base 必须拿到新内容 ===');
    {
      const base = makeBase('publish');
      const readLog = [];
      const ws = new Workspace({ base, runRoot: path.join(os.tmpdir(), 'isoC-' + Date.now()) });
      const cmd = new Command({ writeSquadGate: 1, globalConcurrency: 8 });
      deployCombo(cmd);
      const s = new Scheduler({
        runId: 'isoC', root: ws.runRoot,
        worker: makeFakeWorker({ base, resolveCwd: (t) => ws.cwdFor(t), log: readLog, holdMs: 100 }),
        concurrency: 4, onProgress: (ts) => require('./hierarchy').syncSquads(cmd, ts),
        admission: makeWriteGate(cmd),
        onPublish: (t) => ws.publish(t),
      });
      s.init('g', flattenSquads(cmd));
      await Promise.race([s.run(), sleep(30000).then(() => ({ hang: true }))]);
      const after = fs.readFileSync(path.join(base, 'shared.js'), 'utf8');
      check('C1 写任务的改动已发布到 base', after === GEN2, after === GEN2 ? 'base 已是 B 代' : `base 仍是 ${after[0]} 代`);
      const afterReads = readLog.filter((r2) => r2.id === 'r3' && r2.seen === GEN2).length;
      check('C2 发布后的只读任务读到了新版本（视图没有永久冻结）', afterReads > 0,
        afterReads ? 'r3 读到 B 代' : '发布后的读者仍看到旧版本——发布顺序有问题');
      try { fs.rmSync(base, { recursive: true, force: true }); } catch {} try { fs.rmSync(ws.runRoot, { recursive: true, force: true }); } catch {}
    }

    console.log('\n=== 场景D：exclusiveReads 严格模式——量化吞吐代价 ===');
    {
      const base = makeBase('strict');
      const readLog = [];
      const ws = new Workspace({ base, runRoot: path.join(os.tmpdir(), 'isoD-' + Date.now()), exclusiveReads: true });
      const cmd = new Command({ writeSquadGate: 1, globalConcurrency: 8 });
      deployCombo(cmd);
      const s = new Scheduler({
        runId: 'isoD', root: ws.runRoot,
        worker: makeFakeWorker({ base, resolveCwd: (t) => ws.cwdFor(t), log: readLog, holdMs: 400 }),
        concurrency: 4, onProgress: (ts) => require('./hierarchy').syncSquads(cmd, ts),
        admission: ws.gate(makeWriteGate(cmd)),
        onPublish: (t) => ws.publish(t),
      });
      s.init('g', flattenSquads(cmd));
      const t0 = Date.now();
      await Promise.race([s.run(), sleep(30000).then(() => ({ hang: true }))]);
      const wall = Date.now() - t0;
      const torn = tornReads(readLog);
      check('D1 严格模式下同样无半写读取', torn.length === 0, `${torn.length} 次半写`);
      check('D2 严格模式确实更慢（代价可见，不假装免费）', wall > 400,
        `耗时 ${wall}ms（写任务本身 400ms，严格模式让读者排在写者之后）`);
      console.log(`  严格模式总耗时 ${wall}ms；影子模式同场景约 400-600ms`);
      try { fs.rmSync(base, { recursive: true, force: true }); } catch {} try { fs.rmSync(ws.runRoot, { recursive: true, force: true }); } catch {}
    }

    console.log('\n=== 场景E：影子工作区的失败与守卫必须显式 ===');
    {
      const base2 = makeBase('fail2');
      const runRoot2 = path.join(os.tmpdir(), 'isoE2-' + Date.now());
      fs.mkdirSync(runRoot2, { recursive: true });
      fs.writeFileSync(path.join(runRoot2, 'shadow'), 'not a dir');
      const ws2 = new Workspace({ base: base2, runRoot: runRoot2 });
      let threw2 = null;
      try { ws2.cwdFor({ id: 'w', type: 'implement', attemptId: 1 }); } catch (e) { threw2 = e; }
      check('E1 影子目录创建失败时抛错（fail-closed，不静默回落共享）', threw2 !== null,
        threw2 ? threw2.message.slice(0, 60) : '静默回落到了共享工作区——这是最坏的结果');
      try { fs.rmSync(base2, { recursive: true, force: true }); } catch {} try { fs.rmSync(runRoot2, { recursive: true, force: true }); } catch {}
    }
    {

      const ws3 = new Workspace({ base: makeBase('ro'), runRoot: path.join(os.tmpdir(), 'isoE3-' + Date.now()) });
      const roCwd = ws3.cwdFor({ id: 'r', type: 'review', attemptId: 1 });
      check('E2 只读任务不分配影子（零复制开销）', roCwd === ws3.base && ws3.stats.allocated === 0,
        `allocated=${ws3.stats.allocated}`);

      const w1 = ws3.cwdFor({ id: 'w', type: 'implement', attemptId: 1 });
      const w2 = ws3.cwdFor({ id: 'w', type: 'implement', attemptId: 1 });
      check('E3 同一 attempt 复用影子（不重复复制）', w1 === w2 && ws3.stats.allocated === 1,
        `allocated=${ws3.stats.allocated}（应为 1）`);

      const w3 = ws3.cwdFor({ id: 'w', type: 'implement', attemptId: 2 });
      check('E4 重试分配全新影子（不继承失败 attempt 的半成品）', w3 !== w1 && ws3.stats.allocated === 2,
        `allocated=${ws3.stats.allocated}（应为 2）`);
      try { fs.rmSync(ws3.base, { recursive: true, force: true }); } catch {} try { fs.rmSync(ws3.runRoot, { recursive: true, force: true }); } catch {}
    }
    {

      const base4 = makeBase('gen');
      const ws4 = new Workspace({ base: base4, runRoot: path.join(os.tmpdir(), 'isoE4-' + Date.now()) });
      const task = { id: 'w', type: 'implement', attemptId: 1 };
      ws4.cwdFor(task);
      ws4.generation++;
      let threw4 = null;
      try { ws4.publish(task); } catch (e) { threw4 = e; }
      check('E5 base 中途被改时发布拒绝（代号守卫，防覆盖丢失）', threw4 !== null,
        threw4 ? threw4.message.slice(0, 70) : '静默覆盖了别人的改动');
      check('E6 被拒后 base 未被污染', fs.readFileSync(path.join(base4, 'shared.js'), 'utf8') === GEN1);
      try { fs.rmSync(base4, { recursive: true, force: true }); } catch {} try { fs.rmSync(ws4.runRoot, { recursive: true, force: true }); } catch {}
    }
  }

  console.log('\n=== 场景F：差分写与删除传播 ===');
  {
    const base = path.join(os.tmpdir(), 'isoF-' + Date.now());
    fs.mkdirSync(path.join(base, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(base, 'keep.js'), 'KEEP');
    fs.writeFileSync(path.join(base, 'change.js'), 'OLD');
    fs.writeFileSync(path.join(base, 'sub', 'gone.js'), 'GONE');
    fs.writeFileSync(path.join(base, 'obsolete.js'), 'OBSOLETE');
    fs.mkdirSync(path.join(base, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(base, 'node_modules', 'x.js'), 'NM');

    const ws = new Workspace({ base, runRoot: path.join(os.tmpdir(), 'isoFR-' + Date.now()) });
    const task = { id: 'w', type: 'implement', attemptId: 1 };
    const dir = ws.cwdFor(task);

    fs.writeFileSync(path.join(dir, 'change.js'), 'NEW');
    fs.writeFileSync(path.join(dir, 'added.js'), 'ADDED');
    fs.unlinkSync(path.join(dir, 'sub', 'gone.js'));
    fs.unlinkSync(path.join(dir, 'obsolete.js'));
    const before = Date.now();
    const pub = ws.publish(task);

    check('F1 改过的文件已更新', fs.readFileSync(path.join(base, 'change.js'), 'utf8') === 'NEW');
    check('F2 新增的文件已落地', fs.existsSync(path.join(base, 'added.js')));
    check('F3 删除语义传播到 base（旧实现会留下幽灵文件）', !fs.existsSync(path.join(base, 'sub', 'gone.js')));
    check('F4 顶层删除也传播', !fs.existsSync(path.join(base, 'obsolete.js')));
    check('F5 没动的文件仍在', fs.existsSync(path.join(base, 'keep.js')));
    check('F6 排除目录未被误删', fs.existsSync(path.join(base, 'node_modules', 'x.js')),
      '排除目录不在快照清单里，不该被当成"任务删了"');
    check('F7 差分写：只更新真正变动的文件', pub.updated.length === 1 && pub.updated[0] === 'change.js',
      `updated=${JSON.stringify(pub.updated)}`);
    check('F8 差分写：新增与删除各自记账', pub.created.length === 1 && pub.deleted.length === 2,
      `created=${JSON.stringify(pub.created)} deleted=${JSON.stringify(pub.deleted)}`);
    console.log(`  发布耗时 ${Date.now() - before}ms`);

    {
      const base5 = path.join(os.tmpdir(), 'isoF5-' + Date.now());
      fs.mkdirSync(base5, { recursive: true });
      fs.writeFileSync(path.join(base5, 'a.js'), 'A');
      const ws5 = new Workspace({ base: base5, runRoot: path.join(os.tmpdir(), 'isoF5R-' + Date.now()) });
      const t5 = { id: 'w', type: 'implement', attemptId: 1 };
      const d5 = ws5.cwdFor(t5);
      fs.writeFileSync(path.join(base5, 'user-added.js'), 'USER');
      fs.unlinkSync(path.join(d5, 'a.js'));
      const p5 = ws5.publish(t5);
      check('F9 快照之后才出现在 base 的文件不被误删', fs.existsSync(path.join(base5, 'user-added.js')),
        p5.deleted.includes('user-added.js') ? `误删了人工新增文件（本场景删的其实是 ${JSON.stringify(p5.deleted)}）` : `只删了任务真删的 ${JSON.stringify(p5.deleted)}`);
      check('F10 任务真删的文件仍被删', !fs.existsSync(path.join(base5, 'a.js')));
      try { fs.rmSync(base5, { recursive: true, force: true }); } catch {} try { fs.rmSync(ws5.runRoot, { recursive: true, force: true }); } catch {}
    }
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {} try { fs.rmSync(ws.runRoot, { recursive: true, force: true }); } catch {}
  }

  console.log('\n=== 场景G：逃逸检测（子代理绕过影子区写 base）===');
  {
    const base = path.join(os.tmpdir(), 'isoG-' + Date.now());
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, 'a.js'), 'A-ORIGINAL');
    fs.writeFileSync(path.join(base, 'b.js'), 'B-ORIGINAL');
    let reported = null;
    const ws = new Workspace({ base, runRoot: path.join(os.tmpdir(), 'isoGR-' + Date.now()),
      onEscape: (t, files) => { reported = { id: t.id, files }; } });
    const task = { id: 'w', type: 'implement', attemptId: 1 };
    ws.cwdFor(task);

    fs.writeFileSync(path.join(base, 'a.js'), 'A-ESCAPED');

    fs.writeFileSync(path.join(ws.cwdFor(task), 'b.js'), 'B-VIA-SHADOW');
    const pub = ws.publish(task);

    check('G1 逃逸被检出并上报', reported !== null && reported.files.includes('a.js'),
      reported ? `检出 ${JSON.stringify(reported.files)}` : '完全没发现——M5 的保证被静默破坏');
    check('G2 计数进入统计', ws.stats.escapes === 1, `escapes=${ws.stats.escapes}`);
    check('G3 默认不阻断发布（避免误伤用户手改）', fs.readFileSync(path.join(base, 'b.js'), 'utf8') === 'B-VIA-SHADOW');
    check('G4 外部改动不被悄悄回滚（用户手改代码不能被毁掉）',
      fs.readFileSync(path.join(base, 'a.js'), 'utf8') === 'A-ESCAPED',
      '差分写若覆盖冲突文件就会把外部改动悄悄还原——那是数据丢失');
    check('G5 冲突文件如实计入未落地清单（不假装全部成功）', pub.conflicts.includes('a.js') && ws.stats.conflicts === 1,
      `conflicts=${JSON.stringify(pub.conflicts)}`);

    check('G6 冲突文件任务侧版本已隔离至 conflictDir（有副本可人工合并）',
      !!pub.conflictDir && fs.existsSync(path.join(pub.conflictDir, 'a.js'))
      && fs.readFileSync(path.join(pub.conflictDir, 'a.js'), 'utf8') === 'A-ORIGINAL'
      && fs.readFileSync(path.join(base, 'a.js'), 'utf8') === 'A-ESCAPED',
      pub.conflictDir || '无 conflictDir');
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {} try { fs.rmSync(ws.runRoot, { recursive: true, force: true }); } catch {}
  }
  {

    const base = path.join(os.tmpdir(), 'isoG2-' + Date.now());
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, 'a.js'), 'A');
    const ws = new Workspace({ base, runRoot: path.join(os.tmpdir(), 'isoG2R-' + Date.now()), strictIsolation: true });
    const task = { id: 'w', type: 'implement', attemptId: 1 };
    ws.cwdFor(task);
    fs.writeFileSync(path.join(base, 'a.js'), 'ESCAPED');
    let threw = null;
    try { ws.publish(task); } catch (e) { threw = e; }
    check('G6 strictIsolation 下逃逸让发布失败（不静默放过）', threw !== null && /隔离被绕过/.test(threw.message),
      threw ? threw.message.slice(0, 60) : '静默放行');
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {} try { fs.rmSync(ws.runRoot, { recursive: true, force: true }); } catch {}
  }
  {

    const base = path.join(os.tmpdir(), 'isoG3-' + Date.now());
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, 'a.js'), 'A');
    let fired = false;
    const ws = new Workspace({ base, runRoot: path.join(os.tmpdir(), 'isoG3R-' + Date.now()),
      onEscape: () => { fired = true; } });
    const task = { id: 'w', type: 'implement', attemptId: 1 };
    const d = ws.cwdFor(task);
    fs.writeFileSync(path.join(d, 'a.js'), 'A2');
    ws.publish(task);
    check('G7 正常写任务不误报逃逸', !fired && ws.stats.escapes === 0, `escapes=${ws.stats.escapes}`);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {} try { fs.rmSync(ws.runRoot, { recursive: true, force: true }); } catch {}
  }

  console.log('\n=== 场景H：冲突导致部分落地 → 任务降级而非记 done ===');
  {
    const base = path.join(os.tmpdir(), 'isoH-' + Date.now());
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, 'shared.js'), 'V1');
    const ws = new Workspace({ base, runRoot: path.join(os.tmpdir(), 'isoHR-' + Date.now()) });
    let escapedDuring = false;

    const worker = async ({ task }) => {
      if (task.type === 'implement') {
        const dir = ws.cwdFor(task);
        fs.writeFileSync(path.join(dir, 'shared.js'), 'V2-BY-TASK');
        fs.writeFileSync(path.join(base, 'shared.js'), 'V2-BY-EXTERNAL');
        escapedDuring = true;
        return { verdict: 'done', summary: '我改好了' };
      }
      return { verdict: 'done', summary: 'ok' };
    };
    const s = new Scheduler({
      runId: 'isoH', root: path.join(os.tmpdir(), 'isoHRun-' + Date.now()),
      worker, concurrency: 2, onPublish: (t) => ws.publish(t),
    });
    s.init('h', [
      { id: 'w', type: 'implement', role: 'worker', deps: [],
        budget: { timeoutSec: 20, stallSec: 15, maxAttempts: 1 } },
      { id: 'dep', type: 'review', role: 'reviewer', deps: ['w'],
        budget: { timeoutSec: 20, stallSec: 15, maxAttempts: 1 } },
    ]);
    const r = await Promise.race([s.run(), sleep(30000).then(() => ({ hang: true }))]);
    const w = (r.tasks || []).find((t) => t.id === 'w');
    check('H1 确实制造出了冲突', escapedDuring);
    check('H2 部分落地不得记成 done', w && w.state !== 'done',
      w ? `状态=${w.state}（旧实现会记 done，尽管改动没落地）` : '任务丢失');
    check('H3 失败原因指向工作区冲突', w && w.outcome && w.outcome.failureType === 'workspace_conflict',
      w && w.outcome ? `failureType=${w.outcome.failureType}` : '');
    check('H4 冲突文件名如实记录', w && Array.isArray(w.outcome.conflicts) && w.outcome.conflicts.includes('shared.js'),
      w && w.outcome ? JSON.stringify(w.outcome.conflicts) : '');
    check('H5 外部版本被保留（不毁用户改动）',
      fs.readFileSync(path.join(base, 'shared.js'), 'utf8') === 'V2-BY-EXTERNAL');
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {} try { fs.rmSync(ws.runRoot, { recursive: true, force: true }); } catch {}
  }

  console.log('\n=== 场景I：发布失败必须零改动（前置体检）===');
  {
    const base = path.join(os.tmpdir(), 'isoI-' + Date.now());
    fs.mkdirSync(base, { recursive: true });
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(base, 'f' + i + '.js'), 'V1-' + i);
    const ws = new Workspace({ base, runRoot: path.join(os.tmpdir(), 'isoIR-' + Date.now()) });
    const task = { id: 'w', type: 'implement', attemptId: 1 };
    const dir = ws.cwdFor(task);
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, 'f' + i + '.js'), 'V2-' + i);
    fs.chmodSync(path.join(base, 'f2.js'), 0o444);

    let err = null;
    try { ws.publish(task); } catch (e) { err = e; }
    const now = (i) => fs.readFileSync(path.join(base, 'f' + i + '.js'), 'utf8');
    const untouched = [0, 1, 2, 3, 4].every((i) => now(i) === 'V1-' + i);

    check('I1 发布失败时报错', err !== null);
    check('I2 前置体检拦下 → base 零改动（不留下半套）', untouched,
      [0, 1, 2, 3, 4].map((i) => now(i)).join(' '));
    check('I3 错误信息如实说明 base 未被改动', err && /未被改动/.test(err.message),
      err ? err.message.slice(0, 60) : '');
    check('I4 失败现场被记录（可查已落地清单）',
      ws.lastPublishFailure && Array.isArray(ws.lastPublishFailure.applied) && ws.lastPublishFailure.applied.length === 0,
      JSON.stringify(ws.lastPublishFailure && ws.lastPublishFailure.applied));
    check('I5 影子目录保留，可重试发布', fs.existsSync(dir));

    try { fs.chmodSync(path.join(base, 'f2.js'), 0o666); } catch {}
    const pub2 = ws.publish(task);
    const allApplied = [0, 1, 2, 3, 4].every((i) => now(i) === 'V2-' + i);
    check('I6 解除限制后重试可完整落地', allApplied && pub2 !== null,
      [0, 1, 2, 3, 4].map((i) => now(i)).join(' '));
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {} try { fs.rmSync(ws.runRoot, { recursive: true, force: true }); } catch {}
  }

  console.log('\n=== 场景J：新建目录里的新文件必须能发布===');
  {
    const base = path.join(os.tmpdir(), 'isoJ-' + Date.now());
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, 'README.md'), 'r');
    const ws = new Workspace({ base, runRoot: path.join(os.tmpdir(), 'isoJR-' + Date.now()) });
    const task = { id: 'w', type: 'implement', attemptId: 1 };
    const dir = ws.cwdFor(task);

    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'text.js'), 'module.exports = 1;');
    fs.mkdirSync(path.join(dir, 'deep', 'nest'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'deep', 'nest', 'x.js'), 'x');

    let err = null, pub = null;
    try { pub = ws.publish(task); } catch (e) { err = e; }
    check('J1 新目录中的新文件能正常发布（不再被体检误拦）', err === null,
      err ? err.message.slice(0, 80) : '');
    check('J2 新目录与新文件确实落到 base',
      fs.existsSync(path.join(base, 'src', 'text.js')) && fs.readFileSync(path.join(base, 'src', 'text.js'), 'utf8') === 'module.exports = 1;');
    check('J3 多级新建目录也能发布', fs.existsSync(path.join(base, 'deep', 'nest', 'x.js')));
    check('J4 新建项被正确记账为 created', pub && pub.created.length === 2,
      pub ? JSON.stringify(pub.created) : '');
    check('J5 原有文件未受影响', fs.readFileSync(path.join(base, 'README.md'), 'utf8') === 'r');
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {} try { fs.rmSync(ws.runRoot, { recursive: true, force: true }); } catch {}
  }

  console.log('\n=== 场景K：runRoot 不得位于 base 内部（防无界递归挂死）===');
  {
    const base = path.join(os.tmpdir(), 'isoK-' + Date.now());
    fs.mkdirSync(base, { recursive: true });
    let threw = null;
    try { new Workspace({ base, runRoot: base }); } catch (e) { threw = e; }
    check('K1 runRoot === base 时 fail-closed 抛错（而不是静默挂死）', threw !== null,
      threw ? threw.message.slice(0, 70) : '未抛错——会退化成无界递归复制');

    let threw2 = null;
    try { new Workspace({ base, runRoot: path.join(base, 'runs') }); } catch (e) { threw2 = e; }
    check('K2 runRoot 是 base 的子目录时同样抛错', threw2 !== null);

    const wsK = new Workspace({ base });
    check('K3 默认 runRoot 落在 base 之外', wsK.runRoot !== wsK.base && !wsK.runRoot.startsWith(wsK.base + path.sep),
      wsK.runRoot);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(wsK.runRoot, { recursive: true, force: true }); } catch {}
  }
  {

    const base = path.join(os.tmpdir(), 'isoK2-' + Date.now());
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, 'x.js'), 'x');
    const rr = path.join(os.tmpdir(), 'isoK2r-' + Date.now());
    const ws = new Workspace({ base, runRoot: rr });
    const d = ws.cwdFor({ id: 'w', type: 'implement', attemptId: 1 });
    check('K4 runRoot 在 base 之外时正常工作（不是一刀切）',
      fs.existsSync(d) && fs.existsSync(path.join(d, 'x.js')), d);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {} try { fs.rmSync(rr, { recursive: true, force: true }); } catch {}
  }

  console.log('\n=== 场景L：搁浅产出检出 + 自定义 worker 拿到 workspace ===');
  {
    const { makePipeline } = require('./pipeline');
    const base = path.join(os.tmpdir(), 'isoL-' + Date.now());
    const rr = path.join(os.tmpdir(), 'isoLR-' + Date.now());
    fs.mkdirSync(base, { recursive: true });
    let gotWorkspace = null;
    const pipe = makePipeline({
      base, runRoot: rr, runId: 'isoL', concurrency: 2,

      worker: async ({ task, workspace }) => {
        gotWorkspace = workspace;
        if (workspace) fs.writeFileSync(path.join(workspace.cwdFor(task), 'done-work.js'), 'X');
        return { verdict: 'fail', failureType: 'timeout', summary: '超时（被硬裁决）' };
      },
    });
    pipe.scheduler.init('L', [{ id: 'w', type: 'implement', role: 'worker', deps: [], budget: { timeoutSec: 30, stallSec: 20, maxAttempts: 1 } }]);
    const res = await pipe.scheduler.run();
    const ev = fs.readFileSync(pipe.progressFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    const sd = ev.filter((e) => e.kind === 'stranded');
    check('L1 自定义 worker 确实拿到了 workspace', !!gotWorkspace);
    check('L2 任务判为失败', res.tasks[0].state !== 'done', res.tasks[0].state);
    check('L3 未完成的工作**没有**被发布到 base', !fs.existsSync(path.join(base, 'done-work.js')));
    check('L4 stranded 事件被发出（不再静默丢失）', sd.length > 0, sd.length ? sd[0].summary.slice(0, 60) : '无事件');
    check('L5 stats.stranded 计数正确', pipe.workspace.stats.stranded === 1, '实际 ' + pipe.workspace.stats.stranded);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {} try { fs.rmSync(rr, { recursive: true, force: true }); } catch {}
  }
  {

    const { makePipeline } = require('./pipeline');
    const base = path.join(os.tmpdir(), 'isoL2-' + Date.now());
    const rr = path.join(os.tmpdir(), 'isoL2R-' + Date.now());
    fs.mkdirSync(base, { recursive: true });
    const p2 = makePipeline({
      base, runRoot: rr, runId: 'isoL2', concurrency: 2,
      worker: async ({ task, workspace }) => { fs.writeFileSync(path.join(workspace.cwdFor(task), 'ok.js'), 'x'); return { verdict: 'done' }; },
    });
    p2.scheduler.init('L2', [{ id: 'g', type: 'implement', role: 'worker', deps: [], budget: { timeoutSec: 30, stallSec: 20, maxAttempts: 1 } }]);
    await p2.scheduler.run();
    const ev2 = fs.readFileSync(p2.progressFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    check('L6 成功任务不得误报搁浅', ev2.filter((e) => e.kind === 'stranded').length === 0);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {} try { fs.rmSync(rr, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (fail === 0 ? '读写隔离回归通过 ✅' : `${fail} 项失败 ❌`));
  process.exit(fail ? 1 : 0);
})();
