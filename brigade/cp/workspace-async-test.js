'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let fail = 0;
const check = (n, c, x = '') => { console.log(`${c ? '  ✓' : '  ✗'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };

const CONTENT = 'x'.repeat(4096);

function makeTree(base, n) {
  fs.mkdirSync(base, { recursive: true });
  for (let i = 0; i < n; i++) {
    const sub = path.join(base, 'd' + (i % 20));
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'f' + i + '.txt'), CONTENT);
  }
}

(async () => {
  console.log('=== r89-B1#6：allocate 异步物化 + onTick 心跳泵 ===');
  const { Workspace } = require('./workspace');

  {
    const base = path.join(os.tmpdir(), 'wa-' + Date.now());
    const runRoot = path.join(os.tmpdir(), 'war-' + Date.now());
    makeTree(base, 3000);
    const ws = new Workspace({ base, runRoot, runId: 'wa1' });
    let ticks = 0;
    const iv = setInterval(() => { ticks++; }, 20);
    let beats = 0;
    const task = { id: 'w1', type: 'implement', attemptId: 1 };
    const t0 = Date.now();
    const dir = await ws.allocate(task, { onTick: () => { beats++; } });
    const ms = Date.now() - t0;
    clearInterval(iv);
    check('① allocate 期间事件循环存活（20ms 计时器前进 ≥5 次；同步基线 0~2）',
      ticks >= 5, `ticks=${ticks}, copyMs=${ms}`);
    check('① onTick 确实在物化期被泵（≥1 次）', beats >= 1, `beats=${beats}`);
    check('① 物化结果正确（影子里有文件）', fs.existsSync(path.join(dir, 'd0', 'f0.txt')));
    const again = ws.cwdFor(task);
    check('② 二次 cwdFor 缓存命中返回同一路径', again === dir, `${again} vs ${dir}`);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch {}
  }

  {
    const { Workspace } = require('./workspace');
    const base = path.join(os.tmpdir(), 'wa4-' + Date.now());
    const runRoot = path.join(os.tmpdir(), 'wa4r-' + Date.now());
    fs.mkdirSync(base, { recursive: true });
    for (let i = 0; i < 100; i++) {
      const sub = path.join(base, 'fan' + i);
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, 'a.txt'), 'x');
      fs.writeFileSync(path.join(sub, 'b.txt'), 'x');
    }
    const ws4 = new Workspace({ base, runRoot, runId: 'wa4' });
    let beats4 = 0;
    const dir4 = await ws4.allocate({ id: 'wf', type: 'implement', attemptId: 1 }, { onTick: () => { beats4++; } });
    check('④ 扇出树让路（100 目录 × 2 文件，beats ≥ 3；r91 前恒 0）', beats4 >= 3, `beats=${beats4}`);
    check('④ 扇出树物化完整', fs.existsSync(path.join(dir4, 'fan99', 'b.txt')));
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch {}
  }

  {
    const src = fs.readFileSync(path.join(__dirname, 'workspace.js'), 'utf8');
    check('⑤ 源级——manifest 指纹走异步让路版（全量/对账两处调用）',
      (src.match(/await this\._writeShadowManifestAsync\(mfile, dir, yc(Full)?\)/g) || []).length === 2);
    const body = src.slice(
      src.indexOf('async _materializeShadowAsync'),
      src.indexOf('async _writeShadowManifestAsync')
    );
    const loop = body.slice(
      body.indexOf('for (const bf of baseFiles)'),
      body.indexOf('if (fingerprint(dst) === baseFp) continue;')
    );
    check('⑤ 源级——对账循环让路检查在 unchanged-continue 之前（循环顶）',
      loop.includes('yc.onYield'));
    check('⑤ 源级——yc 整树共享（copyDirAsync 递归透传 yc）',
      /await copyDirAsync\(s, d, exclude, rel, yc\)/.test(src) && /const yc = \{ n: 0, lastYield: Date\.now\(\), onYield \};/.test(src));

    check('⑧ 源级——r92 四洞全部异步化在场（头收集/尾 walkDirs/rmrfExtrasAsync/manifest 收集/allocate 收集/异步 rmrf）',
      src.includes('await collectFilesAsync(this.base, this.exclude, baseFiles, yc)')
      && src.includes('const walkDirs = async (d, rel)')
      && src.includes('await rmrfExtrasAsync(dir, keep, this.exclude, keepDirs, yc)')
      && src.includes('await collectFilesAsync(dir, this.exclude, files, yc)')
      && src.includes('await collectFilesAsync(dir, this.exclude, copied,')
      && src.includes('await withBeat(() => fs.promises.rm(dir, { recursive: true, force: true }), onYield)'));
  }

  {
    const { makePipeline } = require('./pipeline');
    const base = path.join(os.tmpdir(), 'wa3-' + Date.now());
    const runRoot = path.join(os.tmpdir(), 'wa3r-' + Date.now());
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, 'seed.txt'), 'x');
    const p = makePipeline({
      base, runRoot, runId: 'wa3', concurrency: 1,
      worker: async () => ({ verdict: 'done', summary: 'ok' }),
    });

    p.workspace._materializeShadowAsync = async (dir, onYield) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'stub.txt'), 'x');
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 120));
        if (onYield) onYield();
      }
    };
    p.scheduler.init('慢物化', [
      { id: 'big', type: 'implement', deps: [], budget: { timeoutSec: 60, stallSec: 1, maxAttempts: 1 } },
    ]);
    const res = await p.scheduler.run();
    const big = res.tasks.find((t) => t.id === 'big');
    check('③ 慢物化(2.4s)+stallSec=1s：物化期靠 onTick 心跳存活，任务 done 而非 stalled',
      big && big.state === 'done', big && `${big.state}${big.outcome && big.outcome.failureType ? '(' + big.outcome.failureType + ')' : ''}`);

    const src = fs.readFileSync(path.join(__dirname, 'pipeline.js'), 'utf8');
    check('③ 源级——pipeline 把 scheduler 的 heartbeat 接进 allocate 的 onTick',
      /allocate\(\s*args\.task\s*,\s*\{\s*onTick:\s*args\.heartbeat\s*\}\s*\)/.test(src));
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch {}
  }

  {
    const wsm = require('./workspace');
    const mkTree = (root) => {
      fs.mkdirSync(path.join(root, 'keepdir', 'sub'), { recursive: true });
      fs.mkdirSync(path.join(root, 'emptykept'), { recursive: true });
      fs.mkdirSync(path.join(root, 'extradir'), { recursive: true });
      fs.writeFileSync(path.join(root, 'keep.js'), 'k');
      fs.writeFileSync(path.join(root, 'keepdir', 'k2.js'), 'k');
      fs.writeFileSync(path.join(root, 'keepdir', 'sub', 'k3.js'), 'k');
      fs.writeFileSync(path.join(root, 'extra1.js'), 'e');
      fs.writeFileSync(path.join(root, 'extradir', 'extra2.js'), 'e');
    };
    const snap = (root) => {
      const out = [];
      const walk = (d, rel) => {
        for (const e of fs.readdirSync(d)) {
          const full = path.join(d, e);
          const r = rel ? rel + '/' + e : e;
          const st = fs.lstatSync(full);
          if (st.isDirectory()) { out.push(r + '/'); walk(full, r); } else out.push(r);
        }
      };
      walk(root, '');
      return out.sort().join('|');
    };
    const ta = path.join(os.tmpdir(), 'wpar-a-' + Date.now());
    const tb = path.join(os.tmpdir(), 'wpar-b-' + Date.now());
    mkTree(ta); mkTree(tb);
    const keep = new Set(['keep.js', path.join('keepdir', 'k2.js'), path.join('keepdir', 'sub', 'k3.js'), 'extra1.js']);
    const keepDirs = new Set(['keepdir', path.join('keepdir', 'sub'), 'emptykept']);
    const excl = new Set(['node_modules']);
    wsm.rmrfExtras(ta, keep, excl, keepDirs);
    const { rmrfExtrasAsync } = wsm;

    await rmrfExtrasAsync(tb, keep, excl, keepDirs, { n: 0, lastYield: Date.now(), onYield: () => {} });
    const sa = snap(ta), sb = snap(tb);
    check('⑥ rmrfExtrasAsync 与同步版行为逐点等价（幸存集一致）', sa === sb && sa.includes('keep.js'),
      'a=' + JSON.stringify(sa) + ' b=' + JSON.stringify(sb));
    try { fs.rmSync(ta, { recursive: true, force: true }); fs.rmSync(tb, { recursive: true, force: true }); } catch {}
  }

  {
    const { Workspace } = require('./workspace');
    const base = path.join(os.tmpdir(), 'wa7-' + Date.now());
    const runRoot = path.join(os.tmpdir(), 'wa7r-' + Date.now());
    fs.mkdirSync(base, { recursive: true });
    for (let i = 0; i < 2000; i++) {
      const sub = path.join(base, 'd' + (i % 40));
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, 'f' + i + '.txt'), 'x');
    }
    const ws7 = new Workspace({ base, runRoot, runId: 'wa7' });
    const task7 = { id: 'wr', type: 'implement', attemptId: 1 };
    await ws7.allocate(task7, { onTick: () => {} });
    ws7._shadows.clear();
    let beats7 = 0;
    const t0 = Date.now();
    await ws7.allocate(task7, { onTick: () => { beats7++; } });
    check('⑦ 对账路径全程心跳（2000 文件全未变 beats ≥100；r91 修复版 ≈39）',
      beats7 >= 100, `beats=${beats7}, ${Math.round((Date.now() - t0) / 100) / 10}s`);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch {}
  }

  {
    const { Workspace } = require('./workspace');
    const base = path.join(os.tmpdir(), 'wa9-' + Date.now());
    const runRoot = path.join(os.tmpdir(), 'wa9r-' + Date.now());
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, 'a.js'), 'A');
    fs.writeFileSync(path.join(base, 'build'), 'B');
    fs.writeFileSync(path.join(base, 'dist'), 'C');
    const ws9 = new Workspace({ base, runRoot, runId: 'wa9' });
    const t9 = { id: 'w9', type: 'implement', attemptId: 1 };
    await ws9.allocate(t9, { onTick: () => {} });
    const d9 = ws9.cwdFor(t9);
    const fullOk = fs.existsSync(path.join(d9, 'build')) && fs.existsSync(path.join(d9, 'dist'));
    ws9._shadows.clear();
    await ws9.allocate(t9, { onTick: () => {} });
    const d9b = ws9.cwdFor(t9);
    const reconOk = fs.existsSync(path.join(d9b, 'build')) && fs.existsSync(path.join(d9b, 'dist'));
    check('⑨ 名为 build/dist 的文件全量拷贝不被排除', fullOk);
    check('⑨ 全量与对账路径行为一致（同一任务两次尝试同料）', reconOk && fullOk);

    {
      const wsS = new Workspace({ base, runRoot: path.join(os.tmpdir(), 'wa9s-' + Date.now()), runId: 'wa9s' });
      const dS = wsS.cwdFor({ id: 'w9', type: 'implement', attemptId: 1 });
      check('⑨ 同步 cwdFor 路径同语义（撞名文件不被排除）',
        fs.existsSync(path.join(dS, 'build')) && fs.existsSync(path.join(dS, 'dist')));

    fs.unlinkSync(path.join(base, 'build'));
    ws9._shadows.clear();
    await ws9.allocate(t9, { onTick: () => {} });
    const d9c = ws9.cwdFor(t9);
    check('⑨ base 已删的撞名文件对账后不残留影子', !fs.existsSync(path.join(d9c, 'build')));
    const pub9 = ws9.publish(t9);
    check('⑨ publish 不复活 base 已删文件', !(pub9.created || []).includes('build') && !fs.existsSync(path.join(base, 'build')),
      'created=' + JSON.stringify(pub9.created));
      try { fs.rmSync(wsS.runRoot, { recursive: true, force: true }); } catch {}
    }
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch {}
  }

  console.log(fail ? ('\n' + fail + ' 项失败 ❌') : '\nallocate 异步物化回归通过 ✅');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('异常:', e && e.stack); process.exit(2); });
