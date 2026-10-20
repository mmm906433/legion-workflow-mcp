'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const {Scheduler}=require('./scheduler');
const {makeTask,validatePlan}=require('./task');
let fail=0; const chk=(n,c,x='')=>{console.log((c?'  ✓ ':'  ✗ ')+n+(x?' — '+x:''));if(!c)fail++;};
(async()=>{
  console.log('=== 子代理可命名 / 可寻址 ===');
  const root=path.join(os.tmpdir(),'ad-'+Date.now());
  const s=new Scheduler({runId:'ad',root,concurrency:2,worker:async({task})=>({verdict:'done',summary:task.name||task.id})});
  s.init('g',[
    {id:'t1',name:'scout-1',type:'explore',deps:[],budget:{timeoutSec:20,stallSec:15,maxAttempts:1}},
    {id:'t2',name:'builder-a',type:'implement',deps:['t1'],budget:{timeoutSec:20,stallSec:15,maxAttempts:1}},
    {id:'t3',type:'test',deps:[],budget:{timeoutSec:20,stallSec:15,maxAttempts:1}},
  ]);
  chk('命名任务被接受',s.all().find(t=>t.id==='t1').name==='scout-1');
  chk('未命名任务 name 为 null',s.all().find(t=>t.id==='t3').name===null);
  chk('按名寻址命中唯一对象',s.byName('builder-a').id==='t2');
  chk('寻址不存在的名字返回 null',s.byName('不存在')===null);
  await s.run();
  const addr=s.addressable();
  chk('可寻址清单只含具名任务',addr.length===2 && addr.every(a=>a.state),JSON.stringify(addr.map(a=>a.id+':'+a.state)));
  chk('清单带状态，便于"点名观察"',addr.find(a=>a.id==='t2').state==='done');

  let dup=false, bad=false;
  try{ validatePlan([makeTask({id:'a',name:'x',type:'explore'}),makeTask({id:'b',name:'x',type:'explore'})]); }catch(e){ dup=/重复/.test(e.message); }
  try{ makeTask({id:'a',name:'bad name!',type:'explore'}); validatePlan([makeTask({id:'a',name:'bad name!',type:'explore'})]); }catch(e){ bad=true; }
  chk('重名在计划期被拒（否则寻址指向不确定）',dup);
  chk('非法名被拒',bad);
  try{fs.rmSync(root,{recursive:true,force:true})}catch{}
  console.log(fail?('\n'+fail+' 项失败 ❌'):'\n子代理寻址通过 ✅');
  process.exit(fail?1:0);
})();
