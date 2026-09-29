// Resus Bay front end: routing, sign-in, student pages and playing cases.
import { h, $, api, toast, showError, dateTime, fmt, pill, scorePill, utc, ApiError } from './ui.js';
import { mountSim, destroySim, simRunning } from './sim.js';
import { renderDebrief } from './debrief.js';
import * as T from './teacher.js';
import { editorPage } from './editor.js';

export const state = { user: null };
const main = () => $('#main');
const isStaff = u => u && (u.role === 'admin' || u.role === 'teacher');

// ------------------------------------------------------------------ routing
const ROUTES = [
  ['/login', loginPage, 'public'], ['/setup', setupPage, 'public'], ['/join', joinPage, 'public'],
  ['/password', passwordPage, 'any'],
  ['/', homePage, 'any'], ['/results', resultsPage, 'any'],
  ['/play/case/:id', playCase, 'any'], ['/play/assignment/:id', playAssignment, 'any'], ['/attempt/:id', attemptPage, 'any'],
  ['/teach', T.dashboard, 'staff'], ['/classes', T.classesPage, 'staff'], ['/class/:id', T.classPage, 'staff'],
  ['/assignment/:id', T.assignmentPage, 'staff'], ['/student/:id', T.studentPage, 'staff'],
  ['/cases', T.casesPage, 'staff'], ['/case/:id', editorPage, 'staff'], ['/new-case', editorPage, 'staff'], ['/preview/:id', T.previewPage, 'staff'],
  ['/users', T.usersPage, 'staff']
];
function match(path) {
  for (const [pat, fn, access] of ROUTES) {
    const keys = []; const re = new RegExp('^' + pat.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    const m = re.exec(path); if (m) { const params = {}; keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); return { fn, access, params }; }
  }
  return null;
}
let current = location.hash;
export function go(path) { if (location.hash === '#' + path) route(); else location.hash = '#' + path; }

async function route() {
  if (location.hash !== current) {
    if (simRunning() && !confirm('Leave this case? The attempt will not be scored.')) { history.replaceState(null, '', current); return; }
    if (state.leaveGuard && !state.leaveGuard()) { history.replaceState(null, '', current); return; }
  }
  state.leaveGuard = null;
  destroySim();
  current = location.hash;
  const path = (location.hash.slice(1) || '/').split('?')[0];
  const m = match(path);
  if (!m) return go('/');
  if (m.access !== 'public' && !state.user) return go('/login');
  if (m.access === 'public' && state.user && path !== '/join') return go('/');
  if (state.user && state.user.mustChangePassword && path !== '/password') return go('/password');
  if (m.access === 'staff' && !isStaff(state.user)) return go('/');
  renderNav(path);
  main().replaceChildren(h('p', { class: 'loading', text: 'Loading…' }));
  try { await m.fn(main(), m.params); }
  catch (e) { if (!(e instanceof ApiError && (e.status === 401 || e.status === 428))) { main().replaceChildren(h('div', { class: 'page' }, h('div', { class: 'msg err', text: e.message || 'Could not load this page.' }), h('a', { href: '#/', text: 'Go to the home page' }))); console.error(e); } }
}

function renderNav(path) {
  const u = state.user;
  const link = (href, text) => h('a', { href: '#' + href, text, 'aria-current': (path === href || (href !== '/' && path.startsWith(href))) ? 'page' : null });
  const links = !u ? [] : isStaff(u)
    ? [link('/teach', 'Dashboard'), link('/classes', 'Classes'), link('/cases', 'Cases'), link('/users', u.role === 'admin' ? 'People' : 'Students')]
    : [link('/', 'Home'), link('/results', 'My results')];
  $('#nav').replaceChildren(h('nav', { class: 'topnav', 'aria-label': 'Main' },
    h('a', { class: 'brand', href: '#/' },
      h('svg', { viewBox: '0 0 30 20', 'aria-hidden': 'true', width: '30', height: '20' }), 'Resus Bay', h('small', { text: 'virtual patient simulator' })),
    h('div', { class: 'nav-links' }, links),
    u ? h('div', { class: 'usermenu' }, h('span', { class: 'who', text: `${u.name} · ${u.role}` }),
      h('a', { class: 'btn btn-sm', href: '#/password', text: 'Password' }),
      h('button', { class: 'btn btn-sm', type: 'button', text: 'Sign out', onclick: async () => { if (simRunning() && !confirm('Leave this case?')) return; destroySim(); await api('POST', '/logout'); state.user = null; go('/login'); } })) : null));
  // brand glyph (SVG needs its namespace)
  const svg = $('#nav .brand svg'); const NS = 'http://www.w3.org/2000/svg';
  const g = document.createElementNS(NS, 'svg'); g.setAttribute('viewBox', '0 0 30 20'); g.setAttribute('width', '30'); g.setAttribute('height', '20'); g.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path'); p.setAttribute('d', 'M0 13h8l2-3 2 3h2l2-12 3 18 2-6h9'); p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'var(--accent)'); p.setAttribute('stroke-width', '2'); p.setAttribute('stroke-linejoin', 'round'); p.setAttribute('stroke-linecap', 'round');
  g.append(p); svg.replaceWith(g);
}

// ------------------------------------------------------------------ auth pages
function formField(label, input, note) { return h('label', { class: 'field' }, h('span', { text: label }), input, note ? h('small', { text: note }) : null); }
const input = (id, type = 'text', attrs = {}) => h('input', { id, name: id, type, ...attrs });

async function loginPage(root) {
  const setup = await api('GET', '/setup');
  if (setup.needsSetup) return go('/setup');
  const msg = h('div', { hidden: true });
  const f = h('form', { class: 'center-card', onsubmit: async e => {
    e.preventDefault(); msg.hidden = true;
    try { await api('POST', '/login', { username: $('#username').value.trim(), password: $('#password').value }); await loadMe(); go('/'); }
    catch (err) { showError(err, msg); }
  } },
    h('h1', { text: 'Sign in' }), h('p', { class: 'muted', text: 'Use the username and password from your teacher or administrator.' }),
    formField('Username or roll number', input('username', 'text', { autocomplete: 'username', required: true, autofocus: true })),
    formField('Password', input('password', 'password', { autocomplete: 'current-password', required: true })),
    msg, h('button', { class: 'btn btn-primary', type: 'submit', text: 'Sign in' }),
    h('p', { class: 'hint' }, 'New student with a class code? ', h('a', { href: '#/join', text: 'Join your class' })));
  root.replaceChildren(f);
}

async function setupPage(root) {
  const setup = await api('GET', '/setup');
  if (!setup.needsSetup) return go('/login');
  const msg = h('div', { hidden: true });
  root.replaceChildren(h('form', { class: 'center-card', onsubmit: async e => {
    e.preventDefault(); msg.hidden = true;
    if ($('#pw').value !== $('#pw2').value) { msg.hidden = false; msg.className = 'msg err'; msg.textContent = 'The passwords do not match.'; return; }
    try { await api('POST', '/setup', { code: $('#code').value.trim(), name: $('#name').value.trim(), username: $('#username').value.trim(), password: $('#pw').value }); await loadMe(); toast('Administrator account created.'); go('/teach'); }
    catch (err) { showError(err, msg); }
  } },
    h('h1', { text: 'Set up Resus Bay' }),
    h('p', { class: 'muted', text: 'Create the first administrator account. The setup code is printed in the server window when the server starts.' }),
    formField('Setup code', input('code', 'text', { required: true, autocomplete: 'off' })),
    formField('Your full name', input('name', 'text', { required: true, autocomplete: 'name' })),
    formField('Username', input('username', 'text', { required: true, autocomplete: 'username' })),
    formField('Password', input('pw', 'password', { required: true, minlength: 8, autocomplete: 'new-password' }), 'At least 8 characters.'),
    formField('Repeat password', input('pw2', 'password', { required: true, autocomplete: 'new-password' })),
    msg, h('button', { class: 'btn btn-primary', type: 'submit', text: 'Create administrator' })));
}

async function joinPage(root) {
  const msg = h('div', { hidden: true });
  const signedIn = !!state.user;
  root.replaceChildren(h('form', { class: 'center-card', onsubmit: async e => {
    e.preventDefault(); msg.hidden = true;
    if (!signedIn && $('#pw').value !== $('#pw2').value) { msg.hidden = false; msg.className = 'msg err'; msg.textContent = 'The passwords do not match.'; return; }
    try {
      const r = await api('POST', '/join', signedIn ? { code: $('#code').value.trim() } : { code: $('#code').value.trim(), name: $('#name').value.trim(), username: $('#username').value.trim(), password: $('#pw').value });
      await loadMe(); toast(`You have joined ${r.cohort}.`); go('/');
    } catch (err) { showError(err, msg); }
  } },
    h('h1', { text: 'Join a class' }),
    h('p', { class: 'muted', text: signedIn ? 'Enter the class code your teacher gave you.' : 'Enter the class code from your teacher and create your account. Use your roll number as the username.' }),
    formField('Class code', input('code', 'text', { required: true, autocomplete: 'off', style: 'text-transform:uppercase;letter-spacing:.15em', value: new URLSearchParams(location.hash.split('?')[1] || '').get('code') || '' })),
    signedIn ? null : [
      formField('Full name', input('name', 'text', { required: true, autocomplete: 'name' })),
      formField('Username (roll number)', input('username', 'text', { required: true, autocomplete: 'username' })),
      formField('Password', input('pw', 'password', { required: true, minlength: 8, autocomplete: 'new-password' }), 'At least 8 characters.'),
      formField('Repeat password', input('pw2', 'password', { required: true, autocomplete: 'new-password' }))],
    msg, h('button', { class: 'btn btn-primary', type: 'submit', text: 'Join class' }),
    signedIn ? null : h('p', { class: 'hint' }, 'Already have an account? ', h('a', { href: '#/login', text: 'Sign in' }))));
}

async function passwordPage(root) {
  const forced = state.user && state.user.mustChangePassword;
  const msg = h('div', { hidden: true });
  root.replaceChildren(h('form', { class: 'center-card', onsubmit: async e => {
    e.preventDefault(); msg.hidden = true;
    if ($('#pw').value !== $('#pw2').value) { msg.hidden = false; msg.className = 'msg err'; msg.textContent = 'The new passwords do not match.'; return; }
    try { await api('POST', '/me/password', { current: $('#cur').value, password: $('#pw').value }); await loadMe(); toast('Password changed.'); go('/'); }
    catch (err) { showError(err, msg); }
  } },
    h('h1', { text: forced ? 'Choose a new password' : 'Change password' }),
    forced ? h('p', { class: 'muted', text: 'You signed in with a temporary password. Choose your own before continuing.' }) : null,
    formField(forced ? 'Temporary password' : 'Current password', input('cur', 'password', { required: true, autocomplete: 'current-password' })),
    formField('New password', input('pw', 'password', { required: true, minlength: 8, autocomplete: 'new-password' }), 'At least 8 characters.'),
    formField('Repeat new password', input('pw2', 'password', { required: true, autocomplete: 'new-password' })),
    msg, h('button', { class: 'btn btn-primary', type: 'submit', text: 'Save password' })));
}

// ------------------------------------------------------------------ student pages
function dueLabel(a) {
  if (!a.due_at) return 'No due date';
  const d = utc(a.due_at), past = d < new Date();
  return (past ? 'Was due ' : 'Due ') + dateTime(a.due_at);
}
async function homePage(root) {
  if (isStaff(state.user)) return go('/teach');
  await retryPendingResults();
  const d = await api('GET', '/student/home');
  const page = h('div', { class: 'page' });
  page.append(h('div', { class: 'page-head' }, h('div', null, h('p', { class: 'eyebrow', text: d.cohorts.map(c => c.name).join(' · ') || 'Not in a class yet' }), h('h1', { text: `Hello, ${state.user.name.split(' ')[0]}` })),
    h('form', { class: 'row', onsubmit: async e => { e.preventDefault(); try { const r = await api('POST', '/join', { code: $('#joinCode').value.trim() }); toast(`Joined ${r.cohort}.`); route(); } catch (err) { showError(err); } } },
      h('input', { id: 'joinCode', type: 'text', placeholder: 'Class code', 'aria-label': 'Class code', style: 'width:9.5em;text-transform:uppercase', required: true }), h('button', { class: 'btn', type: 'submit', text: 'Join a class' }))));
  if (!d.cohorts.length) page.append(h('div', { class: 'empty-state' }, h('b', { text: 'You are not in a class yet.' }), h('span', { text: 'Enter the class code from your teacher above to see your assigned cases.' })));

  page.append(h('h2', { text: 'Assigned cases' }));
  if (!d.assignments.length) page.append(h('p', { class: 'empty', text: 'No cases assigned yet. Your teacher will add them here.' }));
  else page.append(h('div', { class: 'case-grid' }, d.assignments.map(a => {
    const left = a.max_attempts ? a.max_attempts - a.used : null;
    const closed = a.mode === 'assessment' && a.due_at && utc(a.due_at) < new Date();
    const canStart = !closed && (left == null || left > 0);
    return h('article', { class: 'case' },
      h('div', { class: 'chips' }, a.mode === 'assessment' ? pill('Assessment', 'warn') : pill('Practice', 'neutral'), a.discipline ? h('span', { class: 'chip', text: a.discipline }) : null, h('span', { class: 'chip', text: a.cohort })),
      h('h3', { text: a.title || a.complaint }),
      h('p', { class: 'who', text: dueLabel(a) + (a.max_attempts ? ` · ${a.used}/${a.max_attempts} attempts used` : a.used ? ` · ${a.used} attempt(s)` : '') }),
      h('div', { class: 'foot' }, a.best != null ? h('span', { class: 'hint' }, 'Best: ', h('b', { text: a.best + '%' })) : h('span', { class: 'hint', text: 'Not attempted' }),
        canStart ? h('a', { class: 'btn btn-primary', href: `#/play/assignment/${a.id}`, text: a.used ? 'Try again' : 'Start case' }) : h('span', { class: 'pill neutral', text: closed ? 'Closed' : 'No attempts left' })));
  })));

  page.append(h('h2', { text: 'Practice library' }));
  if (!d.practice.length) page.append(h('p', { class: 'empty', text: 'Open practice is not enabled for your class.' }));
  else page.append(h('div', { class: 'case-grid' }, d.practice.map(c => h('article', { class: 'case' },
    h('div', { class: 'chips' }, c.discipline ? h('span', { class: 'chip', text: c.discipline }) : null, c.difficulty ? h('span', { class: 'chip', text: c.difficulty }) : null),
    h('h3', { text: c.complaint }),
    h('div', { class: 'foot' }, h('span', { class: 'hint', text: 'Diagnosis revealed in the debrief' }), h('a', { class: 'btn btn-primary', href: `#/play/case/${encodeURIComponent(c.id)}`, text: 'Practise' }))))));

  page.append(h('h2', { text: 'Recent attempts' }), attemptsTable(d.recent));
  root.replaceChildren(page);
}
function attemptsTable(rows, { showStudentTitle = false } = {}) {
  if (!rows.length) return h('p', { class: 'empty', text: 'No attempts yet.' });
  return h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, h('tr', null, ['Date', 'Case', 'Type', 'Outcome', 'Sim time', 'Score'].map(t => h('th', { text: t })))),
    h('tbody', null, rows.map(a => h('tr', { class: a.finished_at ? 'clickable' : '', onclick: a.finished_at ? () => go('/attempt/' + a.id) : null },
      h('td', { class: 'num', text: dateTime(a.started_at) }), h('td', { text: showStudentTitle && a.title ? `${a.complaint} (${a.title})` : a.complaint }),
      h('td', { text: a.assignment_id ? 'Assigned' : 'Practice' }), h('td', { text: a.finished_at ? a.outcome : 'Not finished' }),
      h('td', { class: 'num', text: a.sim_seconds != null ? fmt(a.sim_seconds) : '—' }), h('td', null, a.finished_at ? scorePill(a.score, a.passed) : pill('Abandoned', 'neutral')))))));
}
export { attemptsTable };

async function resultsPage(root) {
  const d = await api('GET', '/attempts');
  const done = d.attempts.filter(a => a.finished_at);
  const avg = done.length ? Math.round(done.reduce((s, a) => s + a.score, 0) / done.length) : null;
  root.replaceChildren(h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', { text: 'My results' })),
    h('div', { class: 'tiles' },
      h('div', { class: 'tile' }, h('span', { class: 'v', text: done.length }), h('span', { class: 'k', text: 'Cases completed' })),
      h('div', { class: 'tile' }, h('span', { class: 'v', text: avg == null ? '—' : avg + '%' }), h('span', { class: 'k', text: 'Average score' })),
      h('div', { class: 'tile' }, h('span', { class: 'v', text: done.filter(a => a.passed).length }), h('span', { class: 'k', text: 'Passed' }))),
    attemptsTable(d.attempts)));
}

// ------------------------------------------------------------------ playing
const PENDING_KEY = 'resusbay.pendingResults';
const pending = { get() { try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); } catch { return []; } }, set(v) { try { localStorage.setItem(PENDING_KEY, JSON.stringify(v)); } catch { /* ignore */ } } };
async function submitResult(attemptId, record) {
  try { await api('POST', `/attempts/${attemptId}/finish`, { record }); return true; }
  catch (e) {
    if (e instanceof ApiError && e.status === 409) return true;
    if (e instanceof ApiError && e.status < 500) throw e;
    pending.set([...pending.get().filter(p => p.attemptId !== attemptId), { attemptId, record }]);
    return false;
  }
}
async function retryPendingResults() {
  const list = pending.get(); if (!list.length) return;
  const left = [];
  for (const p of list) { try { await api('POST', `/attempts/${p.attemptId}/finish`, { record: p.record }); } catch (e) { if (!(e instanceof ApiError) || e.status >= 500) left.push(p); } }
  pending.set(left);
  if (list.length > left.length) toast(`${list.length - left.length} saved result(s) uploaded.`);
}

async function startAttempt(root, body, badge) {
  const r = await api('POST', '/attempts', body);
  mountSim(root, r.case, {
    badge: r.mode === 'assessment' ? 'Assessment' : badge,
    onEnd: async record => {
      root.replaceChildren(h('div', { class: 'page' }, h('p', { class: 'loading', text: 'Saving your result…' })));
      let ok = false;
      try { ok = await submitResult(r.attemptId, record); }
      catch (e) { root.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'msg err', text: e.message }), h('a', { href: '#/', text: 'Back to home' }))); return; }
      if (ok) go('/attempt/' + r.attemptId);
      else root.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'msg err', text: 'Could not reach the server. Your result is saved on this device and will upload automatically next time you open the home page.' }),
        h('button', { class: 'btn btn-primary', type: 'button', text: 'Try uploading now', onclick: async () => { await retryPendingResults(); if (!pending.get().some(p => p.attemptId === r.attemptId)) go('/attempt/' + r.attemptId); } })));
    }
  });
}
async function playCase(root, { id }) { await startAttempt(root, { caseId: id }, 'Practice'); }
async function playAssignment(root, { id }) { await startAttempt(root, { assignmentId: Number(id) }, 'Assigned'); }

async function attemptPage(root, { id }) {
  const d = await api('GET', '/attempts/' + id);
  const a = d.attempt;
  if (!a.finished) { root.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'msg err', text: 'This attempt was not finished.' }), h('a', { href: '#/', text: 'Back' }))); return; }
  const back = isStaff(state.user) ? h('button', { class: 'btn', type: 'button', text: 'Back', onclick: () => history.back() }) : h('a', { class: 'btn', href: '#/', text: 'Home' });
  if (d.hidden) {
    root.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'center-card' },
      h('p', { class: 'eyebrow', text: 'Assessment submitted' }), h('h1', { text: 'Your attempt is recorded' }),
      h('p', { class: 'muted', text: 'Your teacher has chosen to release the full debrief after the assessment closes.' }),
      h('div', { class: 'row' }, h('span', { class: 'score', style: 'font-size:3rem', text: a.score + '%' }), scorePill(a.score, a.passed)), back)));
    return;
  }
  const actions = [back];
  if (!isStaff(state.user)) actions.unshift(a.assignment_id ? h('a', { class: 'btn btn-primary', href: `#/play/assignment/${a.assignment_id}`, text: 'Try again' }) : h('a', { class: 'btn btn-primary', href: `#/play/case/${encodeURIComponent(a.case_id)}`, text: 'Retry this case' }));
  const wrap = h('div');
  if (isStaff(state.user)) root.replaceChildren(h('div', { class: 'msg ok', style: 'margin-top:16px', text: `Attempt by ${a.student.name} (${a.student.username}) · ${dateTime(a.finished_at)}` }), wrap);
  else root.replaceChildren(wrap);
  renderDebrief(wrap, d.case, d.record, { actions, student: isStaff(state.user) ? a.student : null });
}

// ------------------------------------------------------------------ boot
async function loadMe() { const r = await api('GET', '/me'); state.user = r.user; return r; }
window.addEventListener('hashchange', route);
(async () => {
  try { await loadMe(); } catch { state.user = null; }
  route();
})();
