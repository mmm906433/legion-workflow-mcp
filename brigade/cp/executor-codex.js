'use strict';

const path = require('path');
const { runSubagent } = require('../subagent');
const { buildTask } = require('../roles');
const { effectiveBudget } = require('./task');

const HEARTBEAT_MS = 15_000;

function makeCodexExecutor(opts = {}) {
  const cwd = opts.cwd || process.cwd();

  const ws = opts.workspace || null;
  const effortByType = opts.effortByType || {
    explore: 'high', research: 'high', implement: 'max', test: 'high', review: 'high', integrate: 'high',
  };
  return async function codexWorker({ task, attemptId, signal, heartbeat, store, runId, byId }) {

    let taskCwd = cwd;
    if (ws) {
      try { taskCwd = ws.cwdFor(task); }
      catch (e) {
        return { verdict: 'fail', failureType: 'workspace_unavailable',
          summary: '影子工作区不可用，拒绝在共享工作区执行写任务: ' + (e && e.message), artifacts: [] };
      }
    }

    const desc = (task.input && task.input.description) || '';
    if (!desc || String(desc).trim().length < 10 || desc === '{}') {
      return { verdict: 'fail', failureType: 'format_violation',
        summary: '任务缺少可执行描述（task.input.description / task.description 均为空），拒绝空跑',
        artifacts: [] };
    }

    const prompt = buildTask({
      role: task.role || mapRole(task.type),
      title: task.title,
      description: task.input && task.input.description ? task.input.description : JSON.stringify(task.input || {}),
      accept: task.accept,
      context: collectContext(store, runId, task, byId),
      extra: task.input && task.input.hints,
    });

    let promptFinal = prompt;
    if (ws && ws.isWriter(task)) {
      const baseAbs = String((ws && ws.base) || cwd);
      if (path.resolve(taskCwd) !== path.resolve(baseAbs)) {
        const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const baseVariants = [baseAbs, baseAbs.replace(/\\/g, '/')]
          .filter((v) => v && path.resolve(v) !== path.resolve(String(taskCwd || '')));
        for (const v of baseVariants) {
          promptFinal = promptFinal.replace(new RegExp(esc(v), 'gi'), taskCwd);
        }
      }
      promptFinal += `\n\n[工作区约束]\n你本次运行的工作目录是 ${taskCwd}（一个隔离的影子工作区副本）。\n` +
        `所有文件读写、命令执行都必须在该目录内进行，使用相对路径。\n` +
        `不要 cd 到其他目录、不要写入该目录之外的绝对路径；你的改动会在你完成后由系统合并回主工作区。\n`;
    }

    const stallMsCfg = effectiveBudget(task).stallSec * 1000;
    const hbMs = Math.max(1000, Math.min(HEARTBEAT_MS, Math.floor(stallMsCfg / 3)));
    const hb = setInterval(() => {
      try { heartbeat(); } catch {}
    }, hbMs);

    const execTimeoutSec = effectiveBudget(task).timeoutSec;
    let r;
    try {
      r = await runSubagent({
        task: promptFinal,
        cwd: taskCwd,
        isShadow: !ws || ws.isWriter(task),
        effort: (task.input && task.input.effort) || effortByType[task.type] || 'high',
        timeoutSec: execTimeoutSec,
        signal,
      });
    } catch (e) {
      r = { ok: false, text: '执行器异常: ' + (e && e.message), aborted: /abort/i.test(String((e && e.name) || '')), ms: 0 };
    } finally {
      clearInterval(hb);
    }
    if (!r || typeof r !== 'object') r = { ok: false, text: '', ms: 0 };

    const bad = classifyBadOutput(r.text);

    const acceptMet = checkAccept(task, r, taskCwd);

    const myAttemptId = (attemptId !== undefined && attemptId !== null) ? attemptId : task.attemptId;
    const art = store.saveArtifact(runId, {
      type: task.type,
      taskId: task.id,
      attemptId: myAttemptId,
      producer: task.role || task.type,
      summary: firstLine(r.text),
      body: r.text,
      ok: !!r.ok && !bad && acceptMet,
      ms: r.ms,
    });

    if (!r.ok) {
      return { verdict: 'fail', summary: String(r.text).slice(0, 300), failureType: r.aborted ? 'stalled' : 'unknown', artifacts: [art.id] };
    }
    if (bad) {

      return { verdict: 'fail', summary: bad.detail, failureType: bad.type, artifacts: [art.id] };
    }
    if (!acceptMet) {
      return { verdict: 'fail', summary: '未满足验收标准（accept 未被确认通过）', failureType: 'acceptance_failed', artifacts: [art.id] };
    }
    return { verdict: 'done', summary: firstLine(r.text), artifacts: [art.id] };
  };
}

function classifyBadOutput(text) {
  const t = String(text || '').trim();
  if (t.length < 30) return { type: 'format_violation', detail: '子智能体产出为空或过短（疑似中断）' };

  if (/unsupported call|no such tool|tool .* (not found|not available|is not)/i.test(t)) {
    return { type: 'tool_miss', detail: '子智能体调用了不存在的工具（确定性失败）' };
  }
  if (/^(我将|我先|让我|I'll |Let me)/.test(t) && t.length < 200) {
    return { type: 'stalled', detail: '子智能体只说了要做但没收尾（疑似空转）' };
  }
  return null;
}

function checkAccept(task, r, cwd) {
  if (!task.accept || !task.accept.length) return true;
  const t = String(r.text || '');

  const head = t.slice(0, 500);
  const writable0 = require('./task').typeMeta(task.type).writable;
  const claimsFailure = /(未完成|无法|失败|不能做到|not (able|done)|could not)/i;

  const sents = head.split(/[。；;\n]/).filter(Boolean);
  const hardFail = writable0 && sents.some((s) => claimsFailure.test(s)
    && /(任务|实现|功能|需求|验收|代码|没有|未能)/.test(s));
  if (hardFail) return false;

  const execItems = execAccepts(task.accept, cwd);

  const realExec = (execItems || []).filter((x) => x.code !== 'NOT_A_COMMAND');

  const writable = require('./task').typeMeta(task.type).writable;
  const fileItems = writable
    ? namedArtifacts(task.accept.filter((a) => !String(a).startsWith('exec:')), cwd)
    : null;
  const all = [...realExec, ...(fileItems || [])];
  if (all.length) {
    return all.every((f) => f.ok);
  }

  const zh = /[\u4e00-\u9fa5]/.test(t);
  return t.length >= (zh ? 30 : 60);
}

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const EXTRA_PROTECTED = String(process.env.LEGION_PROTECTED || '')
  .split(/[,;]/).map((t) => t.trim()).filter(Boolean);
const PROTECTED = [
  ...EXTRA_PROTECTED.flatMap((x) => {
    const name = x.replace(/^[a-zA-Z]:[\\\\/]+/, '').replace(/^[a-zA-Z]:/, '').replace(/[\\\\/]+$/, '');
    if (!name) return [];
    const parts = String(name).split(/[\\/]+/).filter(Boolean).map(escapeRe);
    if (!parts.length) return [];
    return [
      new RegExp('[a-z]:[\\\\/]+' + parts.join('[\\\\/]+') + '(?:[\\\\/][^\\s"\']*)?([\\\\/]?\\*(?:\\.\\*)?)?($|["\'\\s<>)])', 'i'),
      new RegExp('/[a-z]/' + parts.join('/') + '(?:/|\\*|["\'\\s<>)]|$)', 'i'),
    ];
  }),

  new RegExp('[a-z]:[\\\\/]?\\*?($|["\'\\s<>)])', 'i'),

  new RegExp('[a-z]:[\\\\/]users([\\\\/]?\\*)?($|["\'\\s<>)])', 'i'),
  new RegExp('[a-z]:[\\\\/]users[\\\\/][^\\\\/"\'\\s<>]+([\\\\/][^\\\\/"\'\\s<>]+)?([\\\\/]?\\*)?($|["\'\\s<>)])', 'i'),

  new RegExp('/c/users(?:/[^\\s"\']+)?($|["\'\\s<>)])', 'i'),

  new RegExp('[a-z]:[\\\\/]user[^\\\\/"\'\\s<>]*\\*', 'i'),
  new RegExp(String.raw`\\[^\s"']+\\[a-z]\$\\users`, 'i'),
  new RegExp(String.raw`\\[^\s"']+\\[a-z]\$($|[\s"'<>)]|\\)`, 'i'),
];

function segmentIsDangerousExec(seg) {

  if (/(^|[:\\/ "'])\.\.?([/\\ "'<>]|\d+[<>]|$)|(?:[:\\/])[^\\/ "'<>]*\.+([/\\ "'<>]|\d+[<>]|$)/.test(seg)) {
    const collapseDots = (t) => {
      let uni = t.replace(/\\/g, '/');
      uni = uni.replace(/^([a-z]:)(?=\.)/i, '$1/');
      const abs = uni.startsWith('/');
      const st = [];
      for (const tok of uni.split('/')) {
        if (tok === '') continue;
    if (tok === '.') { if (!st.length && !abs) st.push('.'); continue; }
        if (tok === '..') {
          if (st.length && !/^[a-z]:$/i.test(st[st.length - 1]) && st[st.length - 1] !== '..') st.pop();
          else if (!abs && !st.length) st.push('..');
        } else {

          const t2 = tok.replace(/\.+$/, '');
          if (t2 === '' || t2 === '.') continue;
          st.push(t2);
        }
      }
      let out = st.join('/');
      if (abs) out = '/' + out;
      return out === '' ? '.' : out;
    };
    for (let guard = 0; guard < 8; guard++) {
      const folded = seg.split(/(\s+)/).map((w) => {

        if (/[<>]/.test(w)) w = w.replace(/\d*([<>])/g, ' ' + '$1 ');
        const tq = w.match(/"$/);
        const w2 = tq && (seg.split('"').length - 1) % 2 === 1 ? w.slice(0, -1) : w;
        if (w2 === '..' || w2 === '.') return w2;
        if (!/[/\\:]/.test(w2) || !/\./.test(w2)) return w;
        return (w2[0] === '"' || w2[0] === '\'') && w2[w2.length - 1] === w2[0] && w2.length > 1
          ? w2[0] + collapseDots(w2.slice(1, -1)) + w2[0] : collapseDots(w2);
      }).join('');
      if (folded === seg) break;
      seg = folded;
    }
  }

  seg = String(seg).replace(/\^/g, '');
  const bare = seg.replace(/"[^"]*"|'[^']*'/g, ' QARG ');

  if (/\b(powershell|pwsh)\b/i.test(bare)) {
    const encToks = bare.match(/-e[a-z-]*/gi) || [];
    if (encToks.some((t) => 'encodedcommand'.startsWith(t.slice(1).toLowerCase()))) return true;
  }

  let head = bare.replace(/^\s*cmd(?:\.exe)?\s+\/[ck]\s+/i, '').replace(/^\s*(?:powershell|pwsh)(?:\.exe)?\s+(?:-[a-z-]+\s+)*-command\s+/i, '');
  if (/^\s*(?:vssadmin)\s+[^\n]*\bdelete\b/i.test(head)) return true;
  if (/^\s*(?:wbadmin)\s+[^\n]*\b(?:delete|start)\b/i.test(head)) return true;
  if (/^\s*(?:bcdedit)\s+[^\n]*\b(?:delete|set)\b/i.test(head)) return true;
  if (/^\s*reg\s+delete\b/i.test(head)) return true;
  if (/\brobocopy\b[^\n]*\/(?:mir|purge)\b/i.test(head)) return true;
  if (/\bcipher\b[^\n]*\/w\b/i.test(head)) return true;
  if (/^\s*(?:diskpart|takeown|icacls)\b/i.test(head)) return true;
  if (/\bfind\b[^|;&\n]*\s-delete\b/i.test(bare)) {
    const fm = seg.match(/\bfind\b([^|;&\n]*)/i);
    const preDelete = (fm ? fm[1] : '').split(/\s-delete\b/i)[0];
    const toks = preDelete.trim().split(/\s+/).filter(Boolean).filter((t) => !/^-[A-Za-z]/.test(t));
    const target = (toks[0] || '').replace(/^["']|["']$/g, '');
    const FIND_HOME_VAR = /%USERPROFILE%|%HOMEDRIVE%|%HOMEPATH%|%SystemDrive%|%SystemRoot%|%HOME%|%[A-Za-z_]+:~|\$env:(?:USERPROFILE|HOME|HOMEDRIVE|HOMEPATH|SystemDrive)\b|\$\{env:(?:USERPROFILE|HOME|HOMEDRIVE|HOMEPATH|SystemDrive)\}|\$(?:USERPROFILE|HOME|HOMEDRIVE|HOMEPATH|SystemDrive)\b|\$\{(?:USERPROFILE|HOME|HOMEDRIVE|HOMEPATH|SystemDrive)\}/i;
    if (!target
      || /^(?:~|\/|\.{1,2})$/i.test(target)
      || /^[a-z]:[\\/]?$/i.test(target)
      || /^\/[a-z]\/?$/i.test(target)
      || /^[a-z]:[\\/]users(?:[\\/]|$)/i.test(target)
      || /^\/c\/users(?:\/|$)/i.test(target)
      || /^~[\\/]/.test(target)
      || FIND_HOME_VAR.test(target)
      || PROTECTED.some((re) => re.test(target))) return true;
  }

  if (/(?<![\w.-])format(?:\.(?:exe|com))?\b(?=\s+[a-z]{0,2}:|\s+\/[a-z])/i.test(bare)) return true;

  const wrapPair =
    /\b(?:bash|zsh|dash|ksh|sh)(?:\.exe)?(?:\s+(?:-\S+|\d*[<>]&?\S*))*\s+-[a-z]*c\b/i.test(bare) ||
    /\b(?:powershell|pwsh)(?:\.exe)?(?:\s+(?:-\S+|\d*[<>]&?\S*))*\s+-command\b/i.test(bare) ||
    /\bcmd(?:\.exe)?\s[^\n]*?\/[ck]\b/i.test(bare);

  if (wrapPair || /\b-command\b/.test(bare) || /\$\(/.test(seg) || /[<>]\(/.test(bare)) {
    const payloads = [];
    const q = seg.match(/["']([^"']{4,})["']/); if (q) payloads.push(q[1]);
    for (const m of seg.matchAll(/(?:\$\(|<\(|>\()([^)]+)\)/g)) payloads.push(m[1]);
    for (const pl of payloads) { if (segmentIsDangerousExec(pl)) return true; }
  }

  const RM_VERB = /\b(rm|rmdir|del|erase|ri|rd|remove-item)\b/i;
  if (!RM_VERB.test(bare)) return false;
  if (/\bno-preserve-root\b/i.test(bare)) return true;
  const RECUR = /\/s|\/q|--recursive|-Recurse|-[a-z]*[rf][a-z]*/i;

  const GNU_RM = /\b(?:rm|rmdir)\b/i.test(bare) && !/\b(?:del|erase|ri|rd|rmdir|cmd)\b/i.test(bare);
  if (GNU_RM && /(?:^|[\s"'])\/[a-z]\/?\*?(?:\.\*)?(?:$|["'\s<>])/.test(seg)) return true;
  if ((GNU_RM || RECUR.test(bare)) && /(?:^|[\s"'])\/(?:["'\s]|$)/.test(seg)) return true;

  if (/(?:^|\s)\.(?:\/\*?)?(?:\s|$)/.test(bare)) return true;
  if (/(?:^|\s)\.\.(?:\/\*?)?(?:\s|$)/.test(bare)) return true;
  if (/(?:^|\s)~(?:\s|$|[<>])/.test(bare)) return true;
  if (/(?:^|\s)~[/\\](?:\*?)?(?:\s|$|[<>])/.test(bare)) return true;
  if (/(?:^|\s)~[/\\](?:documents|desktop|downloads)(?:[/\\]|\s|$)/i.test(bare)) return true;

  if (/["']\.(?:\/\*?)?["']/.test(seg) || /["']\.\.(?:\/\*?)?["']/.test(seg) || /["']~(?:[/\\]?\*?)?["']/.test(seg)) return true;

  const VAR = String.raw`%USERPROFILE%|%HOMEDRIVE%|%HOMEPATH%|%SystemDrive%|%SystemRoot%|%windir%|%APPDATA%|%LOCALAPPDATA%|%ProgramData%|%ProgramFiles\(x86\)%|%ProgramFiles%|%HOME%|%[A-Za-z_]+:~|\$env:USERPROFILE|\$\{env:USERPROFILE\}|\$env:HOME|\$\{env:HOME\}|\$env:HOMEDRIVE|\$\{env:HOMEDRIVE\}|\$env:HOMEPATH|\$\{env:HOMEPATH\}|\$env:SystemDrive|\$\{env:SystemDrive\}|\$USERPROFILE\b|\$\{USERPROFILE\}|\$HOME\b|\$\{HOME\}|\$HOMEDRIVE\b|\$\{HOMEDRIVE\}|\$HOMEPATH\b|\$\{HOMEPATH\}|\$SystemDrive\b|\$\{SystemDrive\}`;
  const VAR_BARE = new RegExp('(?:^|\\s)["\']?(?:' + VAR + ')["\']?(?:\\s|$)', 'i');
  const VAR_RE = new RegExp(VAR, 'i');
  if (VAR_BARE.test(bare) || VAR_BARE.test(seg)) return true;
  if ((VAR_RE.test(bare) || VAR_RE.test(seg)) && (RECUR.test(bare) || RECUR.test(seg))) return true;

  if (!RECUR.test(bare)) return false;

  return PROTECTED.some((re) => re.test(bare.replace(/\.\//g, '')) || re.test(seg.replace(/\.\//g, '')));
}

function isDangerousExec(cmd) {

  let c = String(cmd || '').replace(/([\\/])[\\/]+/g, '$1').replace(/([a-z]:[\\/][^\s"']*)[\\/]+(\s|["']|$)/gi, '$1$2');

  c = c.replace(/\d*[<>]&\d+/g, ' -RD ').replace(/&>/g, ' -RD ').replace(/([<>])&/g, '$1 ');
  const segs = c.split(/&&|\|\||&|\||;|\r?\n/);
  if (segs.some(segmentIsDangerousExec)) return true;

  const pairAt = (s) => {
    const bare = s.replace(/"[^"]*"|'[^']*'/g, ' QARG ');
    return /\b(?:bash|zsh|dash|ksh|sh)(?:\.exe)?(?:\s+(?:-\S+|\d*[<>]&?\S*))*\s+-[a-z]*c\b/i.test(bare)
      || /\b(?:powershell|pwsh)(?:\.exe)?(?:\s+(?:-\S+|\d*[<>]&?\S*))*\s+-command\b/i.test(bare)
      || /\bcmd(?:\.exe)?\s[^\n]*?\/[ck]\b/i.test(bare)
      || /[<>]\(/.test(bare);
  };
  const wrapperAtCmdPos = segs.some(pairAt);

  if (wrapperAtCmdPos || /\b-command\b|\$\(/.test(c)) {
    for (const m of c.matchAll(/"([^"]{3,})"|'([^']{3,})'/g)) {
      const inner = (m[1] || m[2] || '').replace(/["']/g, '');
      if (inner.length >= 3 && segmentIsDangerousExec(inner)) return true;
    }
    for (const m of c.matchAll(/(?:\$\(|<\(|>\()([^)]+)\)/g)) {
      const inner = m[1].replace(/["']/g, '');
      if (inner.length >= 3 && segmentIsDangerousExec(inner)) return true;
    }
  }

  const VARX = /%USERPROFILE%|%HOMEDRIVE%|%HOMEPATH%|%SystemDrive%|%HOME%|\$env:USERPROFILE|\$[{]env:USERPROFILE[}]|\$env:HOME|\$[{]env:HOME[}]|\$env:HOMEDRIVE|\$[{]env:HOMEDRIVE[}]|\$env:HOMEPATH|\$[{]env:HOMEPATH[}]|\$env:SystemDrive|\$[{]env:SystemDrive[}]|\$USERPROFILE\b|\$[{]USERPROFILE[}]|\$HOME\b|\$[{]HOME[}]|\$HOMEDRIVE\b|\$[{]HOMEDRIVE[}]|\$HOMEPATH\b|\$[{]HOMEPATH[}]|\$SystemDrive\b|\$[{]SystemDrive[}]/i;
  const RMX = /\b(rm|rmdir|del|erase|ri|rd|remove-item)\b/i;
  const RECX = /\/s|\/q|--recursive|-Recurse|-[a-z]*[rf][a-z]*/i;
  const TILDEX = /(?:^|\s)~(?:\s|$|[/\\])/;
  const VAR_FEEDS = segs.some((s) => {
    const bare = s.replace(/"[^"]*"|'[^']*'/g, ' QARG ');
    if (!(VARX.test(s) || TILDEX.test(bare))) return false;
    return !/^\s*(cd|pushd|popd|dirs|echo|pwd|export|printenv)\b/i.test(bare);
  });
  if (VAR_FEEDS && segs.some((s) => RMX.test(s) && RECX.test(s))) return true;

  const LIT_USERS = /[a-z]:[\\/]users(?:[\\/][^\s"']+)?($|[\s<>|)]|\|$)|\/c\/users(?:\/[^\s"']+)?($|[\s<>|)]|\|$)/i;
  const LIT_CHAINS = c.split(/&&|\|\||;|\r?\n/);
  if (LIT_CHAINS.some((chain) => {
    const parts = chain.split('|');
    const mention = parts.some((s) => !/^\s*git\s+(commit|log|push)/i.test(s) && LIT_USERS.test(s.replace(/["']/g, ' ')));
    return mention && parts.some((s) => RMX.test(s) && RECX.test(s));
  })) return true;
  return false;
}

function execAccepts(acceptList, cwd) {
  if (!cwd) return null;
  const { spawnSync } = require('child_process');
  const found = [];
  for (const raw of acceptList) {
    const s = String(raw);
    if (!s.startsWith('exec:')) continue;
    const cmd = s.slice(5).trim();
    if (!cmd) continue;

    if (/[\u4e00-\u9fff]/.test(cmd)) {
      found.push({ cmd: cmd.slice(0, 120), ok: true, code: 'NOT_A_COMMAND',
        tail: 'exec: 条目含中文（疑似自然语言描述而非命令），已忽略——请勿把验收描述写进 exec:' });
      continue;
    }
    if (isDangerousExec(cmd)) {
      found.push({ cmd: cmd.slice(0, 120), ok: false, code: 'BLOCKED',
        tail: '验收命令被安全拦截（递归删除受保护目录/整树删除/格式化）。请改用安全的验证命令。' });
      continue;
    }
    const res = spawnSync(cmd, { cwd, shell: true, timeout: 30_000, encoding: 'utf8', windowsHide: true });
    found.push({
      cmd: cmd.slice(0, 120),
      ok: res.status === 0,
      code: res.status,
      tail: (String(res.stdout || '') + String(res.stderr || '')).trim().slice(-200),
    });
  }
  return found.length ? found : null;
}

function namedArtifacts(acceptList, cwd) {
  if (!cwd) return null;
  const fsx = require('fs');
  const pth = require('path');
  const found = [];

  const FILE_RE = /([\w.\\/-]+[\\/][\w.\\/-]*\.[A-Za-z][A-Za-z0-9]{0,7}|[\w.\\/-]+\.(?:js|ts|jsx|tsx|mjs|cjs|c|cc|cpp|cxx|h|hpp|hh|py|pyw|json|md|txt|csv|xml|yml|yaml|ini|cfg|conf|cs|go|rs|java|sql|sh|bat|ps1|cmd|exe|dll|lib|bin|obj|so|dylib|cmake|proto|lua|sln|vcxproj|filters|props|rc|def|asm|wasm|tar|gz|zip|7z|log|css|scss|html|htm|php|rb|pl|mm|glsl|vert|frag|geom|tproj|ini|bmp|png|jpg|jpeg|gif|ico|wav|mp3|mp4|pdf|docx|xlsx))\b/;
  for (const item of acceptList) {

    const m = String(item).match(FILE_RE);
    if (!m) continue;

    let name = m[1];

    if (/^[a-z]:[\\/]|^[\\/]/i.test(name)) name = pth.basename(name);
    let ok = false, size = 0;
    try {
      const p = pth.join(cwd, name);
      const st = fsx.statSync(p);

      ok = st.isFile() && st.size > 0;
      size = st.size;
    } catch {

      ok = findNested(pth, cwd, name, 0);
      if (ok) {
        try { size = fsx.statSync(pth.join(cwd, ok.rel)).size; } catch { size = 0; }
      }
    }
    found.push({ name, ok: !!ok, size });
  }
  return found.length ? found : null;
}

const ACCEPT_SKIP = new Set(['node_modules', '.git', '.svn', 'runs', 'shadow']);
function findNested(pth, rootDir, name, depth, budgetObj) {
  if (depth > 3) return null;
  let entries;
  try { entries = require('fs').readdirSync(rootDir, { withFileTypes: true }); } catch { return null; }
  const budgetObj2 = budgetObj || { left: 2000 };
  for (const e of entries) {
    if (--budgetObj2.left <= 0) return null;
    if (e.name.startsWith('.') || ACCEPT_SKIP.has(e.name)) continue;
    const full = pth.join(rootDir, e.name);
    if (e.isDirectory()) {
      const hit = findNested(pth, full, name, depth + 1, budgetObj2);
      if (hit) return { rel: hit.rel };
    } else if (e.name === name) {
      try {
        const st = require('fs').statSync(full);
        if (st.isFile() && st.size > 0) return { rel: pth.relative(rootDir, full) };
      } catch {  }
    }
  }
  return null;
}

function mapRole(type) {
  return { explore: 'explorer', research: 'researcher', implement: 'worker', test: 'tester', review: 'reviewer', integrate: 'worker' }[type] || 'worker';
}

function firstLine(s) {
  return String(s || '').trim().split('\n')[0].slice(0, 160);
}

function looksUnfinished(text) {
  const t = String(text || '').trim();
  if (t.length < 30) return true;
  if (/^(我将|我先|让我|I'll |Let me)/.test(t) && t.length < 200) return true;
  if (/unsupported call|no such tool|tool .* not (found|available)/i.test(t)) return true;
  return false;
}

function collectContext(store, runId, task, byId) {
  if (!task.deps || !task.deps.length) return '';
  const parts = [];
  for (const d of task.deps) {
    const dep = byId ? byId.get(d) : null;
    const currentAttempt = dep ? dep.attemptId : null;
    const all = store.listArtifacts(runId, { taskId: d, okOnly: true });

    const okArts = currentAttempt != null ? all.filter((a) => a.attemptId === currentAttempt) : [];
    if (!okArts.length) {
      parts.push(`### 上游 ${d} 无当前 attempt 的有效产出（失败/坏输出/已过期，勿据此臆测）`);
      continue;
    }

    const a = okArts.reduce((best, x) => {
      if (!best) return x;
      return (Date.parse(x.ts) || 0) >= (Date.parse(best.ts) || 0) ? x : best;
    }, null);
    parts.push(`### 上游 ${d} 的产出（${a.type}，${a.producer}，attempt ${a.attemptId}）\n${String(a.body || '').slice(0, 2500)}`);
  }
  return parts.join('\n\n').slice(0, 6000);
}

module.exports = { makeCodexExecutor, classifyBadOutput, checkAccept, namedArtifacts, execAccepts };
