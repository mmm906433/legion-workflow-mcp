'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Workspace } = require('./workspace');

let fails = 0;
const check = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${x ? '  — ' + x : ''}`); if (!c) fails++; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws79-'));
const base = path.join(root, 'base');
const runRoot = path.join(root, 'runs');
fs.mkdirSync(base, { recursive: true });
fs.mkdirSync(runRoot, { recursive: true });

fs.writeFileSync(path.join(base, 'a.js'), 'AAA-v1');
fs.writeFileSync(path.join(base, 'b.js'), 'BBB');
fs.writeFileSync(path.join(base, 'd.js'), 'DDD');
fs.writeFileSync(path.join(base, 'e.js'), 'EEE');
fs.mkdirSync(path.join(base, 'node_modules', 'dep'), { recursive: true });
fs.writeFileSync(path.join(base, 'node_modules', 'dep', 'index.js'), 'module.exports=1;');

const T = { id: 't2', type: 'implement', role: 'worker' };

const w1 = new Workspace({ base, runRoot, runId: 'run-A' });
const w2 = new Workspace({ base, runRoot, runId: 'run-B' });
const d1 = w1.cwdFor({ ...T, attemptId: 0 });
const d2 = w2.cwdFor({ ...T, attemptId: 0 });
check('不同 runId 的同 id 任务拿到不同影子目录', d1 !== d2 && d1.includes('run-A') && d2.includes('run-B'), `${d1} | ${d2}`);
check('影子内容与 base 一致（首拷贝）',
  fs.readFileSync(path.join(d1, 'a.js'), 'utf8') === 'AAA-v1' && fs.existsSync(path.join(d1, 'e.js')));
check('manifest 落在影子目录旁（不进影子内部）',
  fs.existsSync(d1 + '.manifest.json') && !fs.existsSync(path.join(d1, '.manifest.json')));

check('node_modules 以 junction 进影子，依赖可读',
  fs.readFileSync(path.join(d1, 'node_modules', 'dep', 'index.js'), 'utf8') === 'module.exports=1;');

fs.writeFileSync(path.join(base, 'a.js'), 'AAA-v2');
fs.unlinkSync(path.join(base, 'd.js'));
fs.writeFileSync(path.join(d1, 'b.js'), 'AGENT-MUTATED');
fs.writeFileSync(path.join(d1, 'agent-own.js'), 'HALF-DONE');
const eMtimeBefore = fs.statSync(path.join(d1, 'e.js')).mtimeMs;

const d1b = w1.cwdFor({ ...T, attemptId: 1 });
check('重试复用同一影子目录（增量路径）', d1b === d1);
check('base 改动的文件已同步进影子', fs.readFileSync(path.join(d1, 'a.js'), 'utf8') === 'AAA-v2');
check('子代理改过的文件被还原为 base 内容', fs.readFileSync(path.join(d1, 'b.js'), 'utf8') === 'BBB');
check('子代理私造的半成品被清掉', !fs.existsSync(path.join(d1, 'agent-own.js')));
check('base 已删除的文件从影子消失', !fs.existsSync(path.join(d1, 'd.js')));
check('两边都没动的文件未被重写（mtime 不变）', fs.statSync(path.join(d1, 'e.js')).mtimeMs === eMtimeBefore,
  `before=${eMtimeBefore} after=${fs.statSync(path.join(d1, 'e.js')).mtimeMs}`);
check('对账后 junction 仍在、依赖仍可读',
  fs.readFileSync(path.join(d1, 'node_modules', 'dep', 'index.js'), 'utf8') === 'module.exports=1;');
check('对账后 base 的 node_modules 原封未动（未穿越联接删除）',
  fs.existsSync(path.join(base, 'node_modules', 'dep', 'index.js')));

const idx = path.join(runRoot, 'fp-index-' + require('crypto').createHash('sha1')
  .update(base.replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 12) + '.json');
check('指纹索引已落盘', fs.existsSync(idx));

fs.writeFileSync(path.join(base, 'e.js'), 'EEE-v2');
const w3 = new Workspace({ base, runRoot, runId: 'run-C' });
const d3 = w3.cwdFor({ ...T, attemptId: 0 });
check('内容变化后指纹不喂陈旧缓存（影子拿到新内容）',
  fs.readFileSync(path.join(d3, 'e.js'), 'utf8') === 'EEE-v2');

fs.rmSync(root, { recursive: true, force: true });
{
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ws80-'));
  const base2 = path.join(root2, 'base'), runRoot2 = path.join(root2, 'runs');
  fs.mkdirSync(path.join(base2, 'empty-dir', 'nested-empty'), { recursive: true });
  fs.mkdirSync(path.join(base2, 'with-file'), { recursive: true });
  fs.writeFileSync(path.join(base2, 'with-file', 'a.txt'), 'A');
  const w = new Workspace({ base: base2, runRoot: runRoot2, runId: 'l1' });
  const T = { id: 't1', type: 'implement', role: 'worker' };
  const d = w.cwdFor({ ...T, attemptId: 0 });
  fs.writeFileSync(path.join(d, 'agent.txt'), 'X');
  w.cwdFor({ ...T, attemptId: 1 });
  check('L1：纯空目录对账后保留（≡全新拷贝语义）',
    fs.existsSync(path.join(d, 'empty-dir', 'nested-empty')) && fs.existsSync(path.join(d, 'with-file')));
  check('L1：子代理私造文件仍被清理', !fs.existsSync(path.join(d, 'agent.txt')));
  fs.rmSync(root2, { recursive: true, force: true });
}

{
  const root3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ws80c-'));
  const base3 = path.join(root3, 'Mixed-Base');
  const runRoot3 = path.join(root3, 'mixed-base', 'runs');
  fs.mkdirSync(base3, { recursive: true });
  fs.writeFileSync(path.join(base3, 'a.txt'), 'A');
  let threw = null;
  try { new Workspace({ base: base3, runRoot: runRoot3 }); } catch (e) { threw = e; }
  check('大小写等价的 runRoot∈base 抛错（旧实现仅字面比较被绕过）', !!threw && /不得位于/.test(threw.message),
    threw ? threw.message.slice(0, 60) : '未抛');
  fs.rmSync(root3, { recursive: true, force: true });
}

console.log(fails === 0 ? '\n影子对账/碰撞/junction 全部通过 ✅' : `\n${fails} 项失败 ❌`);
process.exit(fails ? 1 : 0);
