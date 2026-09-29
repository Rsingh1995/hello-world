// Teacher and administrator pages: dashboard, classes, assignments, analytics, cases, people.
import { h, $, api, toast, showError, dateTime, dateOnly, fmt, pill, scorePill, modal, confirmButton, download, utc, toLocalInput, fromLocalInput } from './ui.js';
import { state, go, attemptsTable } from './app.js';
import { mountSim } from './sim.js';
import { renderDebrief } from './debrief.js';
import { validateCase, normalizeCase } from '/shared/case-schema.js';

const field = (label, control, note) => h('label', { class: 'field' }, h('span', { text: label }), control, note ? h('small', { text: note }) : null);
const check = (id, label, checked) => h('label', { class: 'check' }, h('input', { type: 'checkbox', id, checked }), h('span', { text: label }));
const reload = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
const tile = (v, k) => h('div', { class: 'tile' }, h('span', { class: 'v', text: v }), h('span', { class: 'k', text: k }));
const pct = (n, d) => d ? Math.round(n / d * 100) : 0;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.name, b.name) || collator.compare(a.username, b.username);

function credentialsBlock(list, title) {
  const csv = 'Name,Username,Temporary password\r\n' + list.map(x => [x.name, x.username, x.password].map(v => /[",]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')).join('\r\n');
  return h('div', { class: 'stack' },
    h('p', { class: 'msg ok', text: `${title}. Give each student their temporary password; they choose their own at first sign-in. These passwords are shown only once.` }),
    h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', type: 'button', text: 'Download credentials (CSV)', onclick: () => download('student-credentials.csv', '﻿' + csv) })),
    h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, h('th', { text: 'Name' }), h('th', { text: 'Username' }), h('th', { text: 'Temporary password' }))),
      h('tbody', null, list.slice(0, 200).map(x => h('tr', null, h('td', { text: x.name }), h('td', { class: 'num', text: x.username }), h('td', { class: 'num', text: x.password })))))),
    list.length > 200 ? h('p', { class: 'hint', text: `Showing 200 of ${list.length}. Download the CSV for the full list.` }) : null);
}

// ================================================================== DASHBOARD
export async function dashboard(root) {
  const d = await api('GET', '/overview');
  const page = h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', null, h('p', { class: 'eyebrow', text: state.user.role === 'admin' ? 'Administrator' : 'Teacher' }), h('h1', { text: `Welcome, ${state.user.name}` })),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/new-case', text: 'New case' }), h('button', { class: 'btn btn-primary', type: 'button', text: 'New class', onclick: newClassDialog }))),
    h('div', { class: 'tiles' }, tile(d.classes, 'Active classes'), tile(d.students, 'Students'), tile(d.attempts7d, 'Cases completed in the last 7 days'), tile(d.cases, 'Published cases'), tile(d.drafts, 'Draft cases')),
    h('h2', { text: 'Assignments' }),
    d.upcoming.length ? h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['Case', 'Class', 'Type', 'Due'].map(t => h('th', { text: t })))),
      h('tbody', null, d.upcoming.map(a => h('tr', { class: 'clickable', onclick: () => go('/assignment/' + a.id) }, h('td', { text: a.complaint }), h('td', { text: a.cohort }), h('td', null, a.mode === 'assessment' ? pill('Assessment', 'warn') : pill('Practice')), h('td', { class: 'num', text: a.due_at ? dateTime(a.due_at) : '—' }))))))
      : h('div', { class: 'empty-state' }, h('b', { text: 'No assignments yet.' }), h('span', { text: 'Create a class, share its code with students, then assign cases from the class page.' })),
    h('h2', { text: 'Getting started' }),
    h('ol', { class: 'prose', style: 'padding-left:1.2em;display:flex;flex-direction:column;gap:6px;max-width:80ch' },
      h('li', null, h('a', { href: '#/classes', text: 'Create a class' }), '. Students join with its 6-letter code, or you import a list of names and roll numbers (CSV).'),
      h('li', null, h('a', { href: '#/cases', text: 'Review the case library' }), '. Play each case in preview, edit it for your local guidelines, and mark it reviewed.'),
      h('li', null, 'Assign cases to a class as practice or as an assessment, with a due date and attempt limit.'),
      h('li', null, 'Follow progress on the assignment page: scores, missed critical actions, common errors, and every student’s debrief.')));
  root.replaceChildren(page);
}

function newClassDialog() {
  const msg = h('div', { hidden: true });
  const d = modal('New class', [field('Class name', h('input', { id: 'cName', type: 'text', placeholder: 'e.g. MBBS 2026, Batch A', required: true })), msg], [
    h('button', { class: 'btn', value: 'cancel', text: 'Cancel' }),
    h('button', { class: 'btn btn-primary', type: 'button', text: 'Create class', onclick: async () => {
      try { const r = await api('POST', '/cohorts', { name: $('#cName').value.trim() }); d.close(); toast('Class created.'); go('/class/' + r.id); } catch (e) { showError(e, msg); }
    } })]);
}

// ================================================================== CLASSES
export async function classesPage(root) {
  const d = await api('GET', '/cohorts');
  root.replaceChildren(h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', null, h('h1', { text: 'Classes' }), h('p', { class: 'sub', text: 'A class groups students (any number, from a small tutorial group to a whole batch) so you can assign cases and follow results.' })),
      h('button', { class: 'btn btn-primary', type: 'button', text: 'New class', onclick: newClassDialog })),
    d.cohorts.length ? h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Class', 'Join code', 'Students', 'Assignments', 'Enrolment', 'Created'].map(t => h('th', { text: t })))),
      h('tbody', null, d.cohorts.map(c => h('tr', { class: 'clickable', onclick: () => go('/class/' + c.id) },
        h('td', null, h('b', { text: c.name }), c.archived ? [' ', pill('Archived')] : null), h('td', null, h('span', { class: 'code-box', text: c.join_code })),
        h('td', { class: 'num', text: c.students }), h('td', { class: 'num', text: c.assignments }),
        h('td', null, c.enrol_open ? pill('Open', 'good') : pill('Closed')), h('td', { class: 'num', text: dateOnly(c.created_at) }))))))
      : h('div', { class: 'empty-state' }, h('b', { text: 'No classes yet.' }), h('button', { class: 'btn btn-primary', type: 'button', text: 'Create your first class', onclick: newClassDialog }))));
}

export async function classPage(root, { id }) {
  const d = await api('GET', '/cohorts/' + id);
  const c = d.cohort;
  const students = d.members.filter(m => m.member_role === 'student').sort(byName);
  const teachers = d.members.filter(m => m.member_role === 'teacher');
  const tabKey = 'classTab';
  let tab = sessionStorage.getItem(tabKey) || 'students';
  const patch = async body => { try { await api('PATCH', '/cohorts/' + c.id, body); reload(); } catch (e) { showError(e); } };
  const joinUrl = `${location.origin}/#/join?code=${c.join_code}`;

  const head = h('div', { class: 'page-head' },
    h('div', null, h('p', { class: 'eyebrow', text: 'Class' }), h('h1', { text: c.name }), c.archived ? pill('Archived') : null),
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', text: 'Rename', onclick: () => { const d2 = modal('Rename class', field('Class name', h('input', { id: 'rn', type: 'text', value: c.name })), [h('button', { class: 'btn', value: 'x', text: 'Cancel' }), h('button', { class: 'btn btn-primary', type: 'button', text: 'Save', onclick: async () => { d2.close(); await patch({ name: $('#rn').value }); } })]); } }),
      h('button', { class: 'btn', type: 'button', text: 'Export results (CSV)', onclick: async () => { try { const r = await api('GET', `/export/cohort/${c.id}`); download(r.filename, r.csv); } catch (e) { showError(e); } } }),
      c.archived ? h('button', { class: 'btn', type: 'button', text: 'Restore class', onclick: () => patch({ archived: false }) }) : confirmButton('Archive class', 'Confirm archive', () => patch({ archived: true }))));

  const codeCard = h('div', { class: 'card' },
    h('div', { class: 'row', style: 'justify-content:space-between;align-items:flex-start' },
      h('div', { class: 'stack', style: 'gap:6px' }, h('span', { class: 'lbl', text: 'Class code' }), h('span', { class: 'bigcode', text: c.join_code }),
        h('span', { class: 'hint' }, 'Students go to ', h('span', { class: 'mono', text: joinUrl }), ' or choose “Join your class” on the sign-in page.')),
      h('div', { class: 'stack', style: 'gap:8px' },
        h('button', { class: 'btn btn-sm', type: 'button', text: 'Copy join link', onclick: () => navigator.clipboard.writeText(joinUrl).then(() => toast('Join link copied.'), () => toast(joinUrl)) }),
        confirmButton('New code', 'Old code stops working', () => patch({ newCode: true }), 'btn btn-sm'))),
    h('div', { class: 'row', style: 'gap:18px' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!c.enrol_open, onchange: e => patch({ enrolOpen: e.target.checked }) }), h('span', { text: 'Students can join with the code' })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!c.open_practice, onchange: e => patch({ openPractice: e.target.checked }) }), h('span', { text: 'Open practice: students can play any published case (except those in assessments)' }))));

  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const panel = h('div', { class: 'tabpanel' });
  const TABS = { students: `Students (${students.length})`, assignments: `Assignments (${d.assignments.filter(a => !a.archived).length})`, teachers: `Teachers (${teachers.length})` };
  const show = t => {
    tab = t; sessionStorage.setItem(tabKey, t);
    for (const b of tabs.children) b.setAttribute('aria-selected', b.dataset.t === t);
    panel.replaceChildren(t === 'students' ? studentsTab(c, students) : t === 'assignments' ? assignmentsTab(c, d.assignments) : teachersTab(c, teachers));
  };
  for (const [k, v] of Object.entries(TABS)) tabs.append(h('button', { class: 'tab', role: 'tab', type: 'button', 'data-t': k, text: v, onclick: () => show(k) }));
  root.replaceChildren(h('div', { class: 'page' }, head, codeCard, h('div', { class: 'panel' }, tabs, panel)));
  show(TABS[tab] ? tab : 'students');
}

function studentsTab(c, students) {
  let filter = '';
  const body = h('tbody');
  const renderRows = () => {
    const f = filter.toLowerCase();
    const rows = students.filter(s => !f || s.name.toLowerCase().includes(f) || s.username.toLowerCase().includes(f));
    body.replaceChildren(...rows.slice(0, 500).map(s => h('tr', null,
      h('td', null, h('a', { href: '#/student/' + s.id, text: s.name }), s.active ? null : [' ', pill('Disabled')]),
      h('td', { class: 'num', text: s.username }), h('td', { class: 'num', text: s.attempts }), h('td', { class: 'num', text: s.avg_score != null ? s.avg_score + '%' : '—' }),
      h('td', { class: 'num', text: s.last_login_at ? dateOnly(s.last_login_at) : 'Never' }),
      h('td', null, h('div', { class: 'row', style: 'gap:4px' },
        h('button', { class: 'btn btn-sm', type: 'button', text: 'Reset password', onclick: async () => { try { const r = await api('POST', `/users/${s.id}/reset-password`); modal('Temporary password', credentialsBlock([{ name: s.name, username: r.username, password: r.password }], 'Password reset'), [h('button', { class: 'btn btn-primary', value: 'ok', text: 'Done' })]); } catch (e) { showError(e); } } }),
        confirmButton('Remove', 'Confirm remove', async () => { try { await api('DELETE', `/cohorts/${c.id}/members/${s.id}`); toast('Removed from class. Their results are kept.'); reload(); } catch (e) { showError(e); } }, 'btn btn-sm btn-danger'))))));
    if (rows.length > 500) body.append(h('tr', null, h('td', { colspan: 6, class: 'hint', text: `Showing 500 of ${rows.length}. Search to narrow the list.` })));
  };
  renderRows();
  return h('div', { class: 'stack' },
    h('div', { class: 'row', style: 'justify-content:space-between' },
      h('input', { type: 'search', placeholder: 'Search name or roll number', 'aria-label': 'Search students', style: 'max-width:320px', oninput: e => { filter = e.target.value; renderRows(); } }),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', text: 'Add one student', onclick: () => addStudentDialog(c) }), h('button', { class: 'btn btn-primary', type: 'button', text: 'Import students (CSV)', onclick: () => importDialog(c) }))),
    students.length ? h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['Name', 'Username', 'Attempts', 'Avg score', 'Last sign-in', ''].map(t => h('th', { text: t })))), body))
      : h('div', { class: 'empty-state' }, h('b', { text: 'No students yet.' }), h('span', { text: `Share the class code ${c.join_code}, or import a CSV list of names and roll numbers.` })));
}

function addStudentDialog(c) {
  const msg = h('div', { hidden: true });
  const d = modal('Add a student', [
    field('Full name', h('input', { id: 'sName', type: 'text', required: true })),
    field('Username (roll number)', h('input', { id: 'sUser', type: 'text', required: true })),
    h('p', { class: 'hint', text: 'A temporary password is generated. The student sets their own at first sign-in. If the username already exists, the student is added to this class instead.' }), msg], [
    h('button', { class: 'btn', value: 'x', text: 'Cancel' }),
    h('button', { class: 'btn btn-primary', type: 'button', text: 'Add student', onclick: async () => {
      const name = $('#sName').value.trim(), username = $('#sUser').value.trim();
      try {
        const r = await api('POST', '/users', { name, username, role: 'student', cohortId: c.id });
        d.close(); modal('Student added', credentialsBlock([{ name, username, password: r.password }], 'Account created'), [h('button', { class: 'btn btn-primary', value: 'ok', text: 'Done', onclick: reload })]);
      } catch (e) {
        if (e.status === 409) { try { await api('POST', `/cohorts/${c.id}/members`, { username }); d.close(); toast('Existing account added to this class.'); reload(); return; } catch (e2) { return showError(e2, msg); } }
        showError(e, msg);
      }
    } })]);
}

function importDialog(c) {
  const msg = h('div', { hidden: true });
  const ta = h('textarea', { id: 'csvText', class: 'code', style: 'min-height:180px', placeholder: 'Name,Roll number\nAsha Verma,MB26001\nRavi Kumar,MB26002' });
  const d = modal('Import students', [
    h('p', { class: 'hint', text: 'Paste a list, or choose a CSV file exported from a spreadsheet. Columns: name and username / roll number (optional third column: password). A header row is detected automatically. Up to 5000 students at a time.' }),
    h('input', { type: 'file', accept: '.csv,text/csv,.txt', onchange: async e => { const f = e.target.files[0]; if (f) ta.value = await f.text(); } }),
    ta, msg], [
    h('button', { class: 'btn', value: 'x', text: 'Cancel' }),
    h('button', { class: 'btn btn-primary', type: 'button', text: 'Import', onclick: async e => {
      e.target.disabled = true; e.target.textContent = 'Importing…';
      try {
        const r = await api('POST', `/cohorts/${c.id}/import`, { csv: ta.value });
        d.close();
        modal('Import complete', [
          h('p', { text: `${r.created.length} new account(s) created, ${r.existing.length} existing account(s) added to the class, ${r.errors.length} row(s) skipped.` }),
          r.errors.length ? h('div', { class: 'problems' }, h('b', { text: 'Skipped rows' }), h('ul', null, r.errors.slice(0, 50).map(x => h('li', { text: `Line ${x.line}${x.username ? ' (' + x.username + ')' : ''}: ${x.error}` })))) : null,
          r.created.length ? credentialsBlock(r.created, `${r.created.length} accounts created`) : null],
        [h('button', { class: 'btn btn-primary', value: 'ok', text: 'Done', onclick: reload })]);
      } catch (err) { e.target.disabled = false; e.target.textContent = 'Import'; showError(err, msg); }
    } })]);
}

function teachersTab(c, teachers) {
  const msg = h('div', { hidden: true });
  return h('div', { class: 'stack' },
    h('p', { class: 'hint', text: 'Co-teachers can manage this class, assign cases and see all results.' }),
    h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, h('th', { text: 'Name' }), h('th', { text: 'Username' }), h('th'))),
      h('tbody', null, teachers.map(t => h('tr', null, h('td', { text: t.name }), h('td', { class: 'num', text: t.username }),
        h('td', null, t.id === state.user.id ? h('span', { class: 'hint', text: 'You' }) : confirmButton('Remove', 'Confirm', async () => { await api('DELETE', `/cohorts/${c.id}/members/${t.id}`); reload(); }, 'btn btn-sm btn-danger'))))))),
    h('form', { class: 'row', onsubmit: async e => { e.preventDefault(); try { await api('POST', `/cohorts/${c.id}/members`, { username: $('#coT').value.trim() }); toast('Teacher added.'); reload(); } catch (err) { showError(err, msg); } } },
      h('input', { id: 'coT', type: 'text', placeholder: 'Teacher’s username', 'aria-label': 'Teacher username', style: 'max-width:260px', required: true }), h('button', { class: 'btn', type: 'submit', text: 'Add co-teacher' })), msg);
}

function assignmentsTab(c, list) {
  const active = list.filter(a => !a.archived), archived = list.filter(a => a.archived);
  const table = rows => h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, h('tr', null, ['Case', 'Type', 'Due', 'Attempts allowed', 'Completed', 'Average'].map(t => h('th', { text: t })))),
    h('tbody', null, rows.map(a => h('tr', { class: 'clickable', onclick: () => go('/assignment/' + a.id) },
      h('td', null, h('b', { text: a.title || a.complaint }), h('div', { class: 'hint', text: a.case_title })),
      h('td', null, a.mode === 'assessment' ? pill('Assessment', 'warn') : pill('Practice')),
      h('td', { class: 'num', text: a.due_at ? dateTime(a.due_at) : '—' }), h('td', { class: 'num', text: a.max_attempts || 'Unlimited' }),
      h('td', { class: 'num', text: a.completed }), h('td', { class: 'num', text: a.avg_score != null ? a.avg_score + '%' : '—' }))))));
  return h('div', { class: 'stack' },
    h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn btn-primary', type: 'button', text: 'Assign a case', onclick: () => assignDialog(c) })),
    active.length ? table(active) : h('p', { class: 'empty', text: 'No cases assigned yet.' }),
    archived.length ? h('details', null, h('summary', { text: `Archived (${archived.length})` }), table(archived)) : null);
}

async function assignDialog(c) {
  const cases = (await api('GET', '/cases?status=published')).cases;
  const msg = h('div', { hidden: true });
  const mode = h('select', { id: 'aMode' }, h('option', { value: 'practice', text: 'Practice: formative, debrief shown' }), h('option', { value: 'assessment', text: 'Assessment: held back from open practice' }));
  const maxA = h('input', { id: 'aMax', type: 'number', min: 1, placeholder: 'Unlimited' });
  const showDb = h('input', { type: 'checkbox', id: 'aShow', checked: true });
  mode.addEventListener('change', () => { if (mode.value === 'assessment') { maxA.value = maxA.value || 1; showDb.checked = false; } });
  const d = modal('Assign a case', [
    field('Case', h('select', { id: 'aCase' }, cases.map(x => h('option', { value: x.id, text: `${x.complaint} (${x.title})` })))),
    field('Title shown to students (optional)', h('input', { id: 'aTitle', type: 'text', placeholder: 'Uses the presenting complaint if blank' })),
    h('div', { class: 'form-grid' }, field('Type', mode), field('Due (optional)', h('input', { id: 'aDue', type: 'datetime-local' })), field('Attempts allowed', maxA)),
    h('label', { class: 'check' }, showDb, h('span', { text: 'Show the full debrief to students straight away (otherwise only the score, until the due date passes)' })),
    msg], [
    h('button', { class: 'btn', value: 'x', text: 'Cancel' }),
    h('button', { class: 'btn btn-primary', type: 'button', text: 'Assign', onclick: async () => {
      try {
        await api('POST', '/assignments', { cohortId: c.id, caseId: $('#aCase').value, title: $('#aTitle').value.trim(), mode: mode.value, dueAt: fromLocalInput($('#aDue').value), maxAttempts: maxA.value ? Number(maxA.value) : null, showDebrief: showDb.checked });
        d.close(); toast('Case assigned.'); reload();
      } catch (e) { showError(e, msg); }
    } })]);
}

// ================================================================== ASSIGNMENT ANALYTICS
export async function assignmentPage(root, { id }) {
  const d = await api('GET', '/analytics/assignment/' + id);
  const a = d.assignment, t = d.totals;
  const patch = async body => { try { await api('PATCH', '/assignments/' + a.id, body); toast('Saved.'); reload(); } catch (e) { showError(e); } };
  d.perStudent.sort(byName);
  const sf = { q: '', f: '' }; const studentBody = h('tbody');
  const n = d.critical.length ? d.critical[0].done + d.critical[0].late + d.critical[0].missed : 0;

  const settings = h('details', { class: 'card' }, h('summary', { text: 'Assignment settings' }),
    h('div', { class: 'form-grid', style: 'margin-top:10px' },
      field('Due', h('input', { id: 'eDue', type: 'datetime-local', value: toLocalInput(a.due_at) })),
      field('Attempts allowed', h('input', { id: 'eMax', type: 'number', min: 1, value: a.max_attempts || '', placeholder: 'Unlimited' }))),
    h('label', { class: 'check', style: 'margin-top:8px' }, h('input', { id: 'eShow', type: 'checkbox', checked: !!a.show_debrief }), h('span', { text: 'Show the full debrief to students straight away' })),
    h('div', { class: 'row', style: 'margin-top:10px' },
      h('button', { class: 'btn btn-primary', type: 'button', text: 'Save settings', onclick: () => patch({ dueAt: fromLocalInput($('#eDue').value), maxAttempts: $('#eMax').value ? Number($('#eMax').value) : null, showDebrief: $('#eShow').checked }) }),
      a.archived ? h('button', { class: 'btn', type: 'button', text: 'Restore', onclick: () => patch({ archived: false }) }) : confirmButton('Archive assignment', 'Confirm archive', () => patch({ archived: true }))));

  const critBars = h('div', { class: 'bars' },
    h('div', { class: 'legend' }, h('span', { style: '--c:var(--good)', text: 'On time' }), h('span', { style: '--c:var(--warn)', text: 'Late' }), h('span', { style: '--c:var(--crit)', text: 'Missed' })),
    d.critical.map(x => { const tot = x.done + x.late + x.missed; return h('div', { class: 'barrow' },
      h('div', null, h('div', { text: x.label }), h('div', { class: 'hint', text: `Median time ${x.medianTime != null ? fmt(x.medianTime) : '—'}${x.within != null ? ` · target ≤ ${fmt(x.within)}` : ''}` })),
      h('div', { class: 'stackbar', role: 'img', 'aria-label': `${x.done} on time, ${x.late} late, ${x.missed} missed` },
        x.done ? h('i', { class: 's-good', style: `width:${pct(x.done, tot)}%` }) : null, x.late ? h('i', { class: 's-warn', style: `width:${pct(x.late, tot)}%` }) : null, x.missed ? h('i', { class: 's-crit', style: `width:${pct(x.missed, tot)}%` }) : null),
      h('span', { class: 'mono', text: `${pct(x.done, tot)}%` })); }));
  const recBars = h('div', { class: 'bars' }, d.recommended.map(x => { const tot = x.done + x.missed; return h('div', { class: 'barrow' }, h('div', { text: x.label }),
    h('div', { class: 'stackbar' }, h('i', { class: 's-good', style: `width:${pct(x.done, tot)}%` })), h('span', { class: 'mono', text: `${pct(x.done, tot)}%` })); }));
  const maxH = Math.max(1, ...d.histogram.map(b => b.n));
  const hist = h('div', null, h('div', { class: 'hist', role: 'img', 'aria-label': 'Distribution of best scores' }, d.histogram.map(b => h('div', null, b.n ? h('b', { text: b.n }) : null, h('i', { style: `height:${b.n / maxH * 100}%` })))),
    h('div', { class: 'hist-x' }, d.histogram.map(b => h('span', { text: b.from }))));
  const dxMax = Math.max(1, ...d.diagnoses.map(x => x.n));

  root.replaceChildren(h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', null, h('p', { class: 'eyebrow' }, h('a', { href: '#/class/' + a.cohort_id, text: a.cohort }), ' · ', a.mode === 'assessment' ? 'Assessment' : 'Practice'),
        h('h1', { text: a.title || a.complaint }), h('p', { class: 'sub', text: `${a.caseTitle}${a.due_at ? ' · due ' + dateTime(a.due_at) : ''}${a.max_attempts ? ` · ${a.max_attempts} attempt(s) allowed` : ''}` })),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/preview/' + encodeURIComponent(a.case_id), text: 'Preview case' }),
        h('button', { class: 'btn', type: 'button', text: 'Export (CSV)', onclick: async () => { const r = await api('GET', `/export/assignment/${a.id}`); download(r.filename, r.csv); } }))),
    h('div', { class: 'tiles' }, tile(`${t.completed}/${t.students}`, 'Students completed'), tile(t.meanFirst != null ? t.meanFirst + '%' : '—', 'Average first-attempt score'), tile(t.medianBest != null ? t.medianBest + '%' : '—', 'Median best score'), tile(`${t.passed}`, 'Students passed'), tile(t.attempts, 'Total attempts'), tile(t.died, 'Patients died (first attempts)')),
    settings,
    t.completed ? h('div', { class: 'grid-2' },
      h('div', { class: 'card' }, h('h2', { text: 'Critical actions' }), h('p', { class: 'hint', text: `First attempts of ${n} student(s). This is where teaching is most needed.` }), critBars),
      h('div', { class: 'card' }, h('h2', { text: 'Score distribution' }), h('p', { class: 'hint', text: 'Best score per student, in 10-point bands.' }), hist),
      h('div', { class: 'card' }, h('h2', { text: 'Most common errors' }), d.penalties.length ? h('div', { class: 'bars' }, d.penalties.slice(0, 10).map(p => h('div', { class: 'barrow' }, h('div', { text: p.label }), h('div', { class: 'stackbar' }, h('i', { class: 's-crit', style: `width:${pct(p.n, n)}%` })), h('span', { class: 'mono', text: `${p.n}` })))) : h('p', { class: 'hint', text: 'No penalties recorded.' })),
      h('div', { class: 'card' }, h('h2', { text: 'Diagnoses chosen' }), h('div', { class: 'bars' }, d.diagnoses.map(x => h('div', { class: 'barrow' }, h('div', null, x.label, x.correct ? [' ', pill('Correct', 'good')] : null), h('div', null, h('div', { class: 'hbar', style: `width:${x.n / dxMax * 100}%;${x.correct ? '' : 'background:var(--line-strong)'}` })), h('span', { class: 'mono', text: x.n }))))),
      h('div', { class: 'card' }, h('h2', { text: 'Recommended actions' }), recBars))
      : h('div', { class: 'empty-state' }, h('b', { text: 'No completed attempts yet.' }), h('span', { text: 'Analytics appear as soon as students finish the case.' })),
    h('h2', { text: 'Students' }),
    h('div', { class: 'row' },
      h('input', { type: 'search', placeholder: 'Search name or roll number', 'aria-label': 'Search students', style: 'max-width:300px', oninput: e => { sf.q = e.target.value.toLowerCase(); drawStudents(); } }),
      h('select', { 'aria-label': 'Filter', style: 'width:auto', onchange: e => { sf.f = e.target.value; drawStudents(); } }, [['', 'All students'], ['none', 'Not started'], ['fail', 'Not yet passed'], ['pass', 'Passed']].map(([v, t]) => h('option', { value: v, text: t })))),
    h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['Name', 'Username', 'Attempts', 'First', 'Best', 'Result', 'Last outcome', ''].map(x => h('th', { text: x })))),
      studentBody))));
  drawStudents();
  function drawStudents() {
    const rows = d.perStudent.filter(s => (!sf.q || s.name.toLowerCase().includes(sf.q) || s.username.toLowerCase().includes(sf.q)) &&
      (!sf.f || (sf.f === 'none' ? !s.attempts : sf.f === 'pass' ? s.passed : s.attempts && !s.passed)));
    studentBody.replaceChildren(...rows.map(s => h('tr', null, h('td', null, h('a', { href: '#/student/' + s.id, text: s.name })), h('td', { class: 'num', text: s.username }), h('td', { class: 'num', text: s.attempts }),
        h('td', { class: 'num', text: s.first != null ? s.first + '%' : '—' }), h('td', { class: 'num', text: s.best != null ? s.best + '%' : '—' }),
        h('td', null, s.attempts ? (s.passed ? pill('Passed', 'good') : pill('Not yet', 'warn')) : pill('Not started')), h('td', { text: s.outcome || '' }),
        h('td', null, s.lastAttemptId ? h('a', { href: '#/attempt/' + s.lastAttemptId, text: 'Debrief' }) : null))));
  }
}

export async function studentPage(root, { id }) {
  const d = await api('GET', '/attempts?userId=' + encodeURIComponent(id));
  root.replaceChildren(h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', null, h('p', { class: 'eyebrow', text: 'Student' }), h('h1', { text: d.student ? d.student.name : 'Student' }), h('p', { class: 'sub mono', text: d.student ? d.student.username : '' })),
      h('button', { class: 'btn', type: 'button', text: 'Back', onclick: () => history.back() })),
    attemptsTable(d.attempts, { showStudentTitle: true })));
}

// ================================================================== CASES
export async function casesPage(root) {
  let status = sessionStorage.getItem('caseFilter') || '';
  const d = await api('GET', '/cases' + (status ? '?status=' + status : ''));
  const importInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const data = normalizeCase(JSON.parse(await f.text()));
      const errs = validateCase(data);
      if (errs.length) return modal('This case has problems', h('div', { class: 'problems' }, h('ul', null, errs.map(x => h('li', { text: x })))), [h('button', { class: 'btn', value: 'x', text: 'Close' })]);
      await api('POST', '/cases', { data, note: `Imported from ${f.name}` });
      toast('Case imported as a draft.'); go('/case/' + data.id);
    } catch (err) { showError(err); }
  } });
  const sel = h('select', { 'aria-label': 'Filter by status', style: 'width:auto', onchange: e => { sessionStorage.setItem('caseFilter', e.target.value); reload(); } },
    [['', 'Draft and published'], ['published', 'Published'], ['draft', 'Drafts'], ['archived', 'Archived']].map(([v, t]) => h('option', { value: v, text: t, selected: v === status })));
  root.replaceChildren(h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', null, h('h1', { text: 'Case library' }), h('p', { class: 'sub', text: 'Cases are shared by all teachers at this institution. Every save creates a new version; students always play the latest published version, and each result records the version played.' })),
      h('div', { class: 'row' }, sel, h('button', { class: 'btn', type: 'button', text: 'Import JSON', onclick: () => importInput.click() }), importInput, h('a', { class: 'btn btn-primary', href: '#/new-case', text: 'New case' }))),
    h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Presenting complaint', 'Diagnosis', 'Discipline', 'Status', 'Reviewed', 'Version', 'Attempts', ''].map(t => h('th', { text: t })))),
      h('tbody', null, d.cases.map(c => h('tr', null,
        h('td', null, h('a', { href: '#/case/' + encodeURIComponent(c.id), text: c.complaint }), c.builtin ? h('div', { class: 'hint', text: 'Built-in' }) : c.author ? h('div', { class: 'hint', text: 'by ' + c.author }) : null),
        h('td', { text: c.title }), h('td', { text: c.discipline || '' }),
        h('td', null, c.status === 'published' ? pill('Published', 'good') : c.status === 'draft' ? pill('Draft', 'warn') : pill('Archived')),
        h('td', null, c.reviewed_by ? h('span', { class: 'hint', text: `${c.reviewed_by}, ${dateOnly(c.reviewed_at)}` }) : pill('Not reviewed', 'neutral')),
        h('td', { class: 'num', text: 'v' + c.current_version }), h('td', { class: 'num', text: c.attempts }),
        h('td', null, h('div', { class: 'row', style: 'gap:4px' }, h('a', { class: 'btn btn-sm', href: '#/preview/' + encodeURIComponent(c.id), text: 'Preview' }), h('a', { class: 'btn btn-sm', href: '#/case/' + encodeURIComponent(c.id), text: 'Edit' }))))))))));
}

export async function previewPage(root, { id }) {
  const d = await api('GET', '/cases/' + encodeURIComponent(id));
  runPreview(root, d.data, () => go('/case/' + encodeURIComponent(id)));
}
/** Play a case without recording a result (teachers testing a case, including unsaved edits). */
export function runPreview(root, data, onBack) {
  mountSim(root, data, { badge: 'Preview: not recorded', onEnd: record => {
    const wrap = h('div');
    root.replaceChildren(h('div', { class: 'msg ok', style: 'margin-top:16px', text: 'Preview only. This result was not saved.' }), wrap);
    renderDebrief(wrap, data, record, { actions: [h('button', { class: 'btn btn-primary', type: 'button', text: 'Play again', onclick: () => runPreview(root, data, onBack) }), h('button', { class: 'btn', type: 'button', text: 'Back to editor', onclick: onBack })] });
  } });
}

// ================================================================== PEOPLE
export async function usersPage(root) {
  const isAdmin = state.user.role === 'admin';
  const s = { q: '', role: isAdmin ? '' : 'student', offset: 0, limit: 50 };
  const list = h('div');
  const load = async () => {
    const d = await api('GET', `/users?q=${encodeURIComponent(s.q)}&role=${s.role}&offset=${s.offset}&limit=${s.limit}`);
    list.replaceChildren(
      h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['Name', 'Username', 'Role', 'Status', 'Last sign-in', ''].map(t => h('th', { text: t })))),
        h('tbody', null, d.users.map(u => h('tr', null,
          h('td', null, u.role === 'student' ? h('a', { href: '#/student/' + u.id, text: u.name }) : u.name), h('td', { class: 'num', text: u.username }),
          h('td', null, isAdmin && u.id !== state.user.id ? h('select', { 'aria-label': 'Role', style: 'width:auto;min-height:30px;padding:2px 6px', onchange: async e => { try { await api('PATCH', '/users/' + u.id, { role: e.target.value }); toast('Role changed.'); } catch (err) { showError(err); load(); } } },
            ['student', 'teacher', 'admin'].map(r => h('option', { value: r, text: r, selected: r === u.role }))) : u.role),
          h('td', null, u.active ? (u.must_change_password ? pill('Temporary password', 'warn') : pill('Active', 'good')) : pill('Disabled')),
          h('td', { class: 'num', text: u.last_login_at ? dateTime(u.last_login_at) : 'Never' }),
          h('td', null, (isAdmin || u.role === 'student') && u.id !== state.user.id ? h('div', { class: 'row', style: 'gap:4px' },
            h('button', { class: 'btn btn-sm', type: 'button', text: 'Reset password', onclick: async () => { try { const r = await api('POST', `/users/${u.id}/reset-password`); modal('Temporary password', credentialsBlock([{ name: u.name, username: r.username, password: r.password }], 'Password reset'), [h('button', { class: 'btn btn-primary', value: 'ok', text: 'Done' })]); load(); } catch (e) { showError(e); } } }),
            h('button', { class: 'btn btn-sm', type: 'button', text: u.active ? 'Disable' : 'Enable', onclick: async () => { try { await api('PATCH', '/users/' + u.id, { active: !u.active }); load(); } catch (e) { showError(e); } } })) : null)))))),
      h('div', { class: 'pager' }, h('span', { text: d.total ? `${s.offset + 1}–${Math.min(s.offset + s.limit, d.total)} of ${d.total}` : 'No people found' }),
        h('button', { class: 'btn btn-sm', type: 'button', text: 'Previous', disabled: s.offset === 0, onclick: () => { s.offset = Math.max(0, s.offset - s.limit); load(); } }),
        h('button', { class: 'btn btn-sm', type: 'button', text: 'Next', disabled: s.offset + s.limit >= d.total, onclick: () => { s.offset += s.limit; load(); } })));
  };
  let timer;
  root.replaceChildren(h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', null, h('h1', { text: isAdmin ? 'People' : 'Students' }), h('p', { class: 'sub', text: isAdmin ? 'Create teacher and administrator accounts, reset passwords and disable accounts. Students are usually added from a class page.' : 'Find any student, reset a password or disable an account. Add students from a class page.' })),
      isAdmin ? h('button', { class: 'btn btn-primary', type: 'button', text: 'New staff account', onclick: newStaffDialog }) : null),
    h('div', { class: 'row' },
      h('input', { type: 'search', placeholder: 'Search name or username', 'aria-label': 'Search', style: 'max-width:320px', oninput: e => { clearTimeout(timer); timer = setTimeout(() => { s.q = e.target.value.trim(); s.offset = 0; load(); }, 250); } }),
      isAdmin ? h('select', { 'aria-label': 'Role', style: 'width:auto', onchange: e => { s.role = e.target.value; s.offset = 0; load(); } }, [['', 'All roles'], ['student', 'Students'], ['teacher', 'Teachers'], ['admin', 'Administrators']].map(([v, t]) => h('option', { value: v, text: t }))) : null),
    list));
  await load();
}

function newStaffDialog() {
  const msg = h('div', { hidden: true });
  const d = modal('New staff account', [
    field('Full name', h('input', { id: 'nName', type: 'text', required: true })),
    field('Username', h('input', { id: 'nUser', type: 'text', required: true })),
    field('Role', h('select', { id: 'nRole' }, h('option', { value: 'teacher', text: 'Teacher: classes, cases and results' }), h('option', { value: 'admin', text: 'Administrator: also manages staff accounts' }))), msg], [
    h('button', { class: 'btn', value: 'x', text: 'Cancel' }),
    h('button', { class: 'btn btn-primary', type: 'button', text: 'Create account', onclick: async () => {
      const name = $('#nName').value.trim(), username = $('#nUser').value.trim();
      try { const r = await api('POST', '/users', { name, username, role: $('#nRole').value }); d.close(); modal('Account created', credentialsBlock([{ name, username, password: r.password }], 'Staff account created'), [h('button', { class: 'btn btn-primary', value: 'ok', text: 'Done', onclick: reload })]); }
      catch (e) { showError(e, msg); }
    } })]);
}
