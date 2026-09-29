# Resus Bay

A virtual patient simulator for clinical teaching. Students manage a deteriorating patient in real
time on a live bedside monitor, then get a scored debrief. Teachers write and edit cases, run
classes of any size, assign cases as practice or assessment, and see where the class goes wrong.

It runs on your own computer or college server and keeps all data private. There is no cloud
service and no per-student fee. It needs only **Node.js 22.13 or newer**: there are no other
packages to install.

## Contents

1. [Quick start on Windows](#quick-start-on-windows)
2. [Using it with a class](#using-it-with-a-class)
3. [Features](#features)
4. [Class size and hosting](#class-size-and-hosting)
5. [Writing cases](#writing-cases)
6. [Backups, security and maintenance](#backups-security-and-maintenance)
7. [Developers](#developers)

## Quick start on Windows

1. Install **Node.js LTS** from <https://nodejs.org>. Use the standard installer and accept the
   defaults.
2. Put this folder where you want it, for example `D:\book\Simulation_based_Teaching\resus-bay`.
3. Double-click **`start-windows.bat`**. A black window opens and shows:
   ```
   Resus Bay is running at http://localhost:3000
     FIRST-TIME SETUP
     Open http://localhost:3000/#/setup and enter this setup code: ABCD2345
   ```
4. Open <http://localhost:3000> in Chrome or Edge. Enter the setup code, then create your
   administrator account.
5. Keep the black window open while the app is in use. Close it (or press Ctrl+C) to stop.

Everything is stored in the `data` folder next to the app (`data\resus-bay.sqlite`).

**Students on the same network** (a college LAN or Wi-Fi) open `http://<your-computer-name>:3000`
or `http://<your-IP-address>:3000`. Find your IP with `ipconfig`. The first time, Windows asks
whether to allow Node.js through the firewall: allow it on private networks.

On Linux or macOS, run `./start.sh` (or `npm start`) instead.

## Using it with a class

1. **Create a class** (Classes → New class). Each class has a 6-letter code.
2. **Add students** in either of two ways:
   - **Self-enrolment:** share the code or the join link. Students create their own account,
     using their roll number as the username. Turn enrolment off when everyone has joined.
   - **Import a list:** paste or upload a CSV with `name` and `roll number` columns, straight from a
     spreadsheet. Up to 5000 at a time. The app creates accounts with temporary passwords and
     gives you a credentials CSV to hand out. Students choose their own password at first
     sign-in.
3. **Review the cases** (Cases). Play each one in *Preview* (nothing is recorded), edit it for your
   local guidelines, then *Mark reviewed*.
4. **Assign cases** from the class page:
   - **Practice:** unlimited or limited attempts, with the full debrief shown straight away.
   - **Assessment:** held back from open practice. By default it allows one attempt and shows only
     the score until the due date passes.
5. **Follow results** on the assignment page:
   - completion and pass rates, and the distribution of scores
   - each critical action: done on time, late or missed, with the median time taken
   - the most common errors and the diagnoses students chose
   - every student's debrief
   - export to CSV at any time
6. **Co-teachers:** add them to a class by username. Create their accounts under People
   (administrators only).

Students can also practise any published case when *Open practice* is on for their class.

## Features

**Simulation**
- Live sweeping monitor: ECG (sinus, AF, ST elevation, VF, PEA, asystole, CPR artefact),
  plethysmograph and respiration traces; HR, SpO₂, NIBP, RR and temperature; alarms; and a beep
  whose pitch falls with saturation.
- The physiology deteriorates in real time unless treated and responds to each treatment.
- Cardiac arrest with ALS logic: CPR, rhythm checks, shocks, adrenaline, amiodarone, ROSC or
  death.
- History taking by free text or suggested questions, with collateral history. The patient becomes
  unable to answer as they deteriorate.
- Examination findings and investigation results that change with the patient's state and with
  treatment; realistic turnaround times; 1×–8× time.
- Prerequisites ("we need IV access first"), dose limits, distractors and harmful options.
- Diagnosis and disposition, then a scored debrief:
  - critical actions against time targets
  - penalties, with the reason for each
  - vital-sign charts with action markers
  - the full timeline, teaching points and references

**Teaching**
- Classes with join codes, CSV import, co-teachers, password resets and account disabling.
- Practice and assessment assignments with due dates, attempt limits and delayed debriefs.
- Class analytics and CSV export.
- **Scoring on the server:** the server recalculates every score from the actions recorded, so a
  student cannot edit their score in the browser.
- **Results survive a lost connection:** if the connection drops at the end of a case, the result
  is kept on the device and uploaded later.

**Cases**
- Six reviewed-to-guideline starter cases:
  - anaphylaxis
  - inferior STEMI with RV involvement
  - tension pneumothorax
  - septic shock
  - life-threatening asthma
  - sulfonylurea hypoglycaemia
- **Form-based case editor:** covers every part of a case, with live validation, preview of
  unsaved edits, and a JSON view for advanced users.
- **Version history:** every save is a new version, and any version can be restored. Each result
  records the version played. Saving a published case clears its review sign-off, so edits get
  re-reviewed.
- Import and export cases as JSON to share them between institutions.

## Class size and hosting

The simulation runs in each student's browser. The server only signs people in, sends the case
and stores the result, a few kilobytes per attempt. One ordinary computer running Resus Bay can
serve **hundreds of students playing at the same time and tens of thousands of accounts**. The
SQLite database handles millions of stored attempts. Every list in the app is searchable, and
the people list is paginated.

| Setting | How |
|---|---|
| One classroom, one laptop | Run `start-windows.bat` on the teacher's laptop; students join over the classroom Wi-Fi |
| Department or college | Run it on a desktop that stays on, or on a server, with the same steps. Ask IT for a fixed name such as `http://resusbay.college.local:3000` |
| Access from home / internet | Put it behind HTTPS (IIS, nginx or Caddy as a reverse proxy, or Docker below) and set `COOKIE_SECURE=1`. Your IT department can do this in an hour |
| Docker | `docker build -t resus-bay . && docker run -d -p 3000:3000 -v resusbay-data:/data --name resus-bay resus-bay` |

Settings (environment variables):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Network interface (`127.0.0.1` = this computer only) |
| `DATA_DIR` | `./data` | Where the database lives |
| `COOKIE_SECURE` | off | Set to `1` when served over HTTPS |
| `SESSION_DAYS` | `14` | How long a sign-in lasts |
| `SETUP_CODE` | random | Fix the first-time setup code instead of a random one |

## Writing cases

Most teachers will use the editor: Cases → New case, or open a case and choose Duplicate. The
editor explains each field. The most important ideas are:

- **Severity** runs from 0 (recovered) to 1 (peri-arrest). The patient starts at the start value
  and worsens at the given rate per minute. You give three sets of vital signs (recovered, at
  presentation, peri-arrest), and the monitor interpolates between them.
- **Treatments** can:
  - shift severity (negative = better) over an onset time
  - change individual vital signs for a period
  - multiply the rate of deterioration (0 stops it)

  They can require another action first (e.g. IV access), be limited in number, or carry a
  penalty with an explanation.
- **Scoring:**
  - *Critical actions* have a target time; late actions earn half points.
  - *Recommended actions* add points.
  - *Penalty rules* catch actions done at the wrong time, e.g. an X-ray before decompressing a
    tension pneumothorax, or a drug given when BP < 90.
  - Correct *diagnosis* and *disposition* also earn points.
- **Variants** let examination findings and results change after treatment or as the patient
  worsens.

The case files in `cases/` are complete examples. Built-in cases are loaded into the library the
first time the server starts. After that, the database copy is the one that counts, and edits
made in the app are never overwritten.

All cases, including the starter cases, **must be reviewed by a clinician at your institution
before teaching use**. Drug doses and pathways vary by country and hospital.

## Backups, security and maintenance

- **Backup:** run `npm run backup` (safe while running). It writes a copy to `data/backups/`.
  Alternatively, stop the server and copy the `data` folder. Schedule it weekly with Windows Task
  Scheduler.
- **Forgotten administrator password:** run `npm run create-admin -- <username> "<Full name>"
  <new-password>`.
- **Passwords** are stored as salted scrypt hashes. Sessions use HTTP-only, SameSite=Strict
  cookies.
- **Limits:** sign-in and class-joining are rate limited. Pages use a strict Content Security
  Policy.
- **Access:** students see only their own attempts; teachers see only their own classes.
- **Personal data:** the app stores names, usernames and results only (no email or phone). Follow
  your institution's data-protection rules. Archive classes rather than deleting them, to keep
  records.
- **Updating:** replace the program files but keep your `data` folder. Then restart.

## Developers

```
server/     HTTP server, API routes, SQLite schema, sign-in (no dependencies)
shared/     case-schema.js (validation), scoring.js (used by browser and server)
public/     front end: plain ES modules, no build step
  js/sim.js       physiology engine, monitor, case UI
  js/debrief.js   debrief and vital-sign charts
  js/editor.js    case editor
  js/teacher.js   classes, assignments, analytics, people
  js/app.js       routing, sign-in, student pages
cases/      starter cases (JSON)
scripts/    create-admin, backup
test/       api.test.js (npm test), e2e.mjs (browser test, needs Playwright)
```

- `npm test` runs the API tests.
- `node test/e2e.mjs` drives a full teacher-and-student session in Chromium.

**Roadmap:**
- AI patient conversation grounded in the case script
- media (ECG images, X-rays, heart and lung sounds)
- classroom projector mode with class voting
- LMS (LTI 1.3) and single sign-on
- the Pulse physiology engine for richer physiology
