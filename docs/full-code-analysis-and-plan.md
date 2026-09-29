# Full Code Medical Simulation: analysis, alternatives and a plan

Prepared for a medical teacher who wants a Full Code–style simulation app for their learners.
Research date: September 2026. Product details and prices come from public listings and change
often, so confirm them with the vendors before deciding.

## 1. What Full Code is

Full Code (fullcodemedical.com, made by Full Code Medical Inc.) is a mobile-first virtual patient
simulator for medical students, residents, physicians, nurses, PAs and paramedics.

**How a case works.** The learner sees a patient (3D avatar) in an ED, ward or ambulance setting,
with a live vital-signs display. A side menu splits actions into *Investigate* (history, exam, labs,
imaging) and *Intervene* (drugs, procedures, consults). Vital signs change in real time, so critical
cases must be stabilised quickly. Every case ends with a diagnosis and a disposition (admit to the
right unit or discharge), then a debrief with a score, a breakdown by skill and a discussion of what
should have been done.

**Main features (from public listings):**

- 200–300+ cases across 30+ disciplines (emergency medicine, OBGYN, paediatrics, EMS and more),
  written and peer-reviewed by clinicians.
- "Patient AI" free-text conversation for history taking.
- Scoring, detailed case debriefs and a "Daily Patient".
- CME: up to 0.5 AMA PRA Category 1™ credit per case on the Pro + CME tier (medium or hard
  difficulty, score ≥ 85%).
- **Dashboard** for institutions: manage users and groups, assign cases, set difficulty, hold cases
  back for assessment, and see every learner action with timing and order.
- **Creator** add-on: faculty edit existing cases or write their own using the same tools as the
  Full Code team (40+ patient models, five 3D environments).

**Pricing seen in listings:** individual Pro at $11.99/month or $71.99/year; Pro + CME at
$99.99/year. Organisational plans appear to start around $120 per seat per year. Get a formal quote.

**What users like:** realistic, game-like cases; the AI conversation; detailed feedback.

**What users complain about:** little free content; the cost for students; a slow pace of new
cases on cheaper tiers.

**Limits for a teacher outside the US:** cases follow US practice (drugs, doses, pathways and
units); per-seat cost adds up for a large class; custom content needs a paid add-on and stays on
the vendor's platform; there is no offline use.

## 2. Your three options

### A. Buy Full Code (fastest)

Best if you want to start this term with minimal effort. Ask for an institutional trial, and check
the price per seat for your cohort size, whether Creator is included, data export, and whether the
cases fit your curriculum and local guidelines.

### B. Use an alternative

| Product | Strengths | Notes |
|---|---|---|
| **Body Interact** | 400+ cases driven by a physiology model; patients from 6 months to 99 years; distributed by Wolters Kluwer | Strong for physiology-based decision making; institutional pricing |
| **Oxford Medical Simulation** | 200+ scenarios in VR or on screen; team work, crisis resource management and communication | VR headsets optional; institutional pricing |
| **vSim for Nursing, Shadow Health, i-Human Patients** | Established nursing and history-taking virtual patients | Mostly nursing-focused |
| **Infirmary Integrated** | Free and open source (Apache 2.0): cardiac monitor, defibrillator, 12-lead ECG, fetal monitor, IABP and EHR simulators | Not a case library. Pairs with low-cost manikins for instructor-led scenarios |
| **Pulse Physiology Engine** (Kitware) | Free, open-source (Apache 2.0) whole-body physiology model: cardiovascular, respiratory, renal, drugs, haemorrhage, pneumothorax and more | A building block for your own simulator, not a finished product |

### C. Build your own (what this repository starts)

A working prototype is in [`../virtual-patient-sim/`](../virtual-patient-sim/). It already has:

- a live sweeping bedside monitor (ECG, pleth, respiration, NIBP, alarms, beeps)
- a physiology model in which the patient deteriorates unless treated and responds to treatment
- cardiac arrest with ALS logic (CPR, shocks, adrenaline, ROSC or death)
- history by free text or suggested questions, examination, and timed investigations
- dosed treatments with prerequisites, distractors and harmful choices
- diagnosis and disposition, then a scored debrief with a vital-sign chart, timeline and teaching
  points
- four cases (anaphylaxis, inferior STEMI with RV involvement, tension pneumothorax,
  sulfonylurea hypoglycaemia)
- a documented JSON case format, so faculty can write cases without programming

**Why building can be better than buying:**

- **Your curriculum:** local guidelines, drug names and doses, units (mmol/L and mg/dL), disease
  patterns and resource settings (for example, a thrombolysis pathway where PCI is not available).
- **Cost at scale:** no per-seat licence. Hosting a static app is close to free.
- **Ownership:** your cases, your learner data, and research you can publish.
- **Teaching modes Full Code does not focus on:** a classroom mode on a projector where students
  vote, team-based cases, and OSCE-style assessment stations.
- **Works offline and on low-end phones.**

**What building really costs.** The software is the smaller part. The main cost is clinical
content: a good case takes a clinician roughly one to three days to write, test and peer review.
Budget for:

- one developer (or a small team) for the platform
- two or three clinician-authors plus a peer reviewer for cases
- a clinical governance process: every case needs references, a version number and a review date

You also give up CME accreditation (unless you partner with an accredited provider) and polished 3D
avatars, which are expensive to make.

## 3. Recommendation

Take a **hybrid path**:

1. **This term:** trial Full Code or Body Interact with one group of learners. See which case
   types, feedback and dashboard features actually change learning in your setting.
2. **In parallel:** pilot this prototype with the same learners on 10–20 cases that you write for
   your own curriculum. Compare engagement and pre/post-test scores.
3. **Then decide.** If the commercial product fits and the price works, keep it. If local fit, cost
   or ownership matters more, grow the prototype using the plan below. Either way you end up with a
   publishable evaluation.

Aim to be *better for your learners* rather than a copy of Full Code. Don't copy its cases, images,
text or branding; write original content.

## 4. Build plan

Effort figures are rough, for one experienced web developer working with clinician-authors.

| Phase | Scope | Rough effort |
|---|---|---|
| 0. Prototype (done) | Engine, monitor, four cases, debrief, JSON case format | Done |
| 1. Pilot-ready | 15–20 cases in your specialty; form-based case editor; learner accounts and saved results (for example Supabase or Firebase); teacher dashboard (assign cases, cohort scores, common mistakes, time to critical actions); installable offline app (PWA) | 6–8 weeks |
| 2. Differentiators | AI patient conversation grounded in the case script (for example the Claude API), with scripted answers as a fallback; AI-written personalised debrief feedback; classroom/projector mode; OSCE mode with held-back cases and rubrics; LMS integration (LTI 1.3) | 2–3 months |
| 3. Depth | Media library (12-lead ECGs, X-rays, CT, heart and lung sounds, patient photos); Pulse physiology engine for richer physiology; multiplayer team cases; case-sharing between institutions; accreditation partner for CME/CPD | 3–6 months |

**Running costs** are small: static hosting is free or a few dollars a month, a database for a few
hundred learners is on a free or low tier, and AI conversation costs a few cents per case attempt.

**Risks and how to manage them:**

| Risk | Mitigation |
|---|---|
| Clinical errors in cases | Named author and reviewer per case, references, version and review date; learners report errors from the debrief |
| AI patient making things up | Give the AI only the case script; forbid facts outside it; keep scripted answers as a fallback; log conversations for review |
| Student data | Minimal personal data; institutional sign-in; follow your institution's data-protection rules |
| Intellectual property | Original cases and artwork only; nothing taken from commercial products |
| Proving it works | Pre/post tests, time to critical action, learner surveys; publish the results |

## 5. Decisions needed from you

1. Who are the learners (undergraduates, interns, residents, nurses, paramedics) and how many?
2. Which specialty or topics should the first 15–20 cases cover?
3. Which devices do they use (phones, laptops, a computer lab), and is internet access reliable?
4. What budget is there for licences, development and clinician time?
5. Is the goal formative practice, summative assessment, or both?

## Sources

- [Full Code Medical Simulation (home)](https://fullcodemedical.com/)
- [Full Code pricing](https://fullcodemedical.com/pricing/)
- [Full Code FAQ](https://fullcodemedical.com/faq/)
- [Full Code Dashboard for organisations](https://fullcodemedical.com/full-code-dashboard/)
- [Full Code for individuals](https://fullcodemedical.com/individuals/)
- [Full Code on the App Store](https://apps.apple.com/us/app/full-code-medical-simulation/id1207424206)
- [Full Code on Google Play](https://play.google.com/store/apps/details?id=com.minerva_medical.minerva&hl=en_US)
- [Full Code app summary and reviews (mwm.ai)](https://mwm.ai/apps/full-code-medical-simulation/1207424206)
- [Full Code on SoftwareSuggest](https://www.softwaresuggest.com/full-code-emergency)
- [Full Code CME product review (CMEList)](https://www.cmelist.com/full-code-cme-product-review/)
- [HealthySimulation vendor page: Full Code](https://www.healthysimulation.com/vendor-product/full-code-medical-simulation/)
- [Body Interact](https://bodyinteract.com/)
- [Body Interact via Wolters Kluwer](https://www.wolterskluwer.com/en/solutions/lippincott-medicine/medical-education/body-interact-virtual-patient-care-simulator)
- [HealthySimulation vendor page: Oxford Medical Simulation](https://www.healthysimulation.com/vendors/oxford-medical-simulation/)
- [Infirmary Integrated (GitHub)](https://github.com/tanjera/infirmary-integrated)
- [Pulse Physiology Engine (Kitware)](https://pulse.kitware.com/)
- [LLM-based virtual patients: scoping review (JMIR 2025)](https://www.jmir.org/2025/1/e79091)
- [LLM-based virtual patient systems for history taking: systematic review (JMIR Med Inform 2026)](https://medinform.jmir.org/2026/1/e79039)
- [Virtual simulations to enhance medical student exposure (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC11270229/)
