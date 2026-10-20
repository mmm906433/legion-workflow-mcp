'use strict';

const fs = require('fs');
const path = require('path');

const STAGE = {
  QUEUED: 'queued',
  PLANNING: 'planning',
  PICKING: 'picking',
  EXECUTING: 'executing',
  VERIFYING: 'verifying',
  REVIEWING: 'reviewing',
  DONE: 'done',
  FAILED: 'failed',
  STALLED: 'stalled',
};

class EventBus {
  constructor() { this.subs = []; this.history = []; }
  on(fn) { this.subs.push(fn); return () => { this.subs = this.subs.filter((f) => f !== fn); }; }
  emit(evt) {

    this._lastTs = Math.max(Date.now(), (this._lastTs || 0) + 1);
    const rec = { ts: this._lastTs, ...evt };
    this.history.push(rec);
    if (this.history.length > 500) this.history.shift();
    for (const fn of this.subs) { try { fn(rec); } catch {} }
    return rec;
  }
}

class RuntimeRegistry {
  constructor({ staleMs = 120000 } = {}) {
    this.entries = new Map();
    this.staleMs = staleMs;
  }

  start(id, meta = {}) {
    this.entries.set(id, {
      id, ...meta, stage: STAGE.EXECUTING,
      startedAt: Date.now(), lastBeat: Date.now(), beats: 1, note: meta.note || '',
    });
  }

  beat(id, note) {
    const e = this.entries.get(id);
    if (!e) return;
    e.lastBeat = Date.now();
    e.beats++;
    if (note) e.note = String(note).slice(0, 200);
  }

  stage(id, stage, note) {
    const e = this.entries.get(id);
    if (!e) return;
    e.stage = stage;
    e.lastBeat = Date.now();
    if (note) e.note = String(note).slice(0, 200);
  }

  finish(id, result) {
    const e = this.entries.get(id);
    if (!e) return null;
    e.stage = result && result.ok === false ? STAGE.FAILED : STAGE.DONE;
    e.finishedAt = Date.now();
    e.ms = e.finishedAt - e.startedAt;
    e.result = result ? { ok: !!result.ok, summary: String(result.summary || '').slice(0, 200) } : null;
    this.entries.delete(id);
    return e;
  }

  snapshot(now = Date.now()) {
    return [...this.entries.values()].map((e) => ({
      ...e,
      elapsedMs: now - e.startedAt,
      idleMs: now - e.lastBeat,
      stalled: now - e.lastBeat > this.staleMs,
    }));
  }

  summary(now = Date.now()) {
    const s = this.snapshot(now);
    return {
      active: s.length,
      stalled: s.filter((x) => x.stalled).length,
      byStage: s.reduce((m, x) => { m[x.stage] = (m[x.stage] || 0) + 1; return m; }, {}),
      items: s.map((x) => `${x.id}[${x.stage}] ${x.title || x.note || ''} (${Math.round(x.elapsedMs / 1000)}s${x.stalled ? ' 卡住!' : ''})`),
    };
  }
}

class ProgressLog {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  write(evt) {
    fs.appendFileSync(this.file, JSON.stringify({ ts: Date.now(), ...evt }) + '\n');
  }
  read(lastN = 30) {
    if (!fs.existsSync(this.file)) return [];
    const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-lastN).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
}

function createObservability(opts = {}) {
  const bus = new EventBus();
  const registry = new RuntimeRegistry({ staleMs: opts.staleMs });
  const log = opts.logFile ? new ProgressLog(opts.logFile) : null;
  bus.on((evt) => { if (log) log.write(evt); if (opts.onEvent) { try { opts.onEvent(evt); } catch {} } });
  return {
    bus, registry, log,
    stage: (id, stage, note) => { bus.emit({ kind: 'stage', id, stage, note }); registry.stage(id, stage, note); },
    start: (id, meta) => { bus.emit({ kind: 'start', id, ...meta }); registry.start(id, meta); },
    beat: (id, note) => { registry.beat(id, note); if (note) bus.emit({ kind: 'beat', id, note }); },
    finish: (id, result) => { const e = registry.finish(id, result); bus.emit({ kind: 'finish', id, ok: !!(result && result.ok), ms: e ? e.ms : 0, summary: result && result.summary }); return e; },
    snapshot: () => registry.snapshot(),
    summary: () => registry.summary(),
  };
}

module.exports = { STAGE, EventBus, RuntimeRegistry, ProgressLog, createObservability };
