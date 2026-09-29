// Case editor: form-based editing of every part of a case, live validation, preview,
// version history, publishing and review sign-off. Advanced users can edit the raw JSON.
import { h, $, api, toast, showError, dateTime, pill, modal, confirmButton, download } from './ui.js';
import { state, go } from './app.js';
import { destroySim } from './sim.js';
import { runPreview } from './teacher.js';
import { validateCase, normalizeCase, blankCase, actionIds, VITAL_KEYS, VITAL_LABELS, GROUPS, GENERIC_ACTION_IDS } from '/shared/case-schema.js';

// ---------------------------------------------------------------- path helpers
const get = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
function set(o, p, v) {
  const ks = p.split('.'); let x = o;
  for (let i = 0; i < ks.length - 1; i++) { if (x[ks[i]] == null || typeof x[ks[i]] !== 'object') x[ks[i]] = /^\d+$/.test(ks[i + 1]) ? [] : {}; x = x[ks[i]]; }
  const last = ks[ks.length - 1];
  if (v === undefined) { if (Array.isArray(x)) x[last] = undefined; else delete x[last]; } else x[last] = v;
}
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);

export async function editorPage(root, params) {
  let W, meta = null, versions = [], isNew = !params.id;
  if (isNew) {
    const dup = sessionStorage.getItem('duplicateCase');
    sessionStorage.removeItem('duplicateCase');
    W = dup ? JSON.parse(dup) : blankCase('new-case-' + Math.random().toString(36).slice(2, 6));
  } else {
    const d = await api('GET', '/cases/' + encodeURIComponent(params.id));
    W = normalizeCase(d.data); meta = d.meta; versions = d.versions;
  }
  let dirty = isNew, section = sessionStorage.getItem('edSection') || 'overview';
  state.leaveGuard = () => !dirty || confirm('You have unsaved changes to this case. Leave without saving?');
  const onUnload = e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onUnload);
  const cleanup = () => { window.removeEventListener('beforeunload', onUnload); window.removeEventListener('hashchange', cleanup); };
  window.addEventListener('hashchange', cleanup);

  const editorDiv = h('div'), previewDiv = h('div');
  const problemsBox = h('div', { 'aria-live': 'polite' });
  const nav = h('nav', { class: 'ed-nav', 'aria-label': 'Case sections' });
  const body = h('div', { class: 'stack' });
  const saveState = h('span', { class: 'hint' });
  let vTimer;
  const changed = (structural) => {
    dirty = true; saveState.textContent = 'Unsaved changes';
    clearTimeout(vTimer); vTimer = setTimeout(validateNow, 400);
    if (structural) renderSection();
  };
  function validateNow() {
    const errs = validateCase(normalizeCase(JSON.parse(JSON.stringify(W))));
    problemsBox.replaceChildren(errs.length
      ? h('div', { class: 'problems' }, h('b', { text: `${errs.length} problem(s) to fix before saving` }), h('ul', null, errs.slice(0, 12).map(e => h('li', { text: e }))), errs.length > 12 ? h('div', { text: `…and ${errs.length - 12} more` }) : null)
      : h('div', { class: 'ok-note', text: 'No problems found. The case can be saved and published.' }));
    renderNav();
    return errs;
  }

  // ---------------------------------------------------------------- widgets
  const lab = (label, ctl, note) => h('label', { class: 'field' }, h('span', { text: label }), ctl, note ? h('small', { text: note }) : null);
  const txt = (p, label, note, attrs = {}) => lab(label, h('input', { type: 'text', value: get(W, p) ?? '', oninput: e => { set(W, p, e.target.value); changed(); }, ...attrs }), note);
  const area = (p, label, note, rows = 3) => lab(label, h('textarea', { rows, oninput: e => { set(W, p, e.target.value); changed(); } }, get(W, p) ?? ''), note);
  const num = (p, label, note, attrs = {}) => lab(label, h('input', { type: 'number', step: 'any', value: get(W, p) ?? '', oninput: e => { set(W, p, e.target.value === '' ? undefined : Number(e.target.value)); changed(); }, ...attrs }), note);
  const sel = (p, label, options, note, onAfter) => lab(label, h('select', { onchange: e => { const v = e.target.value; set(W, p, v === '' ? undefined : v); changed(); if (onAfter) onAfter(v); } },
    options.map(o => { const [v, t] = Array.isArray(o) ? o : [o, o]; return h('option', { value: v, text: t, selected: String(get(W, p) ?? '') === String(v) }); })), note);
  const chk = (p, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!get(W, p), onchange: e => { set(W, p, e.target.checked || undefined); changed(); } }), h('span', { text: label }));
  const csvList = (p, label, note) => lab(label, h('input', { type: 'text', value: (get(W, p) || []).join(', '), oninput: e => { set(W, p, e.target.value.split(',').map(s => s.trim()).filter(Boolean)); changed(); } }), note);
  const lines = (p, label, note) => lab(label, h('textarea', { rows: 6, oninput: e => { set(W, p, e.target.value.split('\n').map(s => s.trim()).filter(Boolean)); changed(); } }, (get(W, p) || []).join('\n')), note);
  function idPick(p, label, note) {
    const ids = [...actionIds(W)];
    const cur = new Set(get(W, p) || []);
    for (const x of cur) if (!ids.includes(x)) ids.push(x);
    return h('div', { class: 'field' }, h('span', { text: label }),
      h('div', { class: 'idpick' }, ids.map(id => h('label', { title: describeId(id) }, h('input', { type: 'checkbox', checked: cur.has(id), onchange: e => { if (e.target.checked) cur.add(id); else cur.delete(id); set(W, p, [...cur]); changed(); } }), id))),
      note ? h('small', { text: note }) : null);
  }
  function describeId(id) {
    for (const k of ['history', 'exam', 'investigations', 'interventions']) { const x = (W[k] || []).find(i => i.id === id); if (x) return `${k}: ${x.q || x.label || ''}`; }
    return GENERIC_ACTION_IDS.includes(id) ? 'built-in action' : 'unknown id';
  }
  const idSelect = (p, label, note) => sel(p, label, [['', '— choose —'], ...[...actionIds(W)].map(i => [i, `${i}: ${describeId(i).split(': ')[1] || describeId(i)}`])], note);

  /** Repeating list editor. */
  function list(p, { title, summary, fields, make, note }) {
    const arr = get(W, p) || []; if (!get(W, p)) set(W, p, arr);
    const box = h('div', { class: 'stack' });
    arr.forEach((it, i) => {
      const ip = `${p}.${i}`;
      const d = h('details', { class: 'item', open: it.__open || null },
        h('summary', null, h('span', { text: summary(it, i) || '(untitled)' }), it.id ? h('span', { class: 'id', text: it.id }) : null),
        h('div', { class: 'item-body' }, fields(ip, it, i),
          h('div', { class: 'item-tools' },
            h('button', { type: 'button', class: 'btn btn-sm', text: '↑', 'aria-label': 'Move up', disabled: i === 0, onclick: () => { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; changed(true); } }),
            h('button', { type: 'button', class: 'btn btn-sm', text: '↓', 'aria-label': 'Move down', disabled: i === arr.length - 1, onclick: () => { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; changed(true); } }),
            h('button', { type: 'button', class: 'btn btn-sm', text: 'Duplicate', onclick: () => { const c = JSON.parse(JSON.stringify(it)); if (c.id) c.id = c.id + '_copy'; arr.splice(i + 1, 0, c); changed(true); } }),
            confirmButton('Delete', 'Confirm delete', () => { arr.splice(i, 1); changed(true); }, 'btn btn-sm btn-danger'))));
      d.addEventListener('toggle', () => { Object.defineProperty(it, '__open', { value: d.open, enumerable: false, configurable: true, writable: true }); });
      box.append(d);
    });
    return h('div', { class: 'stack' }, title ? h('h3', { text: title }) : null, note ? h('p', { class: 'hint', text: note }) : null, box,
      h('div', null, h('button', { type: 'button', class: 'btn', text: '+ Add', onclick: () => { const n = make(arr.length); Object.defineProperty(n, '__open', { value: true, enumerable: false, configurable: true, writable: true }); arr.push(n); changed(true); } })));
  }
  function variants(p) {
    return h('div', { class: 'subgroup' }, h('span', { class: 'lbl', text: 'Changes with the patient’s state (optional)' }),
      list(p + '.variants', {
        note: 'The first matching variant replaces the default text. Leave conditions blank that you do not need.',
        summary: v => v.text ? v.text.slice(0, 70) : 'Variant',
        make: () => ({ if: { severityBelow: 0.25 }, text: '' }),
        fields: vp => [area(vp + '.text', 'Text shown when the conditions match', null, 2),
          h('div', { class: 'form-grid' }, num(vp + '.if.severityBelow', 'Severity below', '0–1. Lower = better.'), num(vp + '.if.severityAbove', 'Severity above', '0–1. Higher = sicker.')),
          idPick(vp + '.if.done', 'After any of these actions'), idPick(vp + '.if.notDone', 'Only if none of these were done')]
      }));
  }

  // ---------------------------------------------------------------- sections
  const SECTIONS = {
    overview: ['Overview', () => [
      h('p', { class: 'hint', text: 'What learners see on the case card, and who the patient is. The diagnosis (title) stays hidden until the debrief.' }),
      h('div', { class: 'form-grid' },
        txt('id', 'Case id', isNew ? 'Lowercase letters, digits and hyphens. Cannot be changed after the first save.' : 'Fixed after the first save.', isNew ? {} : { readonly: true }),
        txt('title', 'Diagnosis (title)', 'Revealed in the debrief.')),
      txt('card.complaint', 'Presenting complaint (card headline)'),
      h('div', { class: 'form-grid' },
        txt('card.discipline', 'Discipline'), txt('card.setting', 'Setting'),
        sel('card.difficulty', 'Difficulty', ['Foundation', 'Core', 'Advanced']), num('card.minutes', 'Typical minutes'), num('passMark', 'Pass mark (%)', 'Default 80.')),
      h('h3', { text: 'Patient' }),
      h('div', { class: 'form-grid' }, txt('patient.name', 'Name'), num('patient.age', 'Age'), sel('patient.sex', 'Sex', [['F', 'Female'], ['M', 'Male'], ['X', 'Other / not stated']]), num('patient.weight', 'Weight (kg)')),
      h('h3', { text: 'Triage' }),
      area('triage.note', 'Triage note', 'The handover the learner reads first.', 4),
      h('div', { class: 'form-grid' }, ['HR', 'BP', 'RR', 'SpO2', 'Temp', 'GCS'].map(k => txt('triage.vitals.' + k, `Triage ${k.replace('SpO2', 'SpO₂')}`)))
    ]],
    physiology: ['Physiology', () => [
      h('p', { class: 'hint', text: 'Severity runs from 0 (recovered) to 1 (peri-arrest). The patient starts at the start severity and worsens at the given rate unless treatment slows or stops it. Vital signs are interpolated between the three rows below.' }),
      h('div', { class: 'form-grid' }, num('physiology.start', 'Start severity', '0–1, e.g. 0.5'), num('physiology.rate', 'Deterioration per minute', 'e.g. 0.06 → peri-arrest in ~8 min'), num('physiology.recovery', 'Recovery per minute', 'Once deterioration is fully stopped.'),
        sel('physiology.rhythm.type', 'Baseline rhythm', [['sinus', 'Sinus'], ['af', 'Atrial fibrillation']]), num('physiology.rhythm.st', 'ST elevation on the monitor', '0 = none, 0.3 = marked'), num('nibpInterval', 'NIBP cycle (seconds)', 'Default 180.')),
      h('div', { class: 'table-wrap' }, h('table', { class: 'vitals-table' }, h('thead', null, h('tr', null, h('th', { text: '' }), VITAL_KEYS.map(k => h('th', { text: VITAL_LABELS[k] })))),
        h('tbody', null, [['best', 'Recovered (0)'], ['initial', 'At presentation'], ['worst', 'Peri-arrest (1)']].map(([row, name]) => h('tr', null, h('th', { text: name }),
          VITAL_KEYS.map(k => h('td', null, h('input', { type: 'number', step: 'any', 'aria-label': `${name} ${VITAL_LABELS[k]}`, value: get(W, `physiology.${row}.${k}`) ?? '', oninput: e => { set(W, `physiology.${row}.${k}`, e.target.value === '' ? undefined : Number(e.target.value)); changed(); } })))))))),
      h('h3', { text: 'Cardiac arrest' }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!W.arrest, onchange: e => { W.arrest = e.target.checked ? { rhythm: 'pea', requireAdrenaline: true, reversibleBy: [], roscSeverity: 0.8 } : null; changed(true); } }), h('span', { text: 'The patient arrests when severity reaches 1' })),
      W.arrest ? h('div', { class: 'subgroup' },
        h('div', { class: 'form-grid' }, sel('arrest.rhythm', 'Arrest rhythm', [['vf', 'VF (shockable)'], ['pea', 'PEA'], ['asystole', 'Asystole']], null, () => changed(true)), num('arrest.roscSeverity', 'Severity after ROSC', 'e.g. 0.8'),
          W.arrest.rhythm === 'vf' ? num('arrest.shocksNeeded', 'Shocks needed for ROSC', 'Default 1.') : null),
        W.arrest.rhythm !== 'vf' ? [h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: W.arrest.requireAdrenaline !== false, onchange: e => { W.arrest.requireAdrenaline = e.target.checked; changed(); } }), h('span', { text: 'ROSC needs adrenaline 1 mg IV' })),
          idPick('arrest.reversibleBy', 'ROSC also needs one of these (the reversible cause)', 'Leave empty if CPR and adrenaline are enough.')] : null)
        : h('p', { class: 'hint', text: 'Without arrest, the patient stays at the worst state (e.g. a seizure or coma described in the bedside appearance).' }),
      h('h3', { text: 'Speech' }),
      h('div', { class: 'form-grid' }, num('speech.impairedAbove', 'Patient cannot answer above severity', 'e.g. 0.8. Collateral sources still answer.'), txt('speech.impairedText', 'What the learner sees instead'))
    ]],
    appearance: ['Bedside appearance', () => [
      h('p', { class: 'hint', text: 'What the learner sees at the bedside at each severity. The first band whose limit is above the current severity is shown; the last band should use 1.01.' }),
      list('appearance', { summary: a => `below ${a.below}: ${a.text || ''}`.slice(0, 80), make: () => ({ below: 1.01, text: '' }),
        fields: p => [h('div', { class: 'form-grid' }, num(p + '.below', 'Up to severity')), area(p + '.text', 'Description', null, 2)] })
    ]],
    history: ['History', () => [
      h('p', { class: 'hint', text: 'Questions the learner can ask. Free-text questions are matched by keywords (lowercase fragments, e.g. "allerg" matches allergy and allergic). Longer keyword matches win.' }),
      list('history', { summary: x => x.q, make: n => ({ id: 'h_q' + (n + 1), q: '', keywords: [], a: '' }),
        fields: p => [h('div', { class: 'form-grid' }, txt(p + '.id', 'Id'), txt(p + '.source', 'Who answers', 'Patient (default), or e.g. Friend, Daughter, Paramedic')),
          txt(p + '.q', 'Suggested question'), csvList(p + '.keywords', 'Keywords (comma-separated)'), area(p + '.a', 'Answer'), variants(p)] })
    ]],
    exam: ['Examination', () => [
      list('exam', { summary: x => x.label, make: n => ({ id: 'e_x' + (n + 1), label: '', text: '' }),
        fields: p => [h('div', { class: 'form-grid' }, txt(p + '.id', 'Id'), txt(p + '.label', 'System (button label)')), area(p + '.text', 'Finding'), variants(p)] })
    ]],
    investigations: ['Investigations', () => [
      h('p', { class: 'hint', text: 'Results are fixed when the test is ordered, so variants can show improvement after treatment. Time is in simulated seconds (60 = 1 minute).' }),
      list('investigations', { summary: x => `${x.label || ''} (${x.group || 'Other'}, ${x.time ?? 60}s)`, make: n => ({ id: 'i_x' + (n + 1), group: 'Bedside', label: '', time: 60, text: '' }),
        fields: p => [h('div', { class: 'form-grid' }, txt(p + '.id', 'Id'), sel(p + '.group', 'Group', ['Bedside', 'Laboratory', 'Imaging', 'Other']), txt(p + '.label', 'Test name'), num(p + '.time', 'Turnaround (seconds)')),
          area(p + '.text', 'Result'), variants(p)] })
    ]],
    interventions: ['Treatments', () => [
      h('p', { class: 'hint', text: `Built-in actions are always available: ${GENERIC_ACTION_IDS.join(', ')}. Add one with the same id to change its label. Effects: severity change (negative = better) over the onset time; temporary vital-sign offsets; and a multiplier on deterioration (0 stops it, 0.5 halves it).` }),
      list('interventions', { summary: x => x.label || x.id, make: n => ({ id: 'tx_' + (n + 1), group: 'Medications', label: '' }),
        fields: p => [
          h('div', { class: 'form-grid' }, txt(p + '.id', 'Id'), sel(p + '.group', 'Group', GROUPS), txt(p + '.label', 'Button label (drug and dose)'), txt(p + '.detail', 'Detail (route, notes)')),
          h('div', { class: 'form-grid' }, num(p + '.max', 'Maximum times', 'Blank = unlimited')), chk(p + '.once', 'Can only be done once'),
          idPick(p + '.requires', 'Needs one of these first', 'e.g. iv_access for IV drugs.'),
          txt(p + '.say', 'Nurse response', 'e.g. Nurse: “Adrenaline given.”'),
          h('div', { class: 'subgroup' }, h('span', { class: 'lbl', text: 'Effect on the patient' }),
            h('div', { class: 'form-grid' }, num(p + '.effects.severity', 'Severity change', '-0.3 = big improvement'), num(p + '.effects.onset', 'Onset (seconds)', 'Default 60'), num(p + '.effects.delay', 'Delay before onset (s)')),
            h('div', { class: 'form-grid' }, VITAL_KEYS.map(k => num(`${p}.effects.vitals.${k}`, `${VITAL_LABELS[k]} change`))),
            h('div', { class: 'form-grid' }, num(p + '.effects.duration', 'Vital-sign change lasts (s)', 'Blank = permanent'), num(p + '.effects.progression.factor', 'Deterioration multiplier', '0 stops, 1 no change'), num(p + '.effects.progression.duration', 'Multiplier lasts (s)', 'Blank = permanent')),
            h('div', { class: 'form-grid' }, num(p + '.effects.maxSeverity', 'Only works below severity', 'e.g. 0.4 for oral drugs'), txt(p + '.effects.blockedSay', 'Message when it cannot be given')),
            idPick(p + '.effects.unlessDone', 'No effect if any of these were done')),
          h('div', { class: 'subgroup' }, h('span', { class: 'lbl', text: 'Harm and feedback' }),
            h('div', { class: 'form-grid' }, num(p + '.harm.points', 'Penalty points if given', 'Blank = not harmful')), area(p + '.harm.why', 'Why it is harmful (debrief)', null, 2),
            area(p + '.feedback', 'Teaching note shown in the debrief when chosen', null, 2))] })
    ]],
    decisions: ['Diagnosis & disposition', () => [
      list('diagnoses', { title: 'Diagnosis options', note: 'Include the correct diagnosis and plausible distractors. Options are shuffled for each attempt.', summary: x => x.label, make: n => ({ id: 'dx_' + (n + 1), label: '' }),
        fields: p => [h('div', { class: 'form-grid' }, txt(p + '.id', 'Id'), txt(p + '.label', 'Diagnosis'))] }),
      h('div', { class: 'form-grid' }, sel('scoring.diagnosis.correct', 'Correct diagnosis', [['', '— choose —'], ...W.diagnoses.map(d => [d.id, d.label || d.id])]), num('scoring.diagnosis.points', 'Points')),
      list('dispositions', { title: 'Disposition options', summary: x => x.label, make: n => ({ id: 'disp_' + (n + 1), label: '' }),
        fields: p => [h('div', { class: 'form-grid' }, txt(p + '.id', 'Id'), txt(p + '.label', 'Disposition'))] }),
      h('div', { class: 'form-grid' }, sel('scoring.disposition.correct', 'Best disposition', [['', '— choose —'], ...W.dispositions.map(d => [d.id, d.label || d.id])]), num('scoring.disposition.points', 'Points')),
      h('div', { class: 'subgroup' }, h('span', { class: 'lbl', text: 'Partial credit for other dispositions (optional)' }),
        h('div', { class: 'form-grid' }, W.dispositions.filter(d => d.id !== W.scoring.disposition?.correct).map(d => num(`scoring.disposition.partial.${d.id}`, d.label || d.id))))
    ]],
    scoring: ['Scoring', () => {
      const item = crit => p => [h('div', { class: 'form-grid' }, txt(p + '.id', 'Id'), txt(p + '.label', 'What the learner should do'), num(p + '.points', 'Points'),
        crit ? num(p + '.within', 'Target time (seconds)', 'Late = half points. Blank = no target.') : null, num(p + '.count', 'Times needed', 'Default 1 (e.g. 2 = repeated test)')),
        idPick(p + '.anyOf', 'Counts when any of these is done'), crit ? area(p + '.why', 'Why it matters (shown if missed)', null, 2) : null];
      return [
        list('scoring.critical', { title: 'Critical actions', note: 'The actions that save the patient. Most of the points belong here.', summary: x => `${x.label || ''} (${x.points ?? 0} pts)`, make: n => ({ id: 'c_' + (n + 1), label: '', anyOf: [], within: 300, points: 10, why: '' }), fields: item(true) }),
        list('scoring.recommended', { title: 'Recommended actions', summary: x => `${x.label || ''} (${x.points ?? 0} pts)`, make: n => ({ id: 'r_' + (n + 1), label: '', anyOf: [], points: 3 }), fields: item(false) }),
        list('scoring.penalties', { title: 'Penalty rules', note: 'Penalise an action when done at the wrong time: before another action, after another action, or when a vital sign meets a condition. Harmful drugs can be penalised directly on the treatment instead.', summary: x => `${x.ifAction || '?'}: −${x.points ?? 0}`, make: () => ({ ifAction: '', points: 5, why: '' }),
          fields: p => [h('div', { class: 'form-grid' }, idSelect(p + '.ifAction', 'When this action is done'), num(p + '.points', 'Penalty points')),
            idPick(p + '.before', '…before any of these (optional)'), idPick(p + '.ifDone', '…after any of these (optional)'),
            h('div', { class: 'form-grid' }, whenField(p)), area(p + '.why', 'Explanation (debrief)', null, 2)] }),
        h('p', { class: 'hint', text: 'Automatic penalties apply in every case: cardiac arrest (−15), CPR delayed over 1 min (−10), first shock delayed over 2 min (−10), death (−30), and wrong resuscitation actions.' })
      ];
    }],
    teaching: ['Teaching points', () => [lines('teaching', 'Teaching points (one per line)', 'Shown in every debrief.'), lines('references', 'References (one per line)', 'Guidelines the case follows.')]],
    json: ['JSON (advanced)', () => {
      const ta = h('textarea', { class: 'code', spellcheck: 'false' }, JSON.stringify(W, null, 2));
      const msg = h('div', { hidden: true });
      return [h('p', { class: 'hint', text: 'Edit the whole case as JSON, then apply. Useful for copying parts between cases. The file format is documented in the README.' }), ta, msg,
        h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', type: 'button', text: 'Apply JSON', onclick: () => { try { const next = normalizeCase(JSON.parse(ta.value)); if (!isNew) next.id = W.id; W = next; changed(); toast('JSON applied.'); } catch (e) { msg.hidden = false; msg.className = 'msg err'; msg.textContent = 'Not valid JSON: ' + e.message; } } }),
          h('button', { class: 'btn', type: 'button', text: 'Download JSON', onclick: () => download(`${W.id}.json`, JSON.stringify(W, null, 2), 'application/json') }))];
    }]
  };
  function whenField(p) {
    const w = get(W, p + '.when') || {};
    const key = Object.keys(w)[0] || '', cond = key ? w[key] : {}, op = Object.keys(cond)[0] || 'lt', val = cond[op] ?? '';
    const apply = (k, o, v) => { set(W, p + '.when', k && v !== '' ? { [k]: { [o]: Number(v) } } : undefined); changed(); };
    let k0 = key, o0 = op, v0 = val;
    return [
      lab('…only when (optional)', h('select', { onchange: e => { k0 = e.target.value; apply(k0, o0, v0); } }, [['', 'Always'], ...VITAL_KEYS.map(k => [k, VITAL_LABELS[k]]), ['severity', 'Severity (0–1)']].map(([v, t]) => h('option', { value: v, text: t, selected: v === key })))),
      lab('Condition', h('select', { onchange: e => { o0 = e.target.value; apply(k0, o0, v0); } }, [['lt', 'is below'], ['lte', 'is at most'], ['gt', 'is above'], ['gte', 'is at least']].map(([v, t]) => h('option', { value: v, text: t, selected: v === op })))),
      lab('Value', h('input', { type: 'number', step: 'any', value: val, oninput: e => { v0 = e.target.value; apply(k0, o0, v0); } }))];
  }

  function renderNav() {
    const counts = { history: W.history.length, exam: W.exam.length, investigations: W.investigations.length, interventions: W.interventions.length, scoring: W.scoring.critical.length + W.scoring.recommended.length };
    nav.replaceChildren(...Object.entries(SECTIONS).map(([k, [label]]) => h('button', { type: 'button', 'aria-current': k === section ? 'true' : 'false', onclick: () => { section = k; sessionStorage.setItem('edSection', k); renderNav(); renderSection(); } }, label, counts[k] != null ? h('span', { class: 'count', text: counts[k] }) : null)));
  }
  function renderSection() {
    const [label, fn] = SECTIONS[section] || SECTIONS.overview;
    body.replaceChildren(h('section', { class: 'ed-section' }, h('h2', { text: label }), fn()));
  }

  // ---------------------------------------------------------------- actions
  async function save() {
    const errs = validateNow();
    if (errs.length) { toast('Fix the problems listed at the top before saving.', 'crit'); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    const note = $('#saveNote').value.trim();
    try {
      if (isNew) { await api('POST', '/cases', { data: W, note: note || 'Created' }); dirty = false; toast('Case saved as a draft.'); state.leaveGuard = null; go('/case/' + W.id); }
      else { const r = await api('PUT', '/cases/' + encodeURIComponent(W.id), { data: W, note, baseVersion: meta.current_version }); dirty = false; toast(`Saved as version ${r.version}.`); state.leaveGuard = null; window.dispatchEvent(new HashChangeEvent('hashchange')); }
    } catch (e) { showError(e); if (e.details) validateNow(); }
  }
  const patch = async (body, done) => { try { await api('PATCH', '/cases/' + encodeURIComponent(W.id), body); toast(done); state.leaveGuard = null; dirty = false; window.dispatchEvent(new HashChangeEvent('hashchange')); } catch (e) { showError(e); } };
  function preview() {
    const errs = validateNow();
    if (errs.length) return toast('Fix the problems listed at the top before previewing.', 'crit');
    editorDiv.hidden = true;
    const stage = h('div');
    const back = () => { destroySim(); previewDiv.replaceChildren(); editorDiv.hidden = false; window.scrollTo({ top: 0 }); };
    previewDiv.replaceChildren(h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn', type: 'button', text: '← Stop preview, back to editor', onclick: back }), h('span', { class: 'hint', text: 'Playing your current edits, including unsaved changes. Nothing is recorded.' })), stage);
    runPreview(stage, JSON.parse(JSON.stringify(W)), back);
  }
  function historyDialog() {
    modal('Version history', h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['Version', 'Saved', 'By', 'Note', ''].map(t => h('th', { text: t })))),
      h('tbody', null, versions.map(v => h('tr', null, h('td', { class: 'num', text: 'v' + v.version }), h('td', { class: 'num', text: dateTime(v.saved_at) }), h('td', { text: v.saved_by || 'Built-in' }), h('td', { text: v.note || '' }),
        h('td', null, v.version === meta.current_version ? pill('Current', 'good') : confirmButton('Restore', 'Confirm restore', () => patch({ restoreVersion: v.version }, `Version ${v.version} restored as a new version.`), 'btn btn-sm'))))))),
      [h('button', { class: 'btn', value: 'x', text: 'Close' })]);
  }

  const statusPill = !meta ? pill('New, not saved', 'warn') : meta.status === 'published' ? pill('Published', 'good') : meta.status === 'draft' ? pill('Draft', 'warn') : pill('Archived');
  const head = h('div', { class: 'page-head' },
    h('div', null, h('p', { class: 'eyebrow' }, h('a', { href: '#/cases', text: 'Case library' }), ' · ', isNew ? 'New case' : `Version ${meta.current_version}`),
      h('h1', { text: W.card.complaint || 'New case' }),
      h('div', { class: 'row', style: 'margin-top:8px' }, statusPill, meta ? (meta.reviewed_by ? pill(`Reviewed by ${meta.reviewed_by}`, 'good') : pill('Not reviewed since last edit')) : null)),
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', text: 'Preview', onclick: preview }),
      !isNew ? h('button', { class: 'btn', type: 'button', text: 'History', onclick: historyDialog }) : null,
      !isNew ? h('button', { class: 'btn', type: 'button', text: 'Duplicate', onclick: () => { const c = JSON.parse(JSON.stringify(W)); c.id = (c.id + '-copy').slice(0, 80); c.card.complaint += ' (copy)'; sessionStorage.setItem('duplicateCase', JSON.stringify(c)); go('/new-case'); } }) : null,
      !isNew && meta.status !== 'published' ? h('button', { class: 'btn btn-primary', type: 'button', text: 'Publish', onclick: () => dirty ? toast('Save your changes first.', 'crit') : patch({ status: 'published' }, 'Published: students can now play this case.') }) : null,
      !isNew && meta.status === 'published' ? confirmButton('Unpublish', 'Confirm unpublish', () => patch({ status: 'draft' }, 'Moved back to draft.'), 'btn') : null,
      !isNew && !meta.reviewed_by ? h('button', { class: 'btn', type: 'button', text: 'Mark reviewed', onclick: () => dirty ? toast('Save your changes first.', 'crit') : patch({ reviewed: true }, 'Marked as clinically reviewed.') }) : null,
      !isNew && meta.status !== 'archived' ? confirmButton('Archive', 'Confirm archive', () => patch({ status: 'archived' }, 'Archived.'), 'btn btn-danger') : null));

  const savebar = h('div', { class: 'savebar' }, saveState, h('span', { class: 'spacer' }),
    h('input', { id: 'saveNote', type: 'text', placeholder: 'What changed? (optional note for the version history)', style: 'max-width:420px', 'aria-label': 'Version note' }),
    h('button', { class: 'btn btn-primary', type: 'button', text: isNew ? 'Save case' : 'Save new version', onclick: save }));
  saveState.textContent = isNew ? 'Not saved yet' : `Last saved ${dateTime(meta.updated_at)}`;

  editorDiv.append(h('div', { class: 'page' }, head,
    !isNew && meta.status === 'published' ? h('p', { class: 'msg ok', text: 'This case is published. Saving creates a new version that students get immediately; past results keep the version they played. Saving clears the review sign-off.' }) : null,
    problemsBox, h('div', { class: 'editor' }, nav, body)), savebar);
  root.replaceChildren(editorDiv, previewDiv);
  validateNow(); renderSection();
}
