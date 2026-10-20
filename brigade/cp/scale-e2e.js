'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Scheduler } = require('./scheduler');
const { Command, syncSquads, flattenSquads, makeWriteGate } = require('./hierarchy');
const { makePipeline } = require('./pipeline');

const { makeCodexExecutor } = require('./executor-codex');
const executor = makeCodexExecutor({});

const SQUADS = parseInt(process.argv[2] || '8', 10);
const PER_SQUAD = parseInt(process.argv[3] || '4', 10);
const OUT = path.join(os.tmpdir(), 'scale-e2e');
const WS = path.join(__dirname, '..', 'mcp', 'websearch.js');

const TOPICS = [
  'Redis 持久化 RDB vs AOF 的取舍',
  'PostgreSQL 索引类型 B-tree 与 GIN 的适用场景',
  'Node.js 流式响应的背压处理机制',
  'TCP 拥塞控制 Reno 与 CUBIC 的区别',
  '浏览器渲染流水线 合成层与重绘',
  'Docker 容器网络 bridge 与 host 模式',
  'Git rebase 与 merge 的历史差异',
  'Linux 内存回收 伙伴系统与页表',
  'HTTP/2 多路复用与队头阻塞',
  'Python GIL 与多进程并发的取舍',
  '消息队列 Kafka 分区与消费组',
  '微服务 熔断降级超时重试四件套',
  '数据库索引 最左前缀与范围查询',
  '前端虚拟滚动 长列表渲染优化',
  '缓存穿透击穿雪崩的应对',
  '编译器 SSA 优化 常见变换',
  'TLS 握手流程与证书链',
  '操作系统 文件锁与分布式锁',
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'README.txt'), '并发验证项目\n');

  const logFile = path.join(OUT, 'progress.jsonl');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const cmd = new Command({ writeSquadGate: 1, globalConcurrency: SQUADS * PER_SQUAD });
  const cards = [];
  for (let i = 0; i < SQUADS; i++) {
    cards.push({ id: 'S' + i, title: '调研小队' + i, goal: TOPICS.slice(i * PER_SQUAD, (i + 1) * PER_SQUAD).join(' / ') });
  }
  cmd.deploy('并发技术调研', cards, (card) =>
    card.goal.split(' / ').map((topic, k) => ({
      id: `${card.id}t${k}`, type: 'research', deps: [],
      budget: { timeoutSec: 600, stallSec: 240, maxAttempts: 1, backoffMs: 500 },
    }))
  );

  const worker = async ({ task, store, runId, signal, heartbeat }) => {
    const topic = task.input && task.input.topic;
    const id = task.id;

    const t = topic || '通用技术';
    const hb = setInterval(() => { try { heartbeat(); } catch {} }, 15000);
    try {
      const r = await executor({
        task: {
          title: t,
          input: { description:
            `调研主题：${t}\n` +
            `第一步：运行 node ${JSON.stringify(WS)} "${t}" 3 拿到搜索结果\n` +
            `第二步：把结果整理成 2-3 条要点，标注来源 URL。中文回答。` },
        },
        store, runId, signal,
      });
      return { ok: r.ok !== false && r.verdict !== 'fail', summary: (r.summary || r.text || '').slice(0, 200), artifacts: r.artifacts || [] };
    } catch (e) {
      return { ok: false, summary: '执行异常: ' + e.message, artifacts: [] };
    } finally {
      clearInterval(hb);
    }
  };

  const tasks = flattenSquads(cmd).map((t) => {
    const m = /^S(\d+)t(\d+)$/.exec(t.id);
    const topic = TOPICS[parseInt(m[1], 10) * PER_SQUAD + parseInt(m[2], 10)] || '';
    t.input = { ...(t.input || {}), topic };
    return t;
  });

  console.log(`=== 真实并发规模验证 ===`);
  console.log(`小队 ${SQUADS} × 每队 ${PER_SQUAD} = ${tasks.length} 个真实子智能体`);
  console.log(`项目: ${OUT}  |  进度: ${logFile}\n`);

  const pipeScale = makePipeline({
    base: OUT,

    runRoot: path.join(os.tmpdir(), 'scale-run-' + Date.now()),
    runId: 'scale', concurrency: SQUADS * PER_SQUAD,
    worker, onProgress: (ts) => syncSquads(cmd, ts), admission: makeWriteGate(cmd),
  });
  const s = pipeScale.scheduler;

  s.init('并发技术调研', tasks);

  const t0 = Date.now();

  const view = setInterval(() => {
    const inflight = s.all().filter((t) => t.state === 'running' || t.state === 'leased').length;
    const done = s.all().filter((t) => t.state === 'done').length;
    const degraded = s.all().filter((t) => ['failed', 'degraded', 'skipped'].includes(t.state)).length;
    console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] 在跑=${inflight} 完成=${done} 未成=${degraded} 闸门=${JSON.stringify(cmd.gateStatus())}`);
  }, 20000);

  const res = await s.run();
  clearInterval(view);
  const ms = Date.now() - t0;

  const arts = fs.existsSync(path.join(OUT, 'scale', 'artifacts'))
    ? fs.readdirSync(path.join(OUT, 'scale', 'artifacts')) : [];
  const bodies = arts.map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(OUT, 'scale', 'artifacts', f), 'utf8')); } catch { return null; }
  }).filter(Boolean);
  const withUrl = bodies.filter((b) => /https?:\/\//.test(String(b.body || ''))).length;

  console.log(`\n=== 结果（${Math.round(ms / 1000)}s）===`);
  console.log(`任务总数 ${res.tasks.length} | 完成 ${res.done} | 失败 ${res.failed} | 降级 ${res.degraded} | 跳过 ${res.skipped}`);
  console.log(`吞吐 ${(res.done / (ms / 1000)).toFixed(2)} 子智能体/秒 | 工件 ${arts.length} | 含来源 URL 的报告 ${withUrl}`);
  console.log(`指挥视图: ${JSON.stringify(cmd.status().squads.map((q) => q.id + ':' + q.status))}`);
  const report = { total: res.tasks.length, done: res.done, failed: res.failed, degraded: res.degraded, ms, artifacts: arts.length, withUrl };
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(report, null, 2));

  const okRate = res.done / res.tasks.length;
  console.log('\n' + (okRate >= 0.5 ? '并发规模验证通过 ✅' : '并发规模验证未达标 ❌'));
  process.exit(okRate >= 0.5 ? 0 : 1);
})();
