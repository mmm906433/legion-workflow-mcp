'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const {Scheduler}=require('./scheduler');
let fail=0; const chk=(n,c,x='')=>{console.log((c?'  ✓ ':'  ✗ ')+n+(x?' — '+x:''));if(!c)fail++;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  console.log('=== 降级污染必须可见 ===');
  const root=path.join(os.tmpdir(),'tn-'+Date.now());
  const w=async({task})=>{
    if(task.id==='A') return {verdict:'fail',failureType:'crash',summary:'炸'};
    if(task.id==='B') return {verdict:'done',summary:'B 完成'};
    return {verdict:'done',summary:'C 完成'};
  };
  const s=new Scheduler({runId:'tn',root,concurrency:3,worker:w});
  s.init('t',[
    {id:'A',type:'implement',deps:[],budget:{timeoutSec:20,stallSec:15,maxAttempts:1}},
    {id:'B',type:'test',deps:['A'],budget:{timeoutSec:20,stallSec:15,maxAttempts:1}},
    {id:'C',type:'review',deps:['B'],budget:{timeoutSec:20,stallSec:15,maxAttempts:1}},
  ]);
  const r=await s.run();
  const A=r.tasks.find(t=>t.id==='A'),B=r.tasks.find(t=>t.id==='B'),C=r.tasks.find(t=>t.id==='C');
  chk('A 失败',A.state==='failed',A.state);
  chk('B 因上游失败而降级',B.state==='degraded',B.state);
  chk('C 仍会执行（不级联降级，避免全盘崩）',C.state==='done',C.state);
  chk('C 明确记录输入含降级产出',Array.isArray(C.outcome.taintFrom)&&C.outcome.taintFrom.includes('B'),
    JSON.stringify(C.outcome.taintFrom));
  chk('C 的摘要里能直接看出打折',/降级产出/.test(String(C.outcome.note||'')),String(C.outcome.note).slice(-50));
  chk('污染事件已落盘（可审计）',s.store.listEvents('tn').some(e=>e.kind==='result_tainted'));

  console.log('=== ：降级 taint 合并（覆盖→合并）===');
  const root2=path.join(os.tmpdir(),'tn7-'+Date.now());
  const w2=async({task})=>{
    if(task.id==='A'||task.id==='E') return {verdict:'fail',failureType:'crash',summary:'炸'};
    return {verdict:'done',summary:task.id+' 完成'};
  };
  const s2=new Scheduler({runId:'tn7',root:root2,concurrency:4,worker:w2});
  s2.init('t',[
    {id:'A',type:'implement',deps:[],budget:{timeoutSec:20,stallSec:15,maxAttempts:1}},
    {id:'B',type:'test',deps:['A'],budget:{timeoutSec:20,stallSec:15,maxAttempts:1}},
    {id:'E',type:'implement',deps:[],budget:{timeoutSec:20,stallSec:15,maxAttempts:1}},
    {id:'D',type:'review',deps:['B','E'],budget:{timeoutSec:20,stallSec:15,maxAttempts:1}},
  ]);
  const r2=await s2.run();
  const D=r2.tasks.find(t=>t.id==='D');

  chk('D 降级且污染链同时含 B 与 E',D.state==='degraded'
    &&Array.isArray(D.taintFrom)&&D.taintFrom.includes('B')&&D.taintFrom.includes('E'),
    D.state+' taintFrom='+JSON.stringify(D.taintFrom));
  chk('B 的根因 A 也在链上（第二跳不丢根因）',D.taintFrom.includes('A'),JSON.stringify(D.taintFrom));
  try{fs.rmSync(root2,{recursive:true,force:true})}catch{}
  try{fs.rmSync(root,{recursive:true,force:true})}catch{}
  console.log(fail?('\n'+fail+' 项失败 ❌'):'\n降级污染追踪通过 ✅');
  process.exit(fail?1:0);
})();
