// Resus Bay HTTP application: API routes + static front end.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tx } from './db.js';
import { Router, HttpError, bad, forbidden, notFound, readJson, parseCookies, send, serveStatic, toCsv, parseCsv } from './http.js';
import { hashPassword, verifyPassword, sha256, newToken, tempPassword, joinCode, passwordProblem, usernameProblem, RateLimiter, randomString } from './auth.js';
import { validateCase, normalizeCase } from '../shared/case-schema.js';
import { evaluate, summarize } from '../shared/scoring.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COOKIE = 'rb_session';
const isStaff = u => u && (u.role === 'admin' || u.role === 'teacher');
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const str = (v, max = 200) => (v == null ? '' : String(v)).trim().slice(0, max);

export function createApp({ db, config = {} }) {
  const cfg = { sessionDays: 14, cookieSecure: false, casesDir: path.join(ROOT, 'cases'), ...config };
  const loginLimiter = new RateLimiter(10, 15 * 60 * 1000);
  const joinLimiter = new RateLimiter(30, 15 * 60 * 1000);
  const r = new Router();
  const q = (sql, ...a) => db.prepare(sql).all(...a);
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);

  // ---------- setup & seeding ----------
  let setupCode = null;
  function needsSetup() { return !one(`SELECT 1 FROM users WHERE role = 'admin' AND active = 1 LIMIT 1`); }
  function ensureSetupCode() {
    if (needsSetup() && !setupCode) setupCode = cfg.setupCode || randomString(8).toUpperCase();
    return setupCode;
  }
  function seedCases() {
    let added = 0;
    if (!fs.existsSync(cfg.casesDir)) return 0;
    for (const f of fs.readdirSync(cfg.casesDir).filter(f => f.endsWith('.json')).sort()) {
      let c; try { c = normalizeCase(JSON.parse(fs.readFileSync(path.join(cfg.casesDir, f), 'utf8'))); } catch { continue; }
      if (validateCase(c).length || one('SELECT 1 FROM cases WHERE id = ?', c.id)) continue;
      tx(db, () => {
        run(`INSERT INTO cases (id, status, current_version, title, complaint, discipline, difficulty, builtin) VALUES (?, 'published', 1, ?, ?, ?, ?, 1)`, c.id, c.title, c.card.complaint, c.card.discipline || null, c.card.difficulty || null);
        run(`INSERT INTO case_versions (case_id, version, data, note) VALUES (?, 1, ?, 'Built-in case')`, c.id, JSON.stringify(c));
      });
      added++;
    }
    return added;
  }

  // ---------- sessions ----------
  function currentUser(req) {
    const tok = parseCookies(req)[COOKIE]; if (!tok) return null;
    const row = one(`SELECT u.id, u.username, u.name, u.role, u.must_change_password, u.active, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`, sha256(tok));
    if (!row || !row.active || row.expires_at < now()) return null;
    return { id: row.id, username: row.username, name: row.name, role: row.role, mustChangePassword: !!row.must_change_password };
  }
  function startSession(res, userId) {
    const tok = newToken();
    const exp = new Date(Date.now() + cfg.sessionDays * 864e5).toISOString().replace('T', ' ').slice(0, 19);
    run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(tok), userId, exp);
    run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), userId);
    if (Math.random() < 0.05) run('DELETE FROM sessions WHERE expires_at < ?', now());
    res.setHeader('Set-Cookie', `${COOKIE}=${tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${cfg.sessionDays * 86400}${cfg.cookieSecure ? '; Secure' : ''}`);
  }
  const need = (ctx, ...roles) => {
    if (!ctx.user) throw new HttpError(401, 'Please sign in.');
    if (roles.length && !roles.includes(ctx.user.role)) throw forbidden();
    return ctx.user;
  };
  const staff = ctx => need(ctx, 'admin', 'teacher');

  function createUser({ username, name, role, password, mustChange }) {
    const p = usernameProblem(username); if (p) throw bad(p);
    if (!str(name)) throw bad('Name is required.');
    const pp = passwordProblem(password); if (pp) throw bad(pp);
    if (one('SELECT 1 FROM users WHERE username = ?', username)) throw new HttpError(409, `The username "${username}" is already taken.`);
    const res = run('INSERT INTO users (username, name, role, password_hash, must_change_password) VALUES (?, ?, ?, ?, ?)', username, str(name, 120), role, hashPassword(password), mustChange ? 1 : 0);
    return Number(res.lastInsertRowid);
  }

  // ---------- permissions ----------
  function cohortForStaff(user, id) {
    const c = one('SELECT * FROM cohorts WHERE id = ?', id); if (!c) throw notFound('Class not found.');
    if (user.role !== 'admin' && !one(`SELECT 1 FROM cohort_members WHERE cohort_id = ? AND user_id = ? AND member_role = 'teacher'`, id, user.id)) throw forbidden('You are not a teacher of this class.');
    return c;
  }
  function studentCohortIds(userId) { return q(`SELECT c.id FROM cohort_members m JOIN cohorts c ON c.id = m.cohort_id WHERE m.user_id = ? AND c.archived = 0`, userId).map(x => x.id); }
  function heldBackCaseIds(cohortIds) {
    if (!cohortIds.length) return new Set();
    return new Set(q(`SELECT DISTINCT case_id FROM assignments WHERE archived = 0 AND mode = 'assessment' AND cohort_id IN (${cohortIds.map(() => '?').join(',')})`, ...cohortIds).map(x => x.case_id));
  }
  function practiceCases(userId) {
    const ids = studentCohortIds(userId); if (!ids.length) return [];
    const open = one(`SELECT 1 FROM cohorts WHERE archived = 0 AND open_practice = 1 AND id IN (${ids.map(() => '?').join(',')}) LIMIT 1`, ...ids);
    if (!open) return [];
    const held = heldBackCaseIds(ids);
    return q(`SELECT id, title, complaint, discipline, difficulty, current_version FROM cases WHERE status = 'published' ORDER BY complaint`).filter(c => !held.has(c.id));
  }
  function caseVersion(caseId, version) {
    const row = version ? one('SELECT data FROM case_versions WHERE case_id = ? AND version = ?', caseId, version)
      : one('SELECT v.data FROM cases c JOIN case_versions v ON v.case_id = c.id AND v.version = c.current_version WHERE c.id = ?', caseId);
    return row ? JSON.parse(row.data) : null;
  }
  const publicCase = c => { const x = { ...c }; delete x.title; return x; }; // diagnosis stays hidden until the debrief

  // =====================================================================
  // AUTH
  // =====================================================================
  r.get('/api/setup', () => ({ needsSetup: needsSetup() }));
  r.post('/api/setup', async ctx => {
    if (!needsSetup()) throw forbidden('Setup is already complete.');
    const b = await ctx.body();
    if (!setupCode || str(b.code).toUpperCase() !== setupCode) throw forbidden('The setup code is wrong. It is printed in the server console.');
    const id = createUser({ username: str(b.username, 64), name: b.name, role: 'admin', password: b.password });
    setupCode = null; startSession(ctx.res, id);
    return { ok: true };
  });
  r.post('/api/login', async ctx => {
    const b = await ctx.body(); const username = str(b.username, 64);
    const key = (ctx.req.socket.remoteAddress || '') + '|' + username.toLowerCase();
    if (!loginLimiter.hit(key)) throw new HttpError(429, 'Too many sign-in attempts. Wait 15 minutes and try again.');
    const u = one('SELECT * FROM users WHERE username = ?', username);
    if (!u || !verifyPassword(String(b.password || ''), u.password_hash)) throw new HttpError(401, 'Wrong username or password.');
    if (!u.active) throw forbidden('This account is disabled. Ask your teacher.');
    loginLimiter.reset(key); startSession(ctx.res, u.id);
    return { ok: true };
  });
  r.post('/api/logout', ctx => {
    const tok = parseCookies(ctx.req)[COOKIE]; if (tok) run('DELETE FROM sessions WHERE token_hash = ?', sha256(tok));
    ctx.res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    return { ok: true };
  });
  r.get('/api/me', ctx => ({ user: ctx.user, needsSetup: needsSetup() }));
  r.post('/api/me/password', async ctx => {
    const u = need(ctx); const b = await ctx.body();
    const row = one('SELECT password_hash FROM users WHERE id = ?', u.id);
    if (!verifyPassword(String(b.current || ''), row.password_hash)) throw bad('Your current password is wrong.');
    const p = passwordProblem(b.password); if (p) throw bad(p);
    run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', hashPassword(b.password), u.id);
    return { ok: true };
  });
  r.post('/api/join', async ctx => {
    const b = await ctx.body();
    if (!joinLimiter.hit(ctx.req.socket.remoteAddress || '')) throw new HttpError(429, 'Too many attempts. Try again later.');
    const c = one('SELECT * FROM cohorts WHERE join_code = ? AND archived = 0', str(b.code, 20).toUpperCase());
    if (!c) throw bad('That class code is not valid.');
    if (!c.enrol_open) throw forbidden('Enrolment for this class is closed. Ask your teacher.');
    let userId;
    if (ctx.user) { if (ctx.user.role !== 'student') throw bad('Teachers are added to classes from the class page.'); userId = ctx.user.id; }
    else { userId = createUser({ username: str(b.username, 64), name: b.name, role: 'student', password: b.password }); startSession(ctx.res, userId); }
    run(`INSERT OR IGNORE INTO cohort_members (cohort_id, user_id, member_role) VALUES (?, ?, 'student')`, c.id, userId);
    return { ok: true, cohort: c.name };
  });

  // =====================================================================
  // USERS (staff)
  // =====================================================================
  r.get('/api/users', ctx => {
    const u = staff(ctx); const s = ctx.url.searchParams;
    const role = s.get('role'); const term = '%' + str(s.get('q'), 60) + '%';
    const limit = Math.min(200, int(s.get('limit'), 50)), offset = Math.max(0, int(s.get('offset'), 0));
    const roles = u.role === 'admin' ? ['admin', 'teacher', 'student'] : ['student', 'teacher'];
    const wanted = role && roles.includes(role) ? [role] : roles;
    const where = `role IN (${wanted.map(() => '?').join(',')}) AND (username LIKE ? OR name LIKE ?)`;
    const total = one(`SELECT COUNT(*) n FROM users WHERE ${where}`, ...wanted, term, term).n;
    const rows = q(`SELECT id, username, name, role, active, must_change_password, created_at, last_login_at FROM users WHERE ${where} ORDER BY role, name LIMIT ? OFFSET ?`, ...wanted, term, term, limit, offset);
    return { total, users: rows };
  });
  r.post('/api/users', async ctx => {
    const u = staff(ctx); const b = await ctx.body();
    const role = b.role || 'student';
    if (!['student', 'teacher', 'admin'].includes(role)) throw bad('Unknown role.');
    if (role !== 'student' && u.role !== 'admin') throw forbidden('Only an administrator can create teacher accounts.');
    const password = b.password || tempPassword();
    const id = createUser({ username: str(b.username, 64), name: b.name, role, password, mustChange: !b.password });
    if (b.cohortId && role === 'student') { cohortForStaff(u, int(b.cohortId)); run(`INSERT OR IGNORE INTO cohort_members (cohort_id, user_id, member_role) VALUES (?, ?, 'student')`, int(b.cohortId), id); }
    return { id, username: b.username, password: b.password ? undefined : password };
  });
  r.patch('/api/users/:id', async ctx => {
    const u = staff(ctx); const b = await ctx.body(); const id = int(ctx.params.id);
    const t = one('SELECT * FROM users WHERE id = ?', id); if (!t) throw notFound('User not found.');
    if (t.role !== 'student' && u.role !== 'admin') throw forbidden('Only an administrator can change staff accounts.');
    if (b.name != null) run('UPDATE users SET name = ? WHERE id = ?', str(b.name, 120) || t.name, id);
    if (b.active != null) {
      if (id === u.id) throw bad('You cannot disable your own account.');
      run('UPDATE users SET active = ? WHERE id = ?', b.active ? 1 : 0, id);
      if (!b.active) run('DELETE FROM sessions WHERE user_id = ?', id);
    }
    if (b.role != null) {
      if (u.role !== 'admin') throw forbidden();
      if (!['student', 'teacher', 'admin'].includes(b.role)) throw bad('Unknown role.');
      if (id === u.id && b.role !== 'admin') throw bad('You cannot remove your own administrator role.');
      run('UPDATE users SET role = ? WHERE id = ?', b.role, id);
    }
    return { ok: true };
  });
  r.post('/api/users/:id/reset-password', ctx => {
    const u = staff(ctx); const id = int(ctx.params.id);
    const t = one('SELECT * FROM users WHERE id = ?', id); if (!t) throw notFound('User not found.');
    if (t.role !== 'student' && u.role !== 'admin') throw forbidden('Only an administrator can reset staff passwords.');
    const pw = tempPassword();
    run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', hashPassword(pw), id);
    run('DELETE FROM sessions WHERE user_id = ?', id);
    return { username: t.username, password: pw };
  });

  // =====================================================================
  // CLASSES (cohorts)
  // =====================================================================
  r.get('/api/cohorts', ctx => {
    const u = staff(ctx);
    const base = `SELECT c.*, (SELECT COUNT(*) FROM cohort_members m WHERE m.cohort_id = c.id AND m.member_role = 'student') students,
      (SELECT COUNT(*) FROM assignments a WHERE a.cohort_id = c.id AND a.archived = 0) assignments FROM cohorts c`;
    const rows = u.role === 'admin' ? q(`${base} ORDER BY c.archived, c.created_at DESC`)
      : q(`${base} JOIN cohort_members t ON t.cohort_id = c.id AND t.user_id = ? AND t.member_role = 'teacher' ORDER BY c.archived, c.created_at DESC`, u.id);
    return { cohorts: rows };
  });
  r.post('/api/cohorts', async ctx => {
    const u = staff(ctx); const b = await ctx.body();
    const name = str(b.name, 120); if (!name) throw bad('Give the class a name.');
    let code; do { code = joinCode(); } while (one('SELECT 1 FROM cohorts WHERE join_code = ?', code));
    const id = tx(db, () => {
      const id = Number(run('INSERT INTO cohorts (name, join_code, created_by) VALUES (?, ?, ?)', name, code, u.id).lastInsertRowid);
      run(`INSERT INTO cohort_members (cohort_id, user_id, member_role) VALUES (?, ?, 'teacher')`, id, u.id);
      return id;
    });
    return { id, joinCode: code };
  });
  r.get('/api/cohorts/:id', ctx => {
    const u = staff(ctx); const c = cohortForStaff(u, int(ctx.params.id));
    const members = q(`SELECT u.id, u.username, u.name, u.role, u.active, u.last_login_at, m.member_role,
        (SELECT COUNT(*) FROM attempts a WHERE a.user_id = u.id AND a.finished_at IS NOT NULL) attempts,
        (SELECT ROUND(AVG(a.score)) FROM attempts a WHERE a.user_id = u.id AND a.finished_at IS NOT NULL) avg_score
      FROM cohort_members m JOIN users u ON u.id = m.user_id WHERE m.cohort_id = ? ORDER BY m.member_role DESC, u.name`, c.id);
    const assignments = q(`SELECT a.*, cs.complaint, cs.title case_title,
        (SELECT COUNT(DISTINCT t.user_id) FROM attempts t WHERE t.assignment_id = a.id AND t.finished_at IS NOT NULL) completed,
        (SELECT ROUND(AVG(t.score)) FROM attempts t WHERE t.assignment_id = a.id AND t.finished_at IS NOT NULL) avg_score
      FROM assignments a JOIN cases cs ON cs.id = a.case_id WHERE a.cohort_id = ? ORDER BY a.archived, a.created_at DESC`, c.id);
    return { cohort: c, members, assignments };
  });
  r.patch('/api/cohorts/:id', async ctx => {
    const u = staff(ctx); const c = cohortForStaff(u, int(ctx.params.id)); const b = await ctx.body();
    if (b.name != null) run('UPDATE cohorts SET name = ? WHERE id = ?', str(b.name, 120) || c.name, c.id);
    for (const [k, col] of [['enrolOpen', 'enrol_open'], ['openPractice', 'open_practice'], ['archived', 'archived']]) if (b[k] != null) run(`UPDATE cohorts SET ${col} = ? WHERE id = ?`, b[k] ? 1 : 0, c.id);
    if (b.newCode) { let code; do { code = joinCode(); } while (one('SELECT 1 FROM cohorts WHERE join_code = ?', code)); run('UPDATE cohorts SET join_code = ? WHERE id = ?', code, c.id); }
    return { ok: true };
  });
  r.post('/api/cohorts/:id/members', async ctx => {
    const u = staff(ctx); const c = cohortForStaff(u, int(ctx.params.id)); const b = await ctx.body();
    const t = one('SELECT * FROM users WHERE username = ?', str(b.username, 64)); if (!t) throw notFound('No user with that username.');
    const role = t.role === 'student' ? 'student' : 'teacher';
    run('INSERT OR IGNORE INTO cohort_members (cohort_id, user_id, member_role) VALUES (?, ?, ?)', c.id, t.id, role);
    return { ok: true };
  });
  r.delete('/api/cohorts/:id/members/:userId', ctx => {
    const u = staff(ctx); const c = cohortForStaff(u, int(ctx.params.id));
    if (int(ctx.params.userId) === u.id) throw bad('You cannot remove yourself from the class.');
    run('DELETE FROM cohort_members WHERE cohort_id = ? AND user_id = ?', c.id, int(ctx.params.userId));
    return { ok: true };
  });
  // Bulk import: CSV with columns name, username [, password]. Returns the generated credentials.
  r.post('/api/cohorts/:id/import', async ctx => {
    const u = staff(ctx); const c = cohortForStaff(u, int(ctx.params.id)); const b = await ctx.body();
    const rows = parseCsv(b.csv || '');
    if (!rows.length) throw bad('The file is empty.');
    let start = 0; const head = rows[0].map(x => x.toLowerCase());
    let iName = 0, iUser = 1, iPw = 2;
    if (head.some(h => /name|user|roll|login/.test(h))) {
      start = 1;
      iName = head.findIndex(h => /^(full ?)?name$|student/.test(h)); iUser = head.findIndex(h => /user|roll|login|id/.test(h)); iPw = head.findIndex(h => /pass/.test(h));
      if (iName < 0 || iUser < 0) throw bad('The header row needs a "name" column and a "username" (or roll number) column.');
    }
    if (rows.length - start > 5000) throw bad('Import at most 5000 students at a time.');
    const created = [], existing = [], errors = [];
    tx(db, () => {
      for (let i = start; i < rows.length; i++) {
        const row = rows[i]; const name = row[iName], username = row[iUser], pw = iPw >= 0 ? row[iPw] : '';
        const line = i + 1;
        if (!username || !name) { errors.push({ line, error: 'Missing name or username.' }); continue; }
        const ex = one('SELECT id, role FROM users WHERE username = ?', username);
        if (ex) {
          if (ex.role !== 'student') { errors.push({ line, username, error: 'Username belongs to a staff account.' }); continue; }
          run(`INSERT OR IGNORE INTO cohort_members (cohort_id, user_id, member_role) VALUES (?, ?, 'student')`, c.id, ex.id);
          existing.push({ username, name }); continue;
        }
        const up = usernameProblem(username); if (up) { errors.push({ line, username, error: up }); continue; }
        const password = pw && !passwordProblem(pw) ? pw : tempPassword();
        const id = Number(run('INSERT INTO users (username, name, role, password_hash, must_change_password) VALUES (?, ?, ?, ?, 1)', username, name.slice(0, 120), 'student', hashPassword(password)).lastInsertRowid);
        run(`INSERT INTO cohort_members (cohort_id, user_id, member_role) VALUES (?, ?, 'student')`, c.id, id);
        created.push({ name, username, password });
      }
    });
    return { created, existing, errors };
  });

  // =====================================================================
  // CASES
  // =====================================================================
  r.get('/api/cases', ctx => {
    const u = need(ctx);
    if (!isStaff(u)) return { cases: practiceCases(u.id) };
    const status = ctx.url.searchParams.get('status');
    const rows = q(`SELECT c.id, c.status, c.current_version, c.title, c.complaint, c.discipline, c.difficulty, c.builtin, c.reviewed_by, c.reviewed_at, c.updated_at,
        u.name author, (SELECT COUNT(*) FROM attempts a WHERE a.case_id = c.id AND a.finished_at IS NOT NULL) attempts
      FROM cases c LEFT JOIN users u ON u.id = c.author_id ${status ? 'WHERE c.status = ?' : `WHERE c.status != 'archived'`} ORDER BY c.status DESC, c.complaint`, ...(status ? [status] : []));
    return { cases: rows };
  });
  r.get('/api/cases/:id', ctx => {
    const u = staff(ctx);
    const c = one('SELECT * FROM cases WHERE id = ?', ctx.params.id); if (!c) throw notFound('Case not found.');
    const versions = q(`SELECT v.version, v.note, v.saved_at, u.name saved_by FROM case_versions v LEFT JOIN users u ON u.id = v.saved_by WHERE v.case_id = ? ORDER BY v.version DESC`, c.id);
    const v = int(ctx.url.searchParams.get('version'), 0);
    return { meta: c, versions, data: caseVersion(c.id, v || null) };
  });
  r.post('/api/cases', async ctx => {
    const u = staff(ctx); const b = await ctx.body();
    const data = normalizeCase(b.data || {}); const errs = validateCase(data);
    if (errs.length) throw Object.assign(bad('The case has problems.'), { details: errs });
    if (one('SELECT 1 FROM cases WHERE id = ?', data.id)) throw new HttpError(409, `A case with id "${data.id}" already exists. Choose another id.`);
    tx(db, () => {
      run(`INSERT INTO cases (id, status, current_version, title, complaint, discipline, difficulty, author_id) VALUES (?, 'draft', 1, ?, ?, ?, ?, ?)`, data.id, data.title, data.card.complaint, data.card.discipline || null, data.card.difficulty || null, u.id);
      run('INSERT INTO case_versions (case_id, version, data, note, saved_by) VALUES (?, 1, ?, ?, ?)', data.id, JSON.stringify(data), str(b.note, 300) || 'Created', u.id);
    });
    return { id: data.id, version: 1 };
  });
  r.put('/api/cases/:id', async ctx => {
    const u = staff(ctx); const b = await ctx.body();
    const c = one('SELECT * FROM cases WHERE id = ?', ctx.params.id); if (!c) throw notFound('Case not found.');
    const data = normalizeCase(b.data || {}); data.id = c.id;
    const errs = validateCase(data); if (errs.length) throw Object.assign(bad('The case has problems.'), { details: errs });
    if (b.baseVersion && int(b.baseVersion) !== c.current_version) throw new HttpError(409, `Someone saved version ${c.current_version} after you opened this case. Reload to see their changes before saving.`);
    const v = c.current_version + 1;
    tx(db, () => {
      run('INSERT INTO case_versions (case_id, version, data, note, saved_by) VALUES (?, ?, ?, ?, ?)', c.id, v, JSON.stringify(data), str(b.note, 300) || null, u.id);
      run(`UPDATE cases SET current_version = ?, title = ?, complaint = ?, discipline = ?, difficulty = ?, updated_at = datetime('now'), reviewed_by = NULL, reviewed_at = NULL WHERE id = ?`, v, data.title, data.card.complaint, data.card.discipline || null, data.card.difficulty || null, c.id);
    });
    return { id: c.id, version: v };
  });
  r.patch('/api/cases/:id', async ctx => {
    const u = staff(ctx); const b = await ctx.body();
    const c = one('SELECT * FROM cases WHERE id = ?', ctx.params.id); if (!c) throw notFound('Case not found.');
    if (b.status != null) {
      if (!['draft', 'published', 'archived'].includes(b.status)) throw bad('Unknown status.');
      if (b.status === 'published') { const errs = validateCase(caseVersion(c.id)); if (errs.length) throw Object.assign(bad('Fix the problems before publishing.'), { details: errs }); }
      run(`UPDATE cases SET status = ?, updated_at = datetime('now') WHERE id = ?`, b.status, c.id);
    }
    if (b.reviewed) run(`UPDATE cases SET reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`, str(b.reviewedBy, 120) || u.name, c.id);
    if (b.restoreVersion) {
      const data = caseVersion(c.id, int(b.restoreVersion)); if (!data) throw notFound('Version not found.');
      const v = c.current_version + 1;
      tx(db, () => {
        run('INSERT INTO case_versions (case_id, version, data, note, saved_by) VALUES (?, ?, ?, ?, ?)', c.id, v, JSON.stringify(data), `Restored version ${int(b.restoreVersion)}`, u.id);
        run(`UPDATE cases SET current_version = ?, title = ?, complaint = ?, updated_at = datetime('now') WHERE id = ?`, v, data.title, data.card.complaint, c.id);
      });
    }
    return { ok: true };
  });

  // =====================================================================
  // ASSIGNMENTS
  // =====================================================================
  r.post('/api/assignments', async ctx => {
    const u = staff(ctx); const b = await ctx.body();
    const c = cohortForStaff(u, int(b.cohortId));
    const cs = one('SELECT * FROM cases WHERE id = ?', str(b.caseId, 80)); if (!cs) throw notFound('Case not found.');
    if (cs.status !== 'published') throw bad('Publish the case before assigning it.');
    const mode = b.mode === 'assessment' ? 'assessment' : 'practice';
    const due = b.dueAt ? str(b.dueAt, 30).replace('T', ' ') : null;
    const maxA = b.maxAttempts ? Math.max(1, int(b.maxAttempts, 1)) : (mode === 'assessment' ? 1 : null);
    const id = Number(run('INSERT INTO assignments (cohort_id, case_id, title, mode, due_at, max_attempts, show_debrief, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      c.id, cs.id, str(b.title, 120) || null, mode, due, maxA, b.showDebrief === false ? 0 : 1, u.id).lastInsertRowid);
    return { id };
  });
  r.patch('/api/assignments/:id', async ctx => {
    const u = staff(ctx); const b = await ctx.body();
    const a = one('SELECT * FROM assignments WHERE id = ?', int(ctx.params.id)); if (!a) throw notFound('Assignment not found.');
    cohortForStaff(u, a.cohort_id);
    if (b.archived != null) run('UPDATE assignments SET archived = ? WHERE id = ?', b.archived ? 1 : 0, a.id);
    if (b.dueAt !== undefined) run('UPDATE assignments SET due_at = ? WHERE id = ?', b.dueAt ? str(b.dueAt, 30).replace('T', ' ') : null, a.id);
    if (b.maxAttempts !== undefined) run('UPDATE assignments SET max_attempts = ? WHERE id = ?', b.maxAttempts ? Math.max(1, int(b.maxAttempts, 1)) : null, a.id);
    if (b.showDebrief != null) run('UPDATE assignments SET show_debrief = ? WHERE id = ?', b.showDebrief ? 1 : 0, a.id);
    return { ok: true };
  });

  // =====================================================================
  // STUDENT HOME
  // =====================================================================
  r.get('/api/student/home', ctx => {
    const u = need(ctx);
    const cohorts = q(`SELECT c.id, c.name FROM cohort_members m JOIN cohorts c ON c.id = m.cohort_id WHERE m.user_id = ? AND c.archived = 0 ORDER BY c.name`, u.id);
    const ids = cohorts.map(c => c.id);
    const assignments = ids.length ? q(`SELECT a.id, a.cohort_id, a.case_id, a.title, a.mode, a.due_at, a.max_attempts, a.show_debrief, cs.complaint, cs.discipline, cs.difficulty, co.name cohort,
        (SELECT COUNT(*) FROM attempts t WHERE t.assignment_id = a.id AND t.user_id = ?) used,
        (SELECT MAX(score) FROM attempts t WHERE t.assignment_id = a.id AND t.user_id = ? AND t.finished_at IS NOT NULL) best
      FROM assignments a JOIN cases cs ON cs.id = a.case_id JOIN cohorts co ON co.id = a.cohort_id
      WHERE a.archived = 0 AND cs.status = 'published' AND a.cohort_id IN (${ids.map(() => '?').join(',')}) ORDER BY (a.due_at IS NULL), a.due_at, a.created_at DESC`, u.id, u.id, ...ids) : [];
    const recent = q(`SELECT a.id, a.case_id, a.assignment_id, a.started_at, a.finished_at, a.score, a.passed, a.outcome, a.sim_seconds, cs.complaint
      FROM attempts a JOIN cases cs ON cs.id = a.case_id WHERE a.user_id = ? ORDER BY a.started_at DESC LIMIT 20`, u.id);
    return { cohorts, assignments, practice: practiceCases(u.id), recent };
  });

  // =====================================================================
  // ATTEMPTS
  // =====================================================================
  r.post('/api/attempts', async ctx => {
    const u = need(ctx); const b = await ctx.body();
    let caseId = str(b.caseId, 80), assignment = null;
    if (b.assignmentId) {
      assignment = one('SELECT * FROM assignments WHERE id = ? AND archived = 0', int(b.assignmentId));
      if (!assignment) throw notFound('Assignment not found.');
      if (!isStaff(u) && !one('SELECT 1 FROM cohort_members WHERE cohort_id = ? AND user_id = ?', assignment.cohort_id, u.id)) throw forbidden('This assignment is not for your class.');
      if (assignment.due_at && assignment.mode === 'assessment' && assignment.due_at < now()) throw forbidden('This assessment has closed.');
      if (assignment.max_attempts && !isStaff(u)) {
        const used = one('SELECT COUNT(*) n FROM attempts WHERE assignment_id = ? AND user_id = ?', assignment.id, u.id).n;
        if (used >= assignment.max_attempts) throw forbidden(`You have used all ${assignment.max_attempts} attempt(s) for this assignment.`);
      }
      caseId = assignment.case_id;
    } else if (!isStaff(u) && !practiceCases(u.id).some(c => c.id === caseId)) throw forbidden('This case is not available for practice.');
    const cs = one('SELECT * FROM cases WHERE id = ?', caseId); if (!cs) throw notFound('Case not found.');
    if (cs.status !== 'published' && !isStaff(u)) throw forbidden('This case is not published.');
    const data = caseVersion(cs.id);
    const id = Number(run('INSERT INTO attempts (user_id, case_id, case_version, assignment_id) VALUES (?, ?, ?, ?)', u.id, cs.id, cs.current_version, assignment ? assignment.id : null).lastInsertRowid);
    return { attemptId: id, case: publicCase(data), mode: assignment ? assignment.mode : 'practice' };
  });
  r.post('/api/attempts/:id/finish', async ctx => {
    const u = need(ctx); const b = await ctx.body();
    const a = one('SELECT * FROM attempts WHERE id = ?', int(ctx.params.id));
    if (!a || a.user_id !== u.id) throw notFound('Attempt not found.');
    if (a.finished_at) throw new HttpError(409, 'This attempt has already been submitted.');
    const rec = b.record || {};
    const c = normalizeCase(caseVersion(a.case_id, a.case_version));
    const record = {
      t: Math.max(0, Number(rec.t) || 0),
      timeline: (Array.isArray(rec.timeline) ? rec.timeline : []).slice(0, 2000).map(x => ({ t: Number(x.t) || 0, id: str(x.id, 80), label: str(x.label, 300), kind: str(x.kind, 20) })),
      penalties: (Array.isArray(rec.penalties) ? rec.penalties : []).slice(0, 100),
      notes: (Array.isArray(rec.notes) ? rec.notes : []).slice(0, 100).map(n => ({ id: str(n.id, 80), label: str(n.label, 300), text: str(n.text, 2000) })),
      vlog: (Array.isArray(rec.vlog) ? rec.vlog : []).slice(0, 5000).map(p => ({ t: Number(p.t) || 0, hr: p.hr == null ? null : Number(p.hr), sbp: p.sbp == null ? null : Number(p.sbp), spo2: p.spo2 == null ? null : Number(p.spo2) })),
      arrestBands: (Array.isArray(rec.arrestBands) ? rec.arrestBands : []).slice(0, 20).map(x => ({ start: Number(x.start) || 0, end: Number(x.end) || 0 })),
      dx: rec.dx ? str(rec.dx, 80) : null, disp: rec.disp ? str(rec.disp, 80) : null,
      died: !!rec.died, endedInArrest: !!rec.endedInArrest, arrests: int(rec.arrests, 0), finalSeverity: Number(rec.finalSeverity) || 0,
      endReason: str(rec.endReason, 20)
    };
    const R = evaluate(c, record);
    run(`UPDATE attempts SET finished_at = datetime('now'), score = ?, passed = ?, outcome = ?, sim_seconds = ?, end_reason = ?, summary = ?, details = ? WHERE id = ?`,
      R.pct, R.passed ? 1 : 0, R.outcome.label, Math.round(record.t), record.endReason, JSON.stringify(summarize(R, record)), JSON.stringify(record), a.id);
    return { ok: true, attemptId: a.id };
  });
  r.get('/api/attempts/:id', ctx => {
    const u = need(ctx);
    const a = one(`SELECT a.*, u.name student_name, u.username FROM attempts a JOIN users u ON u.id = a.user_id WHERE a.id = ?`, int(ctx.params.id));
    if (!a) throw notFound('Attempt not found.');
    let hideDetails = false;
    if (!isStaff(u)) {
      if (a.user_id !== u.id) throw notFound('Attempt not found.');
      if (a.assignment_id) {
        const asg = one('SELECT * FROM assignments WHERE id = ?', a.assignment_id);
        if (asg && !asg.show_debrief && (!asg.due_at || asg.due_at > now())) hideDetails = true;
      }
    } else if (u.role !== 'admin') {
      const shared = one(`SELECT 1 FROM cohort_members s JOIN cohort_members t ON t.cohort_id = s.cohort_id AND t.user_id = ? AND t.member_role = 'teacher' WHERE s.user_id = ? LIMIT 1`, u.id, a.user_id);
      if (!shared && a.user_id !== u.id) throw forbidden('This student is not in any of your classes.');
    }
    if (!a.finished_at) return { attempt: { id: a.id, case_id: a.case_id, started_at: a.started_at, finished: false } };
    const out = { id: a.id, case_id: a.case_id, case_version: a.case_version, assignment_id: a.assignment_id, started_at: a.started_at, finished_at: a.finished_at, score: a.score, passed: !!a.passed, outcome: a.outcome, sim_seconds: a.sim_seconds, student: { name: a.student_name, username: a.username }, finished: true };
    if (hideDetails) return { attempt: out, hidden: true };
    return { attempt: out, record: JSON.parse(a.details || '{}'), case: caseVersion(a.case_id, a.case_version) };
  });
  r.get('/api/attempts', ctx => {
    const u = need(ctx); const s = ctx.url.searchParams;
    const userId = isStaff(u) && s.get('userId') ? int(s.get('userId')) : u.id;
    if (isStaff(u) && userId !== u.id && u.role !== 'admin') {
      const shared = one(`SELECT 1 FROM cohort_members s JOIN cohort_members t ON t.cohort_id = s.cohort_id AND t.user_id = ? AND t.member_role = 'teacher' WHERE s.user_id = ? LIMIT 1`, u.id, userId);
      if (!shared) throw forbidden('This student is not in any of your classes.');
    }
    const student = one('SELECT id, name, username FROM users WHERE id = ?', userId);
    const attempts = q(`SELECT a.id, a.case_id, a.assignment_id, a.started_at, a.finished_at, a.score, a.passed, a.outcome, a.sim_seconds, cs.complaint, cs.title
      FROM attempts a JOIN cases cs ON cs.id = a.case_id WHERE a.user_id = ? ORDER BY a.started_at DESC LIMIT 500`, userId)
      .map(x => isStaff(u) ? x : { ...x, title: undefined });
    return { student, attempts };
  });

  // =====================================================================
  // ANALYTICS & EXPORT
  // =====================================================================
  function assignmentStats(asgId, u) {
    const a = one(`SELECT a.*, co.name cohort FROM assignments a JOIN cohorts co ON co.id = a.cohort_id WHERE a.id = ?`, asgId);
    if (!a) throw notFound('Assignment not found.');
    cohortForStaff(u, a.cohort_id);
    const c = normalizeCase(caseVersion(a.case_id));
    const students = q(`SELECT u.id, u.name, u.username FROM cohort_members m JOIN users u ON u.id = m.user_id WHERE m.cohort_id = ? AND m.member_role = 'student' ORDER BY u.name`, a.cohort_id);
    const rows = q(`SELECT id, user_id, score, passed, outcome, sim_seconds, finished_at, summary FROM attempts WHERE assignment_id = ? AND finished_at IS NOT NULL ORDER BY finished_at`, a.id);
    const byStudent = new Map();
    for (const r of rows) { const l = byStudent.get(r.user_id) || []; l.push(r); byStudent.set(r.user_id, l); }
    const firsts = [...byStudent.values()].map(l => l[0]);                   // first attempts reflect unprompted performance
    const bests = [...byStudent.values()].map(l => l.reduce((m, x) => x.score > m.score ? x : m, l[0]));
    const scores = bests.map(x => x.score).sort((x, y) => x - y);
    const median = scores.length ? (scores.length % 2 ? scores[(scores.length - 1) / 2] : Math.round((scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2)) : null;
    const hist = Array.from({ length: 10 }, (_, i) => ({ from: i * 10, to: i * 10 + 10, n: 0 }));
    for (const s of scores) hist[Math.min(9, Math.floor(s / 10))].n++;
    const sums = firsts.map(x => JSON.parse(x.summary || '{}'));
    const critStats = c.scoring.critical.map(it => {
      const st = sums.map(s => (s.crit || []).find(x => x.id === it.id)).filter(Boolean);
      const times = st.filter(x => x.t != null).map(x => x.t).sort((a, b) => a - b);
      return { id: it.id, label: it.label, within: it.within ?? null, done: st.filter(x => x.s === 'done').length, late: st.filter(x => x.s === 'late').length, missed: st.filter(x => x.s === 'missed').length, medianTime: times.length ? times[Math.floor(times.length / 2)] : null };
    });
    const recStats = c.scoring.recommended.map(it => {
      const st = sums.map(s => (s.rec || []).find(x => x.id === it.id)).filter(Boolean);
      return { id: it.id, label: it.label, done: st.filter(x => x.s !== 'missed').length, missed: st.filter(x => x.s === 'missed').length };
    });
    const penCount = {};
    for (const s of sums) for (const k of s.pen || []) penCount[k] = (penCount[k] || 0) + 1;
    const penaltyLabel = k => {
      if (k.startsWith('harm:')) { const it = c.interventions.find(i => i.id === k.slice(5)); return it ? `Gave ${it.label}` : k; }
      if (k.startsWith('rule:')) { const r = c.scoring.penalties[int(k.slice(5), -1)]; return r ? r.why : k; }
      return ({ arrest: 'Patient went into cardiac arrest', death: 'Patient died', cpr_delay: 'CPR delayed > 1 min', shock_delay: 'First shock delayed > 2 min', cpr_pulse: 'CPR on a patient with a pulse', shock_pulse: 'Shock to a patient with a pulse', shock_nonshock: 'Shocked a non-shockable rhythm', adr_pulse: '1 mg IV adrenaline with a pulse', amio_wrong: 'Amiodarone not indicated' })[k] || k;
    };
    const penalties = Object.entries(penCount).map(([k, n]) => ({ key: k, label: penaltyLabel(k), n })).sort((x, y) => y.n - x.n);
    const dxCount = {};
    for (const s of sums) if (s.dx) dxCount[s.dx] = (dxCount[s.dx] || 0) + 1;
    const diagnoses = c.diagnoses.map(d => ({ id: d.id, label: d.label, correct: d.id === c.scoring.diagnosis.correct, n: dxCount[d.id] || 0 }));
    const perStudent = students.map(s => {
      const l = byStudent.get(s.id) || [];
      return { ...s, attempts: l.length, first: l[0] ? l[0].score : null, best: l.length ? Math.max(...l.map(x => x.score)) : null, passed: l.some(x => x.passed), lastAttemptId: l.length ? l[l.length - 1].id : null, lastAt: l.length ? l[l.length - 1].finished_at : null, outcome: l.length ? l[l.length - 1].outcome : null };
    });
    return {
      assignment: { ...a, complaint: c.card.complaint, caseTitle: c.title },
      totals: { students: students.length, completed: byStudent.size, attempts: rows.length, passed: bests.filter(x => x.passed).length, meanBest: scores.length ? Math.round(scores.reduce((s, x) => s + x, 0) / scores.length) : null, medianBest: median, meanFirst: firsts.length ? Math.round(firsts.reduce((s, x) => s + x.score, 0) / firsts.length) : null, died: firsts.filter(x => x.outcome === 'Patient died').length },
      histogram: hist, critical: critStats, recommended: recStats, penalties, diagnoses, perStudent
    };
  }
  r.get('/api/analytics/assignment/:id', ctx => assignmentStats(int(ctx.params.id), staff(ctx)));
  r.get('/api/export/assignment/:id', ctx => {
    const S = assignmentStats(int(ctx.params.id), staff(ctx));
    const rows = [['Name', 'Username', 'Attempts', 'First score', 'Best score', 'Passed', 'Last outcome', 'Last attempt']];
    for (const s of S.perStudent) rows.push([s.name, s.username, s.attempts, s.first ?? '', s.best ?? '', s.passed ? 'yes' : 'no', s.outcome || '', s.lastAt || '']);
    return { csv: toCsv(rows), filename: `assignment-${S.assignment.id}-${S.assignment.case_id}.csv` };
  });
  r.get('/api/export/cohort/:id', ctx => {
    const u = staff(ctx); const c = cohortForStaff(u, int(ctx.params.id));
    const rows = [['Name', 'Username', 'Case', 'Assignment', 'Mode', 'Started', 'Finished', 'Score', 'Passed', 'Outcome', 'Sim time (s)']];
    for (const x of q(`SELECT u.name, u.username, cs.complaint, a.assignment_id, asg.mode, a.started_at, a.finished_at, a.score, a.passed, a.outcome, a.sim_seconds
        FROM attempts a JOIN users u ON u.id = a.user_id JOIN cases cs ON cs.id = a.case_id LEFT JOIN assignments asg ON asg.id = a.assignment_id
        JOIN cohort_members m ON m.user_id = a.user_id AND m.cohort_id = ? AND m.member_role = 'student'
        WHERE a.assignment_id IS NULL OR asg.cohort_id = ? ORDER BY u.name, a.started_at`, c.id, c.id))
      rows.push([x.name, x.username, x.complaint, x.assignment_id ?? 'practice', x.mode || 'practice', x.started_at, x.finished_at || '', x.score ?? '', x.passed == null ? '' : x.passed ? 'yes' : 'no', x.outcome || '', x.sim_seconds ?? '']);
    return { csv: toCsv(rows), filename: `class-${c.id}-results.csv` };
  });
  r.get('/api/overview', ctx => {
    const u = staff(ctx);
    const cohorts = u.role === 'admin' ? q('SELECT id FROM cohorts WHERE archived = 0') : q(`SELECT c.id FROM cohorts c JOIN cohort_members m ON m.cohort_id = c.id AND m.user_id = ? AND m.member_role = 'teacher' WHERE c.archived = 0`, u.id);
    const ids = cohorts.map(x => x.id); const ph = ids.map(() => '?').join(',') || 'NULL';
    return {
      classes: ids.length,
      students: ids.length ? one(`SELECT COUNT(DISTINCT user_id) n FROM cohort_members WHERE member_role = 'student' AND cohort_id IN (${ph})`, ...ids).n : 0,
      attempts7d: ids.length ? one(`SELECT COUNT(*) n FROM attempts a WHERE a.finished_at >= datetime('now','-7 days') AND a.user_id IN (SELECT user_id FROM cohort_members WHERE member_role = 'student' AND cohort_id IN (${ph}))`, ...ids).n : 0,
      cases: one(`SELECT COUNT(*) n FROM cases WHERE status = 'published'`).n,
      drafts: one(`SELECT COUNT(*) n FROM cases WHERE status = 'draft'`).n,
      upcoming: ids.length ? q(`SELECT a.id, a.mode, a.due_at, cs.complaint, co.name cohort, a.cohort_id FROM assignments a JOIN cases cs ON cs.id = a.case_id JOIN cohorts co ON co.id = a.cohort_id WHERE a.archived = 0 AND a.cohort_id IN (${ph}) ORDER BY (a.due_at IS NULL), a.due_at LIMIT 8`, ...ids) : []
    };
  });

  // =====================================================================
  // REQUEST HANDLER
  // =====================================================================
  const staticRoots = [{ prefix: '/shared/', dir: path.join(ROOT, 'shared') }, { prefix: '/', dir: path.join(ROOT, 'public') }];
  const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  };

  async function handle(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (pathname.startsWith('/api/')) {
      // CSRF: state-changing requests must be JSON from our own origin (SameSite=Strict cookie does the rest)
      if (req.method !== 'GET' && req.headers.origin && req.headers.host && new URL(req.headers.origin).host !== req.headers.host) return send(res, 403, { error: 'Cross-site request refused.' });
      const m = router.match(req.method, pathname);
      if (!m) return send(res, 404, { error: 'Unknown API endpoint.' });
      const ctx = { req, res, url, params: m.params, user: null, body: () => readJson(req) };
      try {
        ctx.user = currentUser(req);
        if (ctx.user && ctx.user.mustChangePassword && !['/api/me', '/api/me/password', '/api/logout'].includes(pathname)) throw new HttpError(428, 'Set a new password before continuing.');
        const out = await m.handler(ctx);
        if (!res.headersSent) send(res, 200, out ?? { ok: true });
      } catch (e) {
        if (e instanceof HttpError) return send(res, e.status, { error: e.message, details: e.details });
        if (String(e.message).includes('UNIQUE constraint')) return send(res, 409, { error: 'That already exists.' });
        console.error(e);
        send(res, 500, { error: 'Something went wrong on the server.' });
      }
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    if (serveStatic(req, res, pathname, staticRoots)) return;
    serveStatic(req, res, '/index.html', staticRoots) || send(res, 404, 'Not found');   // SPA fallback
  }
  const router = r;
  return { handle, seedCases, ensureSetupCode, needsSetup, createUser };
}
