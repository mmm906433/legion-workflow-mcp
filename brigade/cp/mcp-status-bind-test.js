'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', '..', 'workflow-mcp', 'server.js');
const NATIVE = '2026-01-01T00-00-00-000';

let fail = 0;
const check = (n, c, x = '') => { console.log(`${c ? '  ✓' : '  ✗'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scenario(label, setupMeta, expectKept) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpbind-'));
  const stateDir = path.join(tmp, 'state');
  const runsRoot = path.join(tmp, 'runs');
  fs.mkdirSync(stateDir, { recursive: true });
  setupMeta(path.join(runsRoot, NATIVE));
  const rec = {
    runId: 'mcp-bind1', goal: '隔离测试目标', cwd: tmp, pid: 4242,
    startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    nativeRunId: NATIVE,
  };
  fs.writeFileSync(path.join(stateDir, 'runs.json'), JSON.stringify({ 'mcp-bind1': rec }));

  const child = spawn(process.execPath, [SERVER], {

    env: { ...process.env, BRIGADE_MCP_STATE_DIR: stateDir, BRIGADE_RUNS_ROOT: runsRoot, BRIGADE_REDIS: '0' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let buf = ''; const waiters = new Map(); let seq = 0;
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } } catch {}
    }
  });
  const call = (name, args) => new Promise((res) => {
    const id = ++seq; waiters.set(id, res);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
  await sleep(900);
  const r = await call('brigade_status', { run: 'mcp-bind1' });
  child.kill();
  const after = JSON.parse(fs.readFileSync(path.join(stateDir, 'runs.json'), 'utf8'))['mcp-bind1'] || {};
  const kept = after.nativeRunId === NATIVE;
  check(label, expectKept ? kept : !kept,
    `nativeRunId=${String(after.nativeRunId)} / status=${String(r.result && r.result.content && r.result.content[0].text).slice(0, 40).replace(/\n/g, ' ')}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

(async () => {
  console.log('=== ：nativeRunId 瞬态误清 ===');
  await scenario('① meta 瞬态损坏（目录在）→ 绑定保留', (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), '{ this is not valid json !!');
  }, true);
  await scenario('② meta.pid ≠ 台账 pid → 绑定清除', (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ goal: '隔离测试目标', pid: 9999 }));
  }, false);

  await scenario('④ meta.goal ≠ 台账 goal（pid 缺失、目录在）→ 绑定清除', (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ goal: '别的窗口的同文案运行' }));
  }, false);
  await scenario('③ bound 目录被删 → 绑定清除', () => {  }, false);
  console.log(fail ? ('\n' + fail + ' 项失败 ❌') : '\nnativeRunId 绑定守护通过 ✅');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('异常:', e && e.stack); process.exit(2); });
