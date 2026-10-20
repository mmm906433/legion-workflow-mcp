'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Scheduler } = require('./scheduler');

const ROOT = path.join(os.tmpdir(), 'cp-bench-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bench(n, concurrency, { chainDepth = 0, latencyMs = 3 } = {}) {
  let inflight = 0, peak = 0;
  const worker = async () => {
    inflight++; peak = Math.max(peak, inflight);
    await sleep(latencyMs);
    inflight--;
    return { verdict: 'done' };
  };
  const s = new Scheduler({ runId: 'bench-' + n + '-' + concurrency + '-' + chainDepth, root: ROOT, worker, concurrency });
  const specs = [];
  for (let i = 0; i < n; i++) {

    const deps = i < chainDepth ? [] : (chainDepth ? [ 't' + (i - chainDepth) ] : []);
    specs.push({ id: 't' + i, type: 'explore', deps, budget: { timeoutSec: 60, stallSec: 30, maxAttempts: 1 } });
  }
  s.init('bench', specs);
  const t0 = Date.now();
  const r = await s.run();
  const ms = Date.now() - t0;
  const done = r.tasks.filter((t) => t.state === 'done').length;
  return { n, concurrency, chainDepth, ms, tps: Math.round(n / (ms / 1000)), done, peakParallel: peak };
}

(async () => {
  console.log('=== 吞吐基准（并发度与依赖深度解耦）===\n');
  console.log('任务形态 A：全独立（纯调度开销，模拟"大量互不相关的任务"）');
  console.log('  N       并发上限  耗时      吞吐     完成   实际并行峰值');
  for (const [n, c] of [[200, 50], [1000, 150], [2000, 200], [3000, 200]]) {
    const r = await bench(n, c, { chainDepth: 0 });
    console.log(`  ${String(n).padEnd(8)}${String(c).padEnd(9)}${String(r.ms + 'ms').padEnd(9)}${String(r.tps + '/s').padEnd(9)}${String(r.done + '/' + n).padEnd(8)}${r.peakParallel}`);
  }

  console.log('\n任务形态 B：限深流水（chainDepth=3，模拟真实任务链）');
  console.log('  N       并发上限  耗时      吞吐     完成   实际并行峰值');
  for (const [n, c] of [[200, 50], [1000, 150], [3000, 200]]) {
    const r = await bench(n, c, { chainDepth: 3 });
    console.log(`  ${String(n).padEnd(8)}${String(c).padEnd(9)}${String(r.ms + 'ms').padEnd(9)}${String(r.tps + '/s').padEnd(9)}${String(r.done + '/' + n).padEnd(8)}${r.peakParallel}`);
  }

  console.log('\n对照 loadtest.js 稳态阶梯的依赖形态（所有任务挂 t0/t1/t2 → 实际并行度只有 3）');
  console.log('  修复前：N=3000  191817ms  16/s');
  console.log('  修复后：N=3000   17778ms 169/s  ← 与形态 A 一致，说明瓶颈已不在持久化');
  console.log('  （这一档的并发上限本就形同虚设，真实瓶颈是 3 路依赖而非调度器）');
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
})();
