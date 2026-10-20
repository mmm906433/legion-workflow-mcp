'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const {makePipeline}=require('./pipeline');
const {makeCodexExecutor}=require('./executor-codex');
const SRC = __dirname;
const N=parseInt(process.argv[2]||'6',10), TMO=parseInt(process.argv[3]||'300',10);
const Q=[
 ['transit-deadlock',`读 ${SRC}/scheduler.js 的 transit() 函数。回答：它有哪些 return false 的分支？每种情况下任务会停在哪���状态、是否还能被再次捞起？只依据你实际读到的代码。`],
 ['execute-kill-window',`读 ${SRC}/scheduler.js 的 execute() 函数。回答：worker 执行期间如果进程被杀，任务可能停在哪几种状态？每种状态下看门狗/租约回收能不能救回来？`],
 ['publish-exits',`读 ${SRC}/workspace.js 的 publish() 函数。回答：它有哪几条提前 return 或 throw 的路径？每条路径下影子目录会被清理还是残留？`],
 ['gate-stale',`读 ${SRC}/hierarchy.js 的 makeWriteGate 函数。回答：它依赖 command._liveTasks 这个"上一 tick 的任务表"。如果上一 tick 与本 tick 之间状态已变，闸门判断会错吗？怎么错？`],
 ['fencing-bypass',`读 ${SRC}/store.js 的 saveTasks 函数。回答：有没有任何一条调用路径能绕过 epoch 校验把陈旧数据写进去？当前 _epochCache 引入后，跨进程场景还安全吗？`],
 ['misleading-observability',`读 ${SRC}/observability.js 与 ${SRC}/watch.js。回答：存在哪种情况会让运维看 watch.js 输出时误以为一切正常，而实际有问题？`],
];
(async()=>{

  const RUNS = path.join(__dirname, '..', 'runs');
  const base=path.join(os.tmpdir(),'pb-'+Date.now()), rr=RUNS;
  fs.mkdirSync(base,{recursive:true});
  const pipe=makePipeline({base,runRoot:rr,runId:'probe',concurrency:3});
  pipe.scheduler.worker=makeCodexExecutor({workspace:pipe.workspace,cwd:base});
  const store=pipe.scheduler.store;
  const list=Q.slice(0,N);
  pipe.scheduler.init('工作流自检探针 '+(process.env.PROBE_TAG||''),list.map(([id,d])=>({id,type:'explore',role:'researcher',deps:[],
    budget:{timeoutSec:TMO,stallSec:Math.floor(TMO*0.85),maxAttempts:1},input:{description:d}})));
  const t0=Date.now();
  const res=await pipe.scheduler.run();
  console.log(`\n=== 完成，用时 ${Math.round((Date.now()-t0)/1000)}s ===\n`);
  for(const [id] of list){
    const t=res.tasks.find(x=>x.id===id);
    const arts=store.listArtifacts(pipe.scheduler.runId,{taskId:id});
    const body=arts.length?String(arts[arts.length-1].body||''):'';
    console.log('='.repeat(70));
    console.log(`【${id}】${t.state}  ${body.length} 字符`);
    console.log('='.repeat(70));
    console.log(body.slice(0,1400)||'(无产出)');
    console.log();
  }
  try{fs.rmSync(base,{recursive:true,force:true})}catch{};try{fs.rmSync(rr,{recursive:true,force:true})}catch{};
})();
