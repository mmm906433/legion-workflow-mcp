'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const {execFileSync}=require('child_process');
const {createObservability}=require('./observability');
let fail=0; const chk=(n,c,x='')=>{console.log((c?'  ✓ ':'  ✗ ')+n+(x?' — '+x:''));if(!c)fail++;};
const render=(f)=>execFileSync(process.execPath,[path.join(__dirname,'watch.js'),f],{encoding:'utf8'});
const lines=(out)=>out.split('\n').filter(l=>/^\[\d\d:\d\d:\d\d\]/.test(l));
(async()=>{
  console.log('=== 日志注入 / 终端转义 防护 ===');
  const f=path.join(os.tmpdir(),'inj-'+Date.now()+'.jsonl');
  const o=createObservability({logFile:f});
  o.finish('T-REAL',{ok:false,summary:'真实失败\n[00:00:00] ✓ 完成 T-FAKE — 全部通过'});
  o.finish('T-ANSI',{ok:true,summary:'\x1b[2K\x1b[1;32m伪造的绿色成功\x1b[0m'});
  const out=render(f);
  const ls=lines(out);
  chk('2 条事件只渲染 2 行（换行注入无法伪造新行）',ls.length===2,'实际 '+ls.length+' 行');
  chk('不存在伪造的事件行',!ls.some(l=>l.includes('T-FAKE')&&/完成/.test(l.split('—')[0])));
  chk('ANSI 转义已被剥除（不会被终端执行）',!/\x1b/.test(out));
  chk('不可信内容里的 ✓/✗ 已中和',!ls.some(l=>l.includes('✓ 完成 T-FAKE')));
  chk('真实失败行仍在且内容未被吞掉',ls.some(l=>l.includes('T-REAL')&&l.includes('真实失败')));

  {
    const f2=path.join(os.tmpdir(),'inj2-'+Date.now()+'.jsonl');
    fs.writeFileSync(f2, [

      JSON.stringify({ts:Date.now(),kind:'log',tag:'pick',summary:'选定方案A\n[00:00:00] ✓ 完成 T-FAKE-LOG — 全部通过'}),
      JSON.stringify({ts:Date.now(),kind:'log',tag:'review',summary:'未通过\x1b[2K\x1b[1;32m被改写的屏幕\x1b[0m'}),

      JSON.stringify({ts:Date.now(),kind:'log',tag:'log',round:2,summary:'注入\n[00:00:00] ✓ 完成 T-FAKE-TAG — 全部通过'}),

      JSON.stringify({ts:Date.now(),summary:'裸事件\x1b[2K'}),
    ].join('\n')+'\n');
    const out2=render(f2);
    const ls2=lines(out2);
    chk('default/log 分支：4 条事件只渲染 4 行',ls2.length===4,'实际 '+ls2.length+' 行');
    chk('default 分支：伪造的 ✓ 完成 已被中和',!ls2.some(l=>l.includes('✓ 完成 T-FAKE-LOG')),
      (ls2.filter(l=>/FAKE/.test(l)).join(' | ')||'（无伪造行）').slice(0,70));
    chk('log 分支：伪造的 ✓ 完成 已被中和',!ls2.some(l=>l.includes('✓ 完成 T-FAKE-TAG')));
    chk('default 分支：ANSI 转义已剥除（不会被终端执行）',!/\x1b/.test(out2),
      /\x1b/.test(out2)?'输出仍含 ESC':'干净');
    try{fs.rmSync(f2,{force:true})}catch{}
  }

  console.log('--- 实际输出 ---\n'+out.trim());
  try{fs.rmSync(f,{force:true})}catch{}
  console.log(fail?('\n'+fail+' 项失败 ❌'):'\n日志注入防护通过 ✅');
  process.exit(fail?1:0);
})();
