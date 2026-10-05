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
      // Shown beside the green dot in the chat header, followed by the
      // visitor's current time.
      statusText: 'Online now',
      // Billing suspension. The bot stops on the client's site, but the message
      // is shown only in their dashboard — never to their own visitors, who
      // should never learn about a billing dispute.
      suspended: false,
      suspendedMessage: 'Your subscription is overdue. The chatbot is paused on your website until payment is received. Your leads and knowledge base are safe.',
      accent: '#1B3A2F',
      // The colour of text sitting ON the accent — the header, the visitor's
      // own messages, the Send button. Empty means the widget works it out
      // from the accent, which is right for almost every client; it is here
      // for the ones whose brand colour lands in the awkward middle, where
      // neither white nor near-black is quite what they want.
      accentText: '',
      logoUrl: '',
      // The line under the chat box. Owner-controlled, not client-editable:
      // it is the only brand presence on a client's site, so removing it is
      // something you grant or sell, never something they switch off.
      footerText: 'Powered by aiFrontBot',
      footerUrl: 'https://aifrontbot.net',
      // Typeface for the chat widget. A bare family name costs nothing when the
      // client's site already loads that font; fontUrl is only for when it does
      // not, and it adds a third-party request to their page.
      fontFamily: '',
      fontUrl: '',
      brandName: '',            // shown in the dashboard instead of "Front Desk"
      dashboardAccent: '',      // falls back to the widget accent
      dashboardLogoUrl: '',     // wide logo for the dashboard; separate from the chat avatar
      dashboardHighlight: '',   // the highlight colour: active menu item, key figures
      autoOpenSeconds: 0,       // desktop only; 0 means the visitor opens it themselves
      teaser: '',
      // Tappable options shown with the greeting. Visitors often do not know
      // what to ask; a menu converts far better than an empty text box.
      quickReplies: [
        'Book an appointment',
        'What services do you offer?',
        'What are your opening hours?',
        'Where are you located?',
      ],
      languages: 'English',
      handoffMessage: 'Let me pass this to the team — they will reply shortly.',
      // Appended when the bot cannot answer and has no way to reach the
      // visitor. Without it the conversation ends at "I'll check with the
      // team", the visitor closes the tab, and nobody can ever follow up on
      // the one question that proved they were a real buyer.
      unansweredAsk: 'What is the best number to reach you on? Someone from the team will call you back with an answer.',
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
    dismissedGaps: [],
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

// --- app-wide settings ------------------------------------------------
// Everything else here is per-workspace. The sign-in page is shared by every
// client, so its default appearance has to live somewhere global.

const APP_DEFAULTS = {
  loginProductName: 'Front Desk',
  loginTagline: 'chatbot console',
  loginLogoUrl: '',
  loginAccent: '#1B3A2F',
};

function appFile() {
  return path.join(DATA_DIR, '_app.json');
}

export function loadApp() {
  try {
    return { ...APP_DEFAULTS, ...JSON.parse(fs.readFileSync(appFile(), 'utf8')) };
  } catch {
    return { ...APP_DEFAULTS };
  }
}

export function saveApp(patch) {
  const next = { ...loadApp(), ...(patch || {}) };
  ensureDataDir();
  fs.writeFileSync(appFile() + '.tmp', JSON.stringify(next, null, 2));
  fs.renameSync(appFile() + '.tmp', appFile());
  return next;
}

// --- provider usage ----------------------------------------------------
// Per-tenant usage above answers "is this client worth what they pay". This
// answers a different question: how close the whole account is to the provider's
// daily ceiling. That limit is account-wide and per model, so it cannot be
// derived from any one workspace — and it is the limit that actually stops the
// bots, silently, in the evening when the day's traffic has added up.

const usageFile = () => path.join(DATA_DIR, '_usage.json');
let usageCache = null;
let usageTimer = null;

function readUsage() {
  if (usageCache) return usageCache;
  try { usageCache = JSON.parse(fs.readFileSync(usageFile(), 'utf8')); }
  catch { usageCache = {}; }
  return usageCache;
}

function flushUsage() {
  clearTimeout(usageTimer);
  usageTimer = null;
  if (!usageCache) return;
  ensureDataDir();
  fs.writeFileSync(usageFile() + '.tmp', JSON.stringify(usageCache));
  fs.renameSync(usageFile() + '.tmp', usageFile());
}

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

export function recordModelUsage(model, { inputTokens = 0, outputTokens = 0 } = {}) {
  if (!model) return;
  const u = readUsage();
  const day = (u[dayKey()] ||= {});
  const m = (day[model] ||= { tokens: 0, requests: 0 });
  m.tokens += Number(inputTokens || 0) + Number(outputTokens || 0);
  m.requests += 1;

  // A month of history is plenty to see a trend and keeps the file tiny.
  const cutoff = dayKey(new Date(Date.now() - 31 * 864e5));
  for (const k of Object.keys(u)) if (k < cutoff) delete u[k];

  // Batched like tenant writes — chat traffic is bursty and this is one small file.
  if (!usageTimer) usageTimer = setTimeout(flushUsage, 2000);
}

export function usageHistory(days = 7) {
  const u = readUsage();
  const out = [];
  for (let i = 0; i < days; i++) {
    const key = dayKey(new Date(Date.now() - i * 864e5));
    const models = u[key] || {};
    out.push({
      date: key,
      models,
      tokens: Object.values(models).reduce((n, m) => n + m.tokens, 0),
      requests: Object.values(models).reduce((n, m) => n + m.requests, 0),
    });
  }
  return out;
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

// Move a workspace to a different client login — or to none.
//
// The client key travels with it, because that key *is* the client's. A
// workspace joining a client who already has one adopts their key, so all their
// sites stay under a single sign-in. A workspace leaving a client is issued a
// fresh one, so the previous client's key stops opening it the moment you
// reassign — otherwise handing a site to a new owner would quietly leave the old
// one holding a working credential.
export function assignTenant(tenantId, accountId) {
  if (!fs.existsSync(file(tenantId))) throw new Error('That workspace no longer exists.');
  const t = load(tenantId);
  t.accountId = accountId || null;
  const sibling = accountId
    ? listTenants().find((m) => m.id !== tenantId && m.accountId === accountId)
    : null;
  t.clientKey = sibling ? sibling.clientKey : 'ck_' + crypto.randomBytes(16).toString('hex');
  save(tenantId);
  flush();
  return t;
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

process.on('SIGINT', () => { flush(); flushUsage(); process.exit(0); });
process.on('SIGTERM', () => { flush(); flushUsage(); process.exit(0); });
