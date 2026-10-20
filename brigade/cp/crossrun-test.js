const fs=require('fs'),os=require('os'),path=require('path');
const P='./';
const {Scheduler}=require(P+'scheduler');
let bad=0; const chk=(n,c,x='')=>{console.log((c?'  ✓ ':'  ✗ ')+n+(x?' — '+x:''));if(!c)bad++;};
const NEED=0.32, DECL=0.3;
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cr-'));
const task={id:'s',type:'implement',role:'worker',deps:[],budget:{timeoutSec:DECL,stallSec:DECL*0.8,maxAttempts:1}};
(async()=>{
  console.log('=== 跨 run 学习===');

  const shared=path.join(root,'shared-timing.json');
  const mk=(tag)=>new Scheduler({runId:tag,root:path.join(root,tag),concurrency:2,retryBudget:99,timingFile:shared,
    worker:async()=>{await new Promise(r=>setTimeout(r,NEED*1000));return{verdict:'done'};}});
  let s=mk('r1'); s.init('r1',[task]);
  const r1=await s.run();
  chk('run1 冷启动被杀（建立学习素材）',r1.tasks[0].state==='failed',r1.tasks[0].state);

  s._saveTimingProfile();
  const tf=shared;
  chk('计时画像已落盘',fs.existsSync(tf),tf);
  const prof=JSON.parse(fs.readFileSync(tf,'utf8'));
  const first=Object.values(prof)[0];
  const dur = Array.isArray(first)?first:(first&&first.d)||[];
  const tmo = Array.isArray(first)?0:((first&&first.t)||0);
  chk('画像里记下了该类任务的实际耗时',dur.length>0,JSON.stringify(prof).slice(0,80));
  chk('因超时被杀被单独记为"预算不足"的证据',tmo>0,'timeouts='+tmo);

  const {FeedbackEngine}=require('./feedback');
  const censored=new FeedbackEngine();
  censored.importProfile({'worker::implement':{d:[300000,300010,300020,300030,300040],t:5}});
  const a2=censored.advise({id:'s',role:'worker',type:'implement',budget:{timeoutSec:300,stallSec:240,maxAttempts:1}},{});
  chk('删失观测也能驱动放宽（p90 被截顶时唯一出路）',a2.timeoutSec>300,
    `观测值全部封顶 300s，但因有 5 次超时记录 → 放宽到 ${a2.timeoutSec}s`);
  const nocens=new FeedbackEngine();
  nocens.importProfile({'worker::implement':{d:[290000,295000,298000],t:0}});
  chk('没有超时证据时不多事（不无脑放宽）',nocens.advise({id:'s',role:'worker',type:'implement',budget:{timeoutSec:300,stallSec:240,maxAttempts:1}},{}).timeoutSec===300);

  const s2=mk('r2'); s2.init('r2',[task]);
  const a=s2.feedback.advise(task,{});
  chk('新 run 冷启动即放宽预算（不必先失败两次）',a.timeoutSec>DECL,`${DECL}s → ${a.timeoutSec}s`);
  chk('无进展窗口同步放宽',a.stallSec>DECL*0.8, `stallSec ${DECL*0.8}s → ${a.stallSec}s`);
  const r2=await s2.run();
  chk('新 run 首次执行即成功（不再重复同一失败）',r2.tasks[0].state==='done',r2.tasks[0].state);
  {
    const agedRoot=path.join(os.tmpdir(),'xrun-aged-'+Date.now());
    const agedFile=path.join(agedRoot,'timing-profile.json');
    fs.mkdirSync(agedRoot,{recursive:true});
    fs.writeFileSync(agedFile,JSON.stringify({'worker::implement':{rate:0.5,stallRate:0.5,samples:[],observed:[300000]}}));
    { const t=new Date(Date.now()-8*86400_000); fs.utimesSync(agedFile,t,t); }
    const sA=new Scheduler({runId:'aged',root:agedRoot,concurrency:1,timingFile:agedFile,
      worker:async()=>({verdict:'done',summary:'ok'})});
    sA.init('t',[{id:'x',type:'implement',deps:[],budget:{timeoutSec:300,stallSec:240,maxAttempts:1}}]);
    const freshA=(sA.feedback&&sA.feedback.snapshot&&sA.feedback.snapshot())||{};
    const keysA=Object.keys((freshA&&freshA.stats)||freshA||{}).length;
    chk('画像 7 天老化：过期画像不被导入（快照空）',keysA===0,'keys='+keysA);
    fs.utimesSync(agedFile,new Date(),new Date());
    const sB=new Scheduler({runId:'aged2',root:agedRoot,concurrency:1,timingFile:agedFile,
      worker:async()=>({verdict:'done',summary:'ok'})});
    sB.init('t',[{id:'x',type:'implement',deps:[],budget:{timeoutSec:300,stallSec:240,maxAttempts:1}}]);
    const freshB=(sB.feedback&&sB.feedback.snapshot&&sB.feedback.snapshot())||{};
    const keysB=Object.keys((freshB&&freshB.stats)||freshB||{}).length;
    chk('对照：新鲜画像正常导入',keysB>0,'keys='+keysB);
    try{fs.rmSync(agedRoot,{recursive:true,force:true})}catch{}
  }
  try{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(path.join(root,'timing-profile.json'),{force:true})}catch{}
  console.log(bad?('\n'+bad+' 项失败 ❌'):'\n跨 run 学习通过 ✅');
  process.exit(bad?1:0);
})();
