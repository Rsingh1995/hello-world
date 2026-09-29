// Start the Resus Bay server:  npm start   (Node.js 22.13 or newer, no other dependencies)
import http from 'node:http';
import path from 'node:path';
import { openDb } from './db.js';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const db = openDb(path.join(DATA_DIR, 'resus-bay.sqlite'));
const app = createApp({ db, config: {
  cookieSecure: process.env.COOKIE_SECURE === '1',
  sessionDays: Number(process.env.SESSION_DAYS || 14),
  setupCode: process.env.SETUP_CODE || null
} });

const added = app.seedCases();
if (added) console.log(`Added ${added} built-in case(s) to the library.`);
const server = http.createServer((req, res) => app.handle(req, res));
server.keepAliveTimeout = 65000;
server.listen(PORT, HOST, () => {
  console.log(`Resus Bay is running at http://localhost:${PORT}  (data: ${DATA_DIR})`);
  if (app.needsSetup()) {
    console.log('\n  FIRST-TIME SETUP');
    console.log(`  Open http://localhost:${PORT}/#/setup and enter this setup code: ${app.ensureSetupCode()}`);
    console.log('  (or run: npm run create-admin -- <username> "<Full name>" <password>)\n');
  }
});
const stop = () => { server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
