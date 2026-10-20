'use strict';
const http = require('http');
const https = require('https');
const { URL } = require('url');

const decodeEntities = (s) =>
  s.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&ensp;/g, ' ').replace(/&amp;/g, '&');

const stripTags = (h) =>
  decodeEntities(String(h).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\u00a0]+/g, ' ').trim();

// HTTPS through an HTTP CONNECT proxy. One overall timeout covers CONNECT + TLS +
// request + body. Every terminal path calls done() exactly once, which also tears
// down the tunnel.
function httpsViaProxy(u, proxyHost, proxyPort, headers, timeoutMs, redirects) {
  return new Promise((resolve) => {
    const net = require('net');
    const tls = require('tls');
    const zlib = require('zlib');
    let settled = false;
    let timer = null;
    let conn = null;
    let secure = null;
    let req = null;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const s of [req, secure, conn]) { if (s) { try { s.destroy(); } catch (_) {} } }
      resolve(r);
    };
    timer = setTimeout(() => done({ status: 0, body: '' }), timeoutMs);

    const onResponse = (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return done({ status: res.statusCode, body: '' });
        let next;
        try { next = new URL(res.headers.location, u.href).href; } catch (_) { return done({ status: res.statusCode, body: '' }); }
        return get(next, { timeoutMs, useProxy: true, redirects: redirects - 1 }).then(done);
      }
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      const stream = enc.includes('gzip') ? res.pipe(zlib.createGunzip())
        : enc.includes('br') ? res.pipe(zlib.createBrotliDecompress())
        : enc.includes('deflate') ? res.pipe(zlib.createInflate())
        : res;
      let body = '';
      stream.setEncoding('utf8');
      stream.on('data', (c) => { body += c; });
      stream.on('end', () => done({ status: res.statusCode, body }));
      stream.on('error', () => done({ status: res.statusCode, body: '' }));
      res.on('error', () => done({ status: 0, body: '' }));
    };

    const startTls = () => {
      secure = tls.connect({ socket: conn, servername: net.isIP(u.hostname) ? undefined : u.hostname }, () => {
        // http.request (not https.request): the socket is already TLS. https.request
        // would run tls.connect again on it and fail the nested handshake. Node's
        // http.request ignores options.socket, so hand the socket over through the
        // documented createConnection hook (agent must stay unused).
        req = http.request({
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          method: 'GET',
          headers: Object.assign({ Host: u.host }, headers),
          createConnection: () => secure,
        }, onResponse);
        req.on('error', () => done({ status: 0, body: '' }));
        req.end();
      });
      secure.on('error', () => done({ status: 0, body: '' }));
    };

    let headBuf = '';
    const onConnectData = (d) => {
      headBuf += d.toString('latin1');
      const end = headBuf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (headBuf.length > 16384) done({ status: 0, body: '' });
        return;
      }
      conn.removeListener('data', onConnectData);
      const head = headBuf.slice(0, end);
      const rest = headBuf.slice(end + 4);
      if (!/^HTTP\/1\.[01] 2\d\d/.test(head.split('\r\n')[0])) { done({ status: 0, body: '' }); return; }
      if (rest) conn.unshift(Buffer.from(rest, 'latin1'));
      startTls();
    };

    conn = net.connect({ host: proxyHost, port: proxyPort });
    conn.on('error', () => done({ status: 0, body: '' }));
    conn.on('data', onConnectData);
    conn.write('CONNECT ' + u.hostname + ':' + (u.port || 443) + ' HTTP/1.1\r\nHost: ' + u.hostname + ':' + (u.port || 443) + '\r\n\r\n');
  });
}

function get(urlStr, { timeoutMs = 20000, useProxy = false, redirects = 3 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch { return resolve({ status: 0, body: '' }); }
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Accept-Encoding': 'identity',
      },
    };
    const proxy = useProxy ? (process.env.WEBSEARCH_PROXY || '') : '';
    if (proxy) {

      const pm = proxy.match(/^([\w.-]+):(\d+)$/);
      if (!pm) { console.error('WEBSEARCH_PROXY 格式应为 host:port，收到 ' + proxy); return resolve({ status: 0, body: '' }); }
      if (u.protocol === 'https:') {
        return httpsViaProxy(u, pm[1], +pm[2], opts.headers, timeoutMs, redirects).then(resolve);
      }
      opts.hostname = pm[1]; opts.port = +pm[2]; opts.path = u.href; opts.headers.Host = u.host;
    } else { opts.hostname = u.hostname; opts.port = u.port || (u.protocol === 'https:' ? 443 : 80); opts.path = u.pathname + u.search; }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(opts, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return get(new URL(res.headers.location, u.href).href, { timeoutMs, useProxy }).then(resolve);
      }

      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      const zlib = require('zlib');
      const stream = enc.includes('gzip') ? res.pipe(zlib.createGunzip())
        : enc.includes('br') ? res.pipe(zlib.createBrotliDecompress())
        : enc.includes('deflate') ? res.pipe(zlib.createInflate())
        : res;
      let body = '';
      stream.setEncoding('utf8');
      stream.on('data', (c) => { body += c; });
      stream.on('end', () => resolve({ status: res.statusCode, body }));
      stream.on('error', () => resolve({ status: res.statusCode, body: '' }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });
}

function parseBing(html, count) {
  const out = [];
  for (const b of html.split(/<li class="b_algo"/).slice(1)) {
    const m = b.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!m) continue;
    const p = b.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    out.push({ title: stripTags(m[2]).slice(0, 200), url: decodeEntities(m[1]), snippet: p ? stripTags(p[1]).slice(0, 400) : '' });
    if (out.length >= count) break;
  }
  return out;
}

async function search(query, count = 5) {
  const q = encodeURIComponent(query);
  let r = await get('https://cn.bing.com/search?q=' + q + '&setlang=zh-hans&count=' + (count + 5));
  if (r.status === 200) {
    const items = parseBing(r.body, count);
    if (items.length) return items;
  }
  return [];
}

async function fetchPage(url, maxChars = 6000) {
  let r = await get(url);
  if (r.status !== 200) r = await get(url, { useProxy: true });
  if (r.status !== 200) return null;
  return decodeEntities(
    String(r.body)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h\d|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxChars);
}

module.exports = { search, fetchPage };

if (require.main === module) {
  const [, , cmd, ...rest] = process.argv;
  (async () => {
    if (cmd === 'fetch') {
      const url = rest[0];
      const max = parseInt(rest[1] || '6000', 10);
      const t = await fetchPage(url, max);
      if (t === null) { console.log('FETCH_FAILED: ' + url); process.exit(1); }
      console.log(t);
    } else {

      let count = 5;
      if (rest.length && /^\d+$/.test(rest[rest.length - 1])) count = Math.min(parseInt(rest.pop(), 10), 10);
      const query = rest.length ? rest.join(' ') : cmd;
      if (typeof query !== 'string' || !query.trim()) {
        console.log('用法: node websearch.js "<查询词>" [条数]  |  node websearch.js fetch <URL> [字符数]');
        process.exit(2);
      }
      const items = await search(query.trim(), count);
      if (!items.length) { console.log('NO_RESULTS'); process.exit(1); }
      items.forEach((it, i) => console.log(`[${i + 1}] ${it.title}\nURL: ${it.url}\n${it.snippet}\n`));
    }
  })();
}
