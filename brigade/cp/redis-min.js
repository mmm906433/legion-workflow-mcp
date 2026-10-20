'use strict';

const net = require('net');

class RedisMin {
  constructor(sock) {
    this.sock = sock;
    this.dead = false;
    this._buf = Buffer.alloc(0);
    this._pending = [];
    sock.on('data', (d) => this._onData(d));
    const kill = () => this._failAll(new Error('redis 连接关闭'));
    sock.on('error', kill);
    sock.on('close', kill);
  }

  static connect({ host = '127.0.0.1', port = 6390, timeoutMs = 2500 } = {}) {
    return new Promise((resolve) => {
      const sock = net.createConnection({ host, port });
      const done = (v) => { sock.removeAllListeners('timeout'); clearTimeout(timer); resolve(v); };
      const timer = setTimeout(() => { sock.destroy(); done(null); }, timeoutMs);
      sock.on('connect', () => { const r = new RedisMin(sock); done(r); });
      sock.on('error', () => { try { sock.destroy(); } catch {} done(null); });
      sock.on('timeout', () => { sock.destroy(); done(null); });
    });
  }

  close() { this.dead = true; try { this.sock.destroy(); } catch {} this._failAll(new Error('主动关闭')); }

  _failAll(e) {
    if (this.dead && !this._pending.length) return;
    this.dead = true;
    const q = this._pending.splice(0);
    for (const p of q) p.reject(e);
  }

  cmd(...args) {
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(new Error('redis 不可用'));

      const timer = setTimeout(() => {
        this.close();
        reject(new Error('redis 命令超时(5s)，连接已废弃重连'));
      }, 5000);
      const p = {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      this._pending.push(p);
      const bufs = [`*${args.length}\r\n`];
      for (const a of args) {
        const s = String(a);
        bufs.push(`$${Buffer.byteLength(s)}\r\n${s}\r\n`);
      }
      this.sock.write(bufs.join(''));
    });
  }

  _onData(d) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, d]) : d;
    for (;;) {
      const r = this._parse(this._buf);
      if (r === null) return;
      if (r.protocol === 'fatal') {
        this.close();
        return;
      }
      this._buf = this._buf.subarray(r.used);
      const p = this._pending.shift();
      if (!p) return;
      if (r.err) p.reject(new Error('redis: ' + r.val));
      else p.resolve(r.val);
    }
  }

  _parse(buf) {
    const lineEnd = buf.indexOf('\r\n');
    if (lineEnd < 0) return null;
    const head = buf.subarray(0, lineEnd).toString('latin1');
    const type = head[0];
    const body = head.slice(1);
    if (type === '+' || type === ':' || type === '-') {
      return { used: lineEnd + 2, val: body, err: type === '-' };
    }
    if (type === '$') {
      const n = parseInt(body, 10);
      if (!Number.isFinite(n)) return { protocol: 'fatal' };
      if (n < 0) return { used: lineEnd + 2, val: null, err: false };
      const total = lineEnd + 2 + n + 2;
      if (buf.length < total) return null;
      return { used: total, val: buf.subarray(lineEnd + 2, lineEnd + 2 + n).toString('utf8'), err: false };
    }
    if (type === '*') {
      const n = parseInt(body, 10);
      if (!Number.isFinite(n)) return { protocol: 'fatal' };
      if (n < 0) return { used: lineEnd + 2, val: null, err: false };

      let used = lineEnd + 2;
      const out = [];
      let hadErr = false;
      let sub = buf.subarray(used);
      for (let i = 0; i < n; i++) {
        const r = this._parse(sub);
        if (r === null) return null;
        if (r.protocol === 'fatal') return r;
        if (r.err) hadErr = true;
        out.push(r.val);
        used += r.used;
        sub = sub.subarray(r.used);
      }
      return { used, val: hadErr ? out.filter((x) => x !== null) : out, err: hadErr };
    }
    return { protocol: 'fatal' };
  }
}

module.exports = { RedisMin };
