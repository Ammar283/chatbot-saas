// Flat-file store. Deliberately boring: no database to provision, no monthly
// bill, and a tenant's entire state is one readable JSON file you can email
// to a client. Swap for Postgres when a single tenant passes ~5k chunks.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || './data';
const cache = new Map();
let writeTimer = null;
const dirty = new Set();

function file(tenantId) {
  return path.join(DATA_DIR, `${tenantId}.json`);
}

function blank(tenantId, name) {
  return {
    id: tenantId,
    name: name || tenantId,
    createdAt: new Date().toISOString(),
    publicKey: 'pk_' + crypto.randomBytes(12).toString('hex'),
    clientKey: 'ck_' + crypto.randomBytes(16).toString('hex'),
    accountId: null,
    settings: {
      botName: 'Assistant',
      greeting: 'Hi. Ask me anything about what we do.',
      accent: '#1B3A2F',
      logoUrl: '',
      teaser: '',
      languages: 'English',
      handoffMessage: 'Let me pass this to the team — they will reply shortly.',
      bookingConfirmation: 'Your request has been recorded and the team will contact you shortly to confirm the time. Anything else I can help with?',
      notifyEmail: '',
      notifyWhatsApp: '',
      notifyWebhook: '',
      leadFields: ['name', 'phone', 'email'],
      monthlyMessageCap: Number(process.env.DEFAULT_MONTHLY_MESSAGE_CAP || 5000),
      allowedOrigins: [],
      tone: 'warm, brief, never pushy',
      businessFacts: '',
    },
    chunks: [],
    conversations: [],
    leads: [],
    cache: [],
    usage: {},
  };
}

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function load(tenantId) {
  if (cache.has(tenantId)) return cache.get(tenantId);
  const p = file(tenantId);
  let data;
  if (fs.existsSync(p)) {
    data = JSON.parse(fs.readFileSync(p, 'utf8'));
  } else {
    data = blank(tenantId);
  }
  cache.set(tenantId, data);
  return data;
}

export function save(tenantId) {
  dirty.add(tenantId);
  if (writeTimer) return;
  // Batch writes. Chat traffic is bursty and fsync per message is wasteful.
  writeTimer = setTimeout(flush, 400);
}

export function flush() {
  clearTimeout(writeTimer);
  writeTimer = null;
  ensureDataDir();
  for (const id of dirty) {
    const data = cache.get(id);
    if (!data) continue;
    const p = file(id);
    fs.writeFileSync(p + '.tmp', JSON.stringify(data));
    fs.renameSync(p + '.tmp', p);
  }
  dirty.clear();
}

export function listTenants() {
  ensureDataDir();
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => {
      const t = load(f.replace(/\.json$/, ''));
      return { id: t.id, name: t.name, createdAt: t.createdAt, publicKey: t.publicKey, clientKey: t.clientKey, accountId: t.accountId };
    });
}

export function createTenant(tenantId, name, clientKey, accountId) {
  const clean = String(tenantId).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  if (!clean) throw new Error('Please give the workspace a name.');
  if (fs.existsSync(file(clean))) throw new Error('That workspace address is already taken.');
  const t = blank(clean, name);
  // Passing an existing client key groups this site under the same login.
  if (clientKey) t.clientKey = clientKey;
  if (accountId) t.accountId = accountId;
  cache.set(clean, t);
  save(clean);
  flush();
  return t;
}

// Archive, never erase. "I deleted it by accident, can you get it back" is a
// support call you want to be able to say yes to.
export function archiveTenant(tenantId) {
  const p = file(tenantId);
  if (!fs.existsSync(p)) return null;
  const dir = path.join(DATA_DIR, '_archive');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `${tenantId}.${stamp}.json`);
  fs.renameSync(p, dest);
  cache.delete(tenantId);
  dirty.delete(tenantId);
  return dest;
}

export function listArchived() {
  const dir = path.join(DATA_DIR, '_archive');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    let name = f;
    try { name = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).name; } catch {}
    return { file: f, name, archivedAt: fs.statSync(path.join(dir, f)).mtime.toISOString() };
  }).sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}

export function restoreTenant(archiveFile) {
  const src = path.join(DATA_DIR, '_archive', path.basename(archiveFile));
  if (!fs.existsSync(src)) throw new Error('That archive no longer exists.');
  const data = JSON.parse(fs.readFileSync(src, 'utf8'));
  if (fs.existsSync(file(data.id))) throw new Error('A workspace with that address already exists again.');
  fs.renameSync(src, file(data.id));
  cache.delete(data.id);
  return data.id;
}

export function findByPublicKey(publicKey) {
  for (const meta of listTenants()) {
    if (meta.publicKey === publicKey) return load(meta.id);
  }
  return null;
}

// --- usage -------------------------------------------------------------

function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function recordUsage(tenant, { inputTokens = 0, outputTokens = 0, cached = false }) {
  const k = monthKey();
  const u = (tenant.usage[k] ||= { messages: 0, inputTokens: 0, outputTokens: 0, cacheHits: 0 });
  u.messages += 1;
  u.inputTokens += inputTokens;
  u.outputTokens += outputTokens;
  if (cached) u.cacheHits += 1;
}

export function usageThisMonth(tenant) {
  return tenant.usage[monthKey()] || { messages: 0, inputTokens: 0, outputTokens: 0, cacheHits: 0 };
}

export function overCap(tenant) {
  return usageThisMonth(tenant).messages >= (tenant.settings.monthlyMessageCap || Infinity);
}

export const id = () => crypto.randomBytes(8).toString('hex');

process.on('SIGINT', () => { flush(); process.exit(0); });
process.on('SIGTERM', () => { flush(); process.exit(0); });
