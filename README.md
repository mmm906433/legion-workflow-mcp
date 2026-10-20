# Legion Workflow MCP

多子代理"军团"工作流服务器（MCP）。给 opencode 客户端提供一个 `brigade_run` 工具：把一个软件工程任务交给一队子代理并行完成——**架构师拆 DAG → 影子目录隔离实现 → 产物 + exec 机器验收 → 审查闸门 → summary.md 汇总**。适合大范围重构、批量修复、多方案对比这类单会话干不动、又不想手动开 N 个会话的活。

## ⚠️ 安全边界（先读这个）

- 危险命令过滤器**只作用于机器验收命令（accept 里的 `exec:` 条目）**：递归删除用户目录/盘根、格式化、注册表与卷影破坏等会被拦截并标记 BLOCKED。它**不覆盖**子代理会话内部自己执行的命令——子代理通过 `opencode run` 运行。注意：`accept` 里的 `exec:` 由系统以 shell 在任务工作目录执行（写任务在影子副本，只读任务在**真实项目目录**），过滤器只拦已知破坏模式，不是沙箱。
- **写任务默认全权限，不继承宿主审批**：实现/测试等写任务会在影子副本里写入 `.opencode/opencode.json`，把 `permission` 强制设为 `allow`，并禁用该副本里发现的 MCP 服务；该文件只存在于影子副本，不会回写你的项目。可用 `LEGION_PERMISSION` 覆盖（仅字符串，如 `ask`/`deny`；设为 `ask` 时无人值守运行可能因等待审批而超时）。只读任务（勘察/调研/设计/审查）不写该配置，沿用宿主 opencode 配置；"只读"是提示词约束而非沙箱，越界写入会被检测记录但不会被阻止。请像对待任何自主编码代理一样对待它：先备份，或在隔离/低权限环境中运行。
- **提示词注入面**：`brigade_run` 的 `goal` 与 `hints` 会原样拼进架构师提示词，架构师生成的任务描述又会拼进各 worker 提示词；仓库文件与联网搜索结果同样进入上下文。不要把不可信文本直接当作 `goal`，也不要在含不可信内容的仓库上无人值守运行——worker 在影子目录内是 `allow` 权限，可能执行其中的指令。
- 写任务的影子副本机制会把 `cwd` 指向的目录按排除规则复制到工作区（默认跳过 `node_modules`、`.git`、`build`、`dist`、`.opencode` 等，可用 `LEGION_EXCLUDE` 追加）；**`.env` 等未排除文件也会被复制**，落在 `BRIGADE_RUNS_ROOT/shadow` 下并默认保留约 3 天，请按敏感数据对待。请在**具体项目目录**上运行（盘根/用户主目录/系统目录/UNC 路径会被拒绝）。
- 协调层 Redis 只应使用专用本地实例：默认端口 6390，启动时先连 `127.0.0.1:6390`，连不上才尝试拉起 `redis-server`。`redis-server` 需在 PATH 中，或用 `BRIGADE_REDIS_BIN` 指定完整路径；未安装时约 3 秒后自动降级为单实例（功能可用，跨实例互斥与在飞统计失效；首次调用也可能因此多等约 3 秒），也可用 `BRIGADE_REDIS=0` 显式关闭。不要把 `BRIGADE_REDIS_PORT` 指向承载其他数据的实例。

## 环境要求

- **Windows**（进程树管理依赖 taskkill/tasklist；Linux/macOS 未适配）
- Node.js ≥ 18（确保 `node` 在 PATH 中；MCP 配置里用的是裸命令 `node`）
- 本机安装并登录 [opencode](https://opencode.ai) CLI

## 安装（opencode 客户端）

把整个 `LegionWorkflowMcp` 文件夹放到任意固定位置（**目录必须可写**：MCP 台账 `workflow-mcp/.mcp-runs`、运行产物与影子副本 `brigade/runs`、Redis 数据 `brigade/.redis` 默认都落在包内。只读位置请用 `BRIGADE_RUNS_ROOT` / `BRIGADE_MCP_STATE_DIR` 外移，并设 `BRIGADE_REDIS=0`；本包零依赖，无需 `npm install`），然后在全局配置 `~/.config/opencode/opencode.json`（或 `.jsonc`）里注册（把路径换成你的实际位置）：

```jsonc
{
  "mcp": {
    "brigade": {
      "type": "local",
      "command": ["node", "C:/your/path/LegionWorkflowMcp/workflow-mcp/server.js"],
      "enabled": true,
      "timeout": 120000
    }
  }
}
```

重启 opencode 客户端后即可看到工具。

## 工具

| 工具 | 说明 |
|---|---|
| `brigade_run` | 出动军团执行任务（异步：立即返回 mcpId）。参数：`goal`（任务描述）、`cwd`（工作目录）、`model`（可选，`provider/model`；不填跟随 opencode 当前默认模型，可能计费）、`maxParallel`、`timeoutSec`、`hints`（给架构师的额外提示）、`noReview`/`noTest`（跳过审查/测试闸门） |
| `brigade_status` | 按 mcpId 查询进度（每任务明细） |
| `brigade_list` | 列出历史运行 |
| `brigade_stop` | 按 mcpId 停止本机台账内的一次运行（停止其进程树；原生 runId 不支持，`brigade_status` 才支持原生 runId） |
| `brigade_template` | 使用说明与参数模板 |

## 配置（环境变量，全部可选）

| 变量 | 默认 | 说明 |
|---|---|---|
| `LEGION_MODEL` | （无） | 子代理默认模型 id，格式 `provider/model`（示例 `opencode/beam-free`，以你本机可用模型为准）。不设则跟随 opencode 当前默认模型——**可能是付费模型，会产生费用，请自行确认** |
| `LEGION_PROTECTED` | （无） | 额外保护目录（逗号/分号分隔，如 `vault,D:/data`）——验收命令里对这些目录（含任意深度子路径）的递归删除会被拦截。注意实现会丢掉盘符并按路径段匹配：`D:/data` 实际等价于保护任意盘根级 `data` 目录 |
| `LEGION_EXCLUDE` | （无） | 影子复制/发布时额外排除的目录名（逗号/分号分隔；默认已排除 `node_modules`、`.git`、`build`、`dist`、`.opencode` 等） |
| `LEGION_PERMISSION` | `allow` | 写任务影子目录里 worker 的 opencode `permission` 取值（仅字符串，如 `allow`/`ask`/`deny`）；不设即 `allow`，不继承宿主审批 |
| `OPENCODE_BIN` | 自动探测 | opencode 可执行文件完整路径（先探测 npm 全局安装，再回退 PATH 中的 `opencode`） |
| `WEBSEARCH_PROXY` | （直连） | 子代理抓页的 HTTP 代理 `host:port`；仅在直连失败后的回退抓取中使用，不代理搜索请求 |
| `BRIGADE_RUNS_ROOT` | 包内 `brigade/runs` | 原生运行台账/影子副本/报告根目录（server 与引擎两侧都读它；建议绝对路径） |
| `BRIGADE_MCP_STATE_DIR` | 包内 `workflow-mcp/.mcp-runs` | MCP 层 `runs.json` 台账与每次运行日志目录；只读安装必须外移 |
| `BRIGADE_REDIS_PORT` | `6390` | 协调层 Redis 专用端口（只连 `127.0.0.1`） |
| `BRIGADE_REDIS_BIN` | PATH 里的 `redis-server` | redis-server 可执行文件路径；未安装则约 3 秒后降级为单实例 |
| `BRIGADE_REDIS` | 未设置（启用） | 设为 `0` 关闭协调层，直接单实例运行 |

注册时在 mcp 条目加 `"environment": { ... }` 即可生效。

## 危险门说明

验收命令过滤器对**所有 `accept` 里的 `exec:` 条目**始终生效（不可配置关闭；不覆盖子代理内部命令，见上）：删除用户主目录/`C:\Users`（含通配符与前缀星形态）、任何盘符根、`vssadmin/wbadmin/bcdedit/reg` 破坏、`robocopy /MIR`、`cipher /w`、`diskpart`、`format`、`takeown/icacls`（命令位即拦）、管道投喂删除用户目录等（**272 例**矩阵回归锁定）。受保护目录（`LEGION_PROTECTED` 命中项、家目录变量形态、`C:\Users\<name>` 及其常见子目录）的递归删除会被拦截，不再有"深层子路径一律放行"的豁免；盘根单独拦截。注意字面 `C:\Users\<name>` 内置只覆盖到下一层（如 `Documents`），要覆盖整棵树请把该目录加入 `LEGION_PROTECTED`。保护树之外的普通产物目录（`build/`、`tmp/`、`node_modules/` 等）才会放行。改拦截规则请同步更新 `brigade/cp/danger-matrix-test.js` 并保持 `mismatches=0`。

## 自检

```bash
npm run test:danger   # 危险门 272 例回归：mismatches=0 退出 0；任何不匹配退出 1
node -e "const{spawn}=require('child_process');const c=spawn(process.execPath,['workflow-mcp/server.js'],{stdio:['pipe','pipe','pipe']});let seen=false,done=false;const fin=(code)=>{if(done)return;done=true;try{c.kill()}catch{};process.exit(code)};const check=()=>{if(seen)fin(0)};c.stdout.on('data',()=>check());c.stderr.on('data',d=>{if(String(d).includes('ready on stdio'))seen=true;check()});c.on('error',()=>fin(1));c.on('exit',()=>fin(seen?0:1));setTimeout(()=>fin(seen?0:1),5000)"   # 启动自检：看到 ready on stdio 退出 0；5 秒内没看到或异常退出则退出 1
```

## 目录结构

```
LegionWorkflowMcp/
├─ workflow-mcp/server.js   # MCP 服务器（stdio）
├─ brigade/
│  ├─ brigade.js            # 战役入口（server 派生的子进程）
│  ├─ planner.js / roles.js # DAG 拆解与角色提示词
│  ├─ subagent.js           # opencode CLI 子代理驱动
│  ├─ mcp/websearch.js      # 子代理联网搜索/抓页小工具（可用 WEBSEARCH_PROXY）
│  └─ cp/                   # 执行管线（调度/隔离/验收/危险门/协调…）
```

## 许可证

[MIT](./LICENSE) — 可自由使用、修改与再分发。
