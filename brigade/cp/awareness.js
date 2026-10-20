'use strict';

const STAGE = {
  DISPATCHED: 'dispatched',
  ACCEPTED: 'accepted',
  RUNNING: 'running',
  VERIFYING: 'verifying',
  DONE: 'done',
  FAILED: 'failed',
};

class TaskAwareness {
  constructor({ staleMs = 120000, dispatchedGraceMs = 30000, maxLifeMs = 3600000 } = {}) {
    this.staleMs = staleMs;
    this.dispatchedGraceMs = dispatchedGraceMs;
    this.maxLifeMs = maxLifeMs;
    this.tracks = new Map();
  }

  _t(taskId) {
    if (!this.tracks.has(taskId)) {
      this.tracks.set(taskId, {
        taskId, stage: STAGE.DISPATCHED, dispatchedAt: Date.now(),
        acceptedAt: null, startedAt: null, finishedAt: null,
        lastProgressAt: Date.now(), feedback: null, quality: null, events: [],
      });
    }
    return this.tracks.get(taskId);
  }

  _move(taskId, stage, detail) {
    const t = this._t(taskId);
    t.stage = stage;
    t.lastProgressAt = Date.now();
    t.events.push({ ts: t.lastProgressAt, stage, detail: detail || null });
    if (stage === STAGE.ACCEPTED) t.acceptedAt = t.lastProgressAt;
    if (stage === STAGE.RUNNING) t.startedAt = t.lastProgressAt;
    if (stage === STAGE.VERIFYING) t.finishedAt = t.lastProgressAt;
    if (stage === STAGE.DONE || stage === STAGE.FAILED) t.finishedAt = t.lastProgressAt;
    return t;
  }

  dispatched(taskId, detail) {
    const t = this._t(taskId);
    t.feedback = null;
    t.quality = null;
    t.finishedAt = null;
    t.dispatchedAt = Date.now();
    t.acceptedAt = null;
    t.startedAt = null;
    t.round = (t.round || 0) + 1;
    return this._move(taskId, STAGE.DISPATCHED, detail);
  }
  accepted(taskId, detail) { return this._move(taskId, STAGE.ACCEPTED, detail); }
  running(taskId, detail) { return this._move(taskId, STAGE.RUNNING, detail); }
  verifying(taskId, detail) { return this._move(taskId, STAGE.VERIFYING, detail); }

  done(taskId, detail) {
    return this._move(taskId, STAGE.DONE, { ...(detail || {}), reviewed: false });
  }
  failed(taskId, reason) { return this._move(taskId, STAGE.FAILED, { reason }); }

  progress(taskId, note) {
    const t = this._t(taskId);
    t.lastProgressAt = Date.now();
    if (note) t.events.push({ ts: t.lastProgressAt, stage: t.stage, detail: note });
    return t;
  }

  feedback(taskId, { quality, note, reviewer }) {
    const t = this._t(taskId);
    t.feedback = { quality, note, reviewer, at: Date.now() };
    t.quality = quality;
    if (quality === 'fail') return this._move(taskId, STAGE.FAILED, { reason: note });
    return this._move(taskId, STAGE.DONE, { quality });
  }

  audit(now = Date.now()) {
    const whiteRuns = [];
    const stalled = [];
    const noFeedback = [];
    const inFlight = [];
    for (const t of this.tracks.values()) {
      const terminal = t.stage === STAGE.DONE || t.stage === STAGE.FAILED;
      if (!terminal) {
        const sinceDispatch = now - t.dispatchedAt;
        const sinceProgress = now - t.lastProgressAt;

        if (now - t.dispatchedAt > this.maxLifeMs) {
          whiteRuns.push({ taskId: t.taskId, why: `超 maxLife(${Math.round(this.maxLifeMs / 60000)}min) 仍未终结`, at: t.dispatchedAt });
          continue;
        }
        if (t.acceptedAt === null) {
          if (sinceDispatch > this.dispatchedGraceMs) {
            whiteRuns.push({ taskId: t.taskId, why: `派发 ${Math.round(sinceDispatch / 1000)}s 无人接受`, at: t.dispatchedAt });
          } else {
            inFlight.push({ taskId: t.taskId, stage: t.stage, at: t.dispatchedAt });
          }
        } else if (sinceProgress > this.staleMs) {
          stalled.push({ taskId: t.taskId, why: `停滞 ${Math.round(sinceProgress / 1000)}s`, at: t.lastProgressAt });
        } else {
          inFlight.push({ taskId: t.taskId, stage: t.stage, at: t.lastProgressAt });
        }
      } else if (t.stage === STAGE.DONE && !t.feedback) {
        noFeedback.push({ taskId: t.taskId, why: '完成但无质量反馈', at: t.finishedAt });
      }
    }
    return { whiteRuns, stalled, noFeedback, inFlight, total: this.tracks.size };
  }

  stats() {
    const all = [...this.tracks.values()];
    const byStage = {};
    for (const t of all) byStage[t.stage] = (byStage[t.stage] || 0) + 1;
    const withFeedback = all.filter((t) => t.feedback).length;
    return {
      total: all.length, byStage,
      feedbackRate: all.length ? Math.round((withFeedback / all.length) * 100) : 100,
      avgMs: all.filter((t) => t.finishedAt).length
        ? Math.round(all.filter((t) => t.finishedAt).reduce((s, t) => s + (t.finishedAt - t.dispatchedAt), 0) / all.filter((t) => t.finishedAt).length)
        : 0,
    };
  }
}

class BranchResume {
  constructor() {
    this.branches = new Map();
  }

  register(branchId, squadId, taskIds) {

    const b = this.branches.get(branchId);
    if (!b) { this.branches.set(branchId, { branchId, squadId, taskIds: taskIds.map((id) => ({ id, state: 'pending' })), resumeCount: 0 }); return; }
    const have = new Set(b.taskIds.map((t) => t.id));
    for (const id of taskIds) if (!have.has(id)) b.taskIds.push({ id, state: 'pending' });
  }

  mark(branchId, taskId, state) {
    const b = this.branches.get(branchId);
    if (!b) return;
    const t = b.taskIds.find((x) => x.id === taskId);
    if (t) t.state = state;
  }

  planResume(branchId) {
    const b = this.branches.get(branchId);
    if (!b) return { rerun: [], keep: [], done: false };
    b.resumeCount++;
    const rerun = b.taskIds.filter((t) => t.state !== 'done').map((t) => t.id);
    const keep = b.taskIds.filter((t) => t.state === 'done').map((t) => t.id);
    return { rerun, keep, done: rerun.length === 0, resumeCount: b.resumeCount };
  }

  keptArtifacts(branchId, artifactsByTask) {
    const b = this.branches.get(branchId);
    if (!b) return [];
    return b.taskIds.filter((t) => t.state === 'done').map((t) => ({ id: t.id, artifact: artifactsByTask[t.id] || null })).filter((x) => x.artifact);
  }

  status() {
    return [...this.branches.values()].map((b) => ({
      branchId: b.branchId, total: b.taskIds.length,
      done: b.taskIds.filter((t) => t.state === 'done').length, resumeCount: b.resumeCount,
    }));
  }
}

class AgentPool {
  constructor({ reuseThreshold = 0.5, maxPerRole = 4, coldThreshold = 0.55, leaseMs = 300000 } = {}) {

    this.coldThreshold = coldThreshold;
    this.leaseMs = leaseMs;
    this.pool = new Map();
    this.reuseThreshold = reuseThreshold;
    this.maxPerRole = maxPerRole;
    this.reuseCount = 0;
    this.newCount = 0;
  }

  _tokenize(text) {

    const t = String(text).toLowerCase();
    const tokens = [];
    const CJK_RE = /[㐀-䶿一-鿿豈-﫿぀-ゟ゠-ヿ]/;
    for (const seg of t.split(/[^一-鿿㐀-䶿豈-﫿぀-ゟ゠-ヿa-z0-9+#.]+/)) {
      if (!seg) continue;
      if (CJK_RE.test(seg)) {

        for (let i = 0; i < seg.length; i++) {
          if (i + 1 < seg.length) tokens.push(seg.slice(i, i + 2));
          else tokens.push(seg[i]);
        }
      } else {
        tokens.push(seg);
      }
    }
    return new Set(tokens);
  }

  _idf(token) {
    if (!this._df) this._df = new Map();
    if (!this._df.has(token)) {
      const texts = [...this.pool.values()].map((p) => p.lastTaskText || '').filter(Boolean);

      if (texts.length < 3) { this._df.set(token, 1); return 1; }
      const df = texts.filter((t) => this._tokenize(t).has(token)).length;
      this._df.set(token, Math.log((1 + texts.length) / (1 + df)));
    }
    return this._df.get(token);
  }

  _similarity(a, b) {
    const ta = this._tokenize(a);
    const tb = this._tokenize(b);
    if (!ta.size || !tb.size) return 0;
    let inter = 0;
    let union = 0;
    for (const w of new Set([...ta, ...tb])) {
      const wgt = this._idf(w);
      if (ta.has(w) && tb.has(w)) inter += wgt;
      union += wgt;
    }
    return union > 0 ? inter / union : 0;
  }

  acquire(role, taskText, opts = {}) {

    const rolePool = [...this.pool.values()].filter((p) => p.role === role);
    const candidates = opts.noReuse ? [] : rolePool;
    for (const p of candidates) {

      if (p.inUse && p.leaseUntil && p.leaseUntil > Date.now()) continue;
      const sim = this._similarity(p.lastTaskText || '', taskText);
      const corpus = [...this.pool.values()].filter((x) => x.lastTaskText).length;
      const thr = corpus < 3 ? this.coldThreshold : this.reuseThreshold;
      if (sim >= thr && p.qualityScore >= 0.5) {
        p.reuseCount++;
        p.lastTaskText = taskText;
        this._df = null;
        this.reuseCount++;
        return { agentId: p.agentId, reused: true, similarity: Number(sim.toFixed(2)), context: p.context };
      }
    }
    const sameRoleCount = rolePool.length;
    if (sameRoleCount >= this.maxPerRole) {

      const idle = rolePool.filter((p) => !p.inUse);
      if (idle.length) {
        const worst = idle.sort((a, b) => a.qualityScore - b.qualityScore)[0];
        this.pool.delete(worst.agentId);
      }
    }
    const agentId = 'ag-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    this._df = null;
    this.pool.set(agentId, {
      agentId, role, lastTaskText: taskText, context: {}, qualityScore: 0.7, reuseCount: 0, inUse: false,
    });
    this.newCount++;
    return { agentId, reused: false, similarity: 0, context: {} };
  }

  claim(agentId, leaseMs) {
    const p = this.pool.get(agentId);
    if (!p) return false;
    if (p.inUse && p.leaseUntil && p.leaseUntil > Date.now()) return false;
    p.inUse = true;
    p.leaseUntil = Date.now() + (leaseMs || this.leaseMs);
    return true;
  }

  release(agentId) {
    const p = this.pool.get(agentId);
    if (p) { p.inUse = false; p.leaseUntil = 0; }
  }

  report(agentId, { passed, note }) {
    const p = this.pool.get(agentId);
    if (!p) return null;

    p.qualityScore = Math.max(0, Math.min(1,
      passed ? p.qualityScore * 0.7 + 0.3 : p.qualityScore * 0.8));
    p.inUse = false;
    p.leaseUntil = 0;
    p.lastOutcome = { passed, note, at: Date.now() };
    return p;
  }

  remember(agentId, key, value) {
    const p = this.pool.get(agentId);
    if (!p) return;
    p.context[key] = value;
  }

  stats() {
    const all = [...this.pool.values()];
    const totalAcq = this.reuseCount + this.newCount;
    return {
      poolSize: all.length,
      reuseRate: totalAcq ? Math.round((this.reuseCount / totalAcq) * 100) : 0,
      byRole: all.reduce((m, p) => { m[p.role] = (m[p.role] || 0) + 1; return m; }, {}),
      avgQuality: all.length ? Number((all.reduce((s, p) => s + p.qualityScore, 0) / all.length).toFixed(2)) : 0,
    };
  }
}

module.exports = { STAGE, TaskAwareness, BranchResume, AgentPool };
