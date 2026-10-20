'use strict';

const fs = require('fs');
const path = require('path');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function isWindowsReservedName(name) {
  return WIN_RESERVED.test(String(name || '').split('.')[0]);
}

function assertId(id, what = 'id') {
  if (typeof id !== 'string' || !ID_RE.test(id) || id.includes('..')) {
    throw new Error(`非法 ${what}: ${String(id)}（只允许字母数字 . _ -，且不得含 ..）`);
  }
  if (isWindowsReservedName(id)) {
    throw new Error(`非法 ${what}: ${id}（保留设备名，任意扩展形态都会截断/碰撞）`);
  }
  if (/[. ]$/.test(id)) {
    throw new Error(`非法 ${what}: ${id}（不得以点或空格结尾，Windows 会静默截断导致 id 碰撞）`);
  }
  return id;
}

function atomicWrite(root, file, data) {
  const absRoot = path.resolve(root);
  const absFile = path.resolve(file);
  if (absFile !== absRoot && !absFile.startsWith(absRoot + path.sep)) {
    throw new Error('拒绝写入越界路径: ' + file);
  }
  const tmp = absFile + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  fs.mkdirSync(path.dirname(absFile), { recursive: true });
  fs.writeFileSync(tmp, data);

  try {
    const fd = fs.openSync(tmp, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch {  }
  fs.renameSync(tmp, absFile);
}

class FileStore {
  constructor(root) {
    this.root = path.resolve(root);
    this._epochCache = new Map();
    fs.mkdirSync(this.root, { recursive: true });
  }

  runDir(runId) {
    assertId(runId, 'runId');
    return path.join(this.root, runId);
  }

  ensureRun(runId) {
    const dir = this.runDir(runId);
    fs.mkdirSync(path.join(dir, 'events'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
    return dir;
  }

  saveTasks(runId, tasks, epoch) {
    if (typeof epoch !== 'number' || !Number.isFinite(epoch)) {
      throw new Error('saveTasks 缺 epoch（fencing 要求调用方显式传入单调递增值）');
    }
    const dir = this.ensureRun(runId);
    const snapPath = path.join(dir, 'snapshot.json');

    const cur = this.currentEpoch(runId);
    if (epoch <= cur) {
      this.appendEvent(runId, { kind: 'stale_write_rejected', epoch, currentEpoch: cur });
      return false;
    }
    atomicWrite(this.root, snapPath, JSON.stringify({ epoch, tasks }, null, 2));
    this._epochCache.set(runId, epoch);
    return true;
  }

  loadTasks(runId) {
    const snapPath = path.join(this.runDir(runId), 'snapshot.json');
    if (!fs.existsSync(snapPath)) return [];
    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    return snap.tasks || [];
  }

  currentEpoch(runId) {

    let head = 0;
    try {
      const snapPath = path.join(this.runDir(runId), 'snapshot.json');
      const fd = fs.openSync(snapPath, 'r');
      try {
        const buf = Buffer.alloc(64);
        const n = fs.readSync(fd, buf, 0, 64, 0);
        const m = /"epoch"\s*:\s*(\d+)/.exec(buf.slice(0, n).toString('utf8'));
        if (m) head = parseInt(m[1], 10);
      } finally { fs.closeSync(fd); }
    } catch {  }
    const cached = this._epochCache.get(runId) || 0;
    const cur = Math.max(cached, Number.isFinite(head) ? head : 0);
    this._epochCache.set(runId, cur);
    return cur;
  }

  saveMeta(runId, meta) {
    atomicWrite(this.root, path.join(this.runDir(runId), 'meta.json'), JSON.stringify(meta, null, 2));
  }
  loadMeta(runId) {
    const p = path.join(this.runDir(runId), 'meta.json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  }

  saveArtifact(runId, art) {
    const id = art.id ? assertId(art.id, 'artifactId') : 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const record = { ...art, id, ts: new Date().toISOString() };
    atomicWrite(this.root, path.join(this.runDir(runId), 'artifacts', id + '.json'), JSON.stringify(record, null, 2));
    return record;
  }
  getArtifact(runId, id) {
    assertId(id, 'artifactId');
    const p = path.join(this.runDir(runId), 'artifacts', id + '.json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  }
  listArtifacts(runId, filter = {}) {
    const dir = path.join(this.runDir(runId), 'artifacts');
    if (!fs.existsSync(dir)) return [];
    let all = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; }
    }).filter(Boolean);
    if (filter.type) all = all.filter((a) => a.type === filter.type);
    if (filter.taskId) all = all.filter((a) => a.taskId === filter.taskId);
    if (filter.okOnly) all = all.filter((a) => a.ok !== false);
    if (filter.keyword) {
      const k = filter.keyword.toLowerCase();
      all = all.filter((a) => ((a.summary || '') + ' ' + (a.body || '')).toLowerCase().includes(k));
    }
    return all;
  }

  appendEvent(runId, evt) {
    this.ensureRun(runId);
    const line = JSON.stringify({ ts: Date.now(), ...evt }) + '\n';
    fs.appendFileSync(path.join(this.runDir(runId), 'events', 'log.jsonl'), line);
  }
  listEvents(runId) {
    const p = path.join(this.runDir(runId), 'events', 'log.jsonl');
    if (!fs.existsSync(p)) return [];
    const out = [];
    const raw = fs.readFileSync(p, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {  }
    }
    return out;
  }
}

module.exports = { FileStore, atomicWrite, assertId, isWindowsReservedName };
