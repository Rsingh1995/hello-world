// Small UI helpers shared by every page. All text goes through textContent (never innerHTML with data).

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(3)) { if (k == null || k === false) continue; el.append(k.nodeType ? k : document.createTextNode(String(k))); }
  return el;
}
export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const fmt = s => { s = Math.max(0, Math.floor(s || 0)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
export const humanTime = s => s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`;

/** Parse a server timestamp ("YYYY-MM-DD HH:MM:SS", UTC) into a Date. */
export const utc = s => s ? new Date(String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z')) : null;
export const dateTime = s => { const d = utc(s); return d ? d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; };
export const dateOnly = s => { const d = utc(s); return d ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; };
/** Convert a server UTC timestamp to the value of a local <input type="datetime-local">, and back. */
export const toLocalInput = s => { const d = utc(s); if (!d) return ''; const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
export const fromLocalInput = v => v ? new Date(v).toISOString().replace('T', ' ').slice(0, 19) : null;

export class ApiError extends Error { constructor(status, message, details) { super(message); this.status = status; this.details = details; } }

export async function api(method, path, body) {
  const res = await fetch('/api' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  let data = {}; try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/login') && !path.startsWith('/me')) { location.hash = '#/login'; }
    if (res.status === 428) { location.hash = '#/password'; }
    throw new ApiError(res.status, data.error || `Request failed (${res.status}).`, data.details);
  }
  return data;
}

let toastTimer;
export function toast(text, tone = 'good') {
  let el = $('#toast');
  if (!el) { el = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(el); }
  el.className = 'toast ' + tone; el.textContent = text; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

/** Show an error from an API call inside a container (or as a toast). */
export function showError(e, where) {
  const msg = e instanceof ApiError ? e.message : 'Something went wrong. Check your connection and try again.';
  if (!where) return toast(msg, 'crit');
  where.hidden = false;
  where.replaceChildren(h('p', { text: msg }), e.details && e.details.length ? h('ul', null, e.details.map(d => h('li', { text: d }))) : null);
  where.className = 'msg err';
}

export function download(filename, text, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Modal dialog built on <dialog>. Returns the dialog; body is a node or array. */
export function modal(title, body, actions = []) {
  const d = h('dialog', { class: 'modal' },
    h('form', { method: 'dialog', class: 'modal-inner' },
      h('div', { class: 'modal-head' }, h('h2', { text: title }), h('button', { class: 'icon-btn', value: 'close', 'aria-label': 'Close', text: '×' })),
      h('div', { class: 'modal-body' }, body),
      actions.length ? h('div', { class: 'modal-actions' }, actions) : null));
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  d.showModal();
  return d;
}

/** Two-step confirm button: first click arms, second click (within 4 s) runs. */
export function confirmButton(label, confirmLabel, onConfirm, cls = 'btn btn-danger') {
  let armed = 0;
  const b = h('button', { type: 'button', class: cls, text: label, onclick: async () => {
    if (!armed || Date.now() > armed) { armed = Date.now() + 4000; b.textContent = confirmLabel; b.classList.add('confirm'); setTimeout(() => { if (armed && Date.now() > armed) { armed = 0; b.textContent = label; b.classList.remove('confirm'); } }, 4100); return; }
    armed = 0; b.textContent = label; b.classList.remove('confirm'); await onConfirm();
  } });
  return b;
}

export const pill = (text, tone = 'neutral') => h('span', { class: 'pill ' + tone, text });
export const scorePill = (score, passed) => score == null ? pill('In progress', 'neutral') : pill(score + '%', passed ? 'good' : 'warn');
