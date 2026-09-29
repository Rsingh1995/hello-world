import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, salt, key] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(key, 'base64');
    const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(expected, got);
  } catch { return false; }
}

export const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
export const newToken = () => crypto.randomBytes(32).toString('base64url');

// Readable passwords/codes: no 0/O, 1/l/I.
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
export function randomString(n, alphabet = ALPHA) {
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}
export const tempPassword = () => `${randomString(4)}-${randomString(4)}-${randomString(4)}`;
export const joinCode = () => randomString(6, 'ABCDEFGHJKMNPQRSTUVWXYZ23456789');

export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 200) return 'Password is too long.';
  return null;
}
export function usernameProblem(u) {
  if (typeof u !== 'string' || !/^[A-Za-z0-9._@-]{3,64}$/.test(u)) return 'Username must be 3–64 characters: letters, digits, dot, underscore, hyphen or @ (a roll number works well).';
  return null;
}

/** Simple in-memory limiter for login and join attempts. */
export class RateLimiter {
  constructor(max, windowMs) { this.max = max; this.windowMs = windowMs; this.hits = new Map(); }
  hit(key) {
    const now = Date.now();
    const arr = (this.hits.get(key) || []).filter(t => now - t < this.windowMs);
    arr.push(now); this.hits.set(key, arr);
    if (this.hits.size > 50000) for (const [k, v] of this.hits) if (!v.some(t => now - t < this.windowMs)) this.hits.delete(k);
    return arr.length <= this.max;
  }
  reset(key) { this.hits.delete(key); }
}
