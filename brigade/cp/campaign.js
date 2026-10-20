'use strict';

const { TaskAwareness, AgentPool, BranchResume } = require('./awareness');
const { STAGE, createObservability } = require('./observability');

const VERDICT = { PASS: 'pass', FAIL: 'fail', PARTIAL: 'partial' };

class Campaign {

  constructor(goal, opts = {}) {
    this.goal = goal;

    this.obs = opts.observability || createObservability({ logFile: opts.progressFile || null, onEvent: opts.onEvent });
    this.maxRounds = opts.maxRounds ?? 4;
    this.plannerCount = opts.planners ?? 3;
    this.planner = opts.planner;
    this.executor = opts.executor;
    this.reviewer = opts.reviewer;
    this.log = [];

    this.awareness = opts.awareness || new TaskAwareness();
    this.beatMs = opts.beatMs || 15000;
    this.agentPool = new AgentPool({ reuseThreshold: 0.4, maxPerRole: 4 });
    this.branch = new BranchResume();
    this.round = 0;
    this.artifacts = [];
    this.gaps = [];
    this.chosenApproach = null;

    for (const [name, fn] of [['planner', opts.planner], ['executor', opts.executor], ['reviewer', opts.reviewer]]) {
      if (typeof fn !== 'function') throw new Error('Campaign 缺少必需回调: ' + name);
    }
    if (!(this.maxRounds >= 1)) throw new Error('maxRounds 必须 >= 1（收到 ' + this.maxRounds + '）');
    if (!(this.plannerCount >= 1)) throw new Error('planners 必须 >= 1（收到 ' + this.plannerCount + '）');
    this.status = 'init';
  }

  _log(kind, data) {
    const rec = { round: this.round, ts: Date.now(), kind, ...data };
    this.obs.bus.emit({ kind: 'log', tag: kind, round: this.round, summary: data.summary || data.approach || data.verdict || '' });
    this.log.push(rec);
    const tag = { plan: '规划', exec: '执行', review: '审核', pick: '选型', done: '完成', stop: '终止' }[kind] || kind;
    const detail = data.summary || data.approach || data.verdict || '';
    console.log(`[战役 R${this.round}] ${tag}${detail ? ' — ' + String(detail).slice(0, 110) : ''}`);
  }

  async run() {
    const liveBeats = new Set();
    this._liveBeats = liveBeats;
    try {
      return await this._runInner(liveBeats);
    } finally {

      for (const t of liveBeats) { try { clearInterval(t); } catch {} }
      liveBeats.clear();

      for (const tr of this.awareness.tracks.values()) {
        if (tr.stage !== STAGE.DONE && tr.stage !== STAGE.FAILED) {
          try { this.awareness.failed(tr.taskId, 'run() 异常逃逸，强制收口'); } catch {}
          try { this.obs.finish(tr.taskId, { ok: false, summary: 'run() 异常逃逸' }); } catch {}
        }
      }
    }
  }

  async _runInner(liveBeats) {
    while (this.round < this.maxRounds) {
      this.round++;
      this.status = 'planning';
      this.obs.stage('campaign', STAGE.PLANNING, '第' + this.round + '轮规划分流');

      const plannerAgents = [];
      for (let i = 0; i < this.plannerCount; i++) {

        const ag = this.agentPool.acquire('planner', `${this.goal} :: 方向${i}`, { noReuse: this.plannerCount > 1 });
        plannerAgents.push(ag);
      }
      const proposals = await Promise.all(
        plannerAgents.map(async (ag, i) => {

          const pid = `planner-${i}`;
          this.obs.start(pid, { title: `规划方向${i}`, role: 'planner', stage: STAGE.PLANNING, round: this.round });
          const beat = setInterval(() => this.obs.beat(pid, '规划中'), this.beatMs);
          liveBeats.add(beat);
          try {
            const r = await this.planner({
              goal: this.goal,
              round: this.round,
              previousGaps: this.gaps,
              artifacts: this.artifacts,
              agent: ag,
              variant: i,

              resume: this.round > 1 ? (() => {
                const pr = this.branch.planResume('campaign') || { rerun: [], keep: [] };
                const nameOf = (id) => (this.lastSteps || []).find((s) => s.id === id)?.name || undefined;
                return {
                  rerun: pr.rerun.map((id) => ({ id, name: nameOf(id) })),
                  keep: pr.keep.map((id) => ({ id, name: nameOf(id) })),
                };
              })() : [],
            });

            const norm = r && typeof r === 'object' ? { ...r } : {};
            if (!Array.isArray(norm.plan) && Array.isArray(norm.steps)) norm.plan = norm.steps;
            if (!norm.approach && norm.summary) norm.approach = norm.summary;
            this.obs.finish(pid, { ok: Array.isArray(norm.plan) && norm.plan.length > 0, summary: norm.approach || '未给出方案' });
            return { ...norm, agentId: ag.agentId };
          } catch (e) {
            this.obs.finish(pid, { ok: false, summary: '规划失败: ' + e.message });
            return { approach: `规划失败:${e.message}`, plan: null, agentId: ag.agentId };
          } finally {
            clearInterval(beat);
            liveBeats.delete(beat);
          }
        })
      );
      this._log('plan', { summary: `${proposals.length} 个方案（并行找方向）`, proposals: proposals.length });

      const viable = proposals.filter((p) => p && Array.isArray(p.plan) && p.plan.length > 0);
      if (!viable.length) {

        this.planFailures = (this.planFailures || 0) + 1;
        this._log('stop', {
          summary: `本轮无可行方案（第 ${this.planFailures} 次），${this.planFailures >= 2 || this.round >= this.maxRounds ? '终止战役' : '下一轮重试'}`,
        });
        if (this.planFailures >= 2 || this.round >= this.maxRounds) {
          this.status = 'exhausted';
          if (!this.gaps.length) this.gaps = ['规划阶段反复失败，无可行方案'];
          return this.report();
        }
        this.gaps = ['上一轮所有规划者都未能给出可行方案（可能是基础设施抖动），请重试或换更小的切分'];
        continue;
      }
      this.planFailures = 0;
      this.obs.stage('campaign', STAGE.PICKING, '选定方案');
      this.chosenApproach = this.round === 1 ? viable[0] : this._mergeApproach(viable);
      this._log('pick', { summary: this.chosenApproach.approach, agentId: this.chosenApproach.agentId });

      this.status = 'executing';
      this.obs.stage('campaign', STAGE.EXECUTING, '第' + this.round + '轮执行');
      const workId = 'campaign';

      const rawPlan = this.chosenApproach.plan;
      const badStep = (s) => {
        const text = `${(s && (s.name || s.description || s.title)) || ''}`.trim();
        if (!text) return true;
        if (text === '{}' || text === 'undefined' || text === 'null' || text === 'NaN') return true;
        if (/^(undefined|null|NaN)\b/.test(text)) return true;

        if (text.length >= 20 && /我需要先说明|我无法|没有.*任务|任务.*是空的|不存在|抱歉|不确定/.test(text)) return true;
        return false;
      };
      const goodPlan = rawPlan.filter((s) => !badStep(s));
      const droppedSteps = rawPlan.length - goodPlan.length;
      if (droppedSteps > 0) {
        this._log('exec', { summary: `规划质量闸门：丢弃 ${droppedSteps} 个不合格步骤` });
      }
      this.chosenApproach.plan = goodPlan.length
        ? goodPlan
        : [{ name: `完成目标：${String(this.goal).slice(0, 80)}`, description: String(this.goal) }];
      const stepIds = this.chosenApproach.plan.map((_, i) => `${workId}-R${this.round}-s${i}`);
      this.lastSteps = this.chosenApproach.plan.map((p, i) => ({ id: stepIds[i], name: p.name || p.title || p.description }));
      this.branch.register(workId, 'campaign', stepIds);

      const execAgent = this.agentPool.acquire('worker', `campaign:${this.goal}`);
      const roundArtifacts = [];
      for (let i = 0; i < this.chosenApproach.plan.length; i++) {
        const step = this.chosenApproach.plan[i];

        if (roundArtifacts.some((r) => !r.ok)) {
          roundArtifacts.push({ step: i, ok: false, skipped: true, summary: '前序步骤失败，本步未执行', artifacts: [] });
          const sid = `${stepIds[i]}`;
          this.branch.mark(workId, sid, 'failed');

          this.awareness.dispatched(sid, { round: this.round, step, skipped: true });
          this.awareness.failed(sid, '前序步骤失败，本步未执行');
          continue;
        }
        const sid = `${stepIds[i]}`;
        this.branch.mark(workId, sid, 'running');
        this.obs.start(sid, { title: step.name, stage: STAGE.EXECUTING, role: 'worker', round: this.round });
        this.awareness.dispatched(sid, { round: this.round, step });
        this.awareness.accepted(sid);
        this.awareness.running(sid);

        const stepBeat = setInterval(() => {
          this.obs.beat(sid, '执行中');

          this.awareness.progress(sid, '执行中');
        }, this.beatMs);
        liveBeats.add(stepBeat);
        let out;
        try {
          out = await this.executor({
            task: step,
            goal: this.goal,
            gaps: this.gaps,
            artifacts: this.artifacts,
            context: execAgent.context,
            agent: execAgent,
            round: this.round,
            stepIndex: i,
          });
        } catch (e) {
          out = { ok: false, summary: '执行异常: ' + e.message, artifacts: [] };
        }

        clearInterval(stepBeat);
        liveBeats.delete(stepBeat);

        if (!out || typeof out !== 'object') out = { ok: false, summary: 'executor 未返回有效结果', artifacts: [] };

        if (out.ok === undefined && out.verdict !== undefined) out.ok = out.verdict === 'done' || out.verdict === 'PASS';
        if (out.ok === undefined) out.ok = false;
        if (out.summary === undefined) out.summary = out.body || out.text || '';
        if (!Array.isArray(out.artifacts)) out.artifacts = [];
        this.obs.stage(sid, STAGE.VERIFYING, out.summary ? String(out.summary).slice(0, 80) : '');
        this.awareness.verifying(sid);
        this.branch.mark(workId, sid, out.ok ? 'done' : 'failed');

        const produced = Array.isArray(out.artifacts) ? out.artifacts : [];
        if (produced.length) {
          this.artifacts.push(...produced.map((a) => ({ ...a, task: step, round: this.round, needsCleanup: !out.ok })));
        }
        clearInterval(stepBeat);
        liveBeats.delete(stepBeat);
        this.obs.finish(sid, { ok: !!out.ok, summary: out.summary });
        roundArtifacts.push({ step: i, ok: !!out.ok, summary: out.summary, artifacts: produced });

        if (out.ok) {
          if (out.memory) this.agentPool.remember(execAgent.agentId, 'lesson', out.memory);
        } else {
          this.awareness.failed(sid, out.summary);
        }
      }
      this._log('exec', { summary: `本轮 ${roundArtifacts.filter((r) => r.ok).length}/${roundArtifacts.length} 步成功（上下文已保留）` });

      this.status = 'reviewing';
      this.obs.stage('campaign', STAGE.REVIEWING, '质量审核');

      this.obs.start('reviewer', { title: '质量审核', role: 'reviewer', stage: STAGE.REVIEWING, round: this.round });
      const reviewBeat = setInterval(() => this.obs.beat('reviewer', '审核中'), this.beatMs);
      liveBeats.add(reviewBeat);
      let review;
      try {
        review = await this.reviewer({
          goal: this.goal,
          artifacts: this.artifacts,
          round: this.round,
          approach: this.chosenApproach.approach,
          steps: roundArtifacts,
        });
      } catch (e) {
        review = { verdict: VERDICT.FAIL, gaps: ['审核异常:' + e.message], quality: 0 };
      } finally {
        clearInterval(reviewBeat);
        liveBeats.delete(reviewBeat);
        this.obs.finish('reviewer', { ok: review && review.verdict === VERDICT.PASS, summary: review && (review.verdict || '') });
      }

      if (!review || typeof review !== 'object') {
        review = { verdict: VERDICT.FAIL, gaps: ['审核者未返回有效结果'], quality: 0 };
      }

      if (review.verdict === undefined && typeof review.pass === 'boolean') {
        review.verdict = review.pass ? VERDICT.PASS : VERDICT.FAIL;
      }
      if (!Array.isArray(review.gaps)) review.gaps = review.gaps ? [String(review.gaps)] : [];
      const passed = review.verdict === VERDICT.PASS;
      this.agentPool.report(execAgent.agentId, { passed, note: passed ? '审核通过' : '审核未通过' });

      for (let i = 0; i < roundArtifacts.length; i++) {
        const sid = stepIds[i];
        if (!sid) continue;
        if (roundArtifacts[i].skipped) continue;
        this.awareness.feedback(sid, {
          quality: passed ? 'pass' : 'fail',
          note: roundArtifacts[i].summary,
          reviewer: 'campaign',
        });
      }

      if (!passed) {
        for (let i = 0; i < roundArtifacts.length; i++) {
          if (roundArtifacts[i].ok && !roundArtifacts[i].skipped) {
            this.branch.mark(workId, stepIds[i], 'failed');
          }
        }
      }

      if (passed) {
        this._log('review', { summary: `通过（质量 ${review.quality ?? '-'}）` });
        this.status = 'done';
        this._log('done', { summary: `需求达成，共 ${this.round} 轮` });
        return this.report();
      }

      this.gaps = review.gaps || ['质量未达标'];
      this._log('review', { summary: `未通过（${this.gaps.length} 个缺口）→ 下一轮定向修正`, verdict: review.verdict, gaps: this.gaps });
    }
    this.status = 'exhausted';
    this._log('stop', { summary: `达到最大轮次 ${this.maxRounds} 仍未达标` });
    return this.report();
  }

  _mergeApproach(viable) {
    const base = viable[0];
    const extra = viable.slice(1, 3).map((p) => p.approach).filter(Boolean);
    if (!extra.length) return base;
    return { ...base, approach: `${base.approach}（吸收：${extra.join('；')}）` };
  }

  report() {
    return {
      goal: this.goal,
      status: this.status,
      rounds: this.round,
      chosenApproach: this.chosenApproach && this.chosenApproach.approach,
      gaps: this.gaps,
      artifacts: this.artifacts,

      retainedAgents: [...this.agentPool.pool.values()]
        .filter((p) => p.context && Object.keys(p.context).length)
        .map((p) => ({ agentId: p.agentId, role: p.role, quality: Number(p.qualityScore.toFixed(2)), memory: p.context })),
      audit: this.awareness.audit(),
      awarenessStats: this.awareness.stats(),
      agentStats: this.agentPool.stats(),
      log: this.log,
      live: this.obs.summary(),
    };
  }
}

module.exports = { Campaign, VERDICT };
