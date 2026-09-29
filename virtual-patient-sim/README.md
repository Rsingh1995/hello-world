# Resus Bay: virtual patient simulator (prototype)

A browser-based, case-driven clinical simulator in the style of Full Code, Body Interact and
Oxford Medical Simulation. Learners manage a deteriorating virtual patient in real time: history,
examination, investigations with realistic turnaround times, and treatments that change the
patient's physiology on a live bedside monitor. Every case ends with a scored debrief.

It is a single HTML file with no build step and no server. It runs offline on any laptop, tablet or
phone browser, and it can be emailed or put on a USB stick.

## Try it

- **Quickest:** open `index.html` in Chrome, Edge, Firefox or Safari. The three built-in cases work
  straight away.
- **With the case folder:** serve the directory so the page can load cases from `cases/`:
  ```bash
  cd virtual-patient-sim
  python3 -m http.server 8000
  # open http://localhost:8000
  ```
  Any static host works as well (GitHub Pages, Netlify, a college web server).
- **Import a case:** use **Import case (.json)** in the library. Imported cases are kept in that
  browser.

## What the prototype does

| Area | What it does |
|---|---|
| Bedside monitor | Sweeping ECG (lead II), SpO₂ pleth and respiration traces drawn from the patient's physiology. Numerics for HR, SpO₂, NIBP (auto-cycling every 3 min or on demand), RR and temperature. Alarms, and an optional QRS beep whose pitch falls with saturation, as on real monitors. Rhythms: sinus (with optional ST elevation), AF, VF, PEA, asystole, and CPR artefact. |
| Physiology | Each case has a *severity* from 0 (recovered) to 1 (peri-arrest). It rises at the case's rate unless treatment slows or stops it. Vital signs are interpolated between the case's `best`, `initial` and `worst` values. Interventions can shift severity, change individual vital signs for a period, and change the rate of progression. |
| Cardiac arrest | At severity 1 the patient arrests with the case's rhythm. CPR, rhythm checks, defibrillation, adrenaline and amiodarone work to ALS logic. ROSC needs the right steps (shock for VF; CPR, adrenaline and the reversible cause for PEA). Death after 10 minutes without ROSC. |
| History | Free-text questions matched to the case's scripted answers by keywords, plus suggested questions. Collateral history from a friend, relative or paramedic. The patient becomes too breathless or confused to answer as they deteriorate. |
| Examination | System-by-system findings that change with the patient's state and with treatment (for example, breath sounds return after decompression). |
| Investigations | Bedside, laboratory and imaging tests with turnaround times. Results reflect the patient's state when the test was ordered. |
| Treatment | Grouped, dosed actions with prerequisites ("we need IV access first"), dose limits and nurse responses. Distractors and harmful options are included deliberately. |
| Time | Real-time clock with 1×, 2×, 4× and 8× speed and pause. |
| Debrief | Score against critical actions (with time targets), recommended actions, penalties for harmful choices, diagnosis and disposition. Vital-sign trends with action markers, the learner's full timeline, teaching points and references. **Copy result for teacher** puts a plain-text summary on the clipboard. Recent attempts are saved in the browser. |

### Built-in cases

| Case | Discipline | Teaches |
|---|---|---|
| Lip swelling, rash and breathlessness after lunch | Emergency medicine | Anaphylaxis: IM adrenaline first, fluids, no IV-bolus adrenaline, antihistamines and steroids are not first-line |
| Central chest pain and sweating for 45 min | Cardiology | Inferior STEMI with RV involvement: ECG in 10 min, right-sided leads, avoid nitrates, fluids, activate the cath lab; VF arrest if the patient deteriorates |
| Motorcyclist, rapidly worsening breathlessness | Trauma | Tension pneumothorax: decompress before imaging, correct side and site, chest drain, no positive-pressure ventilation first |
| Found confused and sweaty at home (in `cases/`) | Endocrinology | Sulfonylurea hypoglycaemia: check glucose first, IV 10–20% glucose, recheck, admit for prolonged risk |

The cases are illustrative and follow published guidelines (RCUK 2021 anaphylaxis, ESC 2023 ACS,
ATLS 10th edition, JBDS hypoglycaemia) as closely as possible. **They must be reviewed by faculty
before teaching use.** Doses and pathways vary by country and institution.

## Writing a case

A case is a JSON file. `cases/hypoglycaemia-sulfonylurea.json` is a complete, commented-by-example
template. To add a case to the library, put the file in `cases/` and add its name to
`cases/index.json`, or import it from the library screen.

```jsonc
{
  "id": "unique-id",
  "title": "Diagnosis, shown only in the debrief",
  "card": { "complaint": "What the learner sees on the card", "discipline": "…", "setting": "…", "difficulty": "Core", "minutes": 10 },
  "patient": { "name": "…", "age": 60, "sex": "F", "weight": 70 },
  "triage": { "note": "Triage nurse's note", "vitals": { "HR": "110", "BP": "90/60", "…": "…" } },

  "physiology": {
    "start": 0.5,        // severity at presentation (0 = recovered, 1 = peri-arrest)
    "rate": 0.06,        // severity gained per minute when untreated
    "recovery": 0.05,    // severity lost per minute once progression is fully stopped
    "rhythm": { "type": "sinus", "st": 0 },   // sinus | af ; st = ST elevation (0–0.4)
    "best":    { "hr": 80,  "sbp": 125, "dbp": 78, "rr": 16, "spo2": 98, "temp": 37.0 },
    "initial": { "hr": 115, "sbp": 92,  "dbp": 58, "rr": 26, "spo2": 91, "temp": 37.0 },
    "worst":   { "hr": 150, "sbp": 60,  "dbp": 32, "rr": 38, "spo2": 78, "temp": 37.0 }
  },
  "arrest": { "rhythm": "pea", "requireAdrenaline": true, "reversibleBy": ["action_id"], "roscSeverity": 0.8 },
                         // or { "rhythm": "vf", "shocksNeeded": 1 }, or null for no arrest
  "speech": { "impairedAbove": 0.8, "impairedText": "(Too breathless to answer.)" },
  "appearance": [ { "below": 0.3, "text": "Comfortable" }, { "below": 1.01, "text": "Grey and gasping" } ],

  "history":        [ { "id": "h_x", "q": "Suggested question", "keywords": ["allerg"], "a": "Answer", "source": "Patient" } ],
  "exam":           [ { "id": "e_x", "label": "Chest", "text": "Finding", "variants": [ { "if": { "done": ["tx_id"] }, "text": "Finding after treatment" } ] } ],
  "investigations": [ { "id": "i_x", "group": "Bedside", "label": "VBG", "time": 180, "text": "Result", "variants": [] } ],
  "interventions":  [ {
      "id": "tx_id", "group": "Medications", "label": "Drug and dose", "detail": "Route, notes",
      "requires": ["iv_access"], "once": true, "max": 3,
      "effects": {
        "severity": -0.3, "onset": 120,                   // shift severity over `onset` seconds
        "vitals": { "sbp": 10 }, "duration": 900,         // temporary vital-sign offsets
        "progression": { "factor": 0, "duration": 300 },  // multiply the deterioration rate (0 stops it)
        "unlessDone": ["other_id"], "maxSeverity": 0.4, "blockedSay": "…", "delay": 0
      },
      "say": "Nurse: “Given.”",
      "harm": { "points": 20, "why": "Shown in the debrief" },
      "feedback": "Teaching note shown in the debrief"
  } ],

  "diagnoses":    [ { "id": "dx_a", "label": "…" } ],
  "dispositions": [ { "id": "disp_a", "label": "…" } ],
  "scoring": {
    "critical":    [ { "id": "c1", "label": "…", "anyOf": ["tx_id"], "within": 300, "points": 30, "why": "…" } ],
    "recommended": [ { "id": "r1", "label": "…", "anyOf": ["h_x"], "count": 1, "points": 5 } ],
    "penalties":   [ { "ifAction": "i_ct", "before": ["i_cbg"], "when": { "sbp": { "lt": 90 } }, "ifDone": [], "points": 8, "why": "…" } ],
    "diagnosis":   { "correct": "dx_a", "points": 15 },
    "disposition": { "correct": "disp_a", "points": 10, "partial": { "disp_b": 4 } }
  },
  "teaching": ["…"],
  "references": ["…"]
}
```

Built-in actions available in every case: `monitor`, `iv_access`, `cpr`, `rhythm_check`, `defib`,
`adr_1mg_iv` and `amio_300`. A case can override the label or detail of any of them by listing an
intervention with the same `id`.

**Scoring.** Critical actions done within their time target earn full points; late ones earn half.
Penalties come from harmful interventions, penalty rules, cardiac arrest (−15), delayed CPR or
defibrillation (−10 each) and death (−30). The pass mark is 80% (set `passMark` in a case to change
it).

## Roadmap to a product

See [`../docs/full-code-analysis-and-plan.md`](../docs/full-code-analysis-and-plan.md) for the
market analysis, the build-versus-buy advice and the phased plan. In short:

1. A form-based case editor for faculty, with peer review and version history.
2. Accounts, cohorts and a teacher dashboard (assign cases, hold cases back for assessment, see
   common errors and time to critical actions).
3. AI patient conversation grounded in the case script, and AI-written debrief feedback.
4. Richer media: 12-lead ECG images, X-rays, heart and lung sounds, patient photos.
5. Classroom mode: the teacher runs a case on a projector and the class votes on each step.
6. LMS integration (LTI 1.3), an installable offline app (PWA), and optionally the open-source
   Pulse physiology engine for a fuller physiological model.
