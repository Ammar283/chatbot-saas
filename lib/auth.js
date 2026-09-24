// Email + password accounts with signed session cookies.
//
// No auth library and no database. Node's crypto has everything needed, and a
// dependency you don't add is a dependency you don't have to patch at 2am.
//
// Accounts are the *credential*; workspaces are still owned by tenant records.
// The API keys still work alongside this, so scripts and curl keep functioning.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = () => process.env.DATA_DIR || './data';
const FILE = () => path.join(DATA_DIR(), '_accounts.json');
const SESSION_HOURS = 24 * 14;

// --- storage -----------------------------------------------------------

let accounts = null;

function read() {
  if (accounts) return accounts;
  try {
    accounts = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  } catch {
    accounts = [];
  }
  return accounts;
}

function write() {
  fs.mkdirSync(DATA_DIR(), { recursive: true });
  fs.writeFileSync(FILE() + '.tmp', JSON.stringify(accounts, null, 2));
  fs.renameSync(FILE() + '.tmp', FILE());
}

// --- passwords ---------------------------------------------------------
// scrypt with a per-account salt. Comparison is timing-safe so an attacker
// can't learn anything from how long a failed login takes.

function hash(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function verify(password, account) {
  const attempt = Buffer.from(hash(password, account.salt), 'hex');
  const stored = Buffer.from(account.passwordHash, 'hex');
  return attempt.length === stored.length && crypto.timingSafeEqual(attempt, stored);
}

export function listAccounts() {
  return read().map(({ passwordHash, salt, ...rest }) => rest);
}

export function findByEmail(email) {
  return read().find((a) => a.email === String(email || '').trim().toLowerCase());
}

export function findById(id) {
  return read().find((a) => a.id === id);
}

export function createAccount({ email, password, role = 'client', name = '' }) {
  const clean = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(clean)) throw new Error('That does not look like an email address.');
  if (String(password || '').length < 8) throw new Error('Password must be at least 8 characters.');
  if (findByEmail(clean)) throw new Error('An account with that email already exists.');

  const salt = crypto.randomBytes(16).toString('hex');
  const account = {
    id: 'acc_' + crypto.randomBytes(10).toString('hex'),
    email: clean,
    name: name || clean.split('@')[0],
    role,                          // 'owner' = you, 'client' = them
    salt,
    passwordHash: hash(password, salt),
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  };
  read().push(account);
  write();
  return account;
}

// Clients change jobs, agencies change their contact address, and people mistype
// an email at signup. Without this the only fix is deleting the account, which
// would orphan every workspace attached to it.
export function setEmail(accountId, email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(clean)) throw new Error('That does not look like an email address.');
  const a = findById(accountId);
  if (!a) throw new Error('Account not found.');
  const taken = findByEmail(clean);
  if (taken && taken.id !== accountId) throw new Error('Another account already uses that email.');
  a.email = clean;
  write();
  return a;
}

export function setPassword(accountId, password) {
  if (String(password || '').length < 8) throw new Error('Password must be at least 8 characters.');
  const a = findById(accountId);
  if (!a) throw new Error('Account not found.');
  a.salt = crypto.randomBytes(16).toString('hex');
  a.passwordHash = hash(password, a.salt);
  write();
  return a;
}

export function deleteAccount(accountId) {
  accounts = read().filter((a) => a.id !== accountId);
  write();
}

export function login(email, password) {
  const a = findByEmail(email);
  // Hash anyway on a missing account so timing doesn't reveal which emails exist.
  if (!a) { hash(password, 'decoy-salt-value'); return null; }
  if (!verify(password, a)) return null;
  a.lastLoginAt = new Date().toISOString();
  write();
  return a;
}

// --- sessions ----------------------------------------------------------
// Stateless signed token: id.expiry.signature. Nothing to store, nothing to
// clean up, and revocation comes free by rotating SESSION_SECRET.

const secret = () => process.env.SESSION_SECRET || process.env.ADMIN_KEY || 'insecure-development-secret';

export function issueToken(account) {
  const expires = Date.now() + SESSION_HOURS * 3600e3;
  const payload = `${account.id}.${expires}`;
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

export function readToken(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [id, expires, sig] = parts;
  const expected = crypto.createHmac('sha256', secret()).update(`${id}.${expires}`).digest('hex');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  if (Date.now() > Number(expires)) return null;
  return findById(id) || null;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const COOKIE = 'fd_session';

export function cookieOptions() {
  return {
    httpOnly: true,                                  // JavaScript on the page can't read it
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',   // HTTPS only once deployed
    maxAge: SESSION_HOURS * 3600e3,
    path: '/',
  };
}

// First run: create the owner account so there is a way in.
export function bootstrapOwner() {
  if (read().some((a) => a.role === 'owner')) return null;
  const email = process.env.OWNER_EMAIL;
  const password = process.env.OWNER_PASSWORD;
  if (!email || !password) return null;
  return createAccount({ email, password, role: 'owner', name: 'Owner' });
}
