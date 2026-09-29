// Write a consistent copy of the database to data/backups/ (safe while the server is running).
// Usage: npm run backup
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../server/db.js';

const dir = path.resolve(process.env.DATA_DIR || 'data');
const db = openDb(path.join(dir, 'resus-bay.sqlite'));
fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
const file = path.join(dir, 'backups', `resus-bay-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.sqlite`);
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
db.close();
console.log('Backup written to ' + file);
