'use strict';

const fs = require('fs');
const path = require('path');
const { typeMeta } = require('./task');

const DEFAULT_EXCLUDE = new Set([
  'node_modules', '.git', '.hg', '.svn', '.cache', '__pycache__', '.venv', 'dist', 'build',
  '.brigade-tasks',
  '.opencode',
  ...String(process.env.LEGION_EXCLUDE || '').split(/[,;]/).map((t) => t.trim()).filter(Boolean),
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

const BIG_FILE = 8 * 1024 * 1024;

const SAMPLE_BYTES = 64 * 1024;

const RO_BASELINE_BUDGET_MS = 8000;
const RO_BASELINE_MAX_FILES = 30000;

function fingerprintBig(p, size) {
  const crypto = require('crypto');
  const h = crypto.createHash('sha1');
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(SAMPLE_BYTES);
    let off = 0, n;
    while ((n = fs.readSync(fd, buf, 0, SAMPLE_BYTES, off)) > 0) { h.update(buf.subarray(0, n)); off += n; }
    return size + ':full:' + h.digest('hex');
  } finally { fs.closeSync(fd); }
}
function fingerprint(p) {
  let st;
  try { st = fs.statSync(p); } catch { return null; }
  if (!st.isFile()) return null;

  if (FP_INDEX) {
    const hit = FP_INDEX.get(p);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.fp;
  }
  let fp;
  if (st.size > BIG_FILE) {
    try { fp = fingerprintBig(p, st.size); } catch { fp = 'size:' + st.size; }
  } else {
    try {
      const b = fs.readFileSync(p);
      fp = st.size + ':' + require('crypto').createHash('sha1').update(b).digest('hex');
    } catch { return null; }
  }
  if (FP_INDEX) { FP_INDEX.set(p, { size: st.size, mtimeMs: st.mtimeMs, fp }); FP_DIRTY = true; }
  return fp;
}

const SAME_UNKNOWN = null;

let FP_INDEX = null;
let FP_DIRTY = false;
let FP_FILE = null;
let FP_BASE = null;

function fpLoad(runRoot, base) {
  try {
    const crypto = require('crypto');
    const h = crypto.createHash('sha1').update(base.replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 12);
    FP_FILE = path.join(runRoot, `fp-index-${h}.json`);
    FP_BASE = base;
    const raw = JSON.parse(fs.readFileSync(FP_FILE, 'utf8'));

    FP_INDEX = new Map(Object.entries(raw).filter(([k]) => k.startsWith(base + path.sep) || k.startsWith(base + '/')));
  } catch { FP_INDEX = FP_INDEX || new Map(); }
  FP_DIRTY = false;
}
function fpSave() {
  if (!FP_FILE || !FP_DIRTY || !FP_INDEX || !FP_BASE) return;
  try {
    const tmp = FP_FILE + '.tmp-' + process.pid;
    const obj = {};
    for (const [k, v] of FP_INDEX) {
      if (k.startsWith(FP_BASE + path.sep) || k.startsWith(FP_BASE + '/')) obj[k] = v;
    }
    fs.mkdirSync(path.dirname(FP_FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, FP_FILE);
    FP_DIRTY = false;
  } catch {  }
}

function fpInvalidate(p) {
  if (FP_INDEX && p) { FP_INDEX.delete(p); }
}

function sameFile(a, b) {
  let sa, sb;
  try { sa = fs.statSync(a); sb = fs.statSync(b); }
  catch { return SAME_UNKNOWN; }
  if (sa.size !== sb.size) return false;
  if (sa.size === 0) return true;
  if (sa.size > BIG_FILE) {
    try { return fingerprintBig(a, sa.size) === fingerprintBig(b, sb.size); }
    catch { return SAME_UNKNOWN; }
  }
  try {
    const ba = fs.readFileSync(a), bb = fs.readFileSync(b);
    return ba.length === bb.length && ba.equals(bb);
  } catch { return SAME_UNKNOWN; }
}

function rmrfExtras(dir, keepRel, exclude, keepDirs) {
  const files = [];
  const walk = (d, rel) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory() && exclude.has(e.name)) continue;
      const r = rel ? rel + path.sep + e.name : e.name;
      const full = path.join(d, e.name);
      let lst = e;
      try { lst = fs.lstatSync(full); } catch { continue; }
      if (lst.isSymbolicLink()) continue;
      if (lst.isDirectory()) { walk(full, r); continue; }
      if (lst.isFile()) files.push({ full, r });
    }
  };
  walk(dir, '');
  for (const f of files) {
    if (keepRel.has(f.r)) continue;
    try { fs.unlinkSync(f.full); fpInvalidate(f.full); } catch {}
  }

  const keepDirSet = keepDirs || new Set();
  const prune = (d, rel) => {
    let entries;
    try { entries = fs.readdirSync(d); } catch { return false; }
    let empty = true;
    for (const e of entries) {
      if (exclude.has(e)) { empty = false; continue; }
      const full = path.join(d, e);
      const r = rel ? rel + path.sep + e : e;
      let st; try { st = fs.lstatSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (keepDirSet.has(r)) { empty = false; continue; }
        if (prune(full, r)) { try { fs.rmdirSync(full); } catch {} } else empty = false;
      } else empty = false;
    }
    return empty;
  };
  prune(dir, '');
}

function copyDir(src, dst, exclude, baseRel = '') {
  fs.mkdirSync(dst, { recursive: true });
  let entries;
  try { entries = fs.readdirSync(src, { withFileTypes: true }); }
  catch (e) { throw new Error(`复制目录失败 ${src}: ${e.message}`); }
  for (const ent of entries) {

    if (ent.isDirectory() && exclude.has(ent.name)) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    const rel = baseRel ? baseRel + '/' + ent.name : ent.name;
    let st;
    try { st = fs.lstatSync(s); } catch { continue; }
    if (st.isSymbolicLink()) {

      try {
        const target = fs.readlinkSync(s);
        if (fs.existsSync(d)) fs.unlinkSync(d);
        fs.symlinkSync(target, d);
      } catch {  }
      continue;
    }
    if (st.isDirectory()) { copyDir(s, d, exclude, rel); continue; }
    if (st.isFile()) {

      const tmp = d + '.shadowtmp-' + process.pid;
      fs.copyFileSync(s, tmp);
      fs.renameSync(tmp, d);
    }
  }
}

async function copyDirAsync(src, dst, exclude, baseRel = '', yc = null) {
  fs.mkdirSync(dst, { recursive: true });
  let entries;
  try { entries = fs.readdirSync(src, { withFileTypes: true }); }
  catch (e) { throw new Error(`复制目录失败 ${src}: ${e.message}`); }
  for (const ent of entries) {
    if (ent.isDirectory() && exclude.has(ent.name)) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    const rel = baseRel ? baseRel + '/' + ent.name : ent.name;
    let st;
    try { st = fs.lstatSync(s); } catch { continue; }
    if (st.isSymbolicLink()) {
      try {
        const target = fs.readlinkSync(s);
        if (fs.existsSync(d)) fs.unlinkSync(d);
        fs.symlinkSync(target, d);
      } catch {  }
    } else if (st.isDirectory()) {
      await copyDirAsync(s, d, exclude, rel, yc);
    } else if (st.isFile()) {
      const tmp = d + '.shadowtmp-' + process.pid;
      fs.copyFileSync(s, tmp);
      fs.renameSync(tmp, d);
    }

    if (yc && yc.onYield && (++yc.n % 64 === 0 || Date.now() - yc.lastYield >= 100)) {
      await new Promise((r) => setImmediate(r));
      yc.lastYield = Date.now();
      yc.onYield();
    }
  }
}

async function withBeat(fn, beat, ms = 100) {
  if (!beat) return fn();
  const iv = setInterval(() => { try { beat(); } catch {} }, ms);
  try { return await fn(); } finally { clearInterval(iv); }
}

async function collectFilesAsync(dir, exclude, out, yc = null, baseRel = '') {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (ent.isDirectory() && exclude.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isDirectory()) await collectFilesAsync(p, exclude, out, yc, baseRel);
    else if (st.isFile()) out.push(p);
    if (yc && yc.onYield && (++yc.n % 64 === 0 || Date.now() - yc.lastYield >= 100)) {
      await new Promise((r) => setImmediate(r));
      yc.lastYield = Date.now();
      yc.onYield();
    }
  }
}

async function rmrfExtrasAsync(dir, keepRel, exclude, keepDirs, yc = null) {
  const files = [];
  const walk = async (d, rel) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory() && exclude.has(e.name)) continue;
      const r = rel ? rel + path.sep + e.name : e.name;
      const full = path.join(d, e.name);
      let lst = e;
      try { lst = fs.lstatSync(full); } catch { continue; }
      if (lst.isSymbolicLink()) {

      } else if (lst.isDirectory()) {
        await walk(full, r);
      } else if (lst.isFile()) {
        files.push({ full, r });
      }
      if (yc && yc.onYield && (++yc.n % 64 === 0 || Date.now() - yc.lastYield >= 100)) {
        await new Promise((res) => setImmediate(res));
        yc.lastYield = Date.now();
        yc.onYield();
      }
    }
  };
  await walk(dir, '');
  for (const f of files) {
    if (keepRel.has(f.r)) continue;
    try { fs.unlinkSync(f.full); fpInvalidate(f.full); } catch {}
    if (yc && yc.onYield && (++yc.n % 64 === 0 || Date.now() - yc.lastYield >= 100)) {
      await new Promise((res) => setImmediate(res));
      yc.lastYield = Date.now();
      yc.onYield();
    }
  }
  const keepDirSet = keepDirs || new Set();
  const prune = async (d, rel) => {
    let entries;
    try { entries = fs.readdirSync(d); } catch { return false; }
    let empty = true;
    for (const e of entries) {
      if (yc && yc.onYield && (++yc.n % 64 === 0 || Date.now() - yc.lastYield >= 100)) {
        await new Promise((res) => setImmediate(res));
        yc.lastYield = Date.now();
        yc.onYield();
      }
      if (exclude.has(e)) { empty = false; continue; }
      const full = path.join(d, e);
      const r = rel ? rel + path.sep + e : e;
      let st; try { st = fs.lstatSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (keepDirSet.has(r)) { empty = false; continue; }
        if (await prune(full, r)) { try { fs.rmdirSync(full); } catch {} } else empty = false;
      } else empty = false;
      if (yc && yc.onYield && (++yc.n % 64 === 0 || Date.now() - yc.lastYield >= 100)) {
        await new Promise((res) => setImmediate(res));
        yc.lastYield = Date.now();
        yc.onYield();
      }
    }
    return empty;
  };
  await prune(dir, '');
}

class Workspace {

  constructor(o = {}) {
    if (!o.base) throw new Error('Workspace 缺 base');
    this.base = path.resolve(o.base);
    this.runId = String(o.runId || '').replace(/[^A-Za-z0-9._-]/g, '') || null;
    this.runRoot = path.resolve(
      o.runRoot || path.join(path.dirname(this.base), `.cp-shadow-${path.basename(this.base)}`)
    );

    const baseL = this.base.toLowerCase();
    const rootL = this.runRoot.toLowerCase();
    if (rootL === baseL || rootL.startsWith(baseL + path.sep) || rootL.startsWith(baseL + '/')) {
      throw new Error(
        `Workspace runRoot 不得位于 base 内部（会导致影子目录被反复复制、无界递归挂死）：` +
        `base=${this.base} runRoot=${this.runRoot}。请把 runRoot 指到 base 之外的目录。`
      );
    }

    if (baseL === rootL || baseL.startsWith(rootL + path.sep) || baseL.startsWith(rootL + '/')) {
      throw new Error(
        `Workspace base 不得位于 runRoot 内部（对账/拷贝会自嵌套无限加深）：` +
        `base=${this.base} runRoot=${this.runRoot}。--cwd 不能是军团状态目录或其祖先。`
      );
    }
    this.exclusiveReads = !!o.exclusiveReads;

    this.strictIsolation = !!o.strictIsolation;
    this.onEscape = o.onEscape || null;
    this.escapeLog = [];
    this.exclude = new Set([...DEFAULT_EXCLUDE, ...(o.exclude || [])]);
    this.generation = o.generation ?? 1;
    this._shadows = new Map();
    this._publishing = false;

    this._roStart = new Map();
    this._publishedFiles = new Set();
    this.stats = { allocated: 0, published: 0, copyMs: 0, publishMs: 0, filesWritten: 0, filesDeleted: 0, escapes: 0, conflicts: 0, publishFailures: 0, stranded: 0, generationAtRead: new Map() };
    this.lastPublishFailure = null;
    fpLoad(this.runRoot, this.base);
  }

  readGeneration(task) {
    if (!typeMeta(task.type).writable) {
      this.stats.generationAtRead.set(task.id, this.generation);

      this._markReadOnlyStart(task);
    }
    return this.generation;
  }

  _markReadOnlyStart(task) {
    if (this._roStart.has(task.id)) return;

    const snap = new Map();
    const t0 = Date.now();
    let n = 0, capped = false;
    for (const f of this._tracked()) {
      const fp = fingerprint(f);
      if (fp) snap.set(f, fp);
      if (++n % 512 === 0 && (n >= RO_BASELINE_MAX_FILES || Date.now() - t0 >= RO_BASELINE_BUDGET_MS)) { capped = true; break; }
    }
    this._roStart.set(task.id, { at: Date.now(), generation: this.generation, snap, capped, covered: snap.size });

    try { fpSave(); } catch {}
  }

  detectReadOnlyPollution(task) {
    const s = this._roStart.get(task.id);
    if (!s) return [];
    const known = this._publishedFiles || new Set();
    const dirty = [];

    dirty.partial = !!s.capped;
    const t0 = Date.now();
    let n = 0;
    for (const f of this._tracked()) {
      if (known.has(f)) continue;
      const was = s.snap.get(f);
      if (was === undefined) {

        let isFile = false;
        try { isFile = fs.statSync(f).isFile(); } catch { isFile = false; }
        if (!isFile) continue;
        if (s.capped) continue;
        dirty.push(path.relative(this.base, f));
        continue;
      }
      if (Date.now() - t0 >= RO_BASELINE_BUDGET_MS || n >= RO_BASELINE_MAX_FILES) { dirty.partial = true; break; }
      n++;
      const now = fingerprint(f);
      if (now === null) continue;
      if (now !== was) dirty.push(path.relative(this.base, f));
    }
    return dirty;
  }

  _tracked() {
    const out = [];
    try { collectFiles(this.base, this.exclude, out); } catch {}
    return out;
  }

  isWriter(task) {
    const meta = typeMeta(task.type);
    return !!(meta && meta.writable);
  }

  cwdFor(task) {
    if (!this.isWriter(task)) { this.readGeneration(task); return this.base; }
    const { key, dir, cached } = this._shadowPathFor(task);
    if (cached) return dir;
    const t0 = Date.now();
    try {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      this._materializeShadow(dir);
    } catch (e) {
      rmrf(dir);
      throw new Error(`影子工作区创建失败（fail-closed，不回落共享区）: ${e.message}`);
    }
    this.stats.allocated++;
    this.stats.copyMs += Date.now() - t0;
    fpSave();

    const copied = [];
    collectFiles(dir, this.exclude, copied);
    const manifest = new Map();
    for (const f of copied) {
      const rel = path.relative(dir, f);
      manifest.set(rel, fingerprint(f));
    }
    this._shadows.set(key, { dir, generation: this.generation, manifest });
    return dir;
  }

  _shadowPathFor(task) {
    const attempt = task.attemptId ?? 0;
    const key = `${task.id}#${attempt}`;
    const hit = this._shadows.get(key);
    if (hit) return { key, dir: hit.dir, cached: true };
    const runTag = (this.runId || ('p' + Date.now().toString(36))) + '-p' + process.pid;
    const dir = path.join(this.runRoot, 'shadow', runTag, `${task.id}`);
    if (this.runRoot === this.base || this.runRoot.startsWith(this.base + path.sep)) {
      this.exclude.add(path.basename(this.runRoot));
    }
    return { key, dir, cached: false };
  }

  async allocate(task, opts = {}) {
    if (!this.isWriter(task)) { this.readGeneration(task); return this.base; }
    const onTick = opts.onTick || null;
    const beat = () => { if (onTick) { try { onTick(); } catch {} } };
    const { key, dir, cached } = this._shadowPathFor(task);
    if (cached) return dir;
    const t0 = Date.now();
    try {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      await this._materializeShadowAsync(dir, beat);
    } catch (e) {
      rmrf(dir);
      throw new Error(`影子工作区创建失败（fail-closed，不回落共享区）: ${e.message}`);
    }
    this.stats.allocated++;
    this.stats.copyMs += Date.now() - t0;
    fpSave();
    const copied = [];
    await collectFilesAsync(dir, this.exclude, copied, { n: 0, lastYield: Date.now(), onYield: beat });
    const manifest = new Map();
    let lastFpYield = Date.now();
    for (let i = 0; i < copied.length; i++) {
      const rel = path.relative(dir, copied[i]);
      manifest.set(rel, fingerprint(copied[i]));

      if (i % 256 === 255 || Date.now() - lastFpYield >= 100) {
        await new Promise((r) => setImmediate(r));
        lastFpYield = Date.now();
        beat();
      }
    }
    this._shadows.set(key, { dir, generation: this.generation, manifest });
    return dir;
  }

  _materializeShadow(dir) {
    const mfile = dir + '.manifest.json';
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(mfile, 'utf8')); } catch {}
    if (!prev || !fs.existsSync(dir)) {
      rmrf(dir);
      copyDir(this.base, dir, this.exclude);
      this._linkHeavyDirs(dir);
      this._writeShadowManifest(mfile, dir);
      return;
    }

    const baseFiles = [];
    collectFiles(this.base, this.exclude, baseFiles);
    const keep = new Set();
    const keepDirs = new Set();
    for (const bf of baseFiles) {
      const rel = path.relative(this.base, bf);
      keep.add(rel);
      for (let dd = path.dirname(rel); dd && dd !== '.'; dd = path.dirname(dd)) keepDirs.add(dd);
      const dst = path.join(dir, rel);
      const baseFp = fingerprint(bf);
      if (prev[rel] === baseFp) {

        if (fingerprint(dst) === baseFp) continue;
      }

      try {
        const st = fs.lstatSync(dst);
        if (!st.isFile() || st.isSymbolicLink()) rmrf(dst);
      } catch {}
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
      } catch {

        let blocker = path.dirname(dst);
        try { if (fs.lstatSync(blocker).isFile()) { rmrf(blocker); fs.mkdirSync(blocker, { recursive: true }); } } catch {}
      }
      const tmp = dst + '.shadowtmp-' + process.pid;
      fs.copyFileSync(bf, tmp);
      fs.renameSync(tmp, dst);
      fpInvalidate(dst);
    }

    {

      const walkDirs = (d, rel) => {
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (this.exclude.has(e.name)) continue;
          const full = path.join(d, e.name);
          const r = rel ? rel + path.sep + e.name : e.name;
          let st; try { st = fs.lstatSync(full); } catch { continue; }
          if (st.isDirectory() && !st.isSymbolicLink()) { keepDirs.add(r); walkDirs(full, r); }
        }
      };
      walkDirs(this.base, '');
    }
    rmrfExtras(dir, keep, this.exclude, keepDirs);
    this._linkHeavyDirs(dir);
    this._writeShadowManifest(mfile, dir);
  }

  async _materializeShadowAsync(dir, onYield) {
    const mfile = dir + '.manifest.json';
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(mfile, 'utf8')); } catch {}
    const yc = { n: 0, lastYield: Date.now(), onYield };
    if (!prev || !fs.existsSync(dir)) {

      await withBeat(() => fs.promises.rm(dir, { recursive: true, force: true }), onYield);
      const ycFull = yc;
      await copyDirAsync(this.base, dir, this.exclude, '', ycFull);
      this._linkHeavyDirs(dir);
      await this._writeShadowManifestAsync(mfile, dir, ycFull);
      return;
    }

    const baseFiles = [];
    await collectFilesAsync(this.base, this.exclude, baseFiles, yc);
    const keep = new Set();
    const keepDirs = new Set();
    for (const bf of baseFiles) {
      if (yc.onYield && (++yc.n % 64 === 0 || Date.now() - yc.lastYield >= 100)) {
        await new Promise((r) => setImmediate(r));
        yc.lastYield = Date.now();
        yc.onYield();
      }
      const rel = path.relative(this.base, bf);
      keep.add(rel);
      for (let dd = path.dirname(rel); dd && dd !== '.'; dd = path.dirname(dd)) keepDirs.add(dd);
      const dst = path.join(dir, rel);
      const baseFp = fingerprint(bf);
      if (prev[rel] === baseFp) {
        if (fingerprint(dst) === baseFp) continue;
      }
      try {
        const st = fs.lstatSync(dst);
        if (!st.isFile() || st.isSymbolicLink()) rmrf(dst);
      } catch {}
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
      } catch {
        let blocker = path.dirname(dst);
        try { if (fs.lstatSync(blocker).isFile()) { rmrf(blocker); fs.mkdirSync(blocker, { recursive: true }); } } catch {}
      }
      const tmp = dst + '.shadowtmp-' + process.pid;
      fs.copyFileSync(bf, tmp);
      fs.renameSync(tmp, dst);
      fpInvalidate(dst);
    }
    {
      const walkDirs = async (d, rel) => {
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (this.exclude.has(e.name)) continue;
          const full = path.join(d, e.name);
          const r = rel ? rel + path.sep + e.name : e.name;
          let st; try { st = fs.lstatSync(full); } catch { continue; }
          if (st.isDirectory() && !st.isSymbolicLink()) { keepDirs.add(r); await walkDirs(full, r); }
          if (yc.onYield && (++yc.n % 64 === 0 || Date.now() - yc.lastYield >= 100)) {
            await new Promise((res) => setImmediate(res));
            yc.lastYield = Date.now();
            yc.onYield();
          }
        }
      };
      await walkDirs(this.base, '');
    }
    await rmrfExtrasAsync(dir, keep, this.exclude, keepDirs, yc);
    this._linkHeavyDirs(dir);
    await this._writeShadowManifestAsync(mfile, dir, yc);
  }

  async _writeShadowManifestAsync(mfile, dir, yc) {
    try {
      const next = {};
      const files = [];
      await collectFilesAsync(dir, this.exclude, files, yc);
      for (let i = 0; i < files.length; i++) {
        next[path.relative(dir, files[i])] = fingerprint(files[i]);
        if (yc && yc.onYield && (i % 256 === 0 || Date.now() - yc.lastYield >= 100)) {
          await new Promise((r) => setImmediate(r));
          yc.lastYield = Date.now();
          yc.onYield();
        }
      }
      const tmp = mfile + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(next));
      fs.renameSync(tmp, mfile);
    } catch {  }
  }

  _writeShadowManifest(mfile, dir) {
    try {
      const next = {};
      const files = [];
      collectFiles(dir, this.exclude, files);
      for (const f of files) {
        next[path.relative(dir, f)] = fingerprint(f);
      }
      const tmp = mfile + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(next));
      fs.renameSync(tmp, mfile);
    } catch {  }
  }

  _linkHeavyDirs(dir) {
    if (process.platform !== 'win32') return;
    for (const name of ['node_modules', 'build', '.venv', '3rdparty']) {
      const src = path.join(this.base, name);
      const dst = path.join(dir, name);
      let st;
      try { st = fs.statSync(src); } catch { continue; }
      if (!st.isDirectory()) continue;
      try {

        if (fs.existsSync(dst)) {
          let ok = false;
          try { ok = fs.lstatSync(dst).isSymbolicLink() && path.resolve(fs.readlinkSync(dst)) === path.resolve(src); } catch {}
          if (ok) continue;
          rmrf(dst);
        }
        fs.symlinkSync(src, dst, 'junction');
      } catch {  }
    }
  }

  detectEscapes(rec) {
    const out = [];
    for (const [rel, fp] of rec.manifest) {
      const p = path.join(this.base, rel);
      if (!p.startsWith(this.base + path.sep)) continue;
      let now = null;
      try { now = fingerprint(p); } catch { continue; }
      if (now && fp && now !== fp) out.push(rel);
    }
    return out;
  }

  publish(task) {
    if (!this.isWriter(task)) return null;
    const attempt = task.attemptId ?? 0;
    const key = `${task.id}#${attempt}`;
    const rec = this._shadows.get(key);
    if (!rec) return null;
    if (rec.generation !== this.generation) {
      throw new Error(
        `发布拒绝：${task.id} 的影子基于第 ${rec.generation} 代 base，当前已是第 ${this.generation} 代` +
        `——期间有其他写任务改动了共享区，覆盖会丢失其改动（请确认 writeSquadGate=1）`
      );
    }
    const t0 = Date.now();

    const escapes = new Set(this.detectEscapes(rec));
    const conflicts = [];
    if (escapes.size) {
      this.stats.escapes += escapes.size;
      this.escapeLog.push({ task: task.id, attemptId: attempt, files: [...escapes], at: Date.now() });
      if (this.onEscape) { try { this.onEscape(task, [...escapes]); } catch {} }
      if (this.strictIsolation) {
        throw new Error(
          `隔离被绕过（strictIsolation）：${task.id} 期间有 ${escapes.size} 个共享区文件被绕过控制平面改动 ` +
          `——${[...escapes].slice(0, 3).join(', ')}${escapes.size > 3 ? ' …' : ''}。` +
          `写任务应只在自己的影子目录内写；请检查子代理是否 cd 到了绝对路径。`
        );
      }
    }
    this._publishing = true;
    const created = [], updated = [], deleted = [];

    const appliedNow = [];
    try {

      const shadowFiles = [];
      collectFiles(rec.dir, this.exclude, shadowFiles);
      const shadowSet = new Set(shadowFiles.map((f) => path.relative(rec.dir, f)));

      const blocked = [];
      for (const f of shadowFiles) {
        const rel = path.relative(rec.dir, f);
        if (escapes.has(rel)) continue;
        const dst = path.join(this.base, rel);
        if (!dst.startsWith(this.base + path.sep)) { blocked.push(rel + '（越界）'); continue; }
        try {
          if (fs.existsSync(dst)) {
            fs.accessSync(dst, fs.constants.W_OK);
          } else {

            let dir = path.dirname(dst);
            while (dir && dir.startsWith(this.base) && !fs.existsSync(dir)) {
              const up = path.dirname(dir);
              if (up === dir) break;
              dir = up;
            }
            if (fs.existsSync(dir)) fs.accessSync(dir, fs.constants.W_OK);
          }
        } catch (e) {
          blocked.push(rel + '（' + (e.code || e.message) + '）');
        }
      }
      if (blocked.length) {
        throw new Error(
          `发布前置体检未通过，**未写入任何文件**（避免留下半套改动）：` +
          blocked.slice(0, 5).join('、') + (blocked.length > 5 ? ` 等 ${blocked.length} 处` : '')
        );
      }

      for (const f of shadowFiles) {
        const rel = path.relative(rec.dir, f);
        const dst = path.join(this.base, rel);
        if (!dst.startsWith(this.base + path.sep)) throw new Error('拒绝发布到工作区之外: ' + rel);

        if (escapes.has(rel)) { conflicts.push(rel); continue; }
        const existed = fs.existsSync(dst);
        if (existed && sameFile(f, dst)) continue;
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        const tmp = dst + '.cptmp-' + process.pid;
        fs.copyFileSync(f, tmp);
        fs.renameSync(tmp, dst);
        (existed ? updated : created).push(rel);
        appliedNow.push(rel);
      }

      for (const rel of rec.manifest.keys()) {
        if (shadowSet.has(rel)) continue;

        if (escapes.has(rel)) { conflicts.push(rel); continue; }
        const dst = path.join(this.base, rel);
        if (!dst.startsWith(this.base + path.sep)) continue;
        let st;
        try { st = fs.lstatSync(dst); } catch { continue; }
        if (!st.isFile()) continue;
        try { fs.unlinkSync(dst); deleted.push(rel); appliedNow.push('-' + rel); }
        catch (e) { throw new Error(`删除传播失败 ${rel}: ${e.message}`); }
      }
    } catch (e) {

      this.lastPublishFailure = {
        task: task.id, attemptId: attempt, at: Date.now(),
        applied: appliedNow.slice(), error: String(e && e.message),
      };
      this.stats.publishFailures++;

      const state = appliedNow.length
        ? `base 处于**部分应用**状态，已落地：${appliedNow.join(', ')}`
        : 'base **未被改动**（未写入任何文件）';
      throw new Error(`发布失败：${state}。原因：${e && e.message}。影子目录已保留，可重试发布。`);
    } finally {
      this._publishing = false;
    }
    this.generation++;
    this.stats.published++;
    this.stats.filesWritten += created.length + updated.length;
    this.stats.filesDeleted += deleted.length;
    this.stats.conflicts += conflicts.length;
    this.stats.publishMs += Date.now() - t0;

    for (const rel of [...created, ...updated]) {
      try { this._publishedFiles.add(path.join(this.base, rel)); } catch {}
    }

    let readOnlyPollution = [];
    for (const [rid] of this._roStart) {
      if (rid === task.id) continue;
      const dirty = this.detectReadOnlyPollution({ id: rid });
      if (dirty.length) {
        readOnlyPollution.push({ task: rid, files: dirty.slice(), partialBaseline: !!dirty.partial });
        if (!this.readOnlyPollutionLog) this.readOnlyPollutionLog = [];
        this.readOnlyPollutionLog.push({ task: rid, files: dirty.slice(), partialBaseline: !!dirty.partial, at: Date.now(), during: task.id });
      }
    }

    let conflictDir = null;
    if (conflicts.length) {
      try {
        conflictDir = path.join(this.runRoot, 'conflicts',
          (this.runId || 'run'), `${task.id}-a${attempt}-${Date.now().toString(36)}`);
        for (const rel of conflicts) {
          const src = path.join(rec.dir, rel);
          try {
            if (!fs.existsSync(src)) continue;
            const dst = path.join(conflictDir, rel);
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.copyFileSync(src, dst);
          } catch {}
        }
      } catch { conflictDir = null; }
    }
    rmrf(rec.dir);
    this._shadows.delete(key);
    return { created, updated, deleted, conflicts, conflictDir, readOnlyPollution, generation: this.generation };
  }

  defaultWriteGate() {
    const self = this;
    return (task, tasks) => {
      if (Array.isArray(tasks)) self._live = tasks;
      if (!self.isWriter(task)) return true;
      const live = self._live || (Array.isArray(tasks) ? tasks : []);
      for (const t of live) {
        if (t.id === task.id) continue;
        if (!self.isWriter(t)) continue;
        if (t.state === 'running' || t.state === 'leased') return false;
      }
      return true;
    };
  }

  stranded(task) {
    const key = `${task.id}#${task.attemptId ?? 0}`;
    const rec = this._shadows.get(key);
    if (!rec || !fs.existsSync(rec.dir)) return [];
    const out = [];
    collectFiles(rec.dir, this.exclude, out);
    const diff = [];
    for (const f of out) {
      const rel = path.relative(rec.dir, f);
      const dst = path.join(this.base, rel);
      if (!dst.startsWith(this.base + path.sep)) continue;
      let same = false;
      try { same = fs.existsSync(dst) && sameFile(f, dst); } catch { same = false; }
      if (!same) diff.push(rel);
    }
    return diff;
  }

  gate(baseGate) {
    const self = this;
    return (task, tasks) => {
      if (Array.isArray(tasks)) self._live = tasks;
      if (baseGate) {
        const r = baseGate(task, tasks);
        if (r !== true) return r;
      }
      if (self._publishing) return false;
      if (self.exclusiveReads && self.isWriter(task)) return true;
      if (self.exclusiveReads && !self.isWriter(task)) {
        const live = self._live || [];
        const writerInFlight = live.some(
          (t) => t.id !== task.id && self.isWriter(t) && (t.state === 'running' || t.state === 'leased')
        );
        if (writerInFlight) return false;
      }
      return true;
    };
  }

  staleness(task) {
    const g = this.stats.generationAtRead.get(task.id);
    if (g == null) return null;
    return this.generation - g;
  }
}

function collectFiles(dir, exclude, out, baseRel = '') {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (ent.isDirectory() && exclude.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isDirectory()) collectFiles(p, exclude, out, baseRel);
    else if (st.isFile()) out.push(p);
  }
}

module.exports = { Workspace, copyDir, DEFAULT_EXCLUDE, collectFiles, collectFilesAsync, rmrfExtras, rmrfExtrasAsync };
