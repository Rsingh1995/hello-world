// Case format: validation and normalisation shared by the server and the browser.
// A case is plain JSON. See README.md ("Writing a case") for the full reference.

export const VITAL_KEYS = ['hr', 'sbp', 'dbp', 'rr', 'spo2', 'temp'];
export const VITAL_LABELS = { hr: 'HR (bpm)', sbp: 'Systolic BP', dbp: 'Diastolic BP', rr: 'RR (/min)', spo2: 'SpO₂ (%)', temp: 'Temp (°C)' };
export const GENERIC_ACTION_IDS = ['monitor', 'iv_access', 'cpr', 'rhythm_check', 'defib', 'adr_1mg_iv', 'amio_300'];
export const GROUPS = ['Monitoring', 'Airway & breathing', 'Circulation', 'Medications', 'Procedures', 'Help & referral', 'Resuscitation'];
export const RHYTHMS = ['sinus', 'af'];
export const ARREST_RHYTHMS = ['vf', 'pea', 'asystole'];

const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
const num = x => typeof x === 'number' && Number.isFinite(x);

export function normalizeCase(c) {
  for (const k of ['history', 'exam', 'investigations', 'interventions', 'diagnoses', 'dispositions', 'teaching', 'references', 'appearance']) {
    if (!Array.isArray(c[k])) c[k] = [];
  }
  c.card = c.card || {};
  c.patient = c.patient || {};
  c.triage = c.triage || { note: '', vitals: {} };
  c.triage.vitals = c.triage.vitals || {};
  c.scoring = c.scoring || {};
  for (const k of ['critical', 'recommended', 'penalties']) if (!Array.isArray(c.scoring[k])) c.scoring[k] = [];
  c.physiology = c.physiology || {};
  c.physiology.rhythm = c.physiology.rhythm || { type: 'sinus' };
  if (c.physiology.recovery == null) c.physiology.recovery = 0.05;
  if (c.arrest === undefined) c.arrest = null;
  return c;
}

/** Every id a scoring rule may refer to: history, exam, investigations, interventions and built-in actions. */
export function actionIds(c) {
  const ids = new Set(GENERIC_ACTION_IDS);
  for (const k of ['history', 'exam', 'investigations', 'interventions']) for (const x of c[k] || []) if (x && x.id) ids.add(x.id);
  return ids;
}

/** Returns a list of human-readable problems. Empty list = valid. */
export function validateCase(c) {
  const e = [];
  if (!isObj(c)) return ['The case is not a JSON object.'];
  if (!c.id || !/^[a-z0-9][a-z0-9-]{1,79}$/.test(c.id)) e.push('"id" must be 2–80 characters: lowercase letters, digits and hyphens.');
  if (!c.title) e.push('"title" (the diagnosis shown in the debrief) is required.');
  if (!isObj(c.card) || !c.card.complaint) e.push('"card.complaint" (what learners see before starting) is required.');
  if (!isObj(c.patient) || !c.patient.name) e.push('"patient.name" is required.');
  const P = c.physiology;
  if (!isObj(P)) e.push('"physiology" is required.');
  else {
    for (const k of ['best', 'initial', 'worst']) {
      if (!isObj(P[k])) { e.push(`"physiology.${k}" is required.`); continue; }
      for (const v of VITAL_KEYS) if (!num(P[k][v])) e.push(`"physiology.${k}.${v}" must be a number.`);
    }
    if (!(num(P.start) && P.start > 0 && P.start < 1)) e.push('"physiology.start" must be a number between 0 and 1.');
    if (!num(P.rate) || P.rate < 0) e.push('"physiology.rate" must be a number ≥ 0 (severity gained per minute).');
    if (P.recovery != null && (!num(P.recovery) || P.recovery < 0)) e.push('"physiology.recovery" must be a number ≥ 0.');
    if (P.rhythm && !RHYTHMS.includes(P.rhythm.type || 'sinus')) e.push(`"physiology.rhythm.type" must be one of ${RHYTHMS.join(', ')}.`);
  }
  if (c.arrest != null) {
    if (!isObj(c.arrest) || !ARREST_RHYTHMS.includes(c.arrest.rhythm)) e.push(`"arrest.rhythm" must be one of ${ARREST_RHYTHMS.join(', ')} (or set "arrest" to null).`);
  }
  const seen = new Set();
  for (const k of ['history', 'exam', 'investigations', 'interventions']) {
    const list = c[k] || [];
    if (!Array.isArray(list)) { e.push(`"${k}" must be a list.`); continue; }
    list.forEach((x, i) => {
      if (!isObj(x) || !x.id) { e.push(`${k} item ${i + 1} needs an "id".`); return; }
      if (seen.has(x.id) && !(k === 'interventions' && GENERIC_ACTION_IDS.includes(x.id))) e.push(`Duplicate id "${x.id}".`);
      seen.add(x.id);
      if (k === 'history' && (!x.q || !x.a)) e.push(`History "${x.id}" needs a question ("q") and an answer ("a").`);
      if (k === 'exam' && (!x.label || !x.text)) e.push(`Exam "${x.id}" needs a "label" and a finding ("text").`);
      if (k === 'investigations' && (!x.label || !x.text)) e.push(`Investigation "${x.id}" needs a "label" and a result ("text").`);
      if (k === 'investigations' && x.time != null && (!num(x.time) || x.time < 0)) e.push(`Investigation "${x.id}": "time" must be seconds ≥ 0.`);
      if (k === 'interventions' && !x.label && !GENERIC_ACTION_IDS.includes(x.id)) e.push(`Intervention "${x.id}" needs a "label".`);
    });
  }
  const ids = actionIds(c);
  const S = c.scoring;
  if (!isObj(S)) e.push('"scoring" is required.');
  else {
    for (const k of ['critical', 'recommended']) (S[k] || []).forEach((it, i) => {
      if (!it.label) e.push(`scoring.${k} item ${i + 1} needs a "label".`);
      if (!Array.isArray(it.anyOf) || !it.anyOf.length) e.push(`scoring.${k} "${it.label || i + 1}" needs "anyOf" (at least one action id).`);
      else for (const id of it.anyOf) if (!ids.has(id)) e.push(`scoring.${k} "${it.label || i + 1}" refers to unknown action "${id}".`);
      if (!num(it.points)) e.push(`scoring.${k} "${it.label || i + 1}" needs numeric "points".`);
    });
    (S.penalties || []).forEach((r, i) => {
      if (!r.ifAction || !ids.has(r.ifAction)) e.push(`Penalty rule ${i + 1} refers to unknown action "${r.ifAction}".`);
      if (!num(r.points)) e.push(`Penalty rule ${i + 1} needs numeric "points".`);
    });
    const dxIds = new Set((c.diagnoses || []).map(d => d.id));
    const dispIds = new Set((c.dispositions || []).map(d => d.id));
    if (!isObj(S.diagnosis) || !dxIds.has(S.diagnosis.correct)) e.push('"scoring.diagnosis.correct" must match one of the diagnosis options.');
    if (!isObj(S.disposition) || !dispIds.has(S.disposition.correct)) e.push('"scoring.disposition.correct" must match one of the disposition options.');
    if (isObj(S.diagnosis) && !num(S.diagnosis.points)) e.push('"scoring.diagnosis.points" must be a number.');
    if (isObj(S.disposition) && !num(S.disposition.points)) e.push('"scoring.disposition.points" must be a number.');
  }
  if ((c.diagnoses || []).length < 2) e.push('Give at least two diagnosis options.');
  if ((c.dispositions || []).length < 2) e.push('Give at least two disposition options.');
  return e;
}

/** A minimal valid case used by the editor's "New case" button. */
export function blankCase(id = 'new-case') {
  return normalizeCase({
    id, title: 'Diagnosis (shown only in the debrief)',
    card: { complaint: 'Presenting complaint shown on the case card', discipline: 'Emergency medicine', setting: 'Emergency department', difficulty: 'Core', minutes: 10 },
    patient: { name: 'Patient name', age: 50, sex: 'F', weight: 65 },
    triage: { note: 'Triage note', vitals: { HR: '110', BP: '95/60', RR: '24', SpO2: '93% air', Temp: '37.0', GCS: '15' } },
    physiology: {
      start: 0.5, rate: 0.06, recovery: 0.05, rhythm: { type: 'sinus', st: 0 },
      best: { hr: 80, sbp: 124, dbp: 78, rr: 16, spo2: 98, temp: 37 },
      initial: { hr: 110, sbp: 95, dbp: 60, rr: 24, spo2: 93, temp: 37 },
      worst: { hr: 145, sbp: 60, dbp: 32, rr: 36, spo2: 80, temp: 37 }
    },
    arrest: { rhythm: 'pea', requireAdrenaline: true, reversibleBy: [], roscSeverity: 0.8 },
    speech: { impairedAbove: 0.8, impairedText: '(Too unwell to answer.)' },
    appearance: [{ below: 0.3, text: 'Comfortable.' }, { below: 0.7, text: 'Unwell and distressed.' }, { below: 1.01, text: 'Peri-arrest.' }],
    history: [{ id: 'h_what', q: 'What happened?', keywords: ['what happen', 'start'], a: 'Answer.' }],
    exam: [{ id: 'e_general', label: 'General', text: 'Finding.' }],
    investigations: [{ id: 'i_cbg', group: 'Bedside', label: 'Capillary glucose', time: 60, text: '6.0 mmol/L (108 mg/dL).' }],
    interventions: [{ id: 'o2', group: 'Airway & breathing', label: 'High-flow oxygen', detail: '15 L/min non-rebreather', once: true, effects: { vitals: { spo2: 4 }, onset: 60 } }],
    diagnoses: [{ id: 'dx_1', label: 'Correct diagnosis' }, { id: 'dx_2', label: 'Distractor' }],
    dispositions: [{ id: 'disp_1', label: 'Correct disposition' }, { id: 'disp_2', label: 'Wrong disposition' }],
    scoring: {
      critical: [{ id: 'c_o2', label: 'Oxygen given', anyOf: ['o2'], within: 300, points: 20, why: 'Why it matters.' }],
      recommended: [{ id: 'r_mon', label: 'Monitoring attached', anyOf: ['monitor'], points: 5 }],
      penalties: [],
      diagnosis: { correct: 'dx_1', points: 15 },
      disposition: { correct: 'disp_1', points: 10 }
    },
    teaching: ['Teaching point.'], references: ['Guideline reference.']
  });
}
