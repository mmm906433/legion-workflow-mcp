'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let fail = 0;
const check = (n, c, x = '') => { console.log(`${c ? '  ✓' : '  ✗'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };

const { sweep } = require('../brigade');

const root = path.join(os.tmpdir(), 'sweep-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
const DAY = 86400_000;
const mkDir = (p, mtimeDaysAgo) => { fs.mkdirSync(p, { recursive: true }); if (mtimeDaysAgo != null) { const t = new Date(Date.now() - mtimeDaysAgo * DAY); fs.utimesSync(p, t, t); } };
const writeMeta = (runId, meta) => {
  const d = path.join(root, runId); mkDir(d);
  fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify(meta));
};

try {
  console.log('=== ：sweep 活跃守卫 / interrupted 宽限 / conflicts 清理 ===');

  const liveId = '2026-01-01T00-00-00-live';
  writeMeta(liveId, { phase: 'running', startedAt: new Date().toISOString() });
  const shadowTree = path.join(root, 'shadow', liveId + '-p4242', 'w');
  mkDir(shadowTree, 4);
  fs.writeFileSync(path.join(shadowTree, 'f.txt'), 'shadow content');

  const intFresh = '2026-01-01T00-00-00-intfresh';
  writeMeta(intFresh, { phase: 'interrupted', interruptedAt: new Date(Date.now() - 1 * DAY).toISOString() });

  const intOld = '2026-01-01T00-00-00-intold';
  writeMeta(intOld, { phase: 'interrupted', interruptedAt: new Date(Date.now() - 8 * DAY).toISOString() });
  { const d = path.join(root, intOld); const t = new Date(Date.now() - 8 * DAY); fs.utimesSync(d, t, t); }

  const confOldRun = path.join(root, 'conflicts', 'oldrun');
  mkDir(path.join(confOldRun, 'w-a1-x'), null);
  fs.writeFileSync(path.join(confOldRun, 'w-a1-x', 'a.js'), 'task-side');
  { const t = new Date(Date.now() - 4 * DAY); fs.utimesSync(confOldRun, t, t); }
  const confFreshRun = path.join(root, 'conflicts', 'newrun');
  mkDir(path.join(confFreshRun, 'w-a1-y'), null);

  sweep(1, 3, root);

  check('① 活跃 run 的过期 mtime 影子子树幸存（防删除传播误删 base）',
    fs.existsSync(shadowTree), fs.existsSync(shadowTree) ? '' : '被清了——P1 级后患');
  check('② interrupted 7 天内保留（--resume 目标不失）',
    fs.existsSync(path.join(root, intFresh)));
  check('③ interrupted 超 7 天被收走',
    !fs.existsSync(path.join(root, intOld)));
  check('④ conflicts 超龄被清、新鲜保留',
    !fs.existsSync(confOldRun) && fs.existsSync(confFreshRun));
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}

console.log(fail ? ('\n' + fail + ' 项失败 ❌') : '\nsweep 守卫回归通过 ✅');
process.exit(fail ? 1 : 0);
