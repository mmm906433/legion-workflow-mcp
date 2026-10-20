'use strict';

const path = require('path');
const WS = path.join(__dirname, 'mcp', 'websearch.js').replace(/\\/g, '/');

const ROLES = {
  architect: {
    label: '架构师',
    effort: 'high',
    sandbox: 'read-only',
    brief: '你负责把目标拆成可执行的工程任务 DAG，识别依赖和风险。不写代码。',
    output: '一个 JSON 任务列表（含 id/依赖/角色/验收标准）+ 风险清单',
  },
  explorer: {
    label: '勘察员',
    effort: 'high',
    sandbox: 'read-only',
    brief:
      '你负责只读勘察：定位相关文件/符号、摸清现有模式与约束、找出实现切入点。不修改任何文件。',
    output: '一份带文件路径和符号名的勘察报告，写入 state/findings.md 之外的回复正文即可',
  },
  worker: {
    label: '实现工程师',
    effort: 'max',
    sandbox: 'workspace-write',
    brief:
      '你负责实现分配给你的那一个任务。严格按验收标准做，改动最小化，遵循现有代码风格。完成后必须自己跑一次相关测试/检查并贴出真实输出。',
    output: '改动的文件清单 + 验证命令的真实输出 + 遗留风险',
  },
  tester: {
    label: '测试工程师',
    effort: 'high',
    sandbox: 'workspace-write',
    brief:
      '你负责验证：运行项目真实的测试/lint/build 命令，报告真实 exit code 和输出；必要时补写针对性测试。绝不放水、绝不谎报通过。',
    output: '命令 + 真实结果 + 通过/不通过结论',
  },
  reviewer: {
    label: '代码审查员',
    effort: 'high',
    sandbox: 'read-only',
    brief:
      '你负责独立审查：看真实 diff，指出阻断性问题（正确性/边界/错误处理/安全）和非阻断建议。给出 PASS 或 FAIL 结论。',
    output: 'PASS/FAIL + 分级问题清单（带文件/行）',
  },
  researcher: {
    label: '调研员',
    effort: 'high',
    sandbox: 'read-only',
    web: true,
    brief:
      '你负责联网调研。必须先运行 node "' + WS + '" "<关键词>" 5 搜索，再对关键 URL 运行 node "' + WS + '" fetch "<URL>" 4000 读正文。只写查到的事实，附来源 URL，不确定就标注。',
    output: '要点 + 来源 URL',
  },
};

function buildTask({ role, title, description, accept, context, artifacts, extra }) {
  const r = ROLES[role] || ROLES.worker;
  const lines = [];
  lines.push(`# 你是团队中的「${r.label}」`);
  lines.push('');
  lines.push(r.brief);
  lines.push('');
  lines.push(`## 本次任务：${title}`);
  lines.push('');
  lines.push('```');
  lines.push(description);
  lines.push('```');
  if (accept && accept.length) {
    lines.push('');
    lines.push('## 验收标准（全部满足才算完成）');
    accept.forEach((a, i) => lines.push(`${i + 1}. ${a}`));
  }
  if (context) {
    lines.push('');
    lines.push('## 团队上下文（来自已完成的任务，请据此工作）');
    lines.push('```');
    lines.push(context);
    lines.push('```');
  }
  if (artifacts && artifacts.length) {
    lines.push('');
    lines.push('## 相关工件（已落盘，可直接读取）');
    artifacts.forEach((a) => lines.push('- ' + a));
  }
  if (extra) {
    lines.push('');
    lines.push('## 补充要求');
    lines.push(extra);
  }
  lines.push('');
  lines.push('## 汇报格式（你的最终回复就按这个结构，最后一段不要寒暄）');
  lines.push('### 做了什么');
  lines.push('- （按要点列，引用具体文件路径）');
  lines.push('### 验证');
  lines.push('- （跑了什么命令，真实输出摘要）');
  lines.push('### 风险 / 遗留');
  lines.push('- （没有就写"无"）');
  if (r.web) {
    lines.push('### 来源');
    lines.push('- （URL 列表）');
  }
  if (role === 'reviewer') {
    lines.push('### 结论');
    lines.push('- PASS 或 FAIL（FAIL 必须列出阻断项）');
  }
  return lines.join('\n');
}

module.exports = { ROLES, buildTask };
