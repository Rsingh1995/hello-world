// The bedside simulator: physiology engine, sweeping monitor and the case UI.
// mountSim(container, caseData, {onEnd(record), badge}) runs one case at a time.
import { h, $, clamp, lerp, fmt, humanTime } from './ui.js';
import { normalizeCase } from '/shared/case-schema.js';

const VITAL_KEYS = ['hr','sbp','dbp','rr','spo2','temp'];
const GROUP_ORDER = ['Monitoring','Airway & breathing','Circulation','Medications','Procedures','Help & referral','Resuscitation'];
const GENERIC_ACTIONS = [
  {id:'monitor', group:'Monitoring', label:'Attach monitoring', detail:'3-lead ECG, SpO₂, NIBP, temperature', once:true, say:'Nurse: “Monitoring is on.”'},
  {id:'iv_access', group:'Circulation', label:'IV access', detail:'Two large-bore cannulae; bloods drawn', once:true, say:'Nurse: “Two cannulae in and bloods drawn.”'},
  {id:'cpr', group:'Resuscitation', label:'Start CPR', detail:'30:2, 100–120/min, 5–6 cm deep', resus:'cpr'},
  {id:'rhythm_check', group:'Resuscitation', label:'Rhythm & pulse check', detail:'Pause compressions for < 10 s', resus:'check'},
  {id:'defib', group:'Resuscitation', label:'Defibrillate', detail:'150–200 J biphasic, unsynchronised', resus:'shock'},
  {id:'adr_1mg_iv', group:'Resuscitation', label:'Adrenaline 1 mg IV/IO', detail:'Cardiac-arrest dose, every 3–5 min', requires:['iv_access'], resus:'adr'},
  {id:'amio_300', group:'Resuscitation', label:'Amiodarone 300 mg IV/IO', detail:'After 3 shocks in VF/pVT', requires:['iv_access'], resus:'amio'}
];
const RHYTHM_NAMES = {vf:'ventricular fibrillation', pea:'pulseless electrical activity', asystole:'asystole'};

let C = null;   // active case
let S = null;   // simulation state
let ACT = {};   // action map for the active case

function count(id){ return (S && S.counts[id]) || 0; }
function anyDone(ids){ return [].concat(ids).some(id => count(id) > 0); }

function buildActions(c){
  const map = {};
  for (const a of GENERIC_ACTIONS) map[a.id] = {...a};
  for (const a of c.interventions) map[a.id] = {...(map[a.id] || {group:'Medications'}), ...a};
  return map;
}

function newState(c){
  return {
    t:0, speed:1, paused:false, ended:false, endReason:null,
    sev:c.physiology.start, sevFx:[], vitFx:[], prog:[], v:null,
    monitor:false, nibp:null, nibpNext:0, nibpUntil:null,
    counts:{}, timeline:[], log:[], pending:[], results:[], findings:[], transcript:[],
    penalties:[], notes:[], arrest:null, arrests:0, roscs:0, died:false, arrestBands:[],
    vlog:[], nextVlog:0, appearance:null, dx:null, disp:null, alarmAt:0,
    order:{dx:shuffle(c.diagnoses.slice()), disp:shuffle(c.dispositions.slice())}
  };
}
function shuffle(a){ for (let i = a.length-1; i > 0; i--){ const j = Math.floor(Math.random()*(i+1)); [a[i],a[j]] = [a[j],a[i]]; } return a; }

/* ---- physiology ---- */
function baseVitals(sev){
  const P = C.physiology, s0 = P.start, out = {};
  for (const k of VITAL_KEYS){
    const b = P.best[k], i = P.initial[k], w = P.worst[k];
    out[k] = sev <= s0 ? lerp(b, i, sev/s0) : lerp(i, w, (sev-s0)/(1-s0));
  }
  return out;
}
function vitalsNow(){
  if (S.arrest) return {hr: S.arrest.rhythm === 'pea' ? 42 : 0, sbp:0, dbp:0, rr:0, spo2:null, temp:C.physiology.initial.temp};
  const v = baseVitals(S.sev);
  for (const e of S.vitFx){
    if (S.t < e.start) continue;
    let f = clamp((S.t - e.start)/Math.max(1, e.onset), 0, 1);
    if (e.until != null && S.t > e.until) f *= clamp(1 - (S.t - e.until)/60, 0, 1);
    for (const [k,d] of Object.entries(e.vitals)) v[k] += d*f;
  }
  v.spo2 = clamp(v.spo2, 50, 100); v.hr = clamp(v.hr, 20, 220); v.sbp = clamp(v.sbp, 30, 240);
  v.dbp = clamp(v.dbp, 15, Math.max(20, v.sbp - 12)); v.rr = clamp(v.rr, 4, 60);
  return v;
}
function progFactor(){
  let f = 1;
  for (const m of S.prog) if (S.t >= m.start && (m.until == null || S.t < m.until)) f *= m.factor;
  return f;
}
function applyEffects(a){
  const ef = a.effects; if (!ef) return;
  if (ef.unlessDone && anyDone(ef.unlessDone)) return;
  if (ef.maxSeverity != null && S.sev > ef.maxSeverity){ if (ef.blockedSay) log('speech', ef.blockedSay); return; }
  const start = S.t + (ef.delay || 0), onset = ef.onset || 60;
  if (ef.severity) S.sevFx.push({start, onset, total:ef.severity, applied:0});
  if (ef.vitals) S.vitFx.push({start, onset, vitals:ef.vitals, until: ef.duration ? start + ef.duration : null});
  if (ef.progression) S.prog.push({start, factor:ef.progression.factor, until: ef.progression.duration ? start + ef.progression.duration : null});
}

function tick(dt){
  if (!S || S.ended || S.paused) return;
  S.t += dt;
  const P = C.physiology;
  if (!S.arrest){
    const f = progFactor();
    if (f > 0) S.sev += (P.rate/60)*f*dt; else S.sev -= (P.recovery/60)*dt;
  }
  for (const e of S.sevFx){
    if (S.t < e.start || e.done) continue;
    const target = e.total * clamp((S.t - e.start)/Math.max(1, e.onset), 0, 1);
    const d = target - e.applied; e.applied = target; if (target === e.total) e.done = true;
    if (!S.arrest) S.sev += d;
  }
  S.sev = clamp(S.sev, 0, 1);
  if (!S.arrest && S.sev >= 1){ if (C.arrest) startArrest(); }
  if (S.arrest) arrestTick();
  if (S.ended) return;
  S.v = vitalsNow();
  for (const p of S.pending.slice()){
    if (S.t >= p.ready){
      S.pending.splice(S.pending.indexOf(p), 1); S.results.unshift(p);
      log('result', p.text, p.label); markTab('investigate');
      if (UI.tab === 'investigate') renderInvestigate();
    }
  }
  if (S.monitor){
    if (S.nibpUntil != null){ if (S.t >= S.nibpUntil) finishNibp(); }
    else if (S.t >= S.nibpNext) startNibp();
  }
  if (S.t >= S.nextVlog){
    const v = S.v;
    S.vlog.push({t:S.t, hr:S.arrest ? null : Math.round(v.hr), sbp:S.arrest ? null : Math.round(v.sbp), spo2:S.arrest ? null : Math.round(v.spo2)});
    S.nextVlog = S.t + 10;
  }
  updateAppearance();
}

/* ---- cardiac arrest ---- */
const isShockable = r => r === 'vf' || r === 'pvt';
function startArrest(){
  S.arrest = {start:S.t, rhythm:C.arrest.rhythm, cpr:false, shocks:0, adr:0, amio:0, roscAt:null, checkUntil:0};
  S.arrests++; S.arrestBands.push({start:S.t, end:null});
  S.v = vitalsNow();
  addPenalty('arrest', 15, 'The patient deteriorated into cardiac arrest.');
  log('alert', `Cardiac arrest: unresponsive, not breathing normally, no pulse. Monitor shows ${RHYTHM_NAMES[S.arrest.rhythm]}.`);
  log('speech', 'Nurse: “No pulse! Shall I start compressions?”');
  $('#arrestBanner').hidden = false; switchTab('treat');
}
function arrestTick(){
  const A = S.arrest, cfg = C.arrest, el = S.t - A.start;
  if (!A.cpr && el > 60) addPenalty('cpr_delay', 10, 'CPR was not started within 1 minute of cardiac arrest.');
  if (isShockable(A.rhythm) && A.shocks === 0 && el > 120) addPenalty('shock_delay', 10, 'The first shock for a shockable rhythm was delayed beyond 2 minutes.');
  if (A.roscAt == null && A.cpr){
    const ok = isShockable(A.rhythm)
      ? A.shocks >= (cfg.shocksNeeded || 1)
      : (cfg.requireAdrenaline === false || A.adr > 0) && (!cfg.reversibleBy || anyDone(cfg.reversibleBy));
    if (ok) A.roscAt = S.t + (isShockable(A.rhythm) ? 20 : 30);
  }
  if (A.roscAt != null && S.t >= A.roscAt){
    S.roscs++; S.arrestBands[S.arrestBands.length-1].end = S.t; S.arrest = null;
    S.sev = cfg.roscSeverity ?? 0.8; S.nibpUntil = null; S.nibpNext = S.t + 3;
    log('alert', 'ROSC: a pulse is back. Reassess ABCDE and treat the cause.');
    $('#arrestBanner').hidden = true; renderTreat();
  } else if (el >= 600){
    S.died = true; S.arrestBands[S.arrestBands.length-1].end = S.t;
    addPenalty('death', 30, 'Resuscitation was unsuccessful after 10 minutes.');
    log('alert', 'Resuscitation stopped after 10 minutes. The patient died.');
    endCase('died');
  }
}
function currentRhythm(){
  if (!S) return {type:'sinus', beats:true, hr:72, pulse:true, perf:1, rr:14, st:0, p:true};
  if (S.arrest){
    const r = S.arrest.rhythm;
    return {type:r, beats:r === 'pea', hr:42, pulse:false, perf:0, rr:0, st:0, p:true, cpr:S.arrest.cpr && S.t >= S.arrest.checkUntil};
  }
  const v = S.v || vitalsNow(), base = C.physiology.rhythm;
  return {type:base.type || 'sinus', beats:true, hr:v.hr, pulse:true, perf:clamp(v.sbp/120, 0.15, 1), rr:v.rr, st:base.st || 0, p:base.type !== 'af'};
}

/* ---- actions ---- */
function addPenalty(key, points, why){
  if (S.penalties.some(p => p.key === key)) return;
  S.penalties.push({key, points, why, t:S.t});
}
function checkRules(id, v){
  C.scoring.penalties.forEach((r, i) => {
    if (r.ifAction !== id) return;
    if (r.before && anyDone(r.before)) return;
    if (r.ifDone && !anyDone(r.ifDone)) return;
    if (r.when){
      for (const [k,c] of Object.entries(r.when)){
        const x = k === 'severity' ? S.sev : v[k];
        if (x == null) return;
        if (c.gte != null && !(x >= c.gte)) return; if (c.gt != null && !(x > c.gt)) return;
        if (c.lt != null && !(x < c.lt)) return;   if (c.lte != null && !(x <= c.lte)) return;
      }
    }
    addPenalty('rule:' + i, r.points, r.why);
  });
}
function record(id, label, kind){
  const v = S.v || vitalsNow();
  checkRules(id, v);                                  // rules look at what was done *before* this action
  S.counts[id] = (S.counts[id] || 0) + 1;
  S.timeline.push({t:S.t, id, label, kind});
}
function perform(id){
  if (!S || S.ended) return;
  const a = ACT[id]; if (!a) return;
  if (S.paused) togglePause(false);
  if (a.requires && !anyDone(a.requires)){ log('speech', a.requiresSay || 'Nurse: “We need IV access for that first.”'); return; }
  if (a.once && count(id) > 0){ log('system', `${a.label}: already done.`); return; }
  if (a.max && count(id) >= a.max){ log('system', `${a.label}: maximum of ${a.max} reached. Ask for senior help.`); return; }
  if (a.resus){ resus(a); refreshAfterAction(); return; }
  record(id, a.label, 'treat');
  log('action', a.label + (a.detail && !a.say ? ` (${a.detail})` : ''));
  if (a.say) log('speech', a.say);
  if (a.harm) addPenalty('harm:' + id, a.harm.points, a.harm.why);
  if (a.feedback && !S.notes.some(n => n.id === id)) S.notes.push({id, label:a.label, text:a.feedback});
  applyEffects(a);
  if (id === 'monitor'){ S.monitor = true; S.nibpNext = S.t; S.v = vitalsNow(); monitorOverlay(); updateNumerics(); }
  refreshAfterAction();
}
function resus(a){
  const A = S.arrest, kind = a.resus;
  if (kind === 'cpr'){
    if (!A){ record(a.id, 'CPR attempted on a patient with a pulse', 'treat'); addPenalty('cpr_pulse', 15, 'Chest compressions were started on a patient with a pulse.'); log('speech', 'Nurse: “Wait, there is a pulse. Compressions aren’t indicated.”'); return; }
    if (A.cpr){ log('system', 'CPR is already in progress.'); return; }
    A.cpr = true; record(a.id, a.label, 'treat');
    log('action', 'CPR started: 30:2 at 100–120/min, 5–6 cm deep. Swap compressors every 2 minutes.'); return;
  }
  if (kind === 'check'){
    record(a.id, a.label, 'treat');
    if (!A){ const v = S.v || vitalsNow(); log('speech', `Nurse: “Pulse present. Heart rate about ${Math.round(v.hr)}.”`); return; }
    A.checkUntil = S.t + 8;
    log('speech', `Rhythm check: ${RHYTHM_NAMES[A.rhythm]}, no pulse. ${isShockable(A.rhythm) ? 'Shockable: charge the defibrillator.' : 'Non-shockable: continue CPR, give adrenaline, treat reversible causes.'}`);
    return;
  }
  if (kind === 'shock'){
    record(a.id, a.label, 'treat');
    if (!A){ addPenalty('shock_pulse', 25, 'An unsynchronised shock was delivered to a patient with a pulse, which can induce VF.'); log('alert', 'Unsynchronised shock delivered to a patient with a pulse.'); return; }
    if (!isShockable(A.rhythm)){ addPenalty('shock_nonshock', 10, 'A non-shockable rhythm was shocked. This interrupts CPR without benefit.'); log('speech', 'Shock delivered. Rhythm unchanged. Resume CPR.'); return; }
    A.shocks++; log('action', `Shock ${A.shocks} delivered (200 J biphasic). Resume CPR immediately for 2 minutes.`); return;
  }
  if (kind === 'adr'){
    record(a.id, a.label, 'treat');
    if (!A){
      addPenalty('adr_pulse', 20, C.ivAdrenalineHarm || 'Adrenaline 1 mg IV is the cardiac-arrest dose. In a patient with a pulse it can cause severe hypertension, VT/VF and myocardial ischaemia.');
      log('alert', 'Adrenaline 1 mg IV given to a patient with a pulse.');
      S.vitFx.push({start:S.t, onset:20, vitals:{hr:40, sbp:60, dbp:30}, until:S.t + 180}); return;
    }
    A.adr++; log('action', `Adrenaline 1 mg IV given (dose ${A.adr}). Repeat every 3–5 minutes.`); return;
  }
  if (kind === 'amio'){
    record(a.id, a.label, 'treat');
    if (!A || !isShockable(A.rhythm)){ addPenalty('amio_wrong', 10, 'Amiodarone 300 mg is for shock-refractory VF/pVT. It was not indicated here.'); log('system', 'Amiodarone 300 mg given.'); return; }
    A.amio++; log('action', 'Amiodarone 300 mg IV given.');
  }
}
function resolveText(item){
  for (const v of item.variants || []) if (matchCond(v.if)) return v.text;
  return item.text;
}
function matchCond(c){
  if (!c) return true;
  if (c.done && !anyDone(c.done)) return false;
  if (c.notDone && anyDone(c.notDone)) return false;
  if (c.severityBelow != null && !(S.sev < c.severityBelow)) return false;
  if (c.severityAbove != null && !(S.sev > c.severityAbove)) return false;
  return true;
}
function order(id){
  if (!S || S.ended) return;
  const inv = C.investigations.find(x => x.id === id); if (!inv) return;
  if (S.paused) togglePause(false);
  if (S.pending.some(p => p.id === id)){ log('system', `${inv.label} is already pending.`); return; }
  record(id, 'Ordered ' + inv.label, 'investigate');
  const time = inv.time || 60;
  S.pending.push({id, label:inv.label, text:resolveText(inv), ordered:S.t, ready:S.t + time});
  log('action', `Ordered ${inv.label}. Result in about ${humanTime(time)}.`);
  refreshAfterAction();
}
function examine(id){
  if (!S || S.ended) return;
  const e = C.exam.find(x => x.id === id); if (!e) return;
  if (S.paused) togglePause(false);
  record(id, 'Examined ' + e.label.toLowerCase(), 'exam');
  const text = S.arrest ? 'Unresponsive. No breathing, no central pulse.' : resolveText(e);
  S.findings.unshift({t:S.t, label:e.label, text});
  log('action', `Examined ${e.label.toLowerCase()}.`);
  refreshAfterAction();
}
function ask(item, typed){
  if (!S || S.ended) return;
  if (S.paused) togglePause(false);
  record(item.id, 'Asked: ' + item.q, 'history');
  const src = item.source || 'Patient';
  let ans = resolveText({text:item.a, variants:item.variants});
  if (src === 'Patient'){
    if (S.arrest) ans = '(No response. The patient is unresponsive.)';
    else if (C.speech && S.sev > C.speech.impairedAbove) ans = C.speech.impairedText;
  }
  S.transcript.push({who:'You', text:typed || item.q}, {who:src, text:ans});
  log('action', 'Asked: ' + item.q);
  refreshAfterAction();
}
function matchQuestion(text){
  const q = text.toLowerCase(); let best = null, score = 0;
  for (const it of C.history){
    let s = 0; for (const k of it.keywords || []) if (q.includes(k.toLowerCase())) s += k.length;
    if (s > score){ score = s; best = it; }
  }
  return best;
}
function askFree(text){
  text = text.trim(); if (!text) return;
  const it = matchQuestion(text);
  if (it) return ask(it, text);
  S.transcript.push({who:'You', text}, {who:'Patient', text:S.arrest ? '(No response.)' : '(Looks puzzled.) Sorry, I don’t follow. Could you ask that another way?'});
  refreshAfterAction();
}

/* ---- NIBP ---- */
function startNibp(){ S.nibpUntil = S.t + 15; updateNumerics(); }
function finishNibp(){
  const v = S.v || vitalsNow();
  S.nibp = S.arrest ? {fail:true, t:S.t} : {sbp:Math.round(v.sbp), dbp:Math.round(v.dbp), t:S.t};
  S.nibpUntil = null; S.nibpNext = S.t + (C.nibpInterval || 180);
  updateNumerics();
}

/* ---- appearance ---- */
function updateAppearance(){
  let text;
  if (S.arrest) text = 'Unresponsive. Not breathing normally. No central pulse.';
  else { const band = C.appearance.find(b => S.sev < b.below); text = band ? band.text : ''; }
  if (text !== S.appearance){
    if (S.appearance != null) log('observe', 'Patient now: ' + text);
    S.appearance = text; $('#appearance').textContent = text;
  }
}

/* ---- log ---- */
function log(kind, text, title){
  const entry = {t:S.t, kind, text, title};
  S.log.push(entry);
  const li = h('li', {class:kind}, h('time', {text:fmt(entry.t)}), h('span', {class:'txt'}, title ? [h('b', {text:title + ': '}), text] : text));
  const ol = $('#log'); ol.prepend(li);
}

/* ======================================================================
   MONITOR RENDERING (sweep display)
   ====================================================================== */
const g = (x, mu, s, a) => { const z = (x - mu)/s; return a*Math.exp(-0.5*z*z); };
function ecgBeat(d, rr, rh){
  const k = clamp(Math.sqrt(rr), 0.55, 1.1), w = rh.type === 'pea' ? 2.2 : 1;
  let v = 0;
  if (rh.p) v += g(d, 0.07, 0.022, 0.13);
  const q0 = 0.17;
  v += g(d, q0, 0.008*w, -0.09) + g(d, q0 + 0.022*w, 0.009*w, 1) + g(d, q0 + 0.045*w, 0.01*w, -0.24);
  const tMu = q0 + 0.045*w + 0.19*k;
  v += g(d, tMu, 0.045*k, 0.28);
  if (rh.st){ const j = q0 + 0.05*w; v += rh.st/(1 + Math.exp(-(d - j)/0.006))/(1 + Math.exp((d - tMu - 0.04)/0.025)); }
  return v;
}
const plethBeat = (d, perf) => (d < 0 || d > 1.2) ? 0 : perf*(g(d, 0.13, 0.055, 1) + g(d, 0.36, 0.08, 0.32));
const vfWave = t => (0.42*Math.sin(2*Math.PI*4.6*t) + 0.28*Math.sin(2*Math.PI*6.2*t + 1.1) + 0.16*Math.sin(2*Math.PI*3.1*t + 2.3))*(0.75 + 0.25*Math.sin(2*Math.PI*0.35*t));

function makeSource(getRh, onBeat){
  const st = {next:0, beats:[]};
  return t => {
    const rh = getRh();
    if (rh.beats){
      if (st.next < t - 2) st.next = t;
      while (t >= st.next){
        const base = 60/Math.max(20, rh.hr);
        const rr = base*(rh.type === 'af' ? 0.65 + Math.random()*0.7 : 0.985 + Math.random()*0.03);
        st.beats.push({t:st.next, rr}); if (st.beats.length > 4) st.beats.shift();
        if (onBeat) onBeat(rh);
        st.next += rr;
      }
    } else st.next = t;
    let e = 0, p = 0;
    if (rh.beats) for (const b of st.beats){ const d = t - b.t; if (d >= 0 && d < 1.6){ e += ecgBeat(d, b.rr, rh); if (rh.pulse) p += plethBeat(d - 0.2, rh.perf); } }
    if (rh.type === 'vf') e = vfWave(t);
    else if (rh.type === 'asystole') e = 0.015*Math.sin(t*2.1);
    if (rh.type === 'af') e += 0.035*Math.sin(2*Math.PI*6.7*t) + 0.025*Math.sin(2*Math.PI*9.3*t + 1.3);
    e += (Math.random() - 0.5)*0.012;
    if (rh.cpr){ const c = Math.max(0, Math.sin(2*Math.PI*1.9*t)); e += 0.8*c*c; p = 0.4*c*c; }
    const r = rh.rr > 0 ? Math.sin(2*Math.PI*(rh.rr/60)*t) : 0;
    return [e, p, r];
  };
}

class Sweep {
  constructor(canvas, o){
    this.c = canvas; this.ctx = canvas.getContext('2d'); this.o = o; this.x = 0; this.wt = 0; this.prev = [];
    if ('ResizeObserver' in window) new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }
  resize(){
    const r = this.c.getBoundingClientRect(); if (!r.width || !r.height) return;
    this.dpr = window.devicePixelRatio || 1; this.w = r.width; this.h = r.height;
    this.c.width = Math.round(r.width*this.dpr); this.c.height = Math.round(r.height*this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.pps = this.w/(this.o.seconds || 6);
    this.clear();
  }
  clear(){ this.ctx.fillStyle = this.o.bg; this.ctx.fillRect(0, 0, this.w, this.h); this.x = 0; this.prev = this.o.channels.map(() => null); }
  erase(a, b){
    const ctx = this.ctx; ctx.fillStyle = this.o.bg;
    ctx.fillRect(a, 0, Math.min(b, this.w) - a, this.h);
    if (b > this.w) ctx.fillRect(0, 0, b - this.w, this.h);
  }
  step(dt){
    if (!this.w) { this.resize(); if (!this.w) return; }
    const ctx = this.ctx, W = this.w, n = this.o.channels.length, band = this.h/n;
    const dx = dt*this.pps, steps = Math.max(1, Math.ceil(dx*2));
    this.erase(this.x, this.x + dx + 14);
    const pts = this.o.channels.map(() => []);
    for (let i = 1; i <= steps; i++){
      const x = this.x + dx*i/steps, t = this.wt + dt*i/steps, vals = this.o.sample(t);
      for (let c = 0; c < n; c++) pts[c].push([x, this.o.channels[c].y(vals[c], band, c*band)]);
    }
    ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
    for (let c = 0; c < n; c++){
      ctx.strokeStyle = this.o.channels[c].color; ctx.beginPath();
      let p = this.prev[c]; if (p) ctx.moveTo(p[0], p[1]);
      for (let [x, y] of pts[c]){ if (x >= W) x -= W; if (!p || x < p[0]) ctx.moveTo(x, y); else ctx.lineTo(x, y); p = [x, y]; }
      ctx.stroke(); this.prev[c] = p;
    }
    this.x = (this.x + dx) % W; this.wt += dt;
  }
}

const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const MON = {sweep:null, sound:false, audio:null, lastBeep:0};
const UI = {active:false, tab:'history', endArm:0, raf:0, timers:[], opts:{}};

function audioCtx(){ try { MON.audio = MON.audio || new (window.AudioContext || window.webkitAudioContext)(); if (MON.audio.state === 'suspended') MON.audio.resume(); return MON.audio; } catch(e){ return null; } }
function tone(freq, dur = 0.07, vol = 0.07, delay = 0){
  if (!MON.sound) return; const ac = audioCtx(); if (!ac) return;
  try {
    const o = ac.createOscillator(), gn = ac.createGain(), t0 = ac.currentTime + delay;
    o.type = 'sine'; o.frequency.value = freq;
    gn.gain.setValueAtTime(vol, t0); gn.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(gn).connect(ac.destination); o.start(t0); o.stop(t0 + dur + 0.02);
  } catch(e){}
}
function onBeat(){
  if (!MON.sound || !S || !S.monitor) return;
  const now = performance.now(); if (now - MON.lastBeep < 220) return; MON.lastBeep = now;
  const sp = S.v && S.v.spo2 != null ? S.v.spo2 : 90;
  tone(clamp(380 + (sp - 70)*14, 380, 820));   // pitch falls with saturation, like a real monitor
}

function initMonitor(){
  const bg = css('--mon-bg');
  MON.sweep = new Sweep($('#monCanvas'), {
    bg, seconds:6,
    sample: makeSource(currentRhythm, onBeat),
    channels:[
      {color:css('--mon-ecg'), y:(v, b, top) => top + b*0.62 - v*b*0.5},
      {color:css('--mon-spo2'), y:(v, b, top) => top + b*0.8 - v*b*0.58},
      {color:css('--mon-rr'), y:(v, b, top) => top + b*0.5 - v*b*0.28}
    ],
    active:() => UI.active && S && S.monitor && !S.paused && !S.ended
  });
  let last = null;
  const frame = ts => {
    if (!UI.active) return;
    UI.raf = requestAnimationFrame(frame);
    if (last == null){ last = ts; return; }
    const dt = Math.min(0.1, (ts - last)/1000); last = ts;
    if (MON.sweep.o.active()) MON.sweep.step(dt);
  };
  UI.raf = requestAnimationFrame(frame);
}

function updateNumerics(){
  if (!S) return;
  const set = (id, t) => { $(id).textContent = t; };
  const alarm = (id, on) => $(id).classList.toggle('alarm', !!on);
  if (!S.monitor){
    for (const id of ['#vHR','#vSPO2','#vRR','#vT']) set(id, '--'); set('#vBP', '--/--'); set('#vBPsub', 'MAP --');
    for (const id of ['#nHR','#nSPO2','#nBP','#nRR']) alarm(id, false);
    return;
  }
  const v = S.v || vitalsNow(), A = S.arrest, jit = () => Math.round(Math.random()*2 - 1);
  const hr = A ? (A.rhythm === 'pea' ? 42 : null) : Math.round(v.hr) + jit();
  set('#vHR', hr == null ? '---' : hr);
  set('#vSPO2', A ? '--' : Math.round(v.spo2));
  set('#vRR', A ? (A.cpr ? '--' : '0') : Math.round(v.rr));
  set('#vT', v.temp.toFixed(1));
  if (S.nibpUntil != null){ set('#vBP', '…'); set('#vBPsub', 'Measuring'); }
  else if (!S.nibp){ set('#vBP', '--/--'); set('#vBPsub', 'MAP --'); }
  else if (S.nibp.fail){ set('#vBP', '--/--'); set('#vBPsub', `No reading · ${fmt(S.t - S.nibp.t)} ago`); }
  else { const n = S.nibp; set('#vBP', `${n.sbp}/${n.dbp}`); set('#vBPsub', `MAP ${Math.round((n.sbp + 2*n.dbp)/3)} · ${fmt(S.t - n.t)} ago`); }
  const hrA = A ? A.rhythm !== 'pea' : (hr > 130 || hr < 45);
  const spA = A || v.spo2 < 90;
  const bpA = S.nibp && (S.nibp.fail || S.nibp.sbp < 90);
  const rrA = !A && (v.rr > 30 || v.rr < 8);
  alarm('#nHR', hrA); alarm('#nSPO2', spA); alarm('#nBP', bpA); alarm('#nRR', rrA);
  if ((hrA || spA || bpA || rrA) && MON.sound && !S.paused){
    const now = performance.now();
    if (now - S.alarmAt > (A ? 2000 : 5000)){ S.alarmAt = now; tone(880, 0.12, 0.06); tone(660, 0.12, 0.06, 0.16); tone(880, 0.12, 0.06, 0.32); }
  }
}
function monitorOverlay(){
  $('#monOff').hidden = !!(S && S.monitor);
  $('#monPaused').hidden = !(S && S.paused);
  if (S && S.monitor && MON.sweep) MON.sweep.clear();
}

/* ======================================================================
   UI: SIMULATION VIEW
   ====================================================================== */
function switchTab(t){
  UI.tab = t;
  for (const x of ['history','exam','investigate','treat','decide']){
    const b = $('#tab-' + x); b.setAttribute('aria-selected', x === t); $('#panel-' + x).hidden = x !== t;
    if (x === t) b.querySelector('.dot')?.remove();
  }
  renderTab();
}
function markTab(t){ if (UI.tab !== t && !$('#tab-' + t).querySelector('.dot')) $('#tab-' + t).append(h('span', {class:'dot', 'aria-hidden':'true'})); }
function renderTab(){ ({history:renderHistory, exam:renderExam, investigate:renderInvestigate, treat:renderTreat, decide:renderDecide})[UI.tab](); }
function refreshAfterAction(){ renderTab(); updateNumerics(); }

function renderHistory(){
  const p = $('#panel-history');
  const tr = h('div', {class:'transcript', 'aria-live':'polite'});
  if (!S.transcript.length) tr.append(h('p', {class:'hint', text:'Type a question, or pick one below. Answers come from the patient or whoever is with them.'}));
  for (const m of S.transcript) tr.append(h('div', {class:'bubble ' + (m.who === 'You' ? 'you' : 'them')}, h('span', {class:'who', text:m.who}), m.text));
  const input = h('input', {id:'askInput', type:'text', placeholder:'Ask a question, e.g. “Any allergies?”', autocomplete:'off', 'aria-label':'Ask the patient a question'});
  const form = h('form', {class:'askform', onsubmit:e => { e.preventDefault(); const v = input.value; input.value = ''; askFree(v); setTimeout(() => $('#askInput')?.focus(), 0); }}, input, h('button', {class:'btn btn-primary', type:'submit', text:'Ask'}));
  const chips = h('div', {class:'qchips'});
  for (const it of C.history) chips.append(h('button', {type:'button', class:'qchip' + (count(it.id) ? ' asked' : ''), onclick:() => ask(it), text:it.q}));
  p.replaceChildren(tr, form, h('div', {class:'group'}, h('h4', {text:'Suggested questions'}), chips));
  tr.scrollTop = tr.scrollHeight;
}
function renderExam(){
  const p = $('#panel-exam'), acts = h('div', {class:'acts'});
  for (const e of C.exam) acts.append(h('button', {type:'button', class:'act' + (count(e.id) ? ' done' : ''), onclick:() => examine(e.id)}, h('span', {class:'t', text:e.label}), count(e.id) ? h('span', {class:'n', text:'Re-examine'}) : null));
  const list = h('ul', {class:'feed'});
  for (const f of S.findings) list.append(h('li', null, h('div', {class:'meta'}, h('b', {text:f.label}), h('time', {text:fmt(f.t)})), f.text));
  p.replaceChildren(h('div', {class:'group'}, h('h4', {text:'Examine'}), acts), S.findings.length ? h('div', {class:'group'}, h('h4', {text:'Findings'}), list) : h('p', {class:'hint', text:'Findings appear here. Re-examine after treatment to see what has changed.'}));
}
function renderInvestigate(){
  const p = $('#panel-investigate'), groups = {};
  for (const inv of C.investigations) (groups[inv.group || 'Other'] = groups[inv.group || 'Other'] || []).push(inv);
  const out = [];
  for (const [gname, items] of Object.entries(groups)){
    const acts = h('div', {class:'acts'});
    for (const inv of items){
      const pend = S.pending.some(x => x.id === inv.id);
      acts.append(h('button', {type:'button', class:'act' + (count(inv.id) ? ' done' : ''), onclick:() => order(inv.id)}, h('span', {class:'t'}, inv.label, h('span', {class:'d', text:'Result in ~' + humanTime(inv.time || 60)})), h('span', {class:'n', text:pend ? 'Pending' : count(inv.id) ? '×' + count(inv.id) : ''})));
    }
    out.push(h('div', {class:'group'}, h('h4', {text:gname}), acts));
  }
  if (S.pending.length){
    const ul = h('ul', {class:'feed', id:'pendingList'});
    for (const x of S.pending) ul.append(h('li', {'data-id':x.id}, h('div', {class:'meta'}, h('b', {text:x.label}), h('time', {class:'eta', text:'ready in ' + fmt(x.ready - S.t)})), h('div', {class:'bar'}, h('i', {style:`width:${clamp((S.t - x.ordered)/(x.ready - x.ordered)*100, 0, 100)}%`}))));
    out.push(h('div', {class:'group'}, h('h4', {text:'Pending'}), ul));
  }
  const res = h('ul', {class:'feed'});
  for (const r of S.results) res.append(h('li', null, h('div', {class:'meta'}, h('b', {text:r.label}), h('time', {text:'resulted ' + fmt(r.ready)})), r.text));
  out.push(S.results.length ? h('div', {class:'group'}, h('h4', {text:'Results'}), res) : h('p', {class:'hint', text:'Results appear here and in the event log when they are ready. Speed up time to wait for slow tests.'}));
  p.replaceChildren(...out);
}
function renderTreat(){
  const p = $('#panel-treat'), groups = {};
  for (const a of Object.values(ACT)) (groups[a.group] = groups[a.group] || []).push(a);
  const groupOrder = GROUP_ORDER.filter(gn => groups[gn]).concat(Object.keys(groups).filter(gn => !GROUP_ORDER.includes(gn)));
  if (S.arrest){ groupOrder.splice(groupOrder.indexOf('Resuscitation'), 1); groupOrder.unshift('Resuscitation'); }
  p.replaceChildren(...groupOrder.map(gn => {
    const acts = h('div', {class:'acts'});
    for (const a of groups[gn]){
      const n = count(a.id);
      let label = a.label;
      if (a.id === 'cpr' && S.arrest && S.arrest.cpr) label = 'CPR in progress';
      acts.append(h('button', {type:'button', class:'act' + (n ? ' done' : ''), onclick:() => perform(a.id)}, h('span', {class:'t'}, label, a.detail ? h('span', {class:'d', text:a.detail}) : null), h('span', {class:'n', text:n ? (a.once ? 'Done' : '×' + n) : ''})));
    }
    return h('div', {class:'group' + (gn === 'Resuscitation' && S.arrest ? ' hot' : '')}, h('h4', {text:gn}), acts);
  }));
}
function renderDecide(){
  const p = $('#panel-decide');
  const mk = (name, list, sel) => h('fieldset', null, h('legend', {text:name === 'dx' ? 'Most likely diagnosis' : 'Disposition'}),
    ...list.map(o => h('label', {class:'opt'}, h('input', {type:'radio', name:'pick-' + name, id:'pick-' + o.id, value:o.id, checked:sel === o.id, onchange:() => { S[name] = o.id; }}), h('span', {text:o.label}))));
  const btn = h('button', {class:'btn btn-primary', type:'button', id:'btnSubmit', onclick:() => {
    if (!S.dx || !S.disp){ $('#decideMsg').textContent = 'Choose a diagnosis and a disposition first.'; return; }
    record('decision', 'Submitted diagnosis and disposition', 'decide'); endCase('submitted');
  }}, 'Submit and end case');
  p.replaceChildren(
    h('p', {class:'hint', text:'Commit when the patient is stable enough to hand over. Submitting ends the case and opens the debrief.'}),
    mk('dx', S.order.dx, S.dx), mk('disp', S.order.disp, S.disp),
    h('div', {class:'db-actions'}, btn), h('p', {class:'hint', id:'decideMsg', 'aria-live':'polite'}));
}

function togglePause(force){
  if (!S || S.ended) return;
  S.paused = force == null ? !S.paused : force;
  $('#btnPause').textContent = S.paused ? 'Resume' : 'Pause';
  monitorOverlay();
  if (S.paused) log('system', 'Paused.');
  lastReal = performance.now();
}
function resetEnd(){ UI.endArm = 0; const b = $('#btnEnd'); b.textContent = 'End case'; b.classList.remove('confirm'); }


/* ---- lifecycle ---- */
let lastReal = performance.now();
function loop(){
  const now = performance.now(), dtReal = Math.min(1.5, (now - lastReal)/1000); lastReal = now;
  if (!UI.active || !S || S.ended) return;
  if (!S.paused) tick(dtReal*S.speed);
  if (S.ended) return;
  $('#clock').textContent = fmt(S.t);
  if (S.arrest) $('#arrestInfo').textContent = `${fmt(S.t - S.arrest.start)} · ${RHYTHM_NAMES[S.arrest.rhythm]}${S.arrest.cpr ? ' · CPR in progress' : ''}`;
  const pl = document.getElementById('pendingList');
  if (pl) for (const li of pl.children){ const x = S.pending.find(p => p.id === li.dataset.id); if (x){ li.querySelector('.eta').textContent = 'ready in ' + fmt(x.ready - S.t); li.querySelector('.bar i').style.width = clamp((S.t - x.ordered)/(x.ready - x.ordered)*100, 0, 100) + '%'; } }
  if (UI.endArm && now > UI.endArm) resetEnd();
}

function endCase(reason){
  if (S.ended) return;
  S.ended = true; S.endReason = reason;
  const v = S.arrest ? null : vitalsNow();
  S.vlog.push({t:S.t, hr:v ? Math.round(v.hr) : null, sbp:v ? Math.round(v.sbp) : null, spo2:v ? Math.round(v.spo2) : null});
  if (S.arrestBands.length && S.arrestBands[S.arrestBands.length-1].end == null) S.arrestBands[S.arrestBands.length-1].end = S.t;
  const rec = {
    t:S.t, timeline:S.timeline, penalties:S.penalties, notes:S.notes, vlog:S.vlog, arrestBands:S.arrestBands,
    dx:S.dx, disp:S.disp, died:S.died, endedInArrest:!!S.arrest, arrests:S.arrests, finalSeverity:S.sev, endReason:reason
  };
  const cb = UI.opts.onEnd;
  destroySim();
  if (cb) cb(rec);
}

function onBeforeUnload(e){ if (UI.active && S && !S.ended && S.t > 5){ e.preventDefault(); e.returnValue = ''; } }
function onDocClick(e){ const b = e.target.closest('[data-act]'); if (b && UI.root && UI.root.contains(b)) perform(b.dataset.act); }

export function destroySim(){
  UI.active = false;
  cancelAnimationFrame(UI.raf);
  for (const t of UI.timers) clearInterval(t);
  UI.timers = [];
  document.removeEventListener('click', onDocClick);
  window.removeEventListener('beforeunload', onBeforeUnload);
  if (MON.audio) { try { MON.audio.suspend(); } catch(e){} }
}
export const simRunning = () => !!(UI.active && S && !S.ended);

export function mountSim(root, caseData, opts = {}){
  destroySim();
  UI.opts = opts; UI.root = root;
  root.replaceChildren();
  const wrap = document.createElement('div'); wrap.className = 'sim';
  wrap.innerHTML = TEMPLATE;                    // static markup only; all case text is set via textContent
  root.append(wrap);
  const c = normalizeCase(JSON.parse(JSON.stringify(caseData)));
  C = c; ACT = buildActions(c); S = newState(c); S.v = vitalsNow();
  $('#ptName').textContent = c.patient.name;
  $('#ptMeta').textContent = `${c.patient.age} ${c.patient.sex}${c.patient.weight ? ' · ' + c.patient.weight + ' kg' : ''}`;
  $('#ptComplaint').textContent = c.card.complaint;
  $('#triage').textContent = c.triage ? c.triage.note : '';
  if (opts.badge){ $('#simBadge').hidden = false; $('#simBadge').textContent = opts.badge; }
  const tv = $('#triageVitals');
  for (const [k,v] of Object.entries((c.triage && c.triage.vitals) || {})) tv.append(h('div', null, h('dt', {text:k.replace('SpO2','SpO₂')}), h('dd', {text:v})));
  for (const t of ['history','exam','investigate','treat','decide']) $('#tab-' + t).addEventListener('click', () => switchTab(t));
  $('#speedSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || !S) return;
    S.speed = Number(b.dataset.speed);
    for (const x of document.querySelectorAll('#speedSeg button')) x.setAttribute('aria-pressed', x === b);
  });
  $('#btnPause').addEventListener('click', () => togglePause());
  $('#btnResume').addEventListener('click', () => togglePause(false));
  $('#btnSound').textContent = MON.sound ? 'Sound on' : 'Sound off';
  $('#btnSound').addEventListener('click', () => {
    MON.sound = !MON.sound; if (MON.sound) audioCtx();
    $('#btnSound').textContent = MON.sound ? 'Sound on' : 'Sound off'; $('#btnSound').setAttribute('aria-pressed', MON.sound);
  });
  $('#btnNibp').addEventListener('click', () => { if (S && S.monitor && S.nibpUntil == null && !S.ended){ startNibp(); log('system', 'NIBP cycling.'); } });
  $('#btnEnd').addEventListener('click', () => {
    if (!S || S.ended) return;
    if (!UI.endArm){ UI.endArm = performance.now() + 4000; const b = $('#btnEnd'); b.textContent = 'Confirm: end now'; b.classList.add('confirm'); return; }
    resetEnd(); record('end', 'Ended the case early', 'decide'); endCase('ended');
  });
  document.addEventListener('click', onDocClick);
  window.addEventListener('beforeunload', onBeforeUnload);
  UI.active = true; UI.tab = 'history'; UI.endArm = 0;
  initMonitor();
  MON.sweep.resize(); MON.sweep.clear();
  monitorOverlay(); updateNumerics(); updateAppearance();
  log('system', `Case started. ${c.patient.name}, ${c.patient.age}, is in ${(c.card.setting || 'hospital').toLowerCase()}. The patient is yours.`);
  switchTab('history');
  lastReal = performance.now();
  UI.timers.push(setInterval(loop, 200));
  UI.timers.push(setInterval(() => { if (UI.active && S && !S.ended) updateNumerics(); }, 1000));
  window.scrollTo({top:0});
}

const TEMPLATE = `<div class="simbar">
      <div class="pt"><strong id="ptName"></strong><span id="ptMeta" class="mono"></span><span id="ptComplaint" class="complaint"></span></div>
      <div class="controls">
        <span class="pill neutral" id="simBadge" hidden></span>
        <div class="clock"><span class="lbl">Sim time</span><span id="clock">00:00</span></div>
        <div class="seg" role="group" aria-label="Simulation speed" id="speedSeg">
          <button type="button" data-speed="1" aria-pressed="true">1×</button><button type="button" data-speed="2" aria-pressed="false">2×</button><button type="button" data-speed="4" aria-pressed="false">4×</button><button type="button" data-speed="8" aria-pressed="false">8×</button>
        </div>
        <button class="btn" id="btnPause" type="button">Pause</button>
        <button class="btn" id="btnSound" type="button" aria-pressed="false">Sound off</button>
        <button class="btn btn-danger" id="btnEnd" type="button">End case</button>
      </div>
    </div>

    <div id="arrestBanner" class="arrest" hidden role="alert">
      <strong>Cardiac arrest</strong><span class="mono" id="arrestInfo"></span><span class="spacer"></span>
      <button class="btn" type="button" data-act="cpr">Start CPR</button>
      <button class="btn" type="button" data-act="iv_access">IV/IO access</button>
      <button class="btn" type="button" data-act="rhythm_check">Rhythm check</button>
      <button class="btn" type="button" data-act="defib">Shock</button>
      <button class="btn" type="button" data-act="adr_1mg_iv">Adrenaline 1 mg</button>
    </div>

    <div class="bay">
      <div class="col-mon">
        <div class="mon-stack">
          <div class="monitor-wrap">
            <div class="monitor" id="monitor">
              <div class="mon-waves">
                <canvas id="monCanvas"></canvas>
                <span class="wave-lbl" style="top:2px;color:var(--mon-ecg)">II</span>
                <span class="wave-lbl" style="top:33.3%;color:var(--mon-spo2)">PLETH</span>
                <span class="wave-lbl" style="top:66.6%;color:var(--mon-rr)">RESP</span>
              </div>
              <div class="mon-nums">
                <div class="num hr" id="nHR"><span class="lbl"><span>HR</span><span>bpm</span></span><span class="val" id="vHR">--</span></div>
                <div class="num spo2" id="nSPO2"><span class="lbl"><span>SpO₂</span><span>%</span></span><span class="val" id="vSPO2">--</span></div>
                <div class="num nibp" id="nBP"><span class="lbl"><span>NIBP</span><span>mmHg</span></span><span class="val" id="vBP">--/--</span><span class="sub" id="vBPsub">MAP --</span><button class="nibp-btn" id="btnNibp" type="button">Cycle NIBP</button></div>
                <div class="num rr" id="nRR"><span class="lbl"><span>RR</span><span>/min</span></span><span class="val" id="vRR">--</span></div>
                <div class="num temp" id="nT"><span class="lbl"><span>Temp</span><span>°C</span></span><span class="val" id="vT">--</span></div>
              </div>
              <div class="mon-overlay" id="monOff"><p>NO MONITORING ATTACHED</p><button class="btn" type="button" data-act="monitor">Attach monitoring</button></div>
              <div class="mon-overlay" id="monPaused" hidden><p>SIMULATION PAUSED</p><button class="btn" type="button" id="btnResume">Resume</button></div>
            </div>
          </div>
          <div class="panel bedside">
            <div class="appearance"><span class="lbl">At the bedside</span><p id="appearance"></p></div>
            <details open><summary>Triage note</summary><p id="triage"></p><dl class="tv" id="triageVitals"></dl></details>
          </div>
        </div>
      </div>

      <div class="col-work">
        <div class="panel">
          <div class="tabs" role="tablist" aria-label="Clinical actions">
            <button class="tab" role="tab" type="button" id="tab-history" aria-controls="panel-history" aria-selected="true">History</button>
            <button class="tab" role="tab" type="button" id="tab-exam" aria-controls="panel-exam" aria-selected="false">Examine</button>
            <button class="tab" role="tab" type="button" id="tab-investigate" aria-controls="panel-investigate" aria-selected="false">Investigate</button>
            <button class="tab" role="tab" type="button" id="tab-treat" aria-controls="panel-treat" aria-selected="false">Treat</button>
            <button class="tab" role="tab" type="button" id="tab-decide" aria-controls="panel-decide" aria-selected="false">Decide</button>
          </div>
          <div class="tabpanel" role="tabpanel" id="panel-history" aria-labelledby="tab-history"></div>
          <div class="tabpanel" role="tabpanel" id="panel-exam" aria-labelledby="tab-exam" hidden></div>
          <div class="tabpanel" role="tabpanel" id="panel-investigate" aria-labelledby="tab-investigate" hidden></div>
          <div class="tabpanel" role="tabpanel" id="panel-treat" aria-labelledby="tab-treat" hidden></div>
          <div class="tabpanel" role="tabpanel" id="panel-decide" aria-labelledby="tab-decide" hidden></div>
        </div>
      </div>

      <aside class="col-log">
        <div class="panel">
          <h3>Event log</h3>
          <ol class="log" id="log" aria-live="polite"></ol>
        </div>
      </aside>
    </div>`;
