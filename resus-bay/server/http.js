// Minimal HTTP helpers: router, JSON bodies, cookies and static files. No dependencies.
import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const bad = m => new HttpError(400, m);
export const forbidden = (m = 'You do not have permission to do that.') => new HttpError(403, m);
export const notFound = (m = 'Not found.') => new HttpError(404, m);

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, re, keys, handler });
  }
  get(p, h) { this.add('GET', p, h); } post(p, h) { this.add('POST', p, h); }
  put(p, h) { this.add('PUT', p, h); } patch(p, h) { this.add('PATCH', p, h); } delete(p, h) { this.add('DELETE', p, h); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (m) { const params = {}; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); return { handler: r.handler, params }; }
    }
    return null;
  }
}

export function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const type = req.headers['content-type'] || '';
    if (!type.includes('application/json')) return reject(bad('Expected a JSON request body.'));
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Request is too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(bad('The request body is not valid JSON.')); } });
    req.on('error', reject);
  });
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isStr ? body : JSON.stringify(body));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };

/** Serve a file from one of the given roots ({prefix, dir}). Returns true if served. */
export function serveStatic(req, res, pathname, roots) {
  for (const { prefix, dir } of roots) {
    if (!pathname.startsWith(prefix)) continue;
    const rel = pathname.slice(prefix.length) || 'index.html';
    const file = path.resolve(dir, '.' + path.sep + rel);
    if (!file.startsWith(path.resolve(dir) + path.sep)) return false;
    let st; try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300' });
    if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
    return true;
  }
  return false;
}

export function toCsv(rows) {
  const esc = v => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? '"' + (/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""') + '"' : s; };
  return '﻿' + rows.map(r => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

/** Parse simple CSV (quoted fields supported). */
export function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  text = String(text).replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',' || ch === ';' || ch === '\t') { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += ch;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.map(r => r.map(x => x.trim())).filter(r => r.some(x => x));
}
