// Debrief: scored breakdown, vital-sign trends, timeline and teaching points.
// Rendered from a saved attempt record, so it can be reopened any time by the student or teacher.
import { h, $, clamp, fmt } from './ui.js';
import { normalizeCase } from '/shared/case-schema.js';
import { evaluate } from '/shared/scoring.js';

const statusPill = s => s === 'done' ? h('span', {class:'pill good', text:'Done'}) : s === 'late' ? h('span', {class:'pill warn', text:'Late'}) : h('span', {class:'pill crit', text:'Missed'});
function checklist(items){
  return h('ul', {class:'checks'}, items.map(it => h('li', null,
    h('div', null, h('div', null, it.label), h('div', {class:'hint'}, it.t != null ? `at ${fmt(it.t)}` : 'not done', it.within != null ? ` · target ≤ ${fmt(it.within)}` : '')),
    h('div', {style:'text-align:right'}, statusPill(it.status), h('div', {class:'pts', text:`${it.earned}/${it.points}`})),
    it.status !== 'done' && it.why ? h('div', {class:'why', text:it.why}) : null)));
}
export function renderDebrief(root, C, rec, opts = {}){
  C = normalizeCase(C);
  rec = {timeline:[], notes:[], vlog:[], arrestBands:[], penalties:[], t:0, ...rec};
  const R = evaluate(C, rec);
  const dxLabel = id => (C.diagnoses.find(d => d.id === id) || {}).label || 'None chosen';
  const dispLabel = id => (C.dispositions.find(d => d.id === id) || {}).label || 'None chosen';
  const markers = R.crit.filter(x => x.t != null).map(x => ({t:x.t, label:x.label})).sort((a,b) => a.t - b.t);
  const sec = h('div', {class:'debrief'},
    h('div', {class:'db-head'},
      h('div', null, h('p', {class:'eyebrow', text:'Debrief'}), h('h1', {text:C.title}),
        h('p', {class:'sub'}, `${C.patient.name}, ${C.patient.age} ${C.patient.sex} · ${C.card.complaint} · ${fmt(rec.t)} of simulated time`),
        h('div', {class:'chips', style:'margin-top:10px'}, h('span', {class:'pill ' + R.outcome.tone, text:R.outcome.label}), h('span', {class:'pill ' + (R.passed ? 'good' : 'warn'), text:R.passed ? `Passed (≥ ${R.pass}%)` : `Below pass mark of ${R.pass}%`}))),
      h('div', {class:'scorebox'}, h('div', {class:'score', text:R.pct + '%'}), h('div', {class:'hint', text:`${R.earned} points − ${R.pen} penalty of ${R.max}`}))),
    h('div', {class:'db-actions'},
      opts.actions || [],
      h('button', {class:'btn', type:'button', id:'btnCopy', onclick:() => copySummary(C, rec, R, opts), text:'Copy summary'})),
    h('div', {id:'copyFallback', hidden:true}),
    h('div', {class:'db-grid'},
      h('div', {class:'card'}, h('h2', {text:'Critical actions'}), checklist(R.crit),
        h('h3', {text:'Recommended actions'}), checklist(R.rec)),
      h('div', {class:'card'},
        h('h2', {text:'Decisions'}),
        h('dl', {class:'kv'},
          h('dt', {text:'Your diagnosis'}), h('dd', null, dxLabel(rec.dx), ' ', R.dxOk ? h('span', {class:'pill good', text:'Correct'}) : h('span', {class:'pill crit', text:'Incorrect'})),
          h('dt', {text:'Correct'}), h('dd', {text:dxLabel(C.scoring.diagnosis.correct)}),
          h('dt', {text:'Your disposition'}), h('dd', null, dispLabel(rec.disp), ' ', R.dispPts === C.scoring.disposition.points ? h('span', {class:'pill good', text:'Correct'}) : R.dispPts ? h('span', {class:'pill warn', text:'Partly'}) : h('span', {class:'pill crit', text:'Incorrect'})),
          h('dt', {text:'Best disposition'}), h('dd', {text:dispLabel(C.scoring.disposition.correct)})),
        h('h3', {text:'Penalties'}),
        R.penalties.length ? h('ul', {class:'checks'}, R.penalties.map(p => h('li', null, h('div', null, p.why, h('div', {class:'hint', text:'at ' + fmt(p.t)})), h('div', {class:'pts', text:'−' + p.points})))) : h('p', {class:'hint', text:'No penalties.'}),
        rec.notes.length ? [h('h3', {text:'Notes on your choices'}), h('ul', {class:'checks'}, rec.notes.map(n => h('li', null, h('div', null, h('b', {text:n.label}), h('div', {class:'why', text:n.text})))))] : null)),
    h('div', {class:'db-grid'},
      h('div', {class:'card'}, h('h2', {text:'Vital signs'}), h('p', {class:'hint', text:'Recorded every 10 seconds of simulated time. Shaded areas are cardiac arrest. Numbered lines are critical actions. Hover or tap for values.'}), trendCharts(rec, markers)),
      h('div', {class:'card'}, h('h2', {text:'Your timeline'}), h('div', {class:'table-wrap'}, h('table', null, h('thead', null, h('tr', null, h('th', {text:'Time'}), h('th', {text:'Action'}))), h('tbody', null, rec.timeline.map(x => h('tr', null, h('td', {class:'num', text:fmt(x.t)}), h('td', {text:x.label})))))))),
    h('div', {class:'card prose'}, h('h2', {text:'Teaching points'}), h('ul', null, C.teaching.map(t => h('li', {text:t}))),
      C.references.length ? [h('h3', {text:'References'}), h('ul', null, C.references.map(r => h('li', {class:'hint', text:r})))] : null)
  );
  root.replaceChildren(sec);
}

function trendCharts(rec, markers){
  const data = rec.vlog, tEnd = Math.max(60, rec.t);
  const W = 640, H = 112, L = 40, R = 12, T = 12, B = 20;
  const X = t => L + (t/tEnd)*(W - L - R);
  const specs = [{k:'hr', name:'Heart rate', unit:'bpm', lo:40, hi:160}, {k:'sbp', name:'Systolic BP', unit:'mmHg', lo:40, hi:160}, {k:'spo2', name:'SpO₂', unit:'%', lo:70, hi:100}];
  for (const s of specs){
    const vals = data.map(d => d[s.k]).filter(v => v != null);
    if (vals.length){ s.lo = Math.min(s.lo, Math.floor((Math.min(...vals) - 5)/10)*10); s.hi = Math.max(s.hi, Math.ceil((Math.max(...vals) + 5)/10)*10); }
    if (s.k === 'spo2') s.hi = 100;
  }
  const stepMin = [1, 2, 5, 10, 15, 30].find(m => tEnd/60/m <= 8) || 60;
  const NS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs, ...kids) => { const el = document.createElementNS(NS, tag); for (const [k,v] of Object.entries(attrs || {})) el.setAttribute(k, v); for (const k of kids) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k))); return el; };
  const wrap = h('div', {style:'display:flex;flex-direction:column;gap:10px'});
  const hovers = [];
  specs.forEach((s, si) => {
    const Y = v => T + (1 - (v - s.lo)/(s.hi - s.lo))*(H - T - B);
    const svg = sv('svg', {viewBox:`0 0 ${W} ${H}`, role:'img', 'aria-label':`${s.name} over time`});
    const grid = sv('g', {class:'grid'});
    for (const v of [s.lo, Math.round((s.lo + s.hi)/2), s.hi]){ grid.append(sv('line', {x1:L, x2:W - R, y1:Y(v), y2:Y(v)})); svg.append(sv('text', {x:L - 6, y:Y(v) + 4, 'text-anchor':'end'}, v)); }
    for (let m = 0; m*60 <= tEnd; m += stepMin) svg.append(sv('text', {x:X(m*60), y:H - 4, 'text-anchor':'middle'}, m + 'm'));
    svg.prepend(grid);
    for (const b of rec.arrestBands) svg.append(sv('rect', {class:'band', x:X(b.start), y:T, width:Math.max(2, X(b.end ?? rec.t) - X(b.start)), height:H - T - B}));
    let d = '', pen = false, lastPt = null;
    for (const p of data){ if (p[s.k] == null){ pen = false; continue; } d += (pen ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(p[s.k]).toFixed(1); pen = true; lastPt = p; }
    if (d) svg.append(sv('path', {class:'series', d}));
    if (lastPt) svg.append(sv('circle', {class:'end', cx:X(lastPt.t), cy:Y(lastPt[s.k]), r:4}));
    const mk = sv('g', {class:'mk'});
    let lastX = -99, row = 0;
    markers.forEach((m, i) => {
      mk.append(sv('line', {x1:X(m.t), x2:X(m.t), y1:T, y2:H - B}));
      row = X(m.t) - lastX < 16 ? row + 1 : 0; lastX = X(m.t);   // stack markers that would overlap
      const cy = T + (row % 4)*16;
      if (si === 0){ mk.append(sv('circle', {cx:X(m.t), cy, r:7})); mk.append(sv('text', {x:X(m.t), y:cy}, i + 1)); }
    });
    svg.append(mk);
    const hv = sv('g', {class:'hover', visibility:'hidden'}); const hl = sv('line', {y1:T, y2:H - B}); const hc = sv('circle', {r:4}); hv.append(hl, hc); svg.append(hv);
    const out = h('output', {text:''});
    const fig = h('figure', {class:'chart'}, h('figcaption', null, h('span', null, h('b', {text:s.name}), ' ', h('span', {class:'muted', text:s.unit})), out), svg);
    hovers.push({svg, hv, hl, hc, out, s, Y});
    wrap.append(fig);
  });
  const show = (clientX, svg) => {
    const r = svg.getBoundingClientRect(); const x = (clientX - r.left)/r.width*W;
    const t = clamp((x - L)/(W - L - R)*tEnd, 0, tEnd);
    let best = null; for (const p of data) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    if (!best) return;
    for (const o of hovers){
      const val = best[o.s.k];
      o.hv.setAttribute('visibility', 'visible'); o.hl.setAttribute('x1', X(best.t)); o.hl.setAttribute('x2', X(best.t));
      if (val == null){ o.hc.setAttribute('visibility', 'hidden'); o.out.textContent = `${fmt(best.t)} · no reading`; }
      else { o.hc.setAttribute('visibility', 'visible'); o.hc.setAttribute('cx', X(best.t)); o.hc.setAttribute('cy', o.Y(val)); o.out.textContent = `${fmt(best.t)} · ${val} ${o.s.unit}`; }
    }
  };
  const hide = () => { for (const o of hovers){ o.hv.setAttribute('visibility', 'hidden'); o.out.textContent = ''; } };
  for (const o of hovers){ o.svg.addEventListener('pointermove', e => show(e.clientX, o.svg)); o.svg.addEventListener('pointerleave', hide); }
  if (markers.length) wrap.append(h('ol', {class:'marks'}, markers.map((m, i) => h('li', null, h('b', {text:i + 1}), h('time', {text:fmt(m.t)}), ' ', m.label))));
  const tbl = h('details', null, h('summary', {text:'Show values as a table'}), h('div', {class:'table-wrap'}, h('table', null,
    h('thead', null, h('tr', null, h('th', {text:'Time'}), h('th', {text:'HR'}), h('th', {text:'SBP'}), h('th', {text:'SpO₂'}))),
    h('tbody', null, data.filter((_, i) => i % 3 === 0 || i === data.length - 1).map(p => h('tr', null, h('td', {class:'num', text:fmt(p.t)}), h('td', {class:'num', text:p.hr ?? '—'}), h('td', {class:'num', text:p.sbp ?? '—'}), h('td', {class:'num', text:p.spo2 ?? '—'})))))));
  wrap.append(tbl);
  return wrap;
}

function copySummary(C, rec, R, opts){
  const lines = [
    `Resus Bay debrief: ${C.title}`,
    ...(opts.student ? [`Student: ${opts.student.name} (${opts.student.username})`] : []),
    `Patient: ${C.patient.name}, ${C.patient.age} ${C.patient.sex} (case id ${C.id})`,
    `Date: ${new Date().toLocaleString()}`,
    `Score: ${R.pct}% (pass mark ${R.pass}%) · ${R.passed ? 'PASSED' : 'NOT YET PASSED'}`,
    `Outcome: ${R.outcome.label} · simulated time ${fmt(rec.t)}`,
    '', 'Critical actions:',
    ...R.crit.map(x => `  [${x.status.toUpperCase()}] ${x.label}${x.t != null ? ' at ' + fmt(x.t) : ''}`),
    'Recommended actions:',
    ...R.rec.map(x => `  [${x.status.toUpperCase()}] ${x.label}${x.t != null ? ' at ' + fmt(x.t) : ''}`),
    'Penalties:', ...(R.penalties.length ? R.penalties.map(p => `  -${p.points} at ${fmt(p.t)}: ${p.why}`) : ['  none']),
    `Diagnosis: ${(C.diagnoses.find(d => d.id === rec.dx) || {}).label || 'none'} (${R.dxOk ? 'correct' : 'incorrect'})`,
    `Disposition: ${(C.dispositions.find(d => d.id === rec.disp) || {}).label || 'none'}`,
    '', 'Timeline:', ...rec.timeline.map(x => `  ${fmt(x.t)}  ${x.label}`)
  ];
  const text = lines.join('\n');
  const fallback = () => { const box = $('#copyFallback'); box.hidden = false; const ta = h('textarea', {class:'copybox', readonly:true, 'aria-label':'Result summary'}); ta.value = text; box.replaceChildren(h('p', {class:'hint', text:'Copy this text and send it to your teacher:'}), ta); ta.focus(); ta.select(); };
  const btn = $('#btnCopy');
  try {
    navigator.clipboard.writeText(text).then(() => { btn.textContent = 'Copied'; setTimeout(() => btn.textContent = 'Copy summary', 2000); }, fallback);
  } catch(e){ fallback(); }
}

