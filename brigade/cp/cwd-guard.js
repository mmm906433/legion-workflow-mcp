'use strict';
// brigade/cp/cwd-guard.js — 两入口共享的 cwd 形状守卫（不做存在性检查）
const fs = require('fs');
const os = require('os');
const path = require('path');

const SYSTEM_DIRS = ['/users', '/windows', '/program files', '/program files (x86)', '/programdata'];
const SHORT83 = /[~][1-9]/;

function canon(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function unsafeReason(resolved) {
  const low = canon(resolved);
  if (/^[a-z]:$/.test(low)) return '驱动器根';
  const drive = low.slice(0, 2);
  if (!/^[a-z]:$/.test(drive)) return null;
  const home = canon(path.resolve(os.homedir()));
  if (low === home) return '用户主目录';
  if (low === home + '/documents') return '主目录 Documents';
  for (const s of SYSTEM_DIRS) {
    if (low === drive + s || low.startsWith(drive + s + '/')) return '系统/用户目录树 ' + drive + s;
  }
  return null;
}

function checkCwd(cwd) {
  const raw = String(cwd == null ? '' : cwd).trim();
  if (!raw) return { ok: false, reason: 'cwd 为空' };
  if (/^[\\/]{2}/.test(raw)) return { ok: false, reason: 'UNC/扩展长度路径不允许' };
  if (/^[A-Za-z]:$/.test(raw)) return { ok: false, reason: '驱动器相对路径不允许' };
  if (SHORT83.test(raw)) return { ok: false, reason: '8.3 短名路径不允许' };
  const resolved = path.resolve(raw);
  if (SHORT83.test(resolved)) return { ok: false, reason: '8.3 短名路径不允许' };
  const why = unsafeReason(resolved);
  if (why) return { ok: false, reason: why };
  try {
    const real = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
    const whyReal = unsafeReason(real);
    if (whyReal) return { ok: false, reason: '解析后' + whyReal };
  } catch {}
  return { ok: true, path: resolved };
}

module.exports = { checkCwd };
