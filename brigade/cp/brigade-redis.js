'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { RedisMin } = require('./redis-min');

const PORT = parseInt(process.env.BRIGADE_REDIS_PORT || '6390', 10);
const HOST = '127.0.0.1';
const DATA_DIR = path.join(__dirname, '..', '.redis');
const RUN_TTL_SEC = 180;

function findRedisServer() {
  if (process.env.BRIGADE_REDIS_BIN && fs.existsSync(process.env.BRIGADE_REDIS_BIN)) {
    return process.env.BRIGADE_REDIS_BIN;
  }
  return 'redis-server';
}

let _client = undefined;
let _nullAt = 0;
let _ensuring = null;
let ensureAttempts = 0;

async function ensureRedis(opts = {}) {

  if (_client && _client.dead) { _client = undefined; _ensuring = null; }

  const retryNow = !!(opts && opts.retryNow);
  if (_client === null && (retryNow || Date.now() - _nullAt > 60_000)) { _client = undefined; _ensuring = null; }
  if (_client !== undefined) return _client;
  if (_ensuring) return _ensuring;
  ensureAttempts++;
  _ensuring = (async () => {
    if (process.env.BRIGADE_REDIS === '0') { _client = null; _nullAt = Date.now(); return null; }

    let r = await RedisMin.connect({ host: HOST, port: PORT });
    if (r && await ping(r)) { _client = r; return r; }
    if (r) r.close();

    const bin = findRedisServer();
    if (!bin) { _client = null; _nullAt = Date.now(); return null; }
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const child = spawn(bin, [
        '--port', String(PORT), '--bind', HOST,
        '--save', '', '--appendonly', 'no',
        '--dir', DATA_DIR,
        '--maxmemory', '256mb', '--maxmemory-policy', 'allkeys-lru',
        '--pidfile', path.join(DATA_DIR, 'brigade.pid'),
        '--logfile', path.join(DATA_DIR, 'redis.log'),
      ], { stdio: 'ignore', detached: true, windowsHide: true });
      child.on('error', () => {});
      child.unref();
    } catch { _client = null; _nullAt = Date.now(); return null; }

    for (let i = 0; i < 30; i++) {
      await new Promise((res) => setTimeout(res, 100));
      r = await RedisMin.connect({ host: HOST, port: PORT });
      if (r && await ping(r)) { _client = r; return r; }
      if (r) r.close();
    }
    _client = null; _nullAt = Date.now();
    return null;  // 调用方按单实例模式降级
  })();
  return _ensuring;
}

async function ping(r) {
  try { const v = await r.cmd('PING'); return v === 'PONG' || v === true; } catch { return false; }
}

async function regRun(rec) {
  const r = await ensureRedis(); if (!r) return;
  try {
    await r.cmd('SADD', 'brigade:live', rec.runId);
    await r.cmd('SET', 'brigade:run:' + rec.runId, JSON.stringify(rec), 'EX', RUN_TTL_SEC);
  } catch {}
}

async function regHeartbeat(rec) {

  const r = await ensureRedis({ retryNow: true }); if (!r) return;
  try {
    await r.cmd('SADD', 'brigade:live', rec.runId);
    await r.cmd('SET', 'brigade:run:' + rec.runId, JSON.stringify(rec), 'EX', RUN_TTL_SEC);
  } catch {}
}
async function regUpdate(runId, patch) {
  const r = await ensureRedis(); if (!r) return;
  try {
    const cur = await r.cmd('GET', 'brigade:run:' + runId);

    if (!cur) return;
    const rec = JSON.parse(cur);
    await r.cmd('SET', 'brigade:run:' + runId, JSON.stringify({ ...rec, ...patch }), 'EX', RUN_TTL_SEC);
  } catch {}
}
async function regUnregister(runId) {
  const r = await ensureRedis(); if (!r) return;
  try { await r.cmd('DEL', 'brigade:run:' + runId); await r.cmd('SREM', 'brigade:live', runId); } catch {}
}

async function listLiveRuns() {
  const r = await ensureRedis(); if (!r) return [];
  try {
    const ids = (await r.cmd('SMEMBERS', 'brigade:live')) || [];
    if (!ids.length) return [];
    const vals = await r.cmd('MGET', ...ids.map((id) => 'brigade:run:' + id));
    const out = [];
    for (let i = 0; i < ids.length; i++) {
      if (!vals[i]) { try { await r.cmd('SREM', 'brigade:live', ids[i]); } catch {} continue; }
      try { out.push(JSON.parse(vals[i])); } catch {}
    }
    return out;
  } catch { return []; }
}

async function liveRunsForCwd(cwd, excludeRunId) {
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const all = await listLiveRuns();
  return all.filter((x) => x.cwd && norm(x.cwd) === norm(cwd) && x.runId !== excludeRunId);
}
async function inflightCount() {
  const list = await listLiveRuns();
  return list.length;
}

module.exports = {
  ensureRedis, PORT,
  regRun, regHeartbeat, regUpdate, regUnregister, listLiveRuns, liveRunsForCwd,
  inflightCount,
  getEnsureAttempts: () => ensureAttempts,
};
