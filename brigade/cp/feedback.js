'use strict';

const WINDOW = 20;

const SLOW_BUDGET_CEILING_SEC = 3600;

const OBSERVED_MAX = 12;

const SLOW_KILL_TYPES = new Set(['timeout']);

function key(task) {
  return `${task.role || '-'}::${task.type}`;
}

class FeedbackEngine {
  constructor(opts = {}) {
    this.stats = new Map();
    this.meldThreshold = opts.meldThreshold ?? 3;
    this.meldCooldownMs = opts.meldCooldownMs ?? 60_000;
    this.onEvent = opts.onEvent || null;
  }

  _get(k) {
    if (!this.stats.has(k)) {
      this.stats.set(k, { samples: [], observed: [], tripped: false, trippedUntil: 0, blocked: false });
    }
    const st = this.stats.get(k);
    if (!Array.isArray(st.observed)) st.observed = [];
    return st;
  }

  exportProfile() {
    const out = {};
    for (const [k, st] of this.stats) {
      const d = (st.observed || []).slice(-OBSERVED_MAX);
      if (!d.length && !st.timeouts) continue;
      out[k] = st.timeouts ? { d, t: st.timeouts } : d;
    }
    return out;
  }

  importProfile(profile) {
    if (!profile || typeof profile !== 'object') return;
    for (const [k, v] of Object.entries(profile)) {
      const st = this._get(k);
      if (Array.isArray(v)) { st.observed = v.slice(-OBSERVED_MAX); continue; }
      if (v && Array.isArray(v.d)) st.observed = v.d.slice(-OBSERVED_MAX);
      if (v && typeof v.t === 'number') st.timeouts = v.t;
    }
  }

  record(task, outcome) {
    const verdict = outcome.verdict;
    const neutral = verdict === 'degraded' || verdict === 'skip' || verdict === 'stale';
    if (neutral) return this._get(key(task));

    const k = key(task);
    const st = this._get(k);
    const ok = verdict === 'done' || verdict === 'PASS';
    st.samples.push({
      ts: Date.now(),
      ok,
      ms: outcome.ms || 0,
      failureType: outcome.failureType || null,
    });
    if (st.samples.length > WINDOW) st.samples.shift();

    if (outcome.ms > 0 && outcome.failureType !== 'stalled') {
      st.observed.push(outcome.ms);
      if (st.observed.length > OBSERVED_MAX) st.observed.shift();
    }

    if (!ok && SLOW_KILL_TYPES.has(outcome.failureType)) {
      st.timeouts = (st.timeouts || 0) + 1;
      if (st.timeouts > 20) st.timeouts = 20;
      st.lastTimeoutAt = Date.now();
    }

    if (ok) st.lastSuccessAt = Date.now();

    const recent = st.samples.slice(-this.meldThreshold);
    if (recent.length >= this.meldThreshold && recent.every((s) => !s.ok)) {
      if (!st.tripped) {
        st.tripped = true;
        st.halfOpenUsed = false;
        st.trippedUntil = Date.now() + this.meldCooldownMs;
        if (this.onEvent) this.onEvent({ kind: 'circuit_open', key: k, until: st.trippedUntil });
      }
    }

    if (ok && st.tripped) {
      st.tripped = false;
      st.halfOpenUsed = false;
      if (this.onEvent) this.onEvent({ kind: 'circuit_closed', key: k, by: 'record_success' });
    }
    return st;
  }

  reliability(k) {
    const st = this.stats.get(k);
    if (!st || !st.samples.length) return null;
    const s = st.samples;
    const ok = s.filter((x) => x.ok).length;
    const stalls = s.filter((x) => x.failureType === 'stalled').length;
    const avgMs = s.reduce((a, b) => a + b.ms, 0) / s.length;
    return {
      n: s.length,
      rate: ok / s.length,
      stallRate: stalls / s.length,
      avgMs: Math.round(avgMs),
    };
  }

  circuitState(k) {
    const st = this.stats.get(k);
    if (!st) return 'closed';
    if (!st.tripped) return 'closed';
    if (Date.now() > st.trippedUntil) {
      if (st.halfOpenUsed) {
        return 'open';
      }
      st.halfOpenUsed = true;
      if (this.onEvent) this.onEvent({ kind: 'circuit_half_open', key: k });
      return 'half-open';
    }
    return 'open';
  }

  peekCircuitState(k) {
    const st = this.stats.get(k);
    if (!st || !st.tripped) return 'closed';
    if (Date.now() > st.trippedUntil) return st.halfOpenUsed ? 'probing' : 'half-open';
    return 'open';
  }

  consumeProbe(k) {
    const st = this.stats.get(k);
    if (!st || !st.tripped) return 'closed';
    if (Date.now() > st.trippedUntil) {
      if (st.halfOpenUsed) return 'open';
      st.halfOpenUsed = true;
      if (this.onEvent) this.onEvent({ kind: 'circuit_half_open', key: k });
      return 'half-open';
    }
    return 'open';
  }

  notifyResult(k, ok) {
    const st = this._get(k);
    if (st.tripped && ok) {
      st.tripped = false;
      st.halfOpenUsed = false;
      st.samples = [];
      if (this.onEvent) this.onEvent({ kind: 'circuit_closed', key: k });
    } else if (st.tripped && !ok) {
      st.trippedUntil = Date.now() + this.meldCooldownMs;
      st.halfOpenUsed = false;
    }
  }

  advise(task, { blockingCount = 0 } = {}) {
    const k = key(task);
    const rel = this.reliability(k);
    const st = this._get(k);
    const adv = {
      priority: 0,
      timeoutSec: task.budget.timeoutSec,
      maxAttempts: task.budget.maxAttempts,
      stallSec: task.budget.stallSec,
      allow: true,
      reason: '',
    };

    adv.priority += blockingCount * 10;
    if (rel) {

      adv.priority += Math.round(rel.rate * 20) - 10;
      adv.timeoutSec = Math.max(task.budget.timeoutSec, Math.round(task.budget.timeoutSec * (0.75 + rel.rate * 0.5)));
      if (rel.rate < 0.4) {
        adv.priority -= 20;

        const SLOW_KILLS = new Set(['timeout', 'stalled']);
        const recent = st.samples.slice(-8);
        const kills = recent.filter((s) => !s.ok && SLOW_KILLS.has(s.failureType));
        const fastFails = recent.filter((s) => !s.ok && !SLOW_KILLS.has(s.failureType));
        const durations = recent.map((s) => s.ms || 0).filter((m) => m > 0).sort((a, b) => a - b);

        const p90Sec = durations.length >= 2
          ? Math.ceil(durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.9))] / 1000)
          : 0;

        if (p90Sec && kills.length >= 2 && kills.length > fastFails.length) {
          const wanted = Math.ceil(p90Sec * 1.3);
          adv.timeoutSec = Math.max(adv.timeoutSec, task.budget.timeoutSec,
            Math.min(wanted, SLOW_BUDGET_CEILING_SEC));

          const observedMs = durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.9))] || 0;
          adv.stallSec = Math.max(adv.stallSec, task.budget.stallSec,
            Math.ceil(Math.max(observedMs * 1.3, p90Sec * 1000) / 1000));
        }

      }
    }

    const cState = this.peekCircuitState(k);
    if (cState === 'open') {
      adv.allow = false;
      adv.reason = `熔断中：${k} 连续 ${this.meldThreshold} 次失败，冷却至 ${new Date(this.stats.get(k).trippedUntil).toLocaleTimeString('zh-CN')}`;
      adv.priority = -1000;
    } else if (cState === 'probing') {
      adv.allow = false;
      adv.waiting = true;
      adv.reason = '熔断探针在飞，等待判定: ' + k;
      adv.priority = -1000;
    } else if (cState === 'half-open') {
      adv.priority += 500;
    }

    {
      const obs = (st.observed || []).filter((m) => m > 0).sort((a, b) => a - b);
      if (obs.length >= 1) {
        const p90 = obs[Math.min(obs.length - 1, Math.floor(obs.length * 0.9))] / 1000;

        const staleTimeout = st.timeouts > 0 && !(st.lastSuccessAt && st.lastSuccessAt >= (st.lastTimeoutAt || 0));
        if (p90 > task.budget.timeoutSec || staleTimeout) {
          adv.timeoutSec = Math.max(adv.timeoutSec, task.budget.timeoutSec,
            Math.min(Math.ceil(p90 * 1.3), SLOW_BUDGET_CEILING_SEC));
          const obsMs = obs[Math.min(obs.length - 1, Math.floor(obs.length * 0.9))];
          adv.stallSec = Math.max(adv.stallSec, task.budget.stallSec, Math.ceil(obsMs * 1.3 / 1000));
        }
      }
    }
    return adv;
  }

  snapshot() {
    const out = {};
    for (const [k, st] of this.stats) out[k] = { n: st.samples.length, ok: st.samples.filter((s) => s.ok).length, tripped: st.tripped };
    return out;
  }
}

module.exports = { FeedbackEngine };
