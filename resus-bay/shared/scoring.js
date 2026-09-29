// Scoring shared by the browser (debrief) and the server (authoritative score).
// `record` is what the simulator produces at the end of a case:
// { t, timeline:[{t,id,label,kind}], penalties:[{key,points,why,t}], dx, disp,
//   died, endedInArrest, arrests, finalSeverity }

const sum = (a, k) => a.reduce((s, x) => s + (Number(x[k]) || 0), 0);

export function evaluate(c, record) {
  const sc = c.scoring;
  const timeline = Array.isArray(record.timeline) ? record.timeline : [];
  const nth = (ids, n) => {
    const ts = timeline.filter(x => ids.includes(x.id)).map(x => Number(x.t) || 0).sort((a, b) => a - b);
    return ts.length >= n ? ts[n - 1] : null;
  };
  const item = it => {
    const t = nth(it.anyOf || [], it.count || 1);
    let status = 'missed', earned = 0;
    if (t != null) {
      if (it.within != null && t > it.within) { status = 'late'; earned = Math.round(it.points / 2); }
      else { status = 'done'; earned = it.points; }
    }
    return { id: it.id, label: it.label, why: it.why, within: it.within, points: it.points, t, status, earned };
  };
  const crit = (sc.critical || []).map(item);
  const rec = (sc.recommended || []).map(item);
  const dxOk = record.dx === sc.diagnosis.correct;
  const dxPts = dxOk ? sc.diagnosis.points : 0;
  const dispPts = record.disp === sc.disposition.correct ? sc.disposition.points : ((sc.disposition.partial || {})[record.disp] || 0);
  const penalties = (Array.isArray(record.penalties) ? record.penalties : [])
    .map(p => ({ key: String(p.key), points: Math.max(0, Math.min(100, Number(p.points) || 0)), why: String(p.why || ''), t: Number(p.t) || 0 }));
  const max = sum(crit, 'points') + sum(rec, 'points') + sc.diagnosis.points + sc.disposition.points;
  const earned = sum(crit, 'earned') + sum(rec, 'earned') + dxPts + dispPts;
  const pen = sum(penalties, 'points');
  const pct = max > 0 ? Math.max(0, Math.min(100, Math.round((earned - pen) / max * 100))) : 0;
  const pass = c.passMark || 80;
  const start = c.physiology.start;
  let outcome;
  if (record.died) outcome = { label: 'Patient died', tone: 'crit' };
  else if (record.endedInArrest) outcome = { label: 'Case ended during cardiac arrest', tone: 'crit' };
  else if (record.arrests) outcome = { label: 'Survived a cardiac arrest', tone: 'warn' };
  else if (record.finalSeverity < 0.25) outcome = { label: 'Patient stabilised', tone: 'good' };
  else if (record.finalSeverity < start) outcome = { label: 'Improving', tone: 'good' };
  else outcome = { label: 'Still unstable at handover', tone: 'warn' };
  return { crit, rec, penalties, dxOk, dxPts, dispPts, max, earned, pen, pct, pass, passed: pct >= pass && !record.died, outcome };
}

/** Compact per-attempt summary stored for fast class analytics. */
export function summarize(R, record) {
  return {
    crit: R.crit.map(x => ({ id: x.id, s: x.status, t: x.t })),
    rec: R.rec.map(x => ({ id: x.id, s: x.status })),
    pen: R.penalties.map(p => p.key),
    dx: record.dx || null, disp: record.disp || null, dxOk: R.dxOk
  };
}
