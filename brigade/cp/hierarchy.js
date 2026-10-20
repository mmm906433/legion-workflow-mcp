'use strict';

const { makeTask, typeMeta, isSettled } = require('./task');

class Message {
  constructor({ id, from, to, kind, payload, ts }) {
    this.id = id || 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this.from = from;
    this.to = to;
    this.kind = kind;
    this.payload = payload;
    this.ts = ts || Date.now();
  }
  static from(o) { return Object.assign(Object.create(Message.prototype), o); }
  toJSON() { return { id: this.id, from: this.from, to: this.to, kind: this.kind, payload: this.payload, ts: this.ts }; }
}

class MessageBus {
  constructor() { this.log = []; this.seq = 0; }
  post(msg) {
    this.log.push(msg);
    this.log.sort((a, b) => a.ts - b.ts);
    return msg;
  }
  to(target) { return this.log.filter((m) => m.to === target); }
  from(source) { return this.log.filter((m) => m.from === source); }
  broadcast() { return this.log.filter((m) => m.to === 'broadcast'); }

  inbox(squadId) { return this.log.filter((m) => m.to === squadId || m.to === 'broadcast'); }
}

class Squad {
  constructor({ id, card, lead, tasks, mode = 'parallel' }) {
    this.id = id;
    this.card = card;
    this.lead = lead || null;
    this.tasks = tasks || [];
    this.mode = mode;
    this.status = 'forming';
    this.reports = [];
    this.startedAt = 0;
    this.finishedAt = 0;
  }
  progress() {
    if (!this.tasks.length) return 0;
    const done = this.tasks.filter((t) => t.state === 'done').length;
    return Math.round((done / this.tasks.length) * 100);
  }
  toJSON() {
    return {
      id: this.id, card: this.card, mode: this.mode, status: this.status,
      progress: this.progress(), tasks: this.tasks.map((t) => ({ id: t.id, title: t.title, state: t.state })),
      reports: this.reports,
    };
  }
}

function squadBudget(difficulty) {
  if (difficulty === 'trivial') return { squads: 1, perSquad: 1, effort: 'low' };
  if (difficulty === 'simple') return { squads: 1, perSquad: 3, effort: 'medium' };
  if (difficulty === 'moderate') return { squads: 2, perSquad: 3, effort: 'high' };
  if (difficulty === 'hard') return { squads: 4, perSquad: 4, effort: 'high' };
  return { squads: 6, perSquad: 5, effort: 'max' };
}

class Command {
  constructor(opts = {}) {
    this.bus = new MessageBus();
    this.squads = new Map();
    this.decomposed = false;
    this.budget = opts.budget || squadBudget(opts.difficulty || 'moderate');
    this.maxSquadsParallel = opts.maxSquadsParallel ?? Math.max(1, Math.floor((opts.globalConcurrency || 4) / 2));

    this.writeSquadGate = opts.writeSquadGate ?? 1;
    this._liveTasks = [];
    this.log = [];
  }

  _log(level, msg) {
    this.log.push({ ts: Date.now(), level, msg });
    console.log(`[cmd ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, msg);
  }

  deploy(goal, cards, taskFactory) {
    this.decomposed = true;

    if (goal) this.goal = goal;
    const cardList = (cards && cards.length) ? cards : [{ id: 'card0', title: goal, goal, accept: [], difficulty: 'moderate' }];
    for (const card of cardList) {
      const squadId = 'sq-' + card.id;
      const squad = new Squad({ id: squadId, card, mode: card.mode || (card.pipeline ? 'pipeline' : 'parallel') });

      squad.tasks = taskFactory(card, squadId) || [];
      this.squads.set(squadId, squad);
      this.bus.post(new Message({
        from: 'command', to: squadId, kind: 'assign',
        payload: { goal: card.goal, accept: card.accept, mode: squad.mode, budget: this.budget },
      }));
      this._log('info', `部署小队 ${squadId}（${squad.mode}）：${squad.tasks.length} 个任务 — ${card.title}`);
    }
    return this.squads;
  }

  squad(id) { return this.squads.get(id); }

  canSquadRun(squadId) {
    const sq = this.squads.get(squadId);
    if (!sq) return true;

    if (!this._writesWorkspace(sq)) return true;

    const runningWriters = (this._liveTasks || []).filter(
      (t) => t.input && t.input.squadId && t.input.squadId !== squadId
        && (t.state === 'running' || t.state === 'leased') && this._taskWritesWorkspace(t)
    ).length;
    return runningWriters < this.writeSquadGate;
  }

  _taskWritesWorkspace(task) {
    const meta = typeMeta(task.type);
    return !!(meta && meta.writable);
  }

  _writesWorkspace(squad) {
    return squad.tasks.some((t) => {
      const meta = typeMeta(t.type);
      return meta && meta.writable;
    });
  }

  gateStatus() {
    const writers = [...this.squads.values()].filter((s) => s.status === 'active' && this._writesWorkspace(s));
    return { writeGate: this.writeSquadGate, activeWriters: writers.length, saturated: writers.length >= this.writeSquadGate };
  }
  reportSquad(squadId, report) {
    const sq = this.squads.get(squadId);
    if (!sq) return;
    sq.status = 'done';
    sq.finishedAt = Date.now();
    sq.reports.push(report);
    this.bus.post(new Message({ from: squadId, to: 'command', kind: 'report', payload: report }));
    this._log('info', `小队 ${squadId} 完工，进度 100%`);
  }

  blockSquad(squadId, reason) {
    const sq = this.squads.get(squadId);
    if (!sq) return;
    sq.status = 'blocked';
    this.bus.post(new Message({ from: squadId, to: 'command', kind: 'block', payload: { reason } }));
    this._log('warn', `小队 ${squadId} 受阻：${reason}`);
  }

  status() {
    const all = [...this.squads.values()];
    const totalTasks = all.reduce((n, s) => n + s.tasks.length, 0);
    const doneTasks = all.reduce((n, s) => n + s.tasks.filter((t) => t.state === 'done').length, 0);
    return {
      goal: this.goal,
      squads: all.map((s) => s.toJSON()),
      totalTasks, doneTasks,
      progress: totalTasks ? Math.round((doneTasks / totalTasks) * 100) : 0,
      active: all.filter((s) => s.status === 'active').length,
      queued: all.filter((s) => s.status === 'queued').length,
      done: all.filter((s) => s.status === 'done').length,
      blocked: all.filter((s) => s.status === 'blocked').length,
      gate: this.gateStatus(),
      messages: this.bus.log.length,
    };
  }
}

function makeWriteGate(command) {
  return (task, tasks) => {
    if (Array.isArray(tasks)) command._liveTasks = tasks;
    const squadId = task.input && task.input.squadId;
    if (!squadId) return true;
    const sq = command.squads.get(squadId);
    if (!sq) return true;
    if (!command._writesWorkspace(sq)) return true;
    if (!command._taskWritesWorkspace(task)) return true;

    const live = command._liveTasks && command._liveTasks.length ? command._liveTasks : sq.tasks;
    const squadBusy = live.some(
      (t) => t.id !== task.id && t.input && t.input.squadId === squadId
        && (t.state === 'running' || t.state === 'leased') && command._taskWritesWorkspace(t)
    );

    if (squadBusy) return false;
    return command.canSquadRun(squadId);
  };
}

function flattenSquads(command) {
  const tasks = [];
  for (const squad of command.squads.values()) {
    for (const t of squad.tasks) {
      tasks.push(makeTask({ ...t, input: { ...(t.input || {}), squadId: squad.id } }));
    }
  }
  return tasks;
}

function syncSquads(command, tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const squad of command.squads.values()) {

    squad.tasks = squad.tasks.map((t) => byId.get(t.id) || t);
    if (squad.status === 'done' || squad.status === 'aborted' || squad.status === 'blocked') continue;
    const all = squad.tasks;
    const done = all.filter((t) => t.state === 'done').length;
    const failed = all.filter((t) => t.state === 'failed').length;

    const settled = all.filter((t) => isSettled(t)).length;

    if (all.length && settled === all.length) {
      if (done === all.length) {
        command.reportSquad(squad.id, {
          squadId: squad.id, goal: squad.card.goal,
          outputs: all.map((t) => ({ id: t.id, summary: (t.outcome && t.outcome.note) || '' })),
        });
      } else if (failed === all.length) {
        command.blockSquad(squad.id, '全部任务失败');
      } else {

        if (done === 0) {
          command.blockSquad(squad.id, '无成功任务');
          continue;
        }

        command.reportSquad(squad.id, {
          squadId: squad.id, goal: squad.card.goal, partial: true,
          summary: `${done}/${all.length} 成功，${all.length - done} 未成功`,
          outputs: all.map((t) => ({ id: t.id, state: t.state, summary: (t.outcome && t.outcome.note) || '' })),
        });
      }
    } else {

      if (command.canSquadRun(squad.id)) {
        squad.status = 'active';
        if (!squad.startedAt) squad.startedAt = Date.now();
      } else {
        squad.status = 'queued';
      }
    }
  }
}

module.exports = { Command, Squad, MessageBus, Message, squadBudget, flattenSquads, syncSquads, makeWriteGate };
