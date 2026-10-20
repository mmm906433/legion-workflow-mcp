'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const {makePipeline}=require('./pipeline');
const {execFileSync}=require('child_process');
let fail=0; const chk=(n,c,x='')=>{console.log((c?'  ✓ ':'  ✗ ')+n+(x?' — '+x:''));if(!c)fail++;};
(async()=>{
  console.log('=== 单代理 transcript ===');
  const base=path.join(os.tmpdir(),'ts-'+Date.now()), rr=path.join(os.tmpdir(),'tsr-'+Date.now());
  fs.mkdirSync(base,{recursive:true});
  const p=makePipeline({base,runRoot:rr,runId:'ts',concurrency:3,worker:async({task})=>({verdict:'done',summary:'ok'})});
  p.scheduler.init('g',[
    {id:'a',name:'scout-1',type:'explore',deps:[],budget:{timeoutSec:20,stallSec:15,maxAttempts:1}},
    {id:'b',name:'builder-a',type:'implement',deps:[],budget:{timeoutSec:20,stallSec:15,maxAttempts:1}},
    {id:'c',type:'test',deps:[],budget:{timeoutSec:20,stallSec:15,maxAttempts:1}},
  ]);
  await p.scheduler.run();
  const d=path.join(rr,'transcripts');
  chk('为具名任务各生成一份 transcript',fs.existsSync(d)&&fs.readdirSync(d).sort().join(',')==='builder-a.jsonl,scout-1.jsonl',
    fs.existsSync(d)?fs.readdirSync(d).join(','):'目录不存在');
  const ev=(n)=>fs.readFileSync(path.join(d,n),'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const s1=ev('scout-1.jsonl');
  chk('单代理 transcript 含完整生命周期事件',s1.map(e=>e.kind).join(',').includes('start')&&s1.some(e=>e.kind==='finish'),
    s1.map(e=>e.kind).join(','));
  chk('不同代理的 transcript 不串味',!ev('scout-1.jsonl').some(e=>e.id==='b')&&!ev('builder-a.jsonl').some(e=>e.id==='a'));
  chk('未具名任务不产生 transcript（不做无谓 IO）',!fs.existsSync(path.join(d,'c.jsonl')));

  const out=execFileSync(process.execPath,[path.join(__dirname,'watch.js'),path.join(d,'scout-1.jsonl')],{encoding:'utf8'});
  chk('watch.js 可直接渲染单代理 transcript（点名观察）',out.includes('scout-1'),out.split('\n')[0]);
  chk('渲染中只含该代理的事件',!out.includes('builder-a'));
  try{fs.rmSync(base,{recursive:true,force:true});fs.rmSync(rr,{recursive:true,force:true})}catch{}
  console.log(fail?('\n'+fail+' 项失败 ❌'):'\n单代理 transcript 通过 ✅');
  process.exit(fail?1:0);
})();
