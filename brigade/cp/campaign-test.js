'use strict';

const { Campaign, VERDICT } = require('./campaign');

let fail = 0;
const check = (n, c, extra = '') => { console.log(`${c ? '  ✓' : '  ✗'} ${n}${extra ? ' — ' + extra : ''}`); if (!c) fail++; };

(async () => {

  console.log('=== 场景1：多轮迭代（首轮审核不通过→修正→通过）===');
  let round = 0;
  const execCalls = [];
  const camp = new Campaign('实现用户登录功能', {
    planners: 2,
    maxRounds: 4,
    planner: async ({ goal, round: r, previousGaps, variant }) => ({
      approach: `方向${variant}：${previousGaps.length ? '针对缺口修正' : '初始方案'}`,
      plan: [{ name: 'step-' + variant }, { name: 'step2-' + variant }],
      agentId: 'planner-' + variant,
    }),
    executor: async ({ task, gaps, artifacts, context, agent, round: r }) => {
      execCalls.push({ round: r, task: task.name, gapsSeen: gaps.length, artifactsSeen: artifacts.length, hadMemory: !!(context && context.lesson) });

      const ok = r > 1;
      return {
        ok,
        summary: ok ? '产出可用' : '产出不达标',
        artifacts: [{ task: task.name, quality: ok ? 'good' : 'bad' }],
        memory: ok ? '登录要处理 token 刷新' : null,
      };
    },
    reviewer: async ({ round: r }) =>
      r >= 2
        ? { verdict: VERDICT.PASS, quality: 0.9, gaps: [] }
        : { verdict: VERDICT.FAIL, quality: 0.3, gaps: ['缺少 token 刷新', '错误处理不全'] },
  });

  const rep = await camp.run();
  check('多轮迭代直到审核通过', rep.rounds === 2, `rounds=${rep.rounds}`);
  check('最终状态为达成', rep.status === 'done', rep.status);
  check('首轮执行确实拿到了审核缺口做定向修正', execCalls.some((c) => c.round === 2 && c.gapsSeen === 2), JSON.stringify(execCalls.map((c) => `R${c.round}:${c.task}:gaps${c.gapsSeen}`)));
  check('第2轮执行看到了前一轮产出（不重头再来）', execCalls.some((c) => c.round === 2 && c.artifactsSeen > 0), `artifactsSeen=${execCalls.map((c) => c.artifactsSeen).join(',')}`);
  check('有 Agent 带着上下文记忆被保留', rep.retainedAgents.length >= 1, JSON.stringify(rep.retainedAgents.map((a) => a.agentId)));

  console.log('\n=== 场景2：规划分流（派不同子Agent找方向）===');
  const planVariants = [];
  const camp2 = new Campaign('优化检索性能', {
    planners: 3,
    maxRounds: 1,
    planner: async ({ variant, goal }) => {
      planVariants.push(variant);
      return { approach: `方案${variant}`, plan: [{ name: 's' + variant }], agentId: 'p' + variant };
    },
    executor: async () => ({ ok: true, summary: 'ok', artifacts: [{}] }),
    reviewer: async () => ({ verdict: VERDICT.PASS, quality: 1, gaps: [] }),
  });
  const rep2 = await camp2.run();
  check('派了 3 个规划子 Agent 并行找方向', planVariants.length === 3 && new Set(planVariants).size === 3, planVariants.join(','));
  check('指挥部裁决选了一个方案', !!rep2.chosenApproach, rep2.chosenApproach);

  console.log('\n=== 场景3：审核对抗幻觉===');
  const camp3 = new Campaign('实现 API', {
    planners: 1, maxRounds: 3,
    planner: async () => ({ approach: 'A', plan: [{ name: 's1' }] }),
    executor: async () => ({ ok: true, summary: '我完成了（其实没做）', artifacts: [{ fake: true }] }),
    reviewer: async ({ artifacts }) =>

      artifacts.some((a) => a.fake)
        ? { verdict: VERDICT.FAIL, quality: 0, gaps: ['产出是幻觉，没有实际文件'] }
        : { verdict: VERDICT.PASS, quality: 1, gaps: [] },
  });
  const rep3 = await camp3.run();
  check('幻觉产出被打回重做（未一次通过就结束）', rep3.rounds === 3, `rounds=${rep3.rounds}（达到上限仍未通过）`);
  check('幻觉情况最终标记为未达成', rep3.status === 'exhausted', rep3.status);

  console.log('\n=== 场景4：轮次耗尽的诚实性===');
  const camp4 = new Campaign('不可能的任务', {
    planners: 1, maxRounds: 2,
    planner: async () => ({ approach: 'X', plan: [{ name: 's' }] }),
    executor: async () => ({ ok: false, summary: '失败' }),
    reviewer: async () => ({ verdict: VERDICT.FAIL, quality: 0, gaps: ['一直不行'] }),
  });
  const rep4 = await camp4.run();
  check('耗尽轮次后明确报告未达成', rep4.status === 'exhausted' && rep4.rounds === 2, `${rep4.status}/R${rep4.rounds}`);

  console.log('\n=== 场景5：战役内感知统计===');
  check('战役产出了感知数据', rep.awarenessStats.total > 0, JSON.stringify(rep.awarenessStats.byStage));
  check('感知覆盖所有实际执行的步骤', rep.awarenessStats.total >= execCalls.length, `感知${rep.awarenessStats.total} vs 执行${execCalls.length}`);

  console.log('\n=== 场景6：r7 修复回归 ===');

  const ran6 = [];
  const camp6 = new Campaign('链式任务', {
    planners: 1, maxRounds: 1,
    planner: async () => ({ approach: 'A', plan: [{ name: 's1' }, { name: 's2' }, { name: 's3' }] }),
    executor: async ({ task }) => {
      ran6.push(task.name);
      return task.name === 's1' ? { ok: false, summary: '第一步失败' } : { ok: true, summary: 'ok', artifacts: [{}] };
    },
    reviewer: async () => ({ verdict: VERDICT.FAIL, quality: 0, gaps: ['第一步失败'] }),
  });
  const rep6 = await camp6.run();
  check('r7: 前序失败后后续步骤不执行', ran6.join(',') === 's1', `实际执行=${ran6.join(',')}`);
  check('skipped 步骤立即进感知（total=3）', rep6.awarenessStats.total === 3,
    JSON.stringify(rep6.awarenessStats.byStage));
  const trS2 = camp6.awareness.tracks.get('campaign-R1-s2');
  check('skipped 步骤 track 为终态且时间线一致（dispatchedAt ≤ finishedAt）',
    !!trS2 && trS2.stage === 'failed' && trS2.dispatchedAt <= trS2.finishedAt,
    trS2 && `${trS2.stage}@${trS2.dispatchedAt}→${trS2.finishedAt}`);

  const { BranchResume } = require('./awareness');
  const br = new BranchResume();
  br.register('campaign', 'camp', ['campaign-R1-s0', 'campaign-R1-s1']);
  br.mark('campaign', 'campaign-R1-s0', 'done');
  br.register('campaign', 'camp', ['campaign-R2-s0']);
  check('r7: 支线跨轮累积(不被覆盖)', br.status()[0].total === 3, JSON.stringify(br.status()));
  const kept = br.keptArtifacts('campaign', { 'campaign-R1-s0': '产物A' });
  check('r7: keptArtifacts 跨轮命中', kept.length === 1 && kept[0].id === 'campaign-R1-s0', JSON.stringify(kept.map((k) => k.id)));

  const camp7 = new Campaign('幻觉任务', {
    planners: 1, maxRounds: 1,
    planner: async () => ({ approach: 'A', plan: [{ name: 'x' }] }),
    executor: async () => ({ ok: true, summary: '我完成了（其实没做）', artifacts: [{ fake: true }] }),
    reviewer: async () => ({ verdict: VERDICT.FAIL, quality: 0, gaps: ['产出是幻觉'] }),
  });
  const rep7 = await camp7.run();
  const agents7 = rep7.retainedAgents.concat([{ quality: rep7.agentStats.avgQuality }]);
  check('r7: 审核FAIL时 Agent 质量分被压低（不被自报ok带偏）', rep7.agentStats.avgQuality < 0.75, `avgQuality=${rep7.agentStats.avgQuality}`);

  const camp8 = new Campaign('半成品任务', {
    planners: 1, maxRounds: 1,
    planner: async () => ({ approach: 'A', plan: [{ name: 'y' }] }),
    executor: async () => ({ ok: false, summary: '超时但写了半成品', artifacts: [{ file: 'partial.js' }] }),
    reviewer: async () => ({ verdict: VERDICT.FAIL, quality: 0, gaps: ['未完成'] }),
  });
  const rep8 = await camp8.run();
  check('r7: 失败步骤的产物仍被保留并标记 needsCleanup', rep8.artifacts.some((a) => a.file === 'partial.js' && a.needsCleanup === true), JSON.stringify(rep8.artifacts));
  void agents7;

  let threw = false;
  try { new Campaign('x', { planner: async () => ({}), executor: async () => ({}), maxRounds: 2 }); } catch { threw = true; }
  check('r7: 缺 reviewer 时构造期即抛错(fail-fast)', threw);
  threw = false;
  try { new Campaign('x', { planner: async () => ({}), executor: async () => ({}), reviewer: async () => ({}), maxRounds: 0 }); } catch { threw = true; }
  check('r7: maxRounds=0 时构造期抛错', threw);

  console.log('\n=== 场景7：verdict 形态契约（真实 executor-codex 的返回）===');
  const cC7 = new Campaign('x', {
    planners: 1, maxRounds: 1,
    planner: async () => ({ approach: 'A', plan: [{ name: 's1' }] }),
    executor: async () => ({ verdict: 'done', summary: 'ok', artifacts: [{ f: 1 }] }),
    reviewer: async () => ({ verdict: 'pass', gaps: [] }),
  });
  const repC7 = await cC7.run();
  check('verdict 形态被执行器契约接受(不再被误判失败)', repC7.status === 'done', repC7.status);
  check('verdict=done 的产出被计入工件', repC7.artifacts.length >= 1, JSON.stringify(repC7.artifacts));

  const cC8 = new Campaign('y', {
    planners: 1, maxRounds: 1,
    planner: async () => ({ summary: 'B', steps: [{ name: 's1' }] }),
    executor: async () => ({ ok: true, summary: 'ok', artifacts: [{ g: 1 }] }),
    reviewer: async () => ({ pass: true, gaps: [] }),
  });
  const repC8 = await cC8.run();
  check('planner 的 steps 形态与 reviewer 的 pass 形态可接入', repC8.status === 'done', repC8.status);

  console.log('\n=== 场景8：感知心跳接线 ===');
  {
    const { TaskAwareness } = require('./awareness');
    const inj = new TaskAwareness({ staleMs: 300, dispatchedGraceMs: 100 });
    const c8 = new Campaign('长任务', {
      awareness: inj, beatMs: 60, planners: 1, maxRounds: 1,
      planner: async () => ({ approach: 'A', plan: [{ name: 'slow' }] }),
      executor: async () => { await new Promise((r) => setTimeout(r, 700)); return { ok: true, summary: 'ok', artifacts: [] }; },
      reviewer: async () => ({ verdict: VERDICT.PASS, gaps: [] }),
    });
    check('awareness/beatMs 注入生效（构造器直断）', c8.awareness === inj && c8.beatMs === 60, `beatMs=${c8.beatMs}`);
    const rep8b = await c8.run();
    check('健康长步骤不再被误报停滞（awareness.progress 同拍心跳）',
      rep8b.audit.stalled.length === 0, JSON.stringify(rep8b.audit.stalled.map((s) => s.taskId)));
  }

  {
    const fs2 = require('fs');
    const src = fs2.readFileSync(require('path').join(__dirname, 'campaign.js'), 'utf8');
    const m = /stepBeat\s*=\s*setInterval\(\(\)\s*=>\s*\{[\s\S]*?\},\s*this\.beatMs\)/.exec(src);
    check('源级——stepBeat 节拍用 this.beatMs 且回调含 awareness.progress',
      !!m && /awareness\.progress\(/.test(m[0]), m ? '命中' : '未命中 stepBeat 块');
  }

  console.log('\n=== 场景9：审核否决的产出可重跑 ===');
  {
    let resumeSeen = null;
    const c9 = new Campaign('否决重跑', {
      planners: 1, maxRounds: 2,
      planner: async ({ round: r, resume }) => {
        if (r === 2) resumeSeen = resume;
        return { approach: 'A', plan: [{ name: 'a' }, { name: 'b' }] };
      },
      executor: async () => ({ ok: true, summary: '自报 ok', artifacts: [] }),
      reviewer: async ({ round: r }) => r === 1
        ? { verdict: VERDICT.FAIL, quality: 0.3, gaps: ['被否决'] }
        : { verdict: VERDICT.PASS, quality: 0.9, gaps: [] },
    });
    await c9.run();
    check('审核否决的步骤下一轮全部重跑（rerun=2, keep=0）',
      !!resumeSeen && Array.isArray(resumeSeen.rerun) && resumeSeen.rerun.length === 2 && resumeSeen.keep.length === 0,
      resumeSeen ? JSON.stringify({ rerun: resumeSeen.rerun.map((x) => x.id), keep: resumeSeen.keep }) : 'resume 未捕获');
  }

  console.log('\n=== 场景10：逃逸强制收口 ===');
  {
    const c10 = new Campaign('逃逸', {
      planners: 1, maxRounds: 1,
      planner: async () => ({ approach: 'A', plan: [{ name: 'boom' }] }),
      executor: async () => {

        c10.obs.stage = () => { throw new Error('boom'); };
        return { ok: true, summary: 'ok', artifacts: [] };
      },
      reviewer: async () => ({ verdict: VERDICT.PASS, gaps: [] }),
    });
    let rejected = false;
    try { await c10.run(); } catch { rejected = true; }
    const tr10 = [...c10.awareness.tracks.values()].find((t) => t.taskId.includes('-s0'));
    check('run() 逃逸被捕获且 track 强制收口为 failed',
      rejected && !!tr10 && tr10.stage === 'failed', tr10 && tr10.stage);
  }

  console.log('\n' + (fail === 0 ? '战役机制全部通过 ✅' : `${fail} 项失败 ❌`));
  process.exit(fail ? 1 : 0);
})();
