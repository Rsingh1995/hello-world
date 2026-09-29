// End-to-end browser test. Needs Playwright with Chromium:
//   node test/e2e.mjs [screenshot-dir]
// Starts a server on a temporary database, then drives teacher and student sessions.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = await import(path.join(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright', 'index.mjs'))); }

const shots = process.argv[2] || null;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-e2e-'));
const PORT = 3900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env: { ...process.env, PORT, HOST: '127.0.0.1', DATA_DIR: dataDir, SETUP_CODE: 'E2ECODE1' }, stdio: 'pipe' });
await new Promise((res, rej) => { srv.stdout.on('data', d => { if (String(d).includes('running')) res(); }); srv.on('exit', c => rej(new Error('server exited ' + c))); });

const errors = [];
const browser = await chromium.launch();
async function ctx(w = 1400, hgt = 950, scheme = 'light') {
  const c = await browser.newContext({ viewport: { width: w, height: hgt }, colorScheme: scheme });
  const p = await c.newPage();
  p.on('pageerror', e => errors.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !m.text().includes('ERR_CERT_AUTHORITY_INVALID')) errors.push('console: ' + m.text()); });
  p.on('dialog', d => d.accept());
  return p;
}
const shot = async (p, name, full = true) => { if (shots) await p.screenshot({ path: path.join(shots, name + '.png'), fullPage: full }); };
const step = m => console.log('•', m);
try {
  // ---- setup
  const t = await ctx();
  await t.goto(base); await t.waitForURL(/#\/setup/);
  await t.fill('#code', 'E2ECODE1'); await t.fill('#name', 'Dr Meera Rao'); await t.fill('#username', 'meera'); await t.fill('#pw', 'teacherpass1'); await t.fill('#pw2', 'teacherpass1');
  await t.click('button[type=submit]'); await t.waitForURL(/#\/teach/); await t.waitForSelector('text=Welcome, Dr Meera Rao');
  step('setup + dashboard'); await shot(t, 'dashboard');

  // ---- class + import
  await t.click('text=New class >> nth=0'); await t.fill('#cName', 'MBBS 2026 Batch A'); await t.click('text=Create class >> nth=-1');
  await t.waitForURL(/#\/class\/\d+/); const code = (await t.textContent('.bigcode')).trim();
  await t.click('text=Import students (CSV)');
  await t.fill('#csvText', 'Name,Roll number\n' + Array.from({ length: 120 }, (_, i) => `Student ${i + 1},MB26${String(i + 1).padStart(3, '0')}`).join('\n'));
  await t.click('.modal-actions >> text=Import'); await t.waitForSelector('text=Import complete');
  const pw = await t.textContent('.modal tbody tr:first-child td:nth-child(3)');
  await shot(t, 'import-result', false);
  await t.click('.modal-actions >> text=Done'); await t.waitForSelector('text=Students (120)');
  step(`class created (code ${code}), 120 students imported`); await shot(t, 'class');

  // ---- assign a case
  await t.click('text=Assignments (0)'); await t.click('text=Assign a case');
  await t.selectOption('#aCase', 'anaphylaxis-food'); await t.click('.modal-actions >> text=Assign');
  await t.waitForSelector('text=Assignments (1)');
  step('case assigned');

  // ---- student via import credentials
  const s = await ctx(1280, 900);
  await s.goto(base + '/#/login'); await s.fill('#username', 'MB26001'); await s.fill('#password', pw.trim()); await s.click('button[type=submit]');
  await s.waitForURL(/#\/password/); await s.fill('#cur', pw.trim()); await s.fill('#pw', 'mystudentpw'); await s.fill('#pw2', 'mystudentpw'); await s.click('button[type=submit]');
  await s.waitForSelector('text=Assigned cases'); step('student signed in and changed password'); await shot(s, 'student-home');

  // ---- student plays the case
  await s.click('.case >> text=Start case');
  await s.waitForSelector('#monOff'); await s.click('#monOff button');
  await s.fill('#askInput', 'any allergies?'); await s.press('#askInput', 'Enter');
  await s.click('#tab-treat');
  for (const x of ['High-flow oxygen', 'Adrenaline 0.5 mg IM', 'IV access', 'Crystalloid 500 mL']) await s.click(`.act:has-text("${x}")`);
  await s.click('#speedSeg button[data-speed="8"]'); await s.waitForTimeout(2500);
  await shot(s, 'sim', false);
  await s.click('#tab-decide'); await s.check('#pick-dx_anaph'); await s.check('#pick-disp_obs'); await s.click('#btnSubmit');
  await s.waitForURL(/#\/attempt\/\d+/); await s.waitForSelector('.score');
  const score = await s.textContent('.score'); step('student finished case, score ' + score); await shot(s, 'debrief');

  // second student joins by code
  const s2 = await ctx(390, 844, 'dark');
  await s2.goto(base + '/#/join?code=' + code); await s2.fill('#name', 'Kiran Joseph'); await s2.fill('#username', 'MB26500'); await s2.fill('#pw', 'kiranpass1'); await s2.fill('#pw2', 'kiranpass1');
  await s2.click('button[type=submit]'); await s2.waitForSelector('text=Assigned cases'); step('second student joined by code (phone, dark)');
  await shot(s2, 'student-home-phone-dark');
  const overflow = await s2.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  if (overflow) errors.push('phone: horizontal overflow on student home');

  // ---- teacher analytics
  await t.goto(base + '/#/classes'); await t.click('text=MBBS 2026 Batch A');
  await t.click('text=Assignments (1)'); await t.click('tr.clickable');
  await t.waitForSelector('text=Critical actions'); step('assignment analytics'); await shot(t, 'analytics');
  await t.click('a:text-is("Debrief")'); await t.waitForSelector('.score'); step('teacher opened student debrief');

  // ---- case editor: edit, preview, save, publish new case
  await t.goto(base + '/#/cases'); await t.waitForSelector('text=Case library'); await shot(t, 'cases');
  await t.click('text=New case'); await t.waitForSelector('text=Presenting complaint (card headline)');
  await t.fill('.ed-section input >> nth=0', 'teacher-test-case');
  await t.click('.ed-nav >> text=Treatments'); await t.click('.ed-section >> text=+ Add');
  await t.fill('.item[open] label:has-text("Button label") input', 'Salbutamol 5 mg nebulised');
  await t.fill('.item[open] label:has-text("Severity change") input', '-0.2');
  await shot(t, 'editor');
  await t.click('.ed-nav >> text=Overview');
  await t.click('text=Save case'); await t.waitForURL(/#\/case\/teacher-test-case/);
  await t.waitForSelector('text=Version 1');
  await t.click('.ed-nav >> text=Teaching points'); await t.fill('.ed-section textarea >> nth=0', 'Edited teaching point.');
  await t.fill('#saveNote', 'Added teaching point'); await t.click('text=Save new version'); await t.waitForSelector('text=Version 2');
  await t.click('button:has-text("Publish")'); await t.waitForSelector('text=Published');
  await t.click('text=Preview'); await t.waitForSelector('#monOff'); await t.click('#btnEnd'); await t.click('#btnEnd'); await t.waitForSelector('text=Preview only');
  step('case created, versioned, published and previewed');

  // ---- people page
  await t.goto(base + '/#/users'); await t.waitForSelector('text=New staff account'); await t.waitForSelector('text=of 122');
  step('people page paginates (122 users)');
} catch (e) { errors.push('FAILED: ' + e.message); }
await browser.close(); srv.kill();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'E2E PASSED');
process.exit(errors.length ? 1 : 0);
