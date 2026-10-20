'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkAccept } = require('./executor-codex');

let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) fail++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-accept-'));
const r = { ok: true, text: '任务已完成：所有产物均已生成，并用真实命令逐项验证通过，结果与预期完全一致，无遗留问题。' };

(async () => {
  console.log('=== 可执行验收回归 ===\n');

  check('场景1 exec 通过（exit 0）→ accept',
    checkAccept({ accept: ['exec:node -e "process.exit(0)"'] }, r, tmp) === true);

  check('场景2 exec 失败（exit 1）→ 拒收',
    checkAccept({ accept: ['exec:node -e "process.exit(1)"'] }, r, tmp) === false);

  check('场景3 exec 校验真实产物（sum 对）→ accept',
    checkAccept({ accept: ['exec:node -e "if(2+3!==5)process.exit(1)"'] }, r, tmp) === true);

  check('场景4 exec 校验真实产物（sum 错）→ 拒收',
    checkAccept({ accept: ['exec:node -e "if(2+3!==6)process.exit(1)"'] }, r, tmp) === false);

  fs.writeFileSync(path.join(tmp, 'ok-file.txt'), 'content');
  check('场景5 exec 过 + 点名文件在 → accept',
    checkAccept({ accept: ['exec:node -e "process.exit(0)"', 'ok-file.txt 存在'] }, r, tmp) === true);
  check('场景6 exec 过 + 点名文件缺 → 拒收',
    checkAccept({ accept: ['exec:node -e "process.exit(0)"', 'missing-file.txt 存在'] }, r, tmp) === false);

  check('场景7 无 exec 无文件 → 退化为文本判据（长度够=过）',
    checkAccept({ accept: ['说明你做了什么'] }, r, tmp) === true);

  check('场景8 模型自认失败（结论句否决）→ exec 过也拒收',
    checkAccept({ accept: ['exec:node -e "process.exit(0)"'] },
      { ok: true, text: '任务未完成，实现失败了，缺依赖。' }, tmp) === false);

  check('场景9 exec 超时（30s 上限）→ 拒收',
    checkAccept({ accept: ['exec:node -e "setTimeout(()=>{},60000)"'] }, r, tmp) === false);

  console.log(fail === 0 ? '\n全部通过 ✅' : `\n${fail} 项失败 ❌`);
  process.exit(fail === 0 ? 0 : 1);
})();
