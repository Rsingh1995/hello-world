// Create (or reset) an administrator account from the command line.
// Usage: npm run create-admin -- <username> "<Full name>" <password>
import path from 'node:path';
import { openDb } from '../server/db.js';
import { hashPassword, passwordProblem, usernameProblem } from '../server/auth.js';

const [username, name, password] = process.argv.slice(2);
if (!username || !name || !password) { console.error('Usage: npm run create-admin -- <username> "<Full name>" <password>'); process.exit(1); }
const p = usernameProblem(username) || passwordProblem(password); if (p) { console.error(p); process.exit(1); }
const db = openDb(path.join(path.resolve(process.env.DATA_DIR || 'data'), 'resus-bay.sqlite'));
const ex = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (ex) { db.prepare(`UPDATE users SET role = 'admin', active = 1, name = ?, password_hash = ?, must_change_password = 0 WHERE id = ?`).run(name, hashPassword(password), ex.id); console.log(`Updated ${username}: now an active administrator with the new password.`); }
else { db.prepare(`INSERT INTO users (username, name, role, password_hash) VALUES (?, ?, 'admin', ?)`).run(username, name, hashPassword(password)); console.log(`Created administrator ${username}.`); }
db.close();
