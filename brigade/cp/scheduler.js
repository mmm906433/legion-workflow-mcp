'use strict';

const fs = require('fs');
const path = require('path');
const { FileStore } = require('./store');
const {
  makeTask, canTransit, isSettled, shouldRetry, validatePlan, depsSatisfied, depsHardFailed, depsUnresolvable,
  canRework, pushHistory, isRetryable, backoffDelay, TERMINAL, effectiveBudget,
} = require('./task');
const { FeedbackEngine } = require('./feedback');

function log(...a) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[cp ${t}]`, ...a);
}

const SHARD_THRESHOLD = 64;

function isTerminalState(s) {
  return s === 'done' || s === 'failed' || s === 'skipped' || s === 'degraded';
}

class Scheduler {

  constructor(opts) {
    this.runId = opts.runId;
    this.root = opts.root;
    this.worker = opts.worker;
    this.onPublish = opts.onPublish || null;

    {
      const allowed = ['degrade', 'ignore'];
      const p = opts.workspaceConflictPolicy === undefined ? 'degrade' : opts.workspaceConflictPolicy;
      if (!allowed.includes(p)) {
        throw new Error(`workspaceConflictPolicy 只能是 ${allowed.join(' | ')}，收到 "${p}"（不静默降级——拼错的配置比报错更危险）`);
      }
      this.workspaceConflictPolicy = p;
    }
    this.store = opts.store || new FileStore(opts.root);
    this.concurrency = opts.concurrency ?? 4;
    this.leaseMs = opts.leaseMs ?? 60_000;
    this.feedback = new FeedbackEngine(opts.feedback);
    this.abortCtl = new Map();

    this.zombies = new Map();
    this.zombieTtlMs = opts.zombieTtlMs ?? 60_000;
    this.onProgress = opts.onProgress || null;
    this.admission = opts.admission || null;
    this.gateGraceMs = opts.gateGraceMs ?? 120000;
    this.gateBlockSince = 0;
    this.lastGateProbeAt = 0;
    this.gateQueueThisTick = false;
    this.gateErrorThisTick = false;

    this.retryBudget = opts.retryBudget ?? Math.max(20, this.concurrency * 3);
    this.retriesUsed = 0;
    this.pendingPersist = new Set();
    this.persistBatch = opts.persistBatch ?? 50;
    this.needFlush = false;
    this.lastPersistAt = 0;
    this.flushIntervalMs = opts.flushIntervalMs ?? 100;
    this.timingFile = opts.timingFile || null;
  }

  reapZombies(now = Date.now()) {
    for (const [key, z] of this.zombies) {
      if (now - z.at > z.ttlMs) {
        this.zombies.delete(key);
        this.store.appendEvent(this.runId, { kind: 'zombie_expired', id: z.taskId, aliveMs: now - z.at });
        log(`☠ ${z.taskId} 的僵尸执行器超过 ${Math.round(z.ttlMs / 1000)}s 仍未退出，强制释放并发额度`);
      }
    }
  }

  zombieCount(now = Date.now()) {
    let n = 0;
    for (const z of this.zombies.values()) if (now - z.at <= z.ttlMs) n++;
    return n;
  }

  init(goal, taskSpecs) {

    this.timingFile = this.timingFile || path.join(this.root, 'timing-profile.json');
    this._loadTimingProfile();
    const tasks = taskSpecs.map(makeTask);
    validatePlan(tasks);
    this.store.ensureRun(this.runId);
    this.tasks = tasks;
    this.epoch = this.store.currentEpoch(this.runId);
    this.persist(true);
    this.store.saveMeta(this.runId, { goal, concurrency: this.concurrency, startedAt: new Date().toISOString() });
    this.store.appendEvent(this.runId, { kind: 'run_init', goal, n: tasks.length });
    log(`运行 ${this.runId} 初始化：${tasks.length} 个任务，目标="${goal}"`);
    return tasks;
  }

  load() {
    this.gateBlockSince = 0;
    this.tasks = this.store.loadTasks(this.runId);
    for (const t of this.tasks) {
      if (t.state === 'running' || t.state === 'leased') {
        this.transit(t, 'pending', { leasedBy: null, leaseUntil: 0 });
      }
    }
    return this.tasks;
  }

  all() {
    if (!this.tasks) this.load();
    return this.tasks;
  }

  byId(tasks) {
    return new Map(tasks.map((t) => [t.id, t]));
  }

  byName(name) {
    return this.all().find((t) => t.name === name) || null;
  }

  addressable() {
    return this.all().filter((t) => t.name).map((t) => ({
      name: t.name, id: t.id, type: t.type, state: t.state, squadId: t.input && t.input.squadId,
    }));
  }

  blockingCount(byId) {
    const cnt = new Map();
    for (const t of byId.values()) for (const d of t.deps) cnt.set(d, (cnt.get(d) || 0) + 1);
    return cnt;
  }

  transit(task, to, extra = {}) {
    if (!canTransit(task.state, to)) {
      log(`⚠ 非法迁移 ${task.id}: ${task.state} → ${to}（忽略）`);
      return false;
    }
    const from = task.state;
    task.state = to;
    Object.assign(task, extra);
    this.store.appendEvent(this.runId, { kind: 'transit', id: task.id, from, to, attempt: task.attempts });

    if (isTerminalState(to)) { this.needFlush = true; this.markDirty(task.id); }
    else this.markDirty(task.id);
    return true;
  }

  canDispatch(task) {
    if (!this.admission) return 'ok';
    this.lastGateProbeAt = Date.now();
    let r;
    try {
      r = this.admission(task, this.all());
    } catch (e) {

      log('⚠ 准入闸门异常，fail-closed 拒绝派发 ' + task.id + ': ' + (e && e.message));
      return 'error';
    }

    if (r === true) return 'ok';
    if (r === false) return 'queue';
    log('⚠ 准入闸门返回非布尔(' + typeof r + ')，按 fail-closed 拒绝 ' + task.id);
    return 'error';
  }

  _loadTimingProfile() {
    try {
      if (!this.timingFile || !fs.existsSync(this.timingFile)) return;

      const st = fs.statSync(this.timingFile);
      if (Date.now() - st.mtimeMs > 7 * 86400_000) return;
      const p = JSON.parse(fs.readFileSync(this.timingFile, 'utf8'));
      this.feedback.importProfile(p);
    } catch {  }
  }

  _saveTimingProfile() {
    try {
      if (!this.timingFile) return;
      if (Date.now() - (this._timingSavedAt || 0) < 2000) return;
      this._timingSavedAt = Date.now();
      fs.mkdirSync(path.dirname(this.timingFile), { recursive: true });
      fs.writeFileSync(this.timingFile, JSON.stringify(this.feedback.exportProfile()));
    } catch {  }
  }

  persist(force = false) {
    this.pendingPersist = this.pendingPersist || new Set();
    if (force) {

      const diskEpoch = this.store.currentEpoch(this.runId);
      this.epoch = Math.max(this.epoch || 0, diskEpoch) + 1;
      let ok = this.store.saveTasks(this.runId, this.all(), this.epoch);
      if (!ok) {

        this.epoch = this.store.currentEpoch(this.runId) + 1;
        ok = this.store.saveTasks(this.runId, this.all(), this.epoch);
      }

      if (!ok) {
        this.needFlush = true;
        this.lastPersistAt = Date.now();
        this.store.appendEvent(this.runId, { kind: 'persist_failed_retry_pending', id: 'snapshot' });
        return;
      }
      this.pendingPersist.clear();
      this.needFlush = false;
      this.lastPersistAt = Date.now();
    }
  }

  flushDue() {
    if (!this.needFlush) return;
    if (Date.now() - (this.lastPersistAt || 0) >= this.flushIntervalMs) this.persist(true);
  }

  markDirty(taskId) {
    this.pendingPersist.add(taskId);
    if (this.pendingPersist.size >= this.persistBatch) this.persist(true);
  }

  readySet(tasks) {
    const byId = this.byId(tasks);
    const blocking = this.blockingCount(byId);
    const ready = [];
    const tripped = [];
    const now = Date.now();
    for (const t of tasks) {
      if (t.state !== 'pending' && t.state !== 'blocked' && t.state !== 'failed') continue;

      if (t.state === 'failed') {

        if (t.outcome && t.outcome.watchdog) continue;
        if (!shouldRetry(t, this.retryBudget - this.retriesUsed, now)) continue;
        this.retriesUsed++;
        const reviveDelay = (t.budget && t.budget.backoffMs) || 1000;
        this.transit(t, 'pending', { outcome: t.outcome, notBefore: now + reviveDelay });
      }
      if (t.state !== 'pending' && t.state !== 'blocked') continue;
      if (!depsSatisfied(t, byId)) continue;

      if (!t.taintFrom || !t.taintFrom.length) {
        const taint = [];
        for (const d of t.deps) {
          const dep = byId.get(d);
          if (!dep) continue;
          if (dep.state === 'degraded') { if (!taint.includes(d)) taint.push(d); }
          for (const x of (dep.taintFrom || [])) if (!taint.includes(x)) taint.push(x);
        }
        if (taint.length) t.taintFrom = taint;
      }
      if (t.notBefore && now < t.notBefore) continue;
      const adv = this.feedback.advise(t, { blockingCount: blocking.get(t.id) || 0 });
      t.priority = adv.priority;
      if (!adv.allow) { if (!adv.waiting) tripped.push({ task: t, adv }); continue; }
      t._adv = adv;
      ready.push(t);
    }

    for (const t of ready) if (t.attempts > 0) t.priority -= 50 * t.attempts;
    ready.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    return { ready, tripped };
  }

  applyTripped(tripped) {
    let n = 0;
    for (const { task, adv } of tripped) {
      if (this.transit(task, 'skipped', { leasedBy: null, leaseUntil: 0, outcome: { verdict: 'skip', failureType: 'circuit_open', note: adv.reason } })) n++;
    }
    return n;
  }

  propagateFailure(tasks) {
    const byId = this.byId(tasks);
    let changed = 0;
    for (const t of tasks) {
      if (!['pending', 'blocked'].includes(t.state)) continue;
      const bad = depsHardFailed(t, byId);
      if (!bad) continue;

      if (bad.state === 'failed' && canRework(bad) && t.allowRework) continue;

      if (t.onUpstreamFail === 'skip') {
        if (this.transit(t, 'skipped', { outcome: { verdict: 'skip', failureType: 'upstream_failed', note: '上游 ' + bad.id + ' 失败（级联跳过）' } })) changed++;
        continue;
      }

      const taint = new Set(t.taintFrom || []);
      for (const d of t.deps) {
        const dep = byId.get(d);
        if (dep && dep.state === 'degraded') { taint.add(d); for (const x of dep.taintFrom || []) taint.add(x); }
      }
      taint.add(bad.id);
      for (const x of bad.taintFrom || []) taint.add(x);
      if (this.transit(t, 'degraded', { degradedVia: bad.id, taintFrom: [...taint], outcome: { verdict: 'degraded', failureType: 'upstream_failed', note: '上游 ' + bad.id + ' 失败' } })) changed++;
    }
    return changed;
  }

  markUnresolvable(tasks) {
    const byId = this.byId(tasks);
    let n = 0;
    for (const t of tasks) {
      if (t.state !== 'pending') continue;
      const missing = depsUnresolvable(t, byId);
      if (missing && this.transit(t, 'skipped', { outcome: { verdict: 'skip', failureType: 'unknown', note: '悬空依赖 ' + missing } })) n++;
    }
    return n;
  }

  async execute(task) {
    const ac = new AbortController();
    let enteredRun = false;
    try {
      this.abortCtl.set(task.id, ac);

      const adv = task._adv || {};
      const timeoutMs = effectiveBudget(task).timeoutSec * 1000;
      const stallMs = effectiveBudget(task).stallSec * 1000;

      task.attempts += 1;
      task.attemptId += 1;
      const myAttemptId = task.attemptId;
      this.transit(task, 'leased', { leasedBy: 'sched', leaseUntil: Date.now() + this.leaseMs, lastHeartbeat: Date.now() });
      const t0 = Date.now();
      this.store.appendEvent(this.runId, { kind: 'exec_start', id: task.id, attempt: task.attempts, attemptId: myAttemptId, timeoutSec: Math.round(timeoutMs / 1000) });
      log(`▶ ${task.id} [${task.type}/${task.role || '-'}] ${task.title}（尝试 ${task.attempts}/${task.budget.maxAttempts}，超时 ${Math.round(timeoutMs / 1000)}s，卡死阈值 ${Math.round(stallMs / 1000)}s）`);

      this.transit(task, 'running', { startedAt: t0, lastHeartbeat: Date.now() });
      enteredRun = true;

      const heartbeat = () => {

        if (task.attemptId !== myAttemptId) return;
        task.lastHeartbeat = Date.now();
        this.store.appendEvent(this.runId, { kind: 'heartbeat', id: task.id, attemptId: myAttemptId });
      };

      let outcome = null;
      let failureType = null;
      let hardTimedOut = false;
      let hardTimer = null;
      let workerStillRunning = false;
      const zkey = `${task.id}#${myAttemptId}`;
      try {

      const hardTimeout = new Promise((resolve) => { hardTimer = setTimeout(() => resolve({ __hard: 'timeout' }), timeoutMs); });
      const stallWatch = setInterval(() => {
        const base = task.lastHeartbeat || task.startedAt || t0;
        if (Date.now() - base > stallMs) {
          failureType = 'stalled';
          ac.abort();
        }
      }, Math.max(250, Math.floor(stallMs / 4)));

      const submit = (art) => this.store.saveArtifact(this.runId, art);

      workerStillRunning = true;

      const workerPromise = (async () => {
        try {

          return await this.worker({ task, attemptId: myAttemptId, signal: ac.signal, heartbeat, submit, store: this.store, runId: this.runId, byId: this.byId(this.all()) });
        } catch (e) {
          return { __err: e };
        } finally {
          workerStillRunning = false;
          this.zombies.delete(zkey);
        }
      })();

      const race = await Promise.race([workerPromise, hardTimeout]);
      clearInterval(stallWatch);
      clearTimeout(hardTimer);
      if (race && race.__hard === 'timeout') {
        failureType = 'timeout';
        hardTimedOut = true;
        ac.abort();
        outcome = { verdict: 'fail', summary: `超时（>${Math.round(timeoutMs / 1000)}s 未返回，强制裁决）` };
      } else if (race && race.__err) {
        outcome = { verdict: 'fail', summary: '执行器异常: ' + (race.__err && race.__err.message) };
      } else {
        outcome = race;
      }

      if (failureType === 'stalled' && (!outcome || outcome.verdict === 'done')) {
        outcome = { verdict: 'fail', summary: `卡死（>${Math.round(stallMs / 1000)}s 无心跳）` };
      }
    } catch (e) {
      outcome = { verdict: 'fail', summary: '调度异常: ' + (e && e.message) };
      failureType = failureType || 'crash';
    } finally {

      if (this.abortCtl.get(task.id) === ac) this.abortCtl.delete(task.id);

      if (workerStillRunning) {

        this.zombies.set(zkey, { at: Date.now(), ac, ttlMs: this.zombieTtlMs, taskId: task.id, attemptId: myAttemptId });
        this.store.appendEvent(this.runId, { kind: 'zombie_registered', id: task.id, attemptId: myAttemptId, ttlMs: this.zombieTtlMs });
        log(`☠ ${task.id} 裁决完成但执行器仍存活，登记僵尸（占用并发额度最多 ${Math.round(this.zombieTtlMs / 1000)}s）`);
      }
    }

    if (task.attemptId !== myAttemptId) {
      this.store.appendEvent(this.runId, { kind: 'stale_result_discarded', id: task.id, myAttemptId, currentAttemptId: task.attemptId });
      log(`⟳ 丢弃 ${task.id} 的过期结果（attempt ${myAttemptId}，当前 ${task.attemptId}）`);
      return 'stale';
    }

    const ms = Date.now() - t0;

    let verdict = (outcome && outcome.verdict) || null;
    if (verdict === null && outcome && typeof outcome.ok === 'boolean') verdict = outcome.ok ? 'done' : 'fail';
    if (verdict !== 'done' && verdict !== 'PASS' && verdict !== 'fail' && verdict !== 'degraded') verdict = 'fail';
    const ft = verdict === 'fail' ? failureType || (outcome && outcome.failureType) || 'unknown' : null;
    const rec = { verdict, ms, failureType: ft, note: outcome && outcome.summary, attemptId: myAttemptId, ts: Date.now() };
    if (task.taintFrom && task.taintFrom.length) {
      rec.taintFrom = task.taintFrom.slice();
      rec.note = (rec.note ? rec.note + ' | ' : '') + '⚠ 输入含降级产出：' + task.taintFrom.join(', ');
      this.store.appendEvent(this.runId, { kind: 'result_tainted', id: task.id, taintFrom: task.taintFrom });
    }

    if (this.onPublish && (verdict === 'done' || verdict === 'PASS')) {
      try {
        const pub = this.onPublish(task, verdict, rec);
        if (pub) rec.published = pub;

        if (pub && pub.conflicts && pub.conflicts.length && this.workspaceConflictPolicy === 'degrade') {
          const list = pub.conflicts.slice(0, 5).join(', ') + (pub.conflicts.length > 5 ? ' …' : '');
          log(`~ ${task.id} 部分改动未落地（${pub.conflicts.length} 个文件与外部改动冲突，已保留外部版本${pub.conflictDir ? '，任务侧版本已隔离至 ' + pub.conflictDir : ''}）：${list}`);
          verdict = 'degraded';
          rec.verdict = 'degraded';
          rec.failureType = 'workspace_conflict';
          rec.conflicts = pub.conflicts;
          if (pub.conflictDir) rec.conflictDir = pub.conflictDir;
        }

        if (pub && pub.readOnlyPollution && pub.readOnlyPollution.length) {
          for (const p of pub.readOnlyPollution) {
            const fl = p.files.slice(0, 5).join(', ') + (p.files.length > 5 ? ' …' : '');
            log(`! 只读任务 ${p.task} 期间有 ${p.files.length} 个文件被直接写入主工作区（未经过影子区）：${fl}`);
            rec.readOnlyPollution = (rec.readOnlyPollution || []).concat(p);
          }
          this.store.appendEvent(this.runId, {
            kind: 'readonly_pollution', id: task.id,
            tasks: pub.readOnlyPollution.map((p) => p.task),
            files: pub.readOnlyPollution.flatMap((p) => p.files).slice(0, 20),
          });
        }
      } catch (e) {
        log(`✗ ${task.id} 影子工作区发布失败，产出未落地，记为失败: ${e && e.message}`);
        verdict = 'fail';
        rec.verdict = 'fail';
        rec.failureType = 'workspace_publish';
      }
    }
    task.outcome = rec;
    pushHistory(task, rec);

    this.feedback.record(task, { verdict, ms, failureType: ft });
    this._saveTimingProfile();

    this.feedback.notifyResult(`${task.role || '-'}::${task.type}`, verdict === 'done' || verdict === 'PASS' || verdict === 'degraded');

    if (verdict === 'degraded') {
      this.transit(task, 'degraded', { outcome: rec, leasedBy: null, leaseUntil: 0 });
      log('~ ' + task.id + ' 降级完成');
    } else if (verdict === 'done' || verdict === 'PASS') {
      this.transit(task, 'done', { outcome: rec, leasedBy: null, leaseUntil: 0 });
      log(`✓ ${task.id} 完成（${Math.round(ms / 1000)}s）${rec.note ? ' — ' + String(rec.note).slice(0, 80) : ''}`);
    } else {

      const retry = shouldRetry({ ...task, outcome: { failureType: ft } }, this.retryBudget - this.retriesUsed);
      if (retry && this.retriesUsed >= this.retryBudget) {
        log(`⛔ ${task.id} 全局重试预算耗尽（${this.retriesUsed}/${this.retryBudget}），不再重试（防失败放大）`);
      }
      if (retry) {
        this.retriesUsed++;

        const tombstone = hardTimedOut || failureType === 'stalled' ? 2000 : 0;
        const delay = Math.max(backoffDelay(task.attempts, task.budget.backoffMs), tombstone);
        log(`↻ ${task.id} 失败（${ft}，${Math.round(ms / 1000)}s），~${Math.round(delay / 1000)}s 后重试（指数退避+jitter${tombstone ? '，含墓碑期' : ''}；预算 ${this.retriesUsed}/${this.retryBudget}）`);
        this.transit(task, 'pending', { outcome: rec, notBefore: Date.now() + delay, leasedBy: null, leaseUntil: 0 });
      } else {
        const why = isRetryable(ft) ? '重试次数用尽' : '确定性失败不重试';
        log(`✗ ${task.id} 最终失败（${ft}，${why}）`);
        this.transit(task, 'failed', { outcome: rec, leasedBy: null, leaseUntil: 0 });
      }
      }
      return verdict;
    } catch (earlyErr) {

      log(`✗ ${task.id} 执行器初始化异常，收敛为失败: ${earlyErr && earlyErr.message}`);

      try { this.feedback.notifyResult(`${task.role || '-'}::${task.type}`, false); } catch (e) { log('⚠ 熔断回填失败(early): ' + (e && e.message)); }
      try {
        task.attemptId += 1;
        const rec = { verdict: 'fail', ms: 0, failureType: 'crash', note: 'execute 早期异常: ' + (earlyErr && earlyErr.message), ts: Date.now() };
        task.outcome = rec;
        pushHistory(task, rec);
        if (enteredRun) this.transit(task, 'failed', { outcome: rec, leasedBy: null, leaseUntil: 0 });
        else this.transit(task, 'pending', { outcome: rec, notBefore: Date.now() + 1000, leasedBy: null, leaseUntil: 0 });
      } catch (e2) {
        log(`✗ ${task.id} 连收敛都失败: ${e2 && e2.message}`);
      }
      return 'fail';
    } finally {
      if (this.abortCtl.get(task.id) === ac) this.abortCtl.delete(task.id);
    }
  }

  async run() {
    let idleTicks = 0;
    let lastProgress = Date.now();
    const origPersist = this.persist.bind(this);

    let persistFails = 0;
    let finished = false;
    this._persistNow = (force) => {
      try {
        origPersist(force);
        persistFails = 0;
      } catch (e) {
        persistFails++;
        log(`⚠ 落盘失败(${persistFails}/50): ${(e && e.message) || e} — 保持待写，下轮重试`);
        if (persistFails >= 50) { this.persist = origPersist; throw e; }
      }
    };
    this.persist = (f) => { this._persistNow(f); lastProgress = Date.now(); idleTicks = 0; };

    try {
    for (;;) {

      if (this.admission) {
        const sinceProbe = Date.now() - this.lastGateProbeAt;
        if (sinceProbe > 1000 && !this.gateQueueThisTick) {

          this.gateBlockSince = 0;
        } else if (this.gateQueueThisTick) {
          this.gateBlockSince = this.gateBlockSince || Date.now();
        }
      }
      let tasks = this.all();
      const byId = this.byId(tasks);
      const inflight = new Set(tasks.filter((t) => t.state === 'running' || t.state === 'leased').map((t) => t.id));

      if (this.onProgress) {
        try { this.onProgress(tasks); } catch {}
      }

      for (const t of tasks) {
        if (t.state !== 'leased') continue;
        if (this.abortCtl.has(t.id)) continue;
        if (t.leaseUntil && Date.now() > t.leaseUntil) {
          log(`⟳ ${t.id} 租约过期（外部持有），回收`);
          this.transit(t, 'pending', { leasedBy: null, leaseUntil: 0, outcome: { verdict: 'lease_expired', failureType: 'stalled' } });
        }
      }

      if (this.markUnresolvable(this.all())) continue;

      if (this.propagateFailure(this.all())) continue;

      this.reapZombies();
      this.gateQueueThisTick = false;
      this.gateErrorThisTick = false;
      let dispatchedAny = false;
      const slots = this.concurrency - inflight.size - this.zombieCount();
      if (slots > 0) {
        const { ready, tripped } = this.readySet(this.all());
        if (this.applyTripped(tripped)) continue;

        const toRun = [];
        this.gateQueueThisTick = false;
        this.gateErrorThisTick = false;
        for (const t of ready) {
          if (toRun.length >= slots) break;
          const gv = this.canDispatch(t);
          if (gv !== 'ok') {

            if (gv === 'queue') this.gateQueueThisTick = true;
            else if (gv === 'error') this.gateErrorThisTick = true;
            continue;
          }
          toRun.push(t);

          t.state = 'leased';
          t.leasedBy = 'sched-pending';
          t.leaseUntil = Date.now() + this.leaseMs;
        }

        if (toRun.length) {
          dispatchedAny = true;
          this.persist(true);

          const probeKeys = new Set();
          const dispatch = [];
          for (const t of toRun) {
            const k = `${t.role || '-'}::${t.type}`;
            let state = 'closed';
            try { state = this.feedback.consumeProbe(k); } catch {}
            if ((state === 'half-open' || state === 'open') && probeKeys.has(k)) {

              try { this.transit(t, 'pending', { leasedBy: null, leaseUntil: 0 }); } catch (e) { log('⚠ 探针退回失败(' + t.id + '): ' + (e && e.message)); }
              continue;
            }
            if (state === 'half-open' || state === 'open') probeKeys.add(k);
            dispatch.push(t);
          }
          for (const t of dispatch) this.execute(t).catch((e) => {
          log(`✗ ${t.id} 结果回写阶段异常: ${(e && e.message) || e}`);
          try { this.feedback.notifyResult(`${t.role || '-'}::${t.type}`, false); } catch (e) { log('⚠ 熔断回填失败(catch): ' + (e && e.message)); }
          try { if (t.state === 'running' || t.state === 'leased') this.transit(t, 'failed', { outcome: { verdict: 'fail', failureType: 'crash', note: '结果回写异常: ' + ((e && e.message) || e) } }); } catch (e2) { log('✗ ' + t.id + ' 终态收敛失败: ' + (e2 && e2.message)); }
        });
          continue;
        }
      }

      this.flushDue();

      if (!dispatchedAny && inflight.size === 0 && this.zombieCount() === 0) {
        this.flushDue();
        await new Promise((r) => setTimeout(r, 200));
      }

      tasks = this.all();
      const settled = (t) => isSettled(t);
      if (tasks.every(settled)) {
        this.store.saveMeta(this.runId, { ...this.store.loadMeta(this.runId), finishedAt: new Date().toISOString() });
        this.store.appendEvent(this.runId, { kind: 'run_done', feedback: this.feedback.snapshot() });

        origPersist(true);
        const count = (s) => tasks.filter((t) => t.state === s).length;
        log(`运行结束：done=${count('done')} failed=${count('failed')} degraded=${count('degraded')} skipped=${count('skipped')} blocked=${count('blocked')}`);
        finished = true;
        return this.summary(tasks);
      }

      const now = Date.now();
      const allPendingSettledForWatchdog = this.all()
        .filter((t) => t.state === 'pending')
        .every((t) => !t.notBefore || t.notBefore <= now);
      if (inflight.size === 0 && this.zombieCount() === 0 && allPendingSettledForWatchdog && Date.now() - lastProgress > 15000) {

        if (this.gateErrorThisTick) {
          log('⚠ 准入闸门故障(err)，跳过豁免并强制收场');
          this.gateErrorThisTick = false;
          this.gateBlockSince = 0;
        } else if (this.gateQueueThisTick) {
          this.gateQueueThisTick = false;
        }
        const gateBlocked = this.gateBlockSince > 0;
        if (gateBlocked) {
          if (Date.now() - this.gateBlockSince <= this.gateGraceMs) {
            lastProgress = Date.now();
            await new Promise((r) => setTimeout(r, 200));
            continue;
          }
          log('⚠ 闸门持续阻塞超过 ' + Math.round(this.gateGraceMs / 1000) + 's，强制收场');
        }
        const stuck = this.all().filter((t) => !settled(t));
        if (stuck.length) {
          log('⚠ 看门狗：15s 无在飞任务且状态无推进，强制收场（防止无限 hang）');
          for (const t of stuck) {
            if (t.state === 'running' || t.state === 'leased') {
              const ac = this.abortCtl.get(t.id);
              if (ac) { try { ac.abort(); } catch {} }
              this.transit(t, 'failed', { outcome: { verdict: 'fail', failureType: 'stalled', watchdog: true, note: 'watchdog 强制收场（不可复活）' }, leasedBy: null, leaseUntil: 0 });
            } else if (t.state === 'failed') {
              this.transit(t, 'skipped', { outcome: { verdict: 'skip', failureType: 'crash', note: 'watchdog 二次兜底' } });
            } else if (t.state === 'pending' || t.state === 'blocked') {
              this.transit(t, 'skipped', { outcome: { verdict: 'skip', failureType: 'crash', note: 'watchdog: 无推进' } });
            }
          }
          lastProgress = Date.now();
          continue;
        }
      }

      idleTicks++;
      const hasInflight = inflight.size > 0;
      const hasReady = this.readySetQuietly(this.all()).length > 0;
      const interval = hasInflight || hasReady ? 2 : 200;
      await new Promise((r) => setTimeout(r, interval));
    }
    } finally {

      for (const ac of this.abortCtl.values()) { try { ac.abort(); } catch {} }
      if (!finished) { try { origPersist(true); } catch (e) { log('⚠ 尽力最终落盘失败: ' + ((e && e.message) || e)); } }
      this.persist = origPersist;
    }
  }

  readySetQuietly(tasks) {
    const byId = this.byId(tasks);
    const now = Date.now();
    const out = [];
    for (const t of tasks) {
      if (t.state !== 'pending' && t.state !== 'blocked') continue;
      if (!depsSatisfied(t, byId)) continue;
      if (t.notBefore && now < t.notBefore) continue;

      if (this.feedback.peekCircuitState(`${t.role || '-'}::${t.type}`) === 'open') continue;
      out.push(t);
    }
    return out;
  }

  summary(tasks) {
    const c = (s) => tasks.filter((t) => t.state === s).length;
    return {
      done: c('done'),
      failed: c('failed'),
      degraded: c('degraded'),
      skipped: c('skipped'),
      blocked: c('blocked'),
      feedback: this.feedback.snapshot(),
      tasks,
    };
  }
}

module.exports = { Scheduler, log };
