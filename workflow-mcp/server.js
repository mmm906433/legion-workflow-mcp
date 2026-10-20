#!/usr/bin/env node
// brigade-workflow MCP server（通用，零依赖）

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const TEAM = require('path').resolve(__dirname, '..', 'brigade').replace(/\\/g, '/');
const { checkCwd } = require(path.join(TEAM, 'cp', 'cwd-guard'));
const RUN_ENTRY = path.join(TEAM, 'brigade.js');
const RUNS_ROOT = process.env.BRIGADE_RUNS_ROOT || path.join(TEAM, 'runs');

const REDIS_API = (() => {
  try {
    return require(path.join(TEAM, 'cp', 'brigade-redis'));
  } catch (e) {
    console.error('[brigade-mcp] 协调层加载失败，降级为单实例模式: ' + (e && e.message));
    return {
      listLiveRuns: async () => [], liveRunsForCwd: async () => [], inflightCount: async () => 0,
    };
  }
})();
const { listLiveRuns, liveRunsForCwd, inflightCount } = REDIS_API;
const MCP_STATE_DIR = process.env.BRIGADE_MCP_STATE_DIR || path.join(__dirname, '.mcp-runs');
const MCP_STATE = path.join(MCP_STATE_DIR, 'runs.json');
fs.mkdirSync(MCP_STATE_DIR, { recursive: true });

const MAX_PARALLEL = 8;
const LOG_RETAIN_MS = 30 * 86400_000;
const TAIL_BYTES = 8192;

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function runMeta(id) { return readJsonSafe(path.join(RUNS_ROOT, id, 'meta.json')); }
function runSnapshot(id) { return readJsonSafe(path.join(RUNS_ROOT, id, 'snapshot.json')); }

function listNativeRuns() {
  try {
    return fs.readdirSync(RUNS_ROOT)
      .filter((d) => /^\d{4}-\d{2}-\d{2}T/.test(d) && fs.statSync(path.join(RUNS_ROOT, d)).isDirectory())
      .sort().reverse();
  } catch { return []; }
}

function loadMcpRuns() {
  try { return JSON.parse(fs.readFileSync(MCP_STATE, 'utf8')); }
  catch (e) {
    if (e && e.code !== 'ENOENT') {
      try { fs.renameSync(MCP_STATE, MCP_STATE + '.corrupt-' + Date.now()); } catch {}
    }
    return {};
  }
}
function saveMcpRuns(m) {
  try {
    let disk = {};
    try { disk = JSON.parse(fs.readFileSync(MCP_STATE, 'utf8')) || {}; } catch {}
    const merged = { ...disk, ...m };
    const tmp = MCP_STATE + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 1));
    fs.renameSync(tmp, MCP_STATE);
  } catch (e) { console.error('[brigade-mcp] 台账写入失败: ' + (e && e.message)); }
}

function pruneMcpRuns() {
  try {
    const diskT0 = (() => { try { return JSON.parse(fs.readFileSync(MCP_STATE, 'utf8')) || {}; } catch { return null; } })();
    if (!diskT0) return;
    const cutoff = Date.now() - LOG_RETAIN_MS;
    const delSet = new Set();
    for (const id of Object.keys(diskT0)) {
      if (Date.parse(diskT0[id] && diskT0[id].startedAt || '') < cutoff) {
        try { fs.rmSync(path.join(MCP_STATE_DIR, id + '.log'), { force: true }); } catch {}
        delSet.add(id);
      }
    }
    if (!delSet.size) return;

    let fresh = {};
    try { fresh = JSON.parse(fs.readFileSync(MCP_STATE, 'utf8')) || {}; } catch { fresh = { ...diskT0 }; }
    for (const id of delSet) delete fresh[id];
    const tmp = MCP_STATE + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(fresh, null, 1));
    fs.renameSync(tmp, MCP_STATE);
  } catch (e) { console.error('[brigade-mcp] 台账清理失败: ' + (e && e.message)); }
}

const aliveCache = new Map();
function processAlive(pid, opts) {
  if (!/^\d+$/.test(String(pid))) return false;
  if (!(opts && opts.fresh)) {
    const hit = aliveCache.get(pid);
    if (hit && Date.now() - hit.at < 10_000) return hit.alive;
  }
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
    if (process.platform === 'win32') {

      try {
        const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8', timeout: 5000, windowsHide: true });
        alive = /^"?node\.exe"?/im.test(String(out).trim());
      } catch {  }
    }
  } catch (e) { alive = e.code === 'EPERM'; }
  aliveCache.set(pid, { alive, at: Date.now() });
  return alive;
}

function reapStaleMeta(rec, opts) {
  if (!rec || !rec.nativeRunId) return;

  if (!/^\d+$/.test(String(rec.pid))) return;
  const metaPath = path.join(RUNS_ROOT, rec.nativeRunId, 'meta.json');
  const meta = readJsonSafe(metaPath);
  if (!meta || (meta.phase !== 'running' && meta.phase !== 'planning')) return;
  if (meta.pid && rec.pid && meta.pid !== rec.pid) return;
  if (processAlive(rec.pid, opts)) return;

  try {
    const tmp = metaPath + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ ...meta, phase: 'interrupted', interruptedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, metaPath);
  } catch (e) {
    console.error('[brigade-mcp] 收尸标记写入失败(' + rec.nativeRunId + '): ' + (e && e.message));
  }
}

function lastSummaryForCwd(cwd, excludeMcpId) {
  try {
    const m = loadMcpRuns();
    const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
    const recs = Object.values(m)
      .filter((r) => r.cwd && norm(r.cwd) === norm(cwd) && r.mcpId !== excludeMcpId && r.nativeRunId)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    for (const rec of recs) {
      const sumPath = path.join(RUNS_ROOT, rec.nativeRunId, 'summary.md');
      if (!fs.existsSync(sumPath)) continue;
      const txt = fs.readFileSync(sumPath, 'utf8');

      const table = txt.match(/\| 任务 \|[\s\S]*?\n\n/);
      const tail = txt.slice(-1200);
      return `[上次战役 ${rec.nativeRunId} 的记录，供延续上下文，不要重复已完成的改动]\n` +
        (table ? table[0].trim() + '\n' : '') + tail.trim();
    }
  } catch {}
  return null;
}

function resolveNativeRunId(rec) {
  const t0 = Date.parse(rec.startedAt) - 60_000;
  let fallback = null;
  for (const id of listNativeRuns()) {
    const dirTime = Date.parse(id.replace(/T(\d{2})-(\d{2})-(\d{2})(?:-\d{1,3})?(?:-r\d+)?$/, 'T$1:$2:$3Z'));
    if (!isNaN(dirTime) && dirTime < t0) continue;
    const meta = runMeta(id);
    if (!meta || meta.goal !== rec.goal) continue;
    if (rec.pid && meta.pid && meta.pid === rec.pid) return id;
    if (!fallback && !(meta.pid && rec.pid && meta.pid !== rec.pid)) fallback = id;
  }
  return fallback;
}

function msOf(t) { return (t.outcome && t.outcome.ms) || (t.history && t.history.length && t.history[t.history.length - 1].ms) || t.ms || 0; }

function tailLog(file, maxLines = 12) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, TAIL_BYTES);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      return buf.toString('utf8').trim().split('\n').slice(-maxLines).join('\n');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

async function toolBrigadeRun(args) {
  const goal = String(args.goal || '').trim().slice(0, 4000);
  let cwd = String(args.cwd || '').trim();
  if (!goal) return { content: [{ type: 'text', text: '❌ 缺少 goal（要完成什么，一句话）' }] };

  const g = checkCwd(cwd);
  if (!g.ok) {
    return { content: [{ type: 'text', text: `cwd 不可用: ${cwd}（${g.reason}）。影子副本会全量物化该目录；请给出具体项目目录。` }] };
  }
  let st = null;
  try { st = fs.statSync(g.path); } catch {}
  if (!st || !st.isDirectory()) {
    return { content: [{ type: 'text', text: `cwd 不存在或不是目录: ${cwd}` }] };
  }
  cwd = g.path;

  const mcpId = 'mcp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  let hints = args.hints ? String(args.hints).slice(0, 8000) : '';
  if (!hints) {
    const prev = lastSummaryForCwd(cwd, mcpId);
    if (prev) hints = prev;
  }
  const argv = [RUN_ENTRY, '--goal', goal, '--cwd', cwd];
  if (args.maxParallel) argv.push('--max-parallel', String(Math.min(MAX_PARALLEL, Math.max(1, parseInt(args.maxParallel, 10) || 3))));
  if (args.timeoutSec) argv.push('--timeout', String(Math.min(7200, Math.max(60, parseInt(args.timeoutSec, 10) || 900))));
  if (hints) argv.push('--hints', hints);
  if (args.noReview) argv.push('--no-review');
  if (args.noTest) argv.push('--no-test');

  const childEnv = { ...process.env };

  if (args.model || process.env.LEGION_MODEL) childEnv.SUBAGENT_MODEL = String(args.model || process.env.LEGION_MODEL);
  childEnv.NO_PROXY = process.env.NO_PROXY || 'localhost,127.0.0.1';

  const outFile = path.join(MCP_STATE_DIR, mcpId + '.log');
  const out = fs.openSync(outFile, 'a');
  const child = spawn(process.execPath, argv, {
    cwd: TEAM,
    detached: true,
    stdio: ['ignore', out, out],
    env: childEnv,
  });
  child.on('error', (e) => {
    try {
      fs.appendFileSync(outFile, `[mcp] spawn 失败: ${e.message}\n`);
      const m2 = loadMcpRuns();
      if (m2[mcpId]) { m2[mcpId].spawnError = e.message; saveMcpRuns(m2); }
    } catch {}
  });
  child.unref();
  fs.closeSync(out);

  const m = loadMcpRuns();
  m[mcpId] = {
    mcpId, goal, cwd, engine: 'cp', pid: child.pid, startedAt: new Date().toISOString(),
    argv, log: outFile, nativeRunId: null,
  };
  saveMcpRuns(m);

  const via = childEnv.SUBAGENT_MODEL || 'opencode 当前默认模型';
  const effParallel = Math.min(MAX_PARALLEL, Math.max(1, parseInt(args.maxParallel, 10) || 3));
  let concurrencyNote = '';
  try {
    const [peers, total] = await Promise.all([liveRunsForCwd(cwd, null), inflightCount()]);
    if (total > 1) {
      concurrencyNote = `\n⚠ 当前共 ${total} 批军团在飞（本目录 ${peers.length + 1} 批）` +
        (peers.length ? `：${peers.map((p) => p.runId).join(', ')}` : '') +
        `\n  同目录并行是安全的（影子目录按 runId 隔离、发布带冲突检测），但会竞争模型额度与本机资源`;
    }
  } catch {}
  return {
    content: [{
      type: 'text',
      text: `✅ 军团已出动（mcpId: ${mcpId}）\n` +
        `目标: ${goal}\n工作目录: ${cwd}\n并发: ${effParallel}\n` +
        `子代理模型: ${via}\n` +
        `流程: 架构师拆 DAG → 影子目录隔离执行 → 产物+exec 机器验收 → 审查闸门（FAIL 自动重做一轮）→ summary.md\n` +
        `下一步: 用 brigade_status 轮询（建议每 30-60s 一次），传 run: "${mcpId}"` + concurrencyNote,
    }],
  };
}

function renderTasks(lines, snap) {
  const tasks = (snap && snap.tasks) || [];
  for (const t of tasks) {
    const note = t.outcome && t.outcome.note ? ' — ' + String(t.outcome.note).slice(0, 50)
      : (t.outcome && t.outcome.failureType ? ' — ' + t.outcome.failureType : '');
    lines.push(`  ${t.id} [${t.role || t.type || '-'}] ${t.state}${note} 尝试${t.attempts || 0} ${Math.round(msOf(t) / 1000)}s`);
  }
  const done = tasks.filter((t) => t.state === 'done').length;
  lines.push('');
  lines.push(`进度: ${done}/${tasks.length} 完成`);
  const sumPath = path.join(RUNS_ROOT, snap.__id, 'summary.md');
  if (fs.existsSync(sumPath)) lines.push(`报告: ${sumPath}`);
}

async function toolBrigadeStatus(args) {
  const run = String(args.run || '').trim();
  if (!run) return { content: [{ type: 'text', text: '❌ 缺少 run（brigade_run 返回的 mcpId，或原生 runId）' }] };
  pruneMcpRuns();
  const m = loadMcpRuns();
  const lines = [];
  let rec = m[run];
  let nativeId = null;
  if (rec) {
    nativeId = resolveNativeRunId(rec);
    if (nativeId && nativeId !== rec.nativeRunId) { rec.nativeRunId = nativeId; saveMcpRuns(m); }

    else if (!nativeId && rec.nativeRunId && Date.now() - Date.parse(rec.startedAt) > 120_000) {

      const boundMeta = runMeta(rec.nativeRunId);
      const dirGone = !fs.existsSync(path.join(RUNS_ROOT, String(rec.nativeRunId)));
      const dirty = dirGone
        || (boundMeta && boundMeta.goal !== undefined && boundMeta.goal !== rec.goal)
        || (boundMeta && boundMeta.pid && rec.pid && boundMeta.pid !== rec.pid);
      if (dirty) { rec.nativeRunId = null; saveMcpRuns(m); }
    }
  } else if (/^\d{4}-\d{2}-\d{2}T[A-Za-z0-9._-]*$/.test(run) && !run.includes('..')) {

    nativeId = run;
  } else {
    return { content: [{ type: 'text', text: `❌ 未知的 run: ${run}` }] };
  }

  if (rec) {
    const alive = processAlive(rec.pid);
    lines.push(`mcpId: ${run}  pid: ${rec.pid}(${alive ? '存活' : '已退出'})  启动: ${rec.startedAt}`);
    lines.push(`goal: ${rec.goal}`);
    if (nativeId) reapStaleMeta(rec);
  }

  if (nativeId) {
    const meta = runMeta(nativeId);
    const snap = runSnapshot(nativeId);
    if (meta) {
      lines.push(`runId: ${nativeId}  阶段: ${meta.phase || '?'}${meta.finishedAt ? '  完成: ' + meta.finishedAt : ''}${meta.retryOf ? '  (重做轮，源 ' + meta.retryOf + ')' : ''}`);
      if (meta.phase === 'interrupted') lines.push('⚠ 该运行被中断（进程被杀/崩溃）——下面的任务状态是中断前的快照，不是最终结果');
    } else if (rec) {
      lines.push(`runId: ${nativeId}（meta 还没写出来——架构师可能还在拆 DAG）`);
    }
    if (snap) {
      snap.__id = nativeId;
      lines.push('');
      renderTasks(lines, snap);
    } else if (meta && meta.phase !== 'planning') {
      lines.push('（快照还没写出来——架构师拆 DAG 中，通常 30-90s）');
    } else if (!meta) {
      const old = path.join(RUNS_ROOT, nativeId, 'summary.md');
      lines.push(fs.existsSync(old) ? `（旧链运行，无结构化状态；报告: ${old}）` : `（${nativeId} 无可读状态）`);
    }
  } else if (rec) {

    const aliveNow = processAlive(rec.pid);
    if (rec.spawnError) {
      lines.push(`❌ 启动失败（spawn 错误）: ${rec.spawnError}——不会自行恢复，请检查后重跑`);
    } else if (!aliveNow && Date.now() - Date.parse(rec.startedAt) > 120_000) {
      lines.push('❌ 进程已退出且未产出任何运行目录——启动即崩溃（多为环境/路径问题）。');
      lines.push('   输出尾部见下；建议原参数重跑一次，再失败请查看完整日志文件。');
    } else {
      lines.push('（原生 runId 还没解析到——架构师拆 DAG 中，通常 30-90s）');
    }
  }

  const logFile = rec ? rec.log : path.join(MCP_STATE_DIR, run + '.log');
  const tail = tailLog(logFile);
  if (tail) { lines.push(''); lines.push('--- 输出尾部 ---'); lines.push(tail); }

  try {
    const live = await listLiveRuns();
    if (live.length) {
      lines.push('');
      lines.push(`当前在飞军团（全部实例）: ${live.length} 批`);
      for (const l of live.slice(0, 8)) {
        lines.push(`  ${l.runId} [${l.phase || '?'}] ${String(l.goal || '').slice(0, 40)} @ ${l.cwd}`);
      }
    }
  } catch {}

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function toolBrigadeList() {
  const lines = ['军团历史运行（最新在前，最多 20 条）:'];
  const ids = listNativeRuns();
  if (!ids.length) lines.push('（空）');
  for (const id of ids.slice(0, 20)) {
    const meta = runMeta(id);
    if (meta) {
      const snap = runSnapshot(id);
      let counts = '（无快照）';
      if (snap) {
        const done = (snap.tasks || []).filter((t) => t.state === 'done').length;
        counts = `${done}/${(snap.tasks || []).length}`;
      }
      lines.push(`  ${id}  [${meta.phase || '?'}] ${counts}  ${String(meta.goal || '').slice(0, 60)}`);
    } else {
      lines.push(`  ${id}  (元信息不可读——可能是刚被中断的运行或旧链遗留，详情看该目录 meta.json)`);
    }
  }
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

async function toolBrigadeStop(args) {
  const run = String(args.run || '').trim();
  const m = loadMcpRuns();
  const rec = m[run];
  if (!rec || !rec.pid) return { content: [{ type: 'text', text: `❌ 找不到该运行的 pid: ${run}` }] };
  if (!/^\d+$/.test(String(rec.pid))) return { content: [{ type: 'text', text: `❌ 台账 pid 非法: ${rec.pid}` }] };

  if (!rec.nativeRunId) {
    for (let tryN = 0; tryN < 4 && !rec.nativeRunId; tryN++) {
      const nid = resolveNativeRunId(rec);
      if (nid) { rec.nativeRunId = nid; saveMcpRuns(m); break; }
      if (tryN < 3) await new Promise((r) => setTimeout(r, 400));
    }
  }
  if (!processAlive(rec.pid)) {
    reapStaleMeta(rec, { fresh: true });
    return { content: [{ type: 'text', text: `进程 ${rec.pid} 已退出，无需停止` }] };
  }
  try {
    if (process.platform === 'win32') execSync(`taskkill /PID ${rec.pid} /T /F`, { stdio: 'ignore', timeout: 15000 });
    else process.kill(rec.pid, 'SIGKILL');
  } catch {}

  await new Promise((r) => setTimeout(r, 300));
  const still = (() => { try { process.kill(rec.pid, 0); return true; } catch { return false; } })();

  reapStaleMeta(rec, { fresh: true });
  if (still) {
    return { content: [{ type: 'text', text: `⚠ 终止指令已发出但进程 ${rec.pid} 仍存活（可能权限不足或已换壳）——请人工确认。` }] };
  }
  return { content: [{ type: 'text', text: `已终止 ${run}（pid ${rec.pid} 及其子进程树）` }] };
}

function toolBrigadeTemplate() {
  return {
    content: [{
      type: 'text',
      text: [
        '# brigade 军团工作流使用说明',
        '',
        '多子代理软件工程管线：架构师把目标拆成 DAG 任务 → 每个写任务在目标目录的**影子副本**里由独立 opencode 子代理执行（读写隔离）→ 以**磁盘产物 + exec: 可执行命令**为证据机器验收（不是听模型自述）→ 审查闸门复核（FAIL 自动重做一轮）→ 汇总 summary.md。',
        '',
        '## brigade_run 参数',
        '- goal（必填）: 要完成什么，一句话。例 "给 utils.js 加 slugify 函数并补 jest 测试"',
        '- cwd（必填）: 工作目录的绝对路径，军团在该目录的影子副本里改动，完成后合并回该目录',
        '- maxParallel: 并发子代理数，默认 3，上限 8',
        '- timeoutSec: 单任务超时，默认 900',
        '- hints: 给架构师的补充约束（如 "不要动 package.json"）',
        '- noReview / noTest: 关闭审查 / 测试环节',
        '',
        '## 调用节奏',
        '1. brigade_run → 拿到 mcpId 立即返回',
        '2. 每 30-60s 调 brigade_status {run: mcpId} 轮询（含每任务状态/阶段/输出尾部；中断会显式标注）',
        '3. 结束后读 summary.md（status 输出里给路径）；失败可原参数重跑，战役链会自动带上上次记录',
        '4. 需要中止: brigade_stop {run: mcpId}',
        '',
        '## 适用判断',
        '适合: 多文件改动、实现+测试+审查要分工的中小型工程任务（5-30 分钟量级）。',
        '不适合: 单文件小改、只读问答——那种直接自己做更快。',
      ].join('\n'),
    }],
  };
}

const TOOLS = [
  {
    name: 'brigade_run',
    description: '出动多子代理军团执行一个软件工程任务（架构师拆解→影子目录隔离实现→产物+exec 机器验收→审查闸门→summary.md）。子代理通过本机 opencode CLI 运行，默认使用 opencode 当前配置的模型（可能产生费用）（可用 model 参数或 LEGION_MODEL 环境变量覆盖）。异步：立即返回 mcpId，用 brigade_status 轮询。',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '要完成的目标，一句话（必填）' },
        cwd: { type: 'string', description: '工作目录绝对路径，改动会合并回这里（必填）' },
        model: { type: 'string', description: '子代理使用的模型 id，格式 provider/model（如 opencode/beam-free，以你本机可用模型为准）；不填则用 opencode 当前默认模型或 LEGION_MODEL 环境变量。注意：默认模型可能是付费模型，会产生费用，请自行确认' },
        maxParallel: { type: 'number', description: '并发子代理数，默认 3，上限 8' },
        timeoutSec: { type: 'number', description: '单任务超时秒数，默认 900' },
        hints: { type: 'string', description: '给架构师的补充约束' },
        noReview: { type: 'boolean', description: '关闭审查环节' },
        noTest: { type: 'boolean', description: '关闭测试环节' },
      },
      required: ['goal', 'cwd'],
    },
  },
  {
    name: 'brigade_status',
    description: '查询军团运行状态：每任务状态/耗时/尝试次数、运行阶段（planning/running/done/failed/interrupted）、输出日志尾部、summary 路径。run 传 brigade_run 返回的 mcpId 或原生 runId。',
    inputSchema: { type: 'object', properties: { run: { type: 'string', description: 'mcpId 或原生 runId（必填）' } }, required: ['run'] },
  },
  {
    name: 'brigade_list',
    description: '列出军团历史运行（最新在前）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'brigade_stop',
    description: '终止一个正在运行的军团任务树。',
    inputSchema: { type: 'object', properties: { run: { type: 'string', description: 'brigade_run 返回的 mcpId（必填）' } }, required: ['run'] },
  },
  {
    name: 'brigade_template',
    description: '军团工作流的使用说明与参数模板（什么时候该用 / 怎么轮询）。',
    inputSchema: { type: 'object', properties: {} },
  },
];

const HANDLERS = {
  brigade_run: toolBrigadeRun,
  brigade_status: toolBrigadeStatus,
  brigade_list: toolBrigadeList,
  brigade_stop: toolBrigadeStop,
  brigade_template: toolBrigadeTemplate,
};

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

let inflightReqs = 0;
let stdinClosed = false;

const maybeExit = () => {
  if (!stdinClosed || inflightReqs !== 0) return;
  try { process.stdout.write('', () => process.exit(0)); } catch { process.exit(0); }

  setTimeout(() => process.exit(0), 5000).unref();
};
rl.on('close', () => { stdinClosed = true; maybeExit(); });

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
  const { id, method, params } = msg;
  if (typeof method !== 'undefined' && method !== null && typeof method !== 'string') return;
  if (method && method.startsWith('notifications/')) return;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'brigade-workflow', version: '1.1.0' },
      },
    });
    return;
  }
  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
  if (method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools: TOOLS } }); return; }
  if (method === 'tools/call') {
    const name = params && params.name;
    const handler = HANDLERS[name];
    if (!handler) { send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown tool: ' + name } }); return; }

    inflightReqs++;
    (async () => {
      try {
        const result = await handler((params && params.arguments) || {});
        send({ jsonrpc: '2.0', id, result });
      } catch (e) {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '❌ 工具执行异常: ' + e.message }], isError: true } });
      } finally {
        inflightReqs--;
        maybeExit();
      }
    })();
    return;
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown method: ' + method } });
});

pruneMcpRuns();
process.stderr.write('[brigade-mcp] ready on stdio (engine=cp)\n');
