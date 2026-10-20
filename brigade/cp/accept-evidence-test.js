'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let fails = 0;
const check = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${x ? '  — ' + x : ''}`); if (!c) fails++; };
const SRC = __dirname;
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

console.log('=== 验收门禁的证据维度 ===\n');

const code = strip(fs.readFileSync(path.join(SRC, 'executor-codex.js'), 'utf8'));
const m = code.match(/function checkAccept\(task,\s*r,\s*cwd\)\s*\{[\s\S]*?\n\}/);
check('能定位到 checkAccept 实现（新版签名接受 cwd）', !!m);

{
  const body = m ? m[0] : '';
  const usesArtifact = /namedArtifacts|cwd|existsSync|statSync/.test(body);
  check('checkAccept 已纳入产物证据维度（不再只看文本）', usesArtifact);
  const usesEvery = /all\.every\(/.test(body) && /namedArtifacts/.test(body);
  check('点名文件必须**全部**存在（every 语义保持；r74 起与 exec 条目合并判定）', usesEvery,
    'some 会让不相干的证据为验收背书');
}

{
  const { checkAccept } = require('./executor-codex');
  const mk = (fn) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r68-')); fn(d); return d; };
  const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} };

  const dA = mk((d) => fs.writeFileSync(path.join(d, 'parse.js'), 'module.exports={sum:()=>15};'));
  const A = checkAccept({ accept: ['parse.js 存在且可被 require', 'sum() 返回 15'] },
    { text: 'Let me verify by running it with node' }, dA);
  check('场景A：产物已做对但只说了半句话 → 判通过（修复前是判失败）', A === true);
  rm(dA);

  const dA2 = mk(() => {});
  const A2 = checkAccept({ accept: ['parse.js 存在'] }, { text: 'Let me verify by running it with node' }, dA2);
  check('场景A2：点名文件不存在 → 判不通过', A2 === false);
  rm(dA2);

  const dA3 = mk((d) => fs.writeFileSync(path.join(d, 'empty.txt'), ''));
  const A3 = checkAccept({ accept: ['empty.txt 存在'] }, { text: 'done' }, dA3);
  check('场景A3：文件存在但为空 → 判不通过（空文件不是证据）', A3 === false);
  rm(dA3);
}

{
  const { checkAccept } = require('./executor-codex');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r68b-'));
  fs.writeFileSync(path.join(d, 'parse.js'), 'x');
  const fail = checkAccept({ accept: ['parse.js 存在'] }, { text: '我未能完成这个任务，无法做到要求的事情。' }, d);
  check('明确声明未完成 → 判不通过（即使产物在也不能翻案）', fail === false,
    '这条不能被放宽，否则半成品会冒充成品');
  fs.rmSync(d, { recursive: true, force: true });
}

{
  const { checkAccept } = require('./executor-codex');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r68d-'));
  fs.writeFileSync(path.join(d, 'parse.js'), 'module.exports={sum:()=>15};');
  const real = '### 做了什么\n- **未创建或修改任何文件。** 工作区里 `parse.js` 和 `data.txt` 在我开始之前就已存在（两者 `LastWriteTime` 均为 2026-01-01 00:00，且目录下无 git 仓库，无法用 `git status` 佐证，但时间戳与本次运行时间一致，说明不是本次产生）。\n- 复查了已存在的实现 `parse.js`，它已满足任务全部要求：\n  - `module.exports = { sum, list }`；`sum()` 为所有数字之和\n  - 顶部注释风格与仓库其它文件一致';
  check('r70 真实场景：方法论里的"无法"不否决正确产出',
    checkAccept({ accept: ['parse.js 存在且可被 require', 'sum() 返回 15'] }, { text: real }, d) === true,
    '做对了却判失败 —— 这是 r68 引入的回归，由 r70 修掉');
  check('r70 但真正的失败声明仍被否决',
    checkAccept({ accept: ['parse.js 存在'] }, { text: '我未能完成这个任务，parse.js 无法实现。' }, d) === false);
  fs.rmSync(d, { recursive: true, force: true });
}

{
  const { checkAccept } = require('./executor-codex');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r68c-'));
  const longText = '已完成。我读了输入文件，创建了输出模块，并运行了 node 验证求和结果为 15，名字数组为 a,b,c。全部验收标准均已满足。';
  check('文本充分(>=60) → 判通过（走旧路径）',
    checkAccept({ accept: ['质量达标'] }, { text: longText }, d) === true, `长度 ${longText.length}`);
  check('文本过短 → 判不通过（走旧路径）',
    checkAccept({ accept: ['质量达标'] }, { text: '好了' }, d) === false);
  fs.rmSync(d, { recursive: true, force: true });
}

{
  const { checkAccept } = require('./executor-codex');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r68e-'));
  fs.mkdirSync(path.join(d, '_e2e_r3'), { recursive: true });
  fs.writeFileSync(path.join(d, '_e2e_r3', 'parse.js'), 'module.exports={sum:()=>60};');
  check('r71 产物在子目录里 → 判通过（修复前判失败）',
    checkAccept({ accept: ['parse.js 存在且可被 require', 'sum() 返回 60'] },
      { text: '已完成，验证通过。' + 'x'.repeat(80) }, d) === true);

  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'r68f-'));
  check('r71 递归查找不制造假通过：确实不存在 → 判不通过',
    checkAccept({ accept: ['parse.js 存在'] }, { text: '已完成，验证通过。' + 'x'.repeat(80) }, d2) === false);

  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'r68g-'));
  fs.mkdirSync(path.join(d3, 'a', 'b', 'c', 'd'), { recursive: true });
  fs.writeFileSync(path.join(d3, 'a', 'b', 'c', 'd', 'parse.js'), 'x');
  check('r71 限深 3 层：4 层嵌套不命中（有界，不是全盘扫描）',
    checkAccept({ accept: ['parse.js 存在'] }, { text: '已完成，验证通过。' + 'x'.repeat(80) }, d3) === false);

  const d4 = fs.mkdtempSync(path.join(os.tmpdir(), 'r68h-'));
  fs.mkdirSync(path.join(d4, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(d4, 'node_modules', 'pkg', 'parse.js'), 'x');
  check('r71 跳过 node_modules（依赖里的同名文件不算证据）',
    checkAccept({ accept: ['parse.js 存在'] }, { text: '已完成，验证通过。' + 'x'.repeat(80) }, d4) === false);

  [d, d2, d3, d4].forEach((x) => { try { fs.rmSync(x, { recursive: true, force: true }); } catch {} });
}

{
  const { checkAccept } = require('./executor-codex');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r78-'));
  fs.writeFileSync(path.join(d, 'readme.md'), '# 项目\n');
  const healthyReport = '只读勘察完成。列出目录：仅有 readme.md 一个文件。' +
    'math.js 不存在（通配符 **/* 全目录确认）。node 命令可用，版本 v26.10.0。结论：math.js 需新建。';
  check('r78 勘察任务如实报告"文件不存在" → 判通过（不再被文件推断误杀）',
    checkAccept({ type: 'explore', accept: ['明确 math.js 是否已存在', '明确 node 可用及版本'] },
      { text: healthyReport }, d) === true,
    '修复前：提到 math.js → 文件必须存在 → 勘察员如实报告反被判失败');
  check('r78 生产型任务仍受文件推断约束（行为不变）',
    checkAccept({ type: 'implement', accept: ['math.js 存在且导出 add'] }, { text: healthyReport }, d) === false);

  check('r78 审查任务退回文本判据',
    checkAccept({ type: 'review', accept: ['给出明确 PASS 或 FAIL 结论'] },
      { text: '审查完成：实现正确，边界覆盖充分。结论：PASS，可以合入。' }, d) === true);
  fs.rmSync(d, { recursive: true, force: true });
}

{
  const { checkAccept } = require('./executor-codex');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r80-'));
  fs.writeFileSync(path.join(d, 'math.js'), 'module.exports={add:(a,b)=>a+b};');
  const good = '已完成实现。创建 math.js 导出 add，真实运行 node 验证 add(2,3)=5 通过，输出正确。';
  check('r80 伪命令 exec 条目不再弄死任务（退回文本判据）',
    checkAccept({ type: 'implement', accept: ['math.js 存在且导出 add', 'exec:上述 node 断言命令退出码为 0'] },
      { text: good }, d) === true,
    '修复前：中文描述进 shell 必非零 → acceptance_failed');
  check('r80 全部条目都是伪命令时不得假通过（文本判据兜底）',
    checkAccept({ type: 'implement', accept: ['exec:上述命令退出码为 0'] },
      { text: '好了' }, d) === false,
    '伪命令被剔除后走文本长度判据，敷衍短文必须拦');
  check('r80 真命令 exec 条目照常机器判',
    checkAccept({ type: 'implement', accept: [`exec:node -e "const m=require('./math.js');if(m.add(2,3)!==5)process.exit(1)"`] },
      { text: good }, d) === true);
  const bad = checkAccept({ type: 'implement', accept: [`exec:node -e "process.exit(1)"`] },
    { text: good }, d);
  check('r80 真命令失败仍判不通过', bad === false);
  fs.rmSync(d, { recursive: true, force: true });
}

{
  const { checkAccept } = require('./executor-codex');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r80f-'));
  fs.writeFileSync(path.join(d, 'math.js'), 'module.exports={add:(a,b)=>a+b,mul:(a,b)=>a*b};');
  const good = '已完成实现。创建 math.js 导出 add 与 mul，真实运行 node 验证 add(2,3)=5、mul(2,3)=6 输出正确。';
  check('r80-R6 属性引用（m.add）不再被当文件名误杀',
    checkAccept({ type: 'implement', accept: ['math.js 存在且包含 add 与 mul 定义', '通过 require 可取到 m.add 与 m.mul 均为 function'] },
      { text: good }, d) === true,
    '修复前：m.add 被当文件在影子目录找不到 → acceptance_failed（worker 实测输出 5/6 却被判死）');

  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'r80g-'));
  check('r80-R6 常规文件名推断保持（data.txt 未产出仍判失败）',
    checkAccept({ type: 'implement', accept: ['data.txt 已生成'] }, { text: good }, d2) === false);
  check('r80-R6 带路径的任意扩展名仍认（build/out.x 被找）',
    checkAccept({ type: 'implement', accept: ['build/out.x 已生成'] }, { text: good }, d2) === false);
  fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(d2, { recursive: true, force: true });
}

{
  const { checkAccept } = require('./executor-codex');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r80h-'));
  fs.mkdirSync(path.join(d, 'build'), { recursive: true });
  fs.writeFileSync(path.join(d, 'build', 'out.x'), 'x');
  fs.writeFileSync(path.join(d, 'my.file.js'), 'module.exports=1;');
  const good = '已完成实现。创建产物并真实运行验证通过，输出与预期一致，无遗留问题。';
  check('R7 反斜杠路径 build\\out.x 命中（已产出→过）',
    checkAccept({ type: 'implement', accept: ['build\\out.x 已生成'] }, { text: good }, d) === true);
  check('R7 含点 stem my.file.js 完整识别（已产出→过）',
    checkAccept({ type: 'implement', accept: ['my.file.js 已生成'] }, { text: good }, d) === true);
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'r80i-'));
  check('R7 白名单外裸扩展名（xxx.foo）退文本判据：未产出但文本充分→过',
    checkAccept({ type: 'implement', accept: ['xxx.foo 存在'] }, { text: good }, d2) === true);
  check('R7 白名单 xxx.sln 现属文件判据：未产出→拦',
    checkAccept({ type: 'implement', accept: ['xxx.sln 存在'] }, { text: good }, d2) === false);
  fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(d2, { recursive: true, force: true });
}

{
  const { checkAccept } = require('./executor-codex');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r80j-'));
  fs.writeFileSync(path.join(d, 'math.js'), 'module.exports={add:(a,b)=>a+b,mul:(a,b)=>a*b};');
  const good = '已完成实现。创建 math.js 导出 add 与 mul，真实运行 node 验证输出 function function 5 6，全部通过。';
  check('R7 绝对路径 accept（C:\\…\\math.js 存在）按 basename 核对',
    checkAccept({ type: 'implement', accept: [`${d}\\math.js 存在`, 'module.exports 导出 add 与 mul 且为函数'] },
      { text: good }, d) === true,
    '修复前：join(cwd,绝对路径)=非法路径 → 找不到 → 做对了也 acceptance_failed');
  fs.rmSync(d, { recursive: true, force: true });
}

{
  const { checkAccept } = require('./executor-codex');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r80k-'));
  fs.writeFileSync(path.join(d, 'readme.md'), '# 项目\n');
  const honestRecon = '只读勘察工作区现状。\n### 做了什么\n- 列出工作区：仅 readme.md\n' +
    '- 确认 math.js 不存在：无法检查其 add/mul 导出情况，后续任务需新建该文件\n' +
    '### 验证\n- 运行 node --version：v26.10.0，Node 运行时可用。';
  check('R7 勘察员如实报告「不存在→无法检查」不再被否决',
    checkAccept({ type: 'explore', accept: ['列出工作区文件清单并明确 math.js 是否存在', '给出 node 可用版本'] },
      { text: honestRecon }, d) === true,
    '修复前：「无法×任务」结论句否决 → 整轮级联报废（t2-t4 全灭）');
  check('R7 生产型任务自称失败仍被否决（语义不放松）',
    checkAccept({ type: 'implement', accept: ['功能可用'] },
      { text: '我未能完成这个任务，功能无法实现。' }, d) === false);
  fs.rmSync(d, { recursive: true, force: true });
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
