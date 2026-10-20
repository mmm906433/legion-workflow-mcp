const { FeedbackEngine } = require('./feedback');
let bad=0; const chk=(n,c,x='')=>{console.log((c?'  ✓ ':'  ✗ ')+n+(x?' — '+x:''));if(!c)bad++;};
const T={id:'t',role:'r',type:'implement',budget:{timeoutSec:300,stallSec:240,maxAttempts:3}};
console.log('=== 预算自适应：慢 ≠ 不可靠 ===');

{ const f=new FeedbackEngine();
  for(let i=0;i<4;i++) f.record(T,{verdict:'fail',failureType:'timeout',ms:295000});
  const a=f.advise(T,{});
  chk('慢而被杀的任务预算被放宽（不是收紧）',a.timeoutSec>300,'实际 '+a.timeoutSec+'s（声明 300s）');
  chk('放宽量由实测 p90 推出而非写死',a.timeoutSec>=Math.ceil(295*1.3*0.9),'p90≈295s → 期望约 '+Math.ceil(295*1.3)+'s');
  chk('仍有安全上限',a.timeoutSec<=3600,'实际 '+a.timeoutSec);
}

{ const f=new FeedbackEngine();
  for(let i=0;i<4;i++) f.record(T,{verdict:'fail',failureType:'crash',ms:1200});
  const a=f.advise(T,{});
  chk('快失败不再压低预算——声明值是下限',a.timeoutSec>=300,'实际 '+a.timeoutSec+'s');
  chk('预算恒为正数（不会变负）',a.timeoutSec>0);
}

{ const f=new FeedbackEngine(); const a=f.advise(T,{});
  chk('冷启动不擅自改预算',a.timeoutSec===300,'实际 '+a.timeoutSec);
}

{ const f=new FeedbackEngine();
  for(let i=0;i<5;i++) f.record(T,{verdict:'done',ms:90000});
  const a=f.advise(T,{});
  chk('稳定成功的任务预算不被压低',a.timeoutSec>=300,'实际 '+a.timeoutSec);
}
console.log(bad?('\n'+bad+' 项失败 ❌'):'\n预算自适应通过 ✅');
process.exit(bad?1:0);
