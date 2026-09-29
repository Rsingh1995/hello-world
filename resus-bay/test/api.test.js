import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { blankCase } from '../shared/case-schema.js';

let server, base, app;
before(async () => {
  const db = openDb(':memory:');
  app = createApp({ db, config: { setupCode: 'TESTCODE' } });
  app.seedCases(); app.ensureSetupCode();
  server = http.createServer((q, s) => app.handle(q, s));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

/** A tiny cookie-keeping client. */
function client() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };
}

const admin = client(), teacher = client(), stu = client(), stu2 = client(), anon = client();
let cohortId, joinCode, asgId, assessId;

test('first-time setup creates the administrator', async () => {
  assert.equal((await anon('GET', '/api/setup')).data.needsSetup, true);
  assert.equal((await admin('POST', '/api/setup', { code: 'WRONG', username: 'admin', name: 'Admin', password: 'password123' })).status, 403);
  assert.equal((await admin('POST', '/api/setup', { code: 'testcode', username: 'admin', name: 'Dr Admin', password: 'password123' })).status, 200);
  assert.equal((await admin('GET', '/api/me')).data.user.role, 'admin');
  assert.equal((await anon('POST', '/api/setup', { code: 'TESTCODE', username: 'x', name: 'x', password: 'password123' })).status, 403);
});

test('admin creates a teacher; teacher must change the temporary password', async () => {
  const r = await admin('POST', '/api/users', { username: 'teacher1', name: 'Dr Teacher', role: 'teacher' });
  assert.equal(r.status, 200); assert.ok(r.data.password);
  assert.equal((await teacher('POST', '/api/login', { username: 'teacher1', password: r.data.password })).status, 200);
  assert.equal((await teacher('GET', '/api/cohorts')).status, 428);
  assert.equal((await teacher('POST', '/api/me/password', { current: r.data.password, password: 'newpassword1' })).status, 200);
  assert.equal((await teacher('GET', '/api/cohorts')).status, 200);
});

test('built-in cases are seeded and published', async () => {
  const r = await teacher('GET', '/api/cases');
  assert.ok(r.data.cases.length >= 6);
  assert.ok(r.data.cases.every(c => c.status === 'published'));
});

test('teacher creates a class; students join by code and by CSV import', async () => {
  const r = await teacher('POST', '/api/cohorts', { name: 'MBBS 2026 Batch A' });
  cohortId = r.data.id; joinCode = r.data.joinCode;
  assert.match(joinCode, /^[A-Z0-9]{6}$/);
  assert.equal((await stu('POST', '/api/join', { code: 'NOPE00', username: 'roll001', name: 'Asha', password: 'studentpw1' })).status, 400);
  assert.equal((await stu('POST', '/api/join', { code: joinCode.toLowerCase(), username: 'roll001', name: 'Asha', password: 'studentpw1' })).status, 200);
  assert.equal((await stu2('POST', '/api/join', { code: joinCode, username: 'ROLL001', name: 'Dup', password: 'studentpw1' })).status, 409);
  const csv = 'Name,Roll number\nRavi Kumar,roll002\n"Singh, Meera",roll003\nAsha,roll001\n,bad\n';
  const imp = await teacher('POST', `/api/cohorts/${cohortId}/import`, { csv });
  assert.equal(imp.data.created.length, 2); assert.equal(imp.data.existing.length, 1); assert.equal(imp.data.errors.length, 1);
  assert.equal(imp.data.created[1].name, 'Singh, Meera');
  const login = await stu2('POST', '/api/login', { username: 'roll002', password: imp.data.created[0].password });
  assert.equal(login.status, 200);
  await stu2('POST', '/api/me/password', { current: imp.data.created[0].password, password: 'roll002pass' });
  const c = await teacher('GET', `/api/cohorts/${cohortId}`);
  assert.equal(c.data.members.filter(m => m.member_role === 'student').length, 3);
});

test('students cannot use staff endpoints', async () => {
  assert.equal((await stu('GET', '/api/users')).status, 403);
  assert.equal((await stu('GET', `/api/cohorts/${cohortId}`)).status, 403);
  assert.equal((await stu('POST', '/api/cases', { data: blankCase('x-case') })).status, 403);
  assert.equal((await anon('GET', '/api/student/home')).status, 401);
});

test('teacher creates, edits and publishes a case with version history', async () => {
  const bad = await teacher('POST', '/api/cases', { data: { id: 'Bad ID' } });
  assert.equal(bad.status, 400); assert.ok(bad.data.details.length > 3);
  const c = blankCase('teacher-case-1');
  assert.equal((await teacher('POST', '/api/cases', { data: c })).status, 200);
  c.card.complaint = 'Edited complaint';
  const put = await teacher('PUT', '/api/cases/teacher-case-1', { data: c, baseVersion: 1, note: 'Edited' });
  assert.equal(put.data.version, 2);
  assert.equal((await teacher('PUT', '/api/cases/teacher-case-1', { data: c, baseVersion: 1 })).status, 409);
  const got = await teacher('GET', '/api/cases/teacher-case-1');
  assert.equal(got.data.versions.length, 2); assert.equal(got.data.data.card.complaint, 'Edited complaint');
  assert.equal((await teacher('POST', '/api/assignments', { cohortId, caseId: 'teacher-case-1' })).status, 400); // draft
  assert.equal((await teacher('PATCH', '/api/cases/teacher-case-1', { status: 'published', reviewed: true })).status, 200);
});

test('assignments, attempts, server-side scoring and limits', async () => {
  asgId = (await teacher('POST', '/api/assignments', { cohortId, caseId: 'anaphylaxis-food', mode: 'practice' })).data.id;
  assessId = (await teacher('POST', '/api/assignments', { cohortId, caseId: 'tension-pneumothorax', mode: 'assessment', showDebrief: false })).data.id;
  const home = await stu('GET', '/api/student/home');
  assert.equal(home.data.assignments.length, 2);
  assert.ok(!home.data.practice.some(c => c.id === 'tension-pneumothorax'), 'assessment cases are held back from practice');
  assert.ok(home.data.practice.some(c => c.id === 'anaphylaxis-food'));
  assert.equal((await stu('POST', '/api/attempts', { caseId: 'tension-pneumothorax' })).status, 403);

  const start = await stu('POST', '/api/attempts', { assignmentId: asgId });
  assert.equal(start.status, 200); assert.equal(start.data.case.title, undefined, 'diagnosis hidden before the debrief');
  const record = {
    t: 400, dx: 'dx_anaph', disp: 'disp_obs', finalSeverity: 0.1, endReason: 'submitted',
    timeline: [{ t: 30, id: 'monitor' }, { t: 60, id: 'adr_im' }, { t: 90, id: 'o2' }, { t: 120, id: 'iv_access' }, { t: 150, id: 'fluid_bolus' }],
    penalties: [], vlog: [{ t: 0, hr: 128, sbp: 86, spo2: 91 }]
  };
  const fin = await stu('POST', `/api/attempts/${start.data.attemptId}/finish`, { record });
  assert.equal(fin.status, 200);
  assert.equal((await stu('POST', `/api/attempts/${start.data.attemptId}/finish`, { record })).status, 409);
  const att = await stu('GET', `/api/attempts/${start.data.attemptId}`);
  assert.equal(att.data.attempt.score, Math.round((30 + 10 + 10 + 5 + 4 + 15 + 10) / 105 * 100));
  assert.equal(att.data.case.title, 'Anaphylaxis (food-triggered)');

  // assessment: one attempt, debrief hidden
  const a1 = await stu('POST', '/api/attempts', { assignmentId: assessId });
  await stu('POST', `/api/attempts/${a1.data.attemptId}/finish`, { record: { t: 100, timeline: [{ t: 10, id: 'needle_r' }], dx: 'dx_tension', disp: 'disp_hdu', finalSeverity: 0.2 } });
  assert.equal((await stu('POST', '/api/attempts', { assignmentId: assessId })).status, 403);
  const hidden = await stu('GET', `/api/attempts/${a1.data.attemptId}`);
  assert.equal(hidden.data.hidden, true); assert.equal(hidden.data.record, undefined);
  assert.ok((await teacher('GET', `/api/attempts/${a1.data.attemptId}`)).data.record, 'teacher sees full details');

  // another student cannot read it
  assert.equal((await stu2('GET', `/api/attempts/${a1.data.attemptId}`)).status, 404);
});

test('class analytics and CSV export', async () => {
  const a = await teacher('GET', `/api/analytics/assignment/${asgId}`);
  assert.equal(a.status, 200);
  assert.equal(a.data.totals.students, 3); assert.equal(a.data.totals.completed, 1);
  const adr = a.data.critical.find(x => x.id === 'c_adr'); assert.equal(adr.done, 1); assert.equal(adr.medianTime, 60);
  assert.equal(a.data.diagnoses.find(d => d.correct).n, 1);
  const ex = await teacher('GET', `/api/export/cohort/${cohortId}`);
  assert.match(ex.data.csv, /roll001/);
  const other = client();
  const t2 = await admin('POST', '/api/users', { username: 'teacher2', name: 'Other', role: 'teacher', password: 'password222' });
  assert.equal(t2.status, 200);
  await other('POST', '/api/login', { username: 'teacher2', password: 'password222' });
  assert.equal((await other('GET', `/api/analytics/assignment/${asgId}`)).status, 403, 'teachers only see their own classes');
});

test('password reset and disabling accounts', async () => {
  const users = await teacher('GET', '/api/users?role=student&q=roll003');
  const id = users.data.users[0].id;
  const r = await teacher('POST', `/api/users/${id}/reset-password`);
  assert.ok(r.data.password);
  await teacher('PATCH', `/api/users/${id}`, { active: false });
  const c = client();
  assert.equal((await c('POST', '/api/login', { username: 'roll003', password: r.data.password })).status, 403);
  assert.equal((await teacher('PATCH', `/api/users/${users.data.users[0].id}`, { role: 'admin' })).status, 403);
});

test('static front end and security headers', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  const sh = await fetch(base + '/shared/case-schema.js'); assert.equal(sh.status, 200);
  const trav = await fetch(base + '/shared/../server/auth.js'); assert.notEqual(await trav.text(), '', 'traversal falls back to index, never server code');
  assert.doesNotMatch(await (await fetch(base + '/..%2fserver%2fauth.js')).text(), /scrypt/);
});
