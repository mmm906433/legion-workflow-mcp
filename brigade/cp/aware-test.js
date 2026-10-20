'use strict';

const { TaskAwareness, BranchResume, AgentPool, STAGE } = require('./awareness');

let fail = 0;
const check = (n, c, extra = '') => { console.log(`${c ? '  ✓' : '  ✗'} ${n}${extra ? ' — ' + extra : ''}`); if (!c) fail++; };

(async () => {
  console.log('=== ① 全流程感知（防白跑）===');
  const aw = new TaskAwareness({ staleMs: 1000, dispatchedGraceMs: 300 });

  const t1 = 'ok-task';
  aw.dispatched(t1); aw.accepted(t1); aw.running(t1); aw.progress(t1, '半程');
  aw.verifying(t1); aw.feedback(t1, { quality: 'pass', note: '验收通过' });

  const t2 = 'ghost-task'; aw.dispatched(t2);

  const t3 = 'stuck-task'; aw.dispatched(t3); aw.accepted(t3); aw.running(t3);

  const t4 = 'nofeedback-task'; aw.dispatched(t4); aw.accepted(t4); aw.running(t4); aw.verifying(t4); aw.done(t4);
  await new Promise((r) => setTimeout(r, 1200));

  const liveId = 'live-task'; aw.dispatched(liveId); aw.accepted(liveId); aw.running(liveId); aw.progress(liveId);
  const audit0 = aw.audit();
  check('健康在途任务不被误判白跑', audit0.whiteRuns.every((x) => x.taskId !== liveId) && audit0.inFlight.some((x) => x.taskId === liveId), JSON.stringify({w:audit0.whiteRuns.map(x=>x.taskId),f:audit0.inFlight.map(x=>x.taskId)}));
  await new Promise((r) => setTimeout(r, 400));
  const audit = aw.audit();
  check('检出"派了无人接"', audit.whiteRuns.some((x) => x.taskId === t2), JSON.stringify(audit.whiteRuns.map((x) => x.taskId)));
  check('检出"停滞卡死"', audit.stalled.some((x) => x.taskId === t3), JSON.stringify(audit.stalled.map((x) => x.taskId)));
  check('检出"完成但无质量反馈"', audit.noFeedback.some((x) => x.taskId === t4));
  check('成功任务不在异常名单', !audit.whiteRuns.some((x) => x.taskId === t1) && !audit.stalled.some((x) => x.taskId === t1) && !audit.noFeedback.some((x) => x.taskId === t1));
  const st = aw.stats();
  check('阶段统计正确', st.byStage[STAGE.DONE] === 2, `byStage=${JSON.stringify(st.byStage)}`);
  check('反馈率可见', st.feedbackRate < 100, `${st.feedbackRate}%`);

  console.log('\n=== ② 支线级续跑（不重头再来）===');
  const br = new BranchResume();
  br.register('br1', 'sq-A', ['x1', 'x2', 'x3', 'x4']);
  br.mark('br1', 'x1', 'done'); br.mark('br1', 'x2', 'done');
  br.mark('br1', 'x3', 'failed'); br.mark('br1', 'x4', 'pending');
  const plan = br.planResume('br1');
  check('只重跑未完成的任务', plan.rerun.join(',') === 'x3,x4', 'rerun=' + plan.rerun.join(','));
  check('已完成的结果被保留', plan.keep.join(',') === 'x1,x2', 'keep=' + plan.keep.join(','));
  check('续跑计数', plan.resumeCount === 1);
  const kept = br.keptArtifacts('br1', { x1: 'artifactA', x2: 'artifactB' });
  check('成功产出可注入续跑上下文', kept.length === 2 && kept[0].artifact === 'artifactA', JSON.stringify(kept.map((k) => k.id)));

  br.mark('br1', 'x3', 'done'); br.mark('br1', 'x4', 'done');
  const plan2 = br.planResume('br1');
  check('全完成后无需重跑', plan2.done === true);

  console.log('\n=== ③ Agent/上下文复用决策 ===');
  const pool = new AgentPool({ reuseThreshold: 0.4, maxPerRole: 3 });
  const a1 = pool.acquire('worker', '实现 CSV 解析函数 sum 并写测试');
  check('首个 Agent 新建', a1.reused === false);
  const a2 = pool.acquire('worker', '实现 CSV 解析函数 sum 并写单元测试');
  check('相似任务复用同一 Agent', a2.reused === true && a2.agentId === a1.agentId, `sim=${a2.similarity}`);
  check('复用时带上下文', !!a2.context);
  const a3 = pool.acquire('tester', '为 CSV 解析函数写测试');
  check('不同角色不复用', a3.reused === false && a3.agentId !== a1.agentId);

  pool.report(a1.agentId, { passed: false, note: '失败' });
  const a4 = pool.acquire('worker', '实现 CSV 解析函数 sum 并写测试');
  check('单次失败的 Agent 仍可复用（0.7→0.56≥0.5）', a4.reused === true && a4.agentId === a1.agentId, `reused=${a4.reused}`);
  pool.report(a1.agentId, { passed: false, note: '再失败' });
  const a4b = pool.acquire('worker', '实现 CSV 解析函数 sum 并写测试');
  check('连续两次失败才淘汰换新（0.56→0.45<0.5）', a4b.reused === false || a4b.agentId !== a1.agentId, `reused=${a4b.reused}`);

  pool.report(a1.agentId, { passed: true, note: '修复后通过' });
  const a5 = pool.acquire('worker', '实现 CSV 解析函数 sum 并写测试');
  pool.remember(a5.agentId, 'learned', 'CommonJS 导出风格');
  const a6 = pool.acquire('worker', '实现 CSV 解析函数 sum 并写测试');
  check('上下文记忆可跨任务保持', a6.reused && a6.context && a6.context.learned === 'CommonJS 导出风格', JSON.stringify(a6.context));

  const cjk = new AgentPool({ reuseThreshold: 0.3 });
  const c1 = cjk.acquire('worker', '实现 CSV 解析函数 sum 并写测试');
  const c2 = cjk.acquire('worker', '实现 CSV 解析函数 sum 并写单测');
  check('中文任务可复用(CJK bigram)', c2.reused === true && c2.agentId === c1.agentId, 'sim=' + c2.similarity);
  const c3 = cjk.acquire('worker', '修复登录崩溃 bug');
  const c4 = cjk.acquire('worker', '部署数据库主从复制架构');
  check('不同中文任务不误复用', c4.reused === false, 'sim=' + c4.similarity);

  const np = new AgentPool({ maxPerRole: 2 });
  for (let i = 0; i < 4; i++) np.acquire('planner', '规划方向 ' + i, { noReuse: true });
  check('noReuse 也受 maxPerRole 约束（≤2）', np.stats().byRole.planner <= 2, JSON.stringify(np.stats().byRole));
  const ps = pool.stats();
  check('复用率统计可见', ps.reuseRate > 0, `${ps.reuseRate}%`);

  console.log('\n' + (fail === 0 ? '感知/续跑/复用 全部通过 ✅' : `${fail} 项失败 ❌`));
  process.exit(fail ? 1 : 0);
})();
