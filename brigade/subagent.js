'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function runSubagent(opts) {
  return runOpencodeSubagent(opts);
}

function findOpencodeBin() {
  if (process.env.OPENCODE_BIN && fs.existsSync(process.env.OPENCODE_BIN)) return process.env.OPENCODE_BIN;
  try {
    const p = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
    if (fs.existsSync(p)) return p;
  } catch {}
  return 'opencode';
}

function discoverMcpNames() {

  const names = new Set(['brigade', 'brigade-redis']);
  const main = (function () {
    for (const f of ['opencode.jsonc', 'opencode.json']) {
      try { return fs.readFileSync(path.join(os.homedir(), '.config', 'opencode', f), 'utf8'); } catch {}
    }
    return null;
  })();
  try {
    if (main === null) throw new Error('no main config');
    const json = JSON.parse(main.replace(/^\s*\/\/.*$/gm, ''));
    for (const k of Object.keys((json && json.mcp) || {})) names.add(k);
  } catch {  }
  return [...names];
}

function ensureWorkerProjectConfig(dir) {
  try {
    const pc = path.join(dir, '.opencode', 'opencode.json');
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(pc, 'utf8')); } catch {  }
    if (!cfg || typeof cfg !== 'object') cfg = {};
    cfg.mcp = cfg.mcp || {};
    for (const name of discoverMcpNames()) {
      cfg.mcp[name] = Object.assign({}, cfg.mcp[name], { enabled: false });
    }

    cfg.permission = process.env.LEGION_PERMISSION || 'allow';
    fs.mkdirSync(path.dirname(pc), { recursive: true });
    fs.writeFileSync(pc, JSON.stringify(cfg, null, 1) + '\n');
  } catch {  }
}

function killTree(child) {
  if (!child) return;
  try { child.kill(); } catch {}
  if (process.platform === 'win32' && child.pid) {
    try { const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); tk.on('error', () => {}); } catch {}
  }
}

function makeUnlinkLadder(unlinkSync, delays = [1000, 4000, 16000]) {
  return (p) => {
    const step = (i) => {
      if (i >= delays.length) return;
      setTimeout(() => { try { unlinkSync(p); } catch { step(i + 1); } }, delays[i]).unref();
    };
    try { unlinkSync(p); } catch { step(0); }
  };
}
const unlinkLadder = makeUnlinkLadder((p) => fs.unlinkSync(p));

function runOpencodeSubagent(opts) {
  const { task, cwd = process.cwd(), timeoutSec = 900, env = {}, signal, isShadow = true } = opts;
  const model = (env && env.SUBAGENT_MODEL) || process.env.SUBAGENT_MODEL || process.env.LEGION_MODEL || '';
  return new Promise((resolve) => {
    let settled = false, buf = '';
    const parts = new Map();
    let lastErr = null;
    const t0 = Date.now();

    const cleanup = { tf: null, tmp: null };
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onAbort) { try { signal.removeEventListener('abort', onAbort); } catch {} }

      if (cleanup.tf) unlinkLadder(cleanup.tf);
      if (cleanup.tmp) unlinkLadder(cleanup.tmp);
      resolve(r);
    };

    let child = null;
    const timer = setTimeout(() => {
      killTree(child);
      done({ ok: false, text: `任务超时（${timeoutSec}s，opencode 引擎）`, ms: timeoutSec * 1000, aborted: true });
    }, timeoutSec * 1000);

    let onAbort = null;
    if (signal) {
      onAbort = () => { killTree(child); done({ ok: false, text: '被调度器中止（超时或无心跳）', ms: Date.now() - t0, aborted: true }); };
      if (signal.aborted) {

        done({ ok: false, text: '被调度器中止（启动前）', ms: 0, aborted: true });
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    if (isShadow) ensureWorkerProjectConfig(cwd);

    const taskStr = String(task || '');
    let message = taskStr;

    if (taskStr.length > 12000) {
      const tfDir = isShadow ? path.join(cwd, '.brigade-tasks') : path.join(require('os').tmpdir(), 'brigade-tasks');
      const tf = path.join(tfDir, `task-${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 6)}.md`);
      try {
        fs.mkdirSync(tfDir, { recursive: true });

        const tfTmp = tf + '.tmp';

        cleanup.tmp = tfTmp;
        fs.writeFileSync(tfTmp, taskStr, 'utf8');
        fs.renameSync(tfTmp, tf);
        cleanup.tf = tf;
        cleanup.tmp = null;
        message = `你的完整任务写在 ${tf} 里：先用 read 工具读取该文件，然后严格按其中的要求执行。`;
      } catch {
        if (cleanup.tmp) { unlinkLadder(cleanup.tmp); cleanup.tmp = null; }
        message = taskStr;
      }
    }
    const argv = ['run', '--pure'];
    if (model) argv.push('-m', model);
    argv.push('--format', 'json', '--dir', cwd, message);
    child = spawn(findOpencodeBin(), argv, {
      env: {
        ...process.env,

        NO_PROXY: process.env.NO_PROXY || 'localhost,127.0.0.1',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line || line[0] !== '{') continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.type === 'text' && m.part && m.part.id != null && typeof m.part.text === 'string') {
          parts.set(m.part.id, m.part.text);
        } else if (m.type === 'error' || (m.level === 'error')) {
          lastErr = m.error || m.message || JSON.stringify(m).slice(0, 300);
        }
      }
    });
    let stderrTail = '';
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-800); });
    child.on('error', (e) => done({ ok: false, text: 'opencode 子进程启动失败: ' + e.message, ms: Date.now() - t0 }));
    child.on('exit', (code) => {
      if (settled) return;
      const texts = [...parts.values()].filter((t) => t && t.trim());
      const text = texts.join('\n\n');
      const ms = Date.now() - t0;
      if (lastErr && !text) return done({ ok: false, text: 'opencode 会话报错: ' + (typeof lastErr === 'string' ? lastErr : JSON.stringify(lastErr)), ms });
      if (!text) return done({ ok: false, text: `opencode run 无输出（code=${code}）${stderrTail ? ' | ' + stderrTail.slice(-300) : ''}`, ms });
      if (code !== 0 && code !== null) {

        return done({ ok: true, text: text + `\n[warn] opencode run 退出 code=${code}${stderrTail ? ' | ' + stderrTail.slice(-200) : ''}`, ms });
      }
      done({ ok: true, text, ms });
    });
  });
}

function resolveTurnOutcome(params, lastError, texts) {
  const turn = (params && params.turn) || {};
  const err = (turn.error && (turn.error.message || turn.error)) || lastError || null;
  if (turn.status && turn.status !== 'completed' && turn.status !== 'success') {
    return { ok: false, text: `子会话失败（status=${turn.status}）: ${err || '未给出原因'}` };
  }
  if (err) return { ok: false, text: '子会话报错: ' + err };
  if (!texts || !texts.length) {

    return { ok: false, text: '子会话正常结束但没有任何输出（疑似中断或工具全部失败）' };
  }

  return { ok: true, text: pickSubstantive(texts) };
}

const NARRATION_ONLY = /^(now|let me|i'?ll|let'?s|first|next|okay|ok|well|then|also|now,|let'?s see|looking at)\b[^\n]{0,80}$/i;
function looksSubstantive(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (t.length > 160) return true;
  if (t.indexOf('```') >= 0) return true;
  if (/[✅❌✓✗]/.test(t)) return true;
  if (/\d/.test(t)) return true;
  if (/[A-Za-z]:\\|\.(js|ts|json|md|txt|log)\b/.test(t)) return true;
  return !NARRATION_ONLY.test(t);
}
function pickSubstantive(texts) {
  const list = (texts || []).map((t) => String(t || '')).filter((t) => t.trim());
  if (!list.length) return '';
  for (let i = list.length - 1; i >= 0; i--) {
    if (looksSubstantive(list[i])) return list[i];
  }
  return list.join('\n\n---\n\n');
}

module.exports = { runSubagent, runOpencodeSubagent, findOpencodeBin, resolveTurnOutcome, pickSubstantive, looksSubstantive, makeUnlinkLadder };