import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as store from './lib/store.js';
import * as auth from './lib/auth.js';
import * as health from './lib/health.js';
import { notifyLead, channelsConfigured, notifyStatus } from './lib/notify.js';
import { create as createBackup } from './scripts/backup.js';
import { buildIndex, bm25, fuse, cosine, cacheLookup, cacheStore, cacheClear } from './lib/retrieve.js';
import { chat, embed, needsSmartModel } from './lib/llm.js';
import { buildSystemPrompt, parseReply, isContactable, isComplete, extractFromMessage, cleanLead, DEFAULT_CONFIRMATION } from './lib/prompt.js';
import { crawl, chunkText, attachEmbeddings } from './lib/ingest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Minimal res.cookie / res.clearCookie so we don't pull in cookie-parser.
function cookieShim(req, res, next) {
  res.cookie = (name, value, opts = {}) => {
    const bits = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path || '/'}`];
    if (opts.maxAge) bits.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
    if (opts.httpOnly) bits.push('HttpOnly');
    if (opts.sameSite) bits.push(`SameSite=${opts.sameSite}`);
    if (opts.secure) bits.push('Secure');
    res.append('Set-Cookie', bits.join('; '));
    return res;
  };
  res.clearCookie = (name, opts = {}) => res.cookie(name, '', { ...opts, maxAge: 0 });
  next();
}
const app = express();
app.use(express.json({ limit: '2mb' }));
// The widget is embedded on other people's sites, so /api/chat stays open.
// Dashboard routes rely on a same-origin cookie, which cors() does not expose.
app.use(cors());
app.use(cookieShim);
app.use(express.static(path.join(__dirname, 'public')));

store.ensureDataDir();
const bootstrapped = auth.bootstrapOwner();
if (bootstrapped) console.log(`\n  Owner account created: ${bootstrapped.email}`);

// Indexes are rebuilt only when a tenant's knowledge base changes.
const indexes = new Map();
function getIndex(tenant) {
  if (!indexes.has(tenant.id)) indexes.set(tenant.id, buildIndex(tenant.chunks));
  return indexes.get(tenant.id);
}
function invalidate(tenantId) { indexes.delete(tenantId); }

// --- rate limiting -----------------------------------------------------
const visitorHits = new Map();
setInterval(() => visitorHits.clear(), 60 * 60 * 1000).unref();

function rateLimited(key) {
  const cap = Number(process.env.MAX_MESSAGES_PER_VISITOR_PER_HOUR || 30);
  const n = (visitorHits.get(key) || 0) + 1;
  visitorHits.set(key, n);
  return n > cap;
}

// Two levels of access.
//   Master key (ADMIN_KEY in .env)  -> you. Every workspace.
//   Client key (ck_... per client)  -> them. Only their own workspaces.
// Without this split you cannot hand the dashboard to a client at all: one key
// would show them every other client's leads.
// Session cookie is the normal path. API keys still work so scripts, curl and
// anything you automate later keep functioning.
function requireAdmin(req, res, next) {
  const account = auth.readToken(auth.parseCookies(req.get('cookie'))[auth.COOKIE]);

  if (account) {
    req.account = account;
    req.isMaster = account.role === 'owner';
    if (!req.isMaster) {
      req.ownedIds = store.listTenants()
        .filter((t) => t.accountId === account.id)
        .map((t) => t.id);
    }
    return next();
  }

  const key = req.get('x-admin-key') || req.query.adminKey;
  if (!key) return res.status(401).json({ error: 'Please sign in.' });

  req.isMaster = Boolean(process.env.ADMIN_KEY) && key === process.env.ADMIN_KEY;
  req.authKey = key;

  if (!req.isMaster) {
    const owned = store.listTenants().filter((t) => t.clientKey === key);
    if (!owned.length) return res.status(401).json({ error: 'Sign-in details not recognised.' });
    req.ownedIds = owned.map((t) => t.id);
  }
  next();
}

function requireOwner(req, res, next) {
  if (!req.isMaster) return res.status(403).json({ error: 'Only the account owner can do that.' });
  next();
}

// Applies to every route carrying a :tenantId.
function requireTenant(req, res, next) {
  if (req.isMaster || req.ownedIds?.includes(req.params.tenantId)) return next();
  return res.status(403).json({ error: 'That workspace is not on your account.' });
}
app.param('tenantId', (req, res, next) => next());

// =======================================================================
// PUBLIC — the widget talks to this
// =======================================================================

app.get('/api/config/:publicKey', (req, res) => {
  const tenant = store.findByPublicKey(req.params.publicKey);
  if (!tenant) return res.status(404).json({ error: 'Unknown workspace key.' });
  const s = tenant.settings;
  res.json({
    botName: s.botName, greeting: s.greeting, accent: s.accent,
    logoUrl: s.logoUrl || '', teaser: s.teaser || '',
    autoOpenSeconds: Number(s.autoOpenSeconds) || 0,
    quickReplies: Array.isArray(s.quickReplies) ? s.quickReplies.slice(0, 8) : [],
    tenant: tenant.name,
  });
});

app.post('/api/chat', async (req, res) => {
  const { publicKey, message, conversationId, history = [] } = req.body || {};
  const tenant = store.findByPublicKey(publicKey);
  if (!tenant) return res.status(404).json({ error: 'Unknown workspace key.' });
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Message is required.' });

  // A public key sits in the page source of the client's site. Origin locking
  // is what stops someone lifting it and burning the client's quota elsewhere.
  const allowed = tenant.settings.allowedOrigins || [];
  const origin = req.get('origin');
  if (allowed.length && origin && !allowed.some((a) => origin === a || origin.endsWith('.' + a.replace(/^https?:\/\//, '')))) {
    return res.status(403).json({ error: 'This key is not permitted on that domain.' });
  }

  const visitor = `${tenant.id}:${req.ip}`;
  if (rateLimited(visitor)) {
    return res.json({ answer: 'You have hit the message limit for this hour. Please try again later.', suggestions: [] });
  }
  if (store.overCap(tenant)) {
    return res.json({ answer: tenant.settings.handoffMessage, handoff: true, suggestions: [] });
  }

  const convId = conversationId || store.id();

  try {
    // 1. Cache. Free, instant, and covers the repeat questions.
    const cached = cacheLookup(tenant, message);
    if (cached && history.length === 0) {
      store.recordUsage(tenant, { cached: true });
      logTurn(tenant, convId, message, cached, { cached: true });
      store.save(tenant.id);
      return res.json({ answer: cached, conversationId: convId, suggestions: [], cached: true });
    }

    // 2. Retrieve.
    const index = getIndex(tenant);
    const keyword = bm25(index, message, 6);
    let results = keyword;

    if (process.env.EMBED_API_KEY && tenant.chunks.some((c) => c.vector)) {
      const qv = await embed([message]);
      if (qv) {
        const vector = tenant.chunks
          .filter((c) => c.vector)
          .map((c) => ({ chunk: c, score: cosine(qv[0], c.vector) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 6);
        results = fuse([keyword, vector]).slice(0, 5);
      }
    }
    results = results.slice(0, 5);

    // 3. Answer.
    const knownLead = tenant.leads.find((l) => l.conversationId === convId) || {};
    // What did the bot ask for last turn? Lets us read a bare "03124574845"
    // or "Ammar Aziz" as an answer rather than guessing from the text alone.
    const required = tenant.settings.leadFields || ['name', 'phone'];
    const lastBotMessage = [...history].reverse().find((h) => h.role === 'assistant')?.content || '';
    const asking = /email/i.test(lastBotMessage) ? 'email'
      : /phone|number|whatsapp|mobile/i.test(lastBotMessage) ? 'phone'
      : /name/i.test(lastBotMessage) ? 'name'
      : null;
    const messages = [
      { role: 'system', content: buildSystemPrompt(tenant, results, knownLead) },
      ...history.slice(-6).map((h) => ({ role: h.role, content: String(h.content).slice(0, 1000) })),
      { role: 'user', content: message.slice(0, 1000) },
    ];

    // Capture contact details from the raw message first — this must not
    // depend on the model call succeeding.
    const scanned = cleanLead(extractFromMessage(message, asking));
    const gaveDetails = Object.keys(scanned).length > 0;
    const scannedLead = mergeLead(tenant, convId, scanned);
    if (scannedLead) { store.save(tenant.id); notifyOnce(tenant, scannedLead); }

    const model = needsSmartModel(message, results) ? process.env.LLM_MODEL_SMART : process.env.LLM_MODEL;
    const out = await chat(messages, { model, json: true, maxTokens: 500 });
    const reply = parseReply(out.text, tenant);

    store.recordUsage(tenant, { inputTokens: out.inputTokens, outputTokens: out.outputTokens });
    health.recordSuccess(reply.grounded);

    // Only cache grounded, standalone answers — never anything conversational.
    if (reply.grounded && history.length === 0 && !reply.handoff) {
      cacheStore(tenant, message, reply.answer);
    }

    // Details arrive one message at a time, so merge rather than replace, and
    // never let a later blank wipe something already collected.
    // The model may still spot something the regex missed (a name given mid
    // sentence, the intent), so merge its extraction on top.
    const lead = mergeLead(tenant, convId, reply.lead);
    if (lead) notifyOnce(tenant, lead);

    logTurn(tenant, convId, message, reply.answer, {
      grounded: reply.grounded,
      handoff: reply.handoff,
      model: out.model,
      // A name or phone number is not a question the bot failed to answer.
      leadTurn: gaveDetails || asking !== null,
    });
    store.save(tenant.id);

    // A blank reply reads as a broken bot. Fall back to something sensible.
    if (!reply.answer.trim()) {
      const merged = { ...knownLead, ...reply.lead };
      reply.answer = isComplete(merged, required)
        ? (tenant.settings.bookingConfirmation || DEFAULT_CONFIRMATION)
        : tenant.settings.handoffMessage;
    }

    res.json({
      answer: reply.answer,
      conversationId: convId,
      handoff: reply.handoff,
      suggestions: reply.suggestions,
      sources: results.map((r) => r.chunk.url).filter(Boolean).slice(0, 2),
    });
  } catch (err) {
    console.error('[chat]', err.message);
    health.recordFailure(err.message);
    store.save(tenant.id);   // anything scanned before the failure is kept
    res.json({ answer: tenant.settings.handoffMessage, conversationId: convId, handoff: true, suggestions: [] });
  }
});

// Contact details are merged the moment they are seen, before the model is
// called. If the provider is down or returns junk, the lead is still captured
// — losing a customer's phone number because an API had a bad minute is not
// an acceptable failure mode.
// Ping once when the lead first becomes reachable, and once more when every
// detail is in. Not on every field, or it becomes noise the owner learns to
// ignore — which is the same as not sending it at all.
function notifyOnce(tenant, lead) {
  const stage = lead.complete ? 'complete' : lead.contactable ? 'contactable' : null;
  if (!stage || lead.notifiedStage === stage || lead.notifiedStage === 'complete') return;
  lead.notifiedStage = stage;
  // Deliberately not awaited: the visitor should never wait on an email.
  notifyLead(tenant, lead)
    .then((r) => { const bad = r.filter((x) => x.failed); if (bad.length) console.warn('[notify]', bad); })
    .catch((e) => console.warn('[notify]', e.message));
}

// The gaps list is only useful if every line is a real question the knowledge
// base failed to answer. Contact details, greetings and questions about the
// visitor's own booking are ungrounded by definition — listing them buries the
// genuine gaps the client should act on.
const PHONE_LIKE = /^[\s+\d()./-]{6,}$/;
const EMAIL_LIKE = /@/;
// A person's name is rarely more than four words — anything longer that looks
// like plain words is a sentence, very often a question in a language whose
// question words we do not list.
const NAME_LIKE = (q) => /^[\p{L}\s.'-]{2,40}$/u.test(q) && q.split(/\s+/).length <= 4;
// Question markers across the languages this bot actually sees.
const QUESTION_WORD = /\?|\b(do|does|did|can|could|what|when|where|how|why|who|which|is|are|will|would|should|price|cost|open|available)\b|\b(kya|kia|kitna|kitne|kitni|kab|kahan|kaise|kaisay|konsa|hai|ho|karte|krte)\b/i;
const SMALL_TALK = /^(hi|hey|hello|thanks?|thank you|ok|okay|sure|yes|no|bye|good (morning|afternoon|evening)|salam|assalam[ou]? ?alaikum)\b/i;
const OWN_BOOKING = /\b(my|the) (appointment|booking|request|slot)\b|\bis (it|that|my appointment) (booked|confirmed)\b/i;

function isKnowledgeGap(turn) {
  if (turn.grounded !== false) return false;
  if (turn.leadTurn) return false;
  const q = String(turn.q || '').trim();
  if (q.length < 8) return false;
  if (SMALL_TALK.test(q)) return false;
  if (OWN_BOOKING.test(q)) return false;
  // A bare name, phone number or email is an answer, not a question.
  const looksLikeContact = PHONE_LIKE.test(q) || EMAIL_LIKE.test(q) || NAME_LIKE(q);
  if (looksLikeContact && !QUESTION_WORD.test(q)) return false;
  return true;
}

function mergeLead(tenant, convId, fields) {
  if (!Object.keys(fields).length) return null;
  const required = tenant.settings.leadFields || ['name', 'phone'];
  let lead = tenant.leads.find((l) => l.conversationId === convId);
  // "Wants: appointment" with no name, phone or email is not a lead — it is a
  // row the client cannot act on. Wait for something identifying before
  // creating one; intent alone is kept for when that arrives.
  if (!lead && !(fields.name || fields.phone || fields.email)) return null;
  if (!lead) {
    lead = { id: store.id(), conversationId: convId, at: new Date().toISOString(), status: 'new' };
    tenant.leads.unshift(lead);
  }
  for (const [k, v] of Object.entries(fields)) if (v) lead[k] = v;
  lead.updatedAt = new Date().toISOString();
  lead.complete = isComplete(lead, required);
  lead.contactable = isContactable(lead);
  lead.missing = required.filter((f) => !String(lead[f] || '').trim());
  const conv = tenant.conversations.find((c) => c.id === convId);
  if (conv?.turns?.length) lead.firstQuestion = conv.turns[0].q;
  return lead;
}

function logTurn(tenant, convId, question, answer, meta = {}) {
  let conv = tenant.conversations.find((c) => c.id === convId);
  if (!conv) {
    conv = { id: convId, startedAt: new Date().toISOString(), turns: [] };
    tenant.conversations.unshift(conv);
    if (tenant.conversations.length > 500) tenant.conversations.length = 500;
  }
  conv.turns.push({ q: question, a: answer, at: new Date().toISOString(), ...meta });
  conv.lastAt = new Date().toISOString();
}

// =======================================================================
// SESSIONS
// =======================================================================

const loginAttempts = new Map();
setInterval(() => loginAttempts.clear(), 15 * 60 * 1000).unref();

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const n = (loginAttempts.get(req.ip) || 0) + 1;
  loginAttempts.set(req.ip, n);
  if (n > 10) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });

  const account = auth.login(email, password);
  // Deliberately vague: never reveal whether the email exists.
  if (!account) return res.status(401).json({ error: 'Email or password is incorrect.' });

  res.cookie(auth.COOKIE, auth.issueToken(account), auth.cookieOptions());
  res.json({ email: account.email, name: account.name, role: account.role });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(auth.COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', requireAdmin, (req, res) => {
  res.json({
    email: req.account?.email || 'API key',
    name: req.account?.name || 'API key',
    role: req.isMaster ? 'owner' : 'client',
    usingKey: !req.account,
  });
});

app.post('/api/me/password', requireAdmin, (req, res) => {
  if (!req.account) return res.status(400).json({ error: 'Sign in with an email and password to change it.' });
  const { current, next } = req.body || {};
  if (!auth.login(req.account.email, current)) return res.status(401).json({ error: 'Current password is incorrect.' });
  try {
    auth.setPassword(req.account.id, next);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- accounts (owner only) ---
app.get('/api/admin/accounts', requireAdmin, requireOwner, (req, res) => {
  const tenants = store.listTenants();
  res.json(auth.listAccounts().map((a) => ({
    ...a,
    workspaces: tenants.filter((t) => store.load(t.id).accountId === a.id).map((t) => t.name),
  })));
});

app.post('/api/admin/accounts', requireAdmin, requireOwner, (req, res) => {
  try {
    const a = auth.createAccount({ ...req.body, role: 'client' });
    res.json({ id: a.id, email: a.email, name: a.name });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/admin/accounts/:id/email', requireAdmin, requireOwner, (req, res) => {
  try {
    const a = auth.setEmail(req.params.id, req.body.email);
    res.json({ ok: true, email: a.email });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/admin/accounts/:id/password', requireAdmin, requireOwner, (req, res) => {
  try { auth.setPassword(req.params.id, req.body.password); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/admin/accounts/:id', requireAdmin, requireOwner, (req, res) => {
  if (req.account?.id === req.params.id) return res.status(400).json({ error: 'You cannot remove your own account.' });
  auth.deleteAccount(req.params.id);
  res.json({ ok: true });
});

// --- your business at a glance (owner only) ---
app.get('/api/admin/summary', requireAdmin, requireOwner, (req, res) => {
  const now = Date.now();
  const rows = store.listTenants().map((meta) => {
    const t = store.load(meta.id);
    const usage = store.usageThisMonth(t);
    const last = t.conversations[0]?.lastAt || t.conversations[0]?.startedAt || null;
    const daysQuiet = last ? Math.floor((now - new Date(last).getTime()) / 864e5) : null;
    const account = t.accountId ? auth.findById(t.accountId) : null;
    return {
      id: t.id,
      name: t.name,
      account: account?.email || null,
      chunks: t.chunks.length,
      leads: t.leads.length,
      newLeads: t.leads.filter((l) => l.status === 'new').length,
      messages: usage.messages,
      capUsedPct: Math.round((usage.messages / (t.settings.monthlyMessageCap || 1)) * 100),
      lastActivity: last,
      daysQuiet,
      // No traffic for a fortnight is the earliest churn signal you get.
      health: !last ? 'not live' : daysQuiet > 14 ? 'at risk' : daysQuiet > 5 ? 'quiet' : 'active',
    };
  });

  res.json({
    workspaces: rows.length,
    clients: new Set(rows.map((r) => r.account).filter(Boolean)).size,
    totalLeads: rows.reduce((n, r) => n + r.leads, 0),
    newLeads: rows.reduce((n, r) => n + r.newLeads, 0),
    messagesThisMonth: rows.reduce((n, r) => n + r.messages, 0),
    atRisk: rows.filter((r) => r.health === 'at risk').length,
    rows: rows.sort((a, b) => (b.leads - a.leads)),
    archived: store.listArchived(),
  });
});

// =======================================================================
// ADMIN — the dashboard talks to this
// =======================================================================

app.get('/api/admin/tenants', requireAdmin, (req, res) => {
  const all = store.listTenants();
  const mine = req.isMaster ? all : all.filter((t) => req.ownedIds.includes(t.id));
  // Never leak a client key to anyone but the master account.
  res.json(mine.map((t) => (req.isMaster ? t : { ...t, clientKey: undefined, accountId: undefined })));
});

app.post('/api/admin/tenants', requireAdmin, (req, res) => {
  try {
    const { id, name, groupWith, accountId } = req.body || {};
    let clientKey, owner;
    if (!req.isMaster) {
      clientKey = req.authKey;                  // clients can only add to their own account
      owner = req.account?.id;
    } else if (groupWith) {
      const sibling = store.load(groupWith);    // put this site under an existing client
      clientKey = sibling?.clientKey;
      owner = sibling?.accountId;
    }
    const t = store.createTenant(id || name, name || id, clientKey, accountId || owner);
    res.json({ id: t.id, name: t.name, publicKey: t.publicKey, clientKey: req.isMaster ? t.clientKey : undefined });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Clients can remove their own workspaces. Typing the name is required, and
// the data is archived rather than erased so a mistake is recoverable.
app.delete('/api/admin/tenants/:tenantId', requireAdmin, requireTenant, (req, res) => {
  const t = store.load(req.params.tenantId);
  const confirm = String(req.body?.confirm || '').trim();
  if (confirm.toLowerCase() !== String(t.name).trim().toLowerCase()) {
    return res.status(400).json({ error: 'Type the workspace name exactly to confirm.' });
  }
  store.flush();
  const dest = store.archiveTenant(req.params.tenantId);
  invalidate(req.params.tenantId);
  res.json({ ok: true, archived: Boolean(dest) });
});

app.post('/api/admin/archive/:file/restore', requireAdmin, requireOwner, (req, res) => {
  try { res.json({ id: store.restoreTenant(req.params.file) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/admin/:tenantId/overview', requireAdmin, requireTenant, (req, res) => {
  const t = store.load(req.params.tenantId);
  const usage = store.usageThisMonth(t);
  const since = Date.now() - 30 * 864e5;
  const recent = t.conversations.filter((c) => new Date(c.startedAt).getTime() > since);
  // Some gaps get answered in "What the bot should know" and some are simply
  // not worth chasing. Dismissed ones stay dismissed so the list keeps meaning
  // something rather than becoming a wall the client scrolls past.
  const dismissed = new Set(t.dismissedGaps || []);
  const unanswered = recent
    .flatMap((c) => c.turns.filter(isKnowledgeGap).map((x) => x.q))
    .filter((q) => !dismissed.has(q));

  res.json({
    name: t.name,
    publicKey: t.publicKey,
    clientKey: req.isMaster ? t.clientKey : undefined,
    isMaster: Boolean(req.isMaster),
    settings: t.settings,
    chunks: t.chunks.length,
    usage,
    conversations: recent.length,
    messages: recent.reduce((n, c) => n + c.turns.length, 0),
    leads: t.leads.length,
    newLeads: t.leads.filter((l) => l.status === 'new').length,
    cacheHitRate: usage.messages ? Math.round((usage.cacheHits / usage.messages) * 100) : 0,
    estimatedCostUsd: +(((usage.inputTokens / 1e6) * Number(process.env.PRICE_IN_PER_M || 0)
      + (usage.outputTokens / 1e6) * Number(process.env.PRICE_OUT_PER_M || 0))).toFixed(4),
    completeLeads: t.leads.filter((l) => l.complete).length,
    unanswered: [...new Set(unanswered)].slice(0, 20),
  });
});

app.post('/api/admin/:tenantId/gaps/dismiss', requireAdmin, requireTenant, (req, res) => {
  const t = store.load(req.params.tenantId);
  const q = String(req.body?.question || '').trim();
  if (!q) return res.status(400).json({ error: 'No question given.' });
  t.dismissedGaps = [...new Set([...(t.dismissedGaps || []), q])].slice(-500);
  store.save(t.id);
  store.flush();
  res.json({ ok: true });
});

app.get('/api/admin/:tenantId/leads', requireAdmin, requireTenant, (req, res) => {
  res.json(store.load(req.params.tenantId).leads.slice(0, 200));
});

app.delete('/api/admin/:tenantId/leads/:leadId', requireAdmin, requireTenant, (req, res) => {
  const t = store.load(req.params.tenantId);
  const before = t.leads.length;
  t.leads = t.leads.filter((l) => l.id !== req.params.leadId);
  store.save(t.id);
  store.flush();
  res.json({ ok: true, removed: before - t.leads.length });
});

app.patch('/api/admin/:tenantId/leads/:leadId', requireAdmin, requireTenant, (req, res) => {
  const t = store.load(req.params.tenantId);
  const lead = t.leads.find((l) => l.id === req.params.leadId);
  if (!lead) return res.status(404).json({ error: 'Lead not found.' });
  if (req.body.status) lead.status = req.body.status;
  store.save(t.id);
  res.json(lead);
});

// Clients ask for their leads in a spreadsheet. Giving them an export button
// is far better than them asking you to email a list every week.
app.get('/api/admin/:tenantId/leads.csv', requireAdmin, requireTenant, (req, res) => {
  const t = store.load(req.params.tenantId);
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Date', 'Name', 'Phone', 'Email', 'Wants', 'First question', 'Status'].join(',')];
  for (const l of t.leads) {
    rows.push([l.at, l.name, l.phone, l.email, l.intent, l.firstQuestion, l.status].map(cell).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${t.id}-leads.csv"`);
  res.send('\uFEFF' + rows.join('\n'));
});

// Conversations are the client's own records, so they can clear them. Deleting
// one leaves any lead it produced untouched — those are separate rows, and
// losing a phone number because someone tidied a chat log would be a bad day.
app.delete('/api/admin/:tenantId/conversations/:convId', requireAdmin, requireTenant, (req, res) => {
  const t = store.load(req.params.tenantId);
  const before = t.conversations.length;
  t.conversations = t.conversations.filter((c) => c.id !== req.params.convId);
  store.save(t.id);
  store.flush();
  res.json({ ok: true, removed: before - t.conversations.length });
});

app.get('/api/admin/:tenantId/conversations', requireAdmin, requireTenant, (req, res) => {
  res.json(store.load(req.params.tenantId).conversations.slice(0, 100));
});

app.put('/api/admin/:tenantId/settings', requireAdmin, requireTenant, (req, res) => {
  const t = store.load(req.params.tenantId);
  Object.assign(t.settings, req.body || {});
  cacheClear(t); // settings changed the bot's behaviour; old answers are stale
  store.save(t.id);
  store.flush();
  res.json(t.settings);
});

app.post('/api/admin/:tenantId/ingest/url', requireAdmin, requireTenant, async (req, res) => {
  const t = store.load(req.params.tenantId);
  const { url, maxPages = 25, replace = true } = req.body || {};
  if (!url) return res.status(400).json({ error: 'A website address is required.' });
  try {
    const { pages, chunks } = await crawl(url, { maxPages });
    await attachEmbeddings(chunks);
    t.chunks = replace ? chunks : t.chunks.concat(chunks);
    cacheClear(t);
    invalidate(t.id);
    store.save(t.id);
    store.flush();
    res.json({ pages: pages.length, chunks: chunks.length, crawled: pages });
  } catch (e) {
    res.status(400).json({ error: `Could not read that site: ${e.message}` });
  }
});

app.post('/api/admin/:tenantId/ingest/text', requireAdmin, requireTenant, async (req, res) => {
  const t = store.load(req.params.tenantId);
  const { title = 'Notes', text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'Some text is required.' });
  const chunks = chunkText(text, title, null);
  await attachEmbeddings(chunks);
  t.chunks.push(...chunks);
  cacheClear(t);
  invalidate(t.id);
  store.save(t.id);
  store.flush();
  res.json({ chunks: chunks.length, total: t.chunks.length });
});

// Clears test leads and conversations but keeps the knowledge base and every
// setting. Before a client demo you want the activity wiped, not the hours of
// crawling and branding that make the thing look finished.
app.delete('/api/admin/:tenantId/activity', requireAdmin, requireTenant, (req, res) => {
  const t = store.load(req.params.tenantId);
  const removed = { leads: t.leads.length, conversations: t.conversations.length };
  t.leads = [];
  t.conversations = [];
  t.cache = [];
  t.usage = {};
  store.save(t.id);
  store.flush();
  res.json({ ok: true, removed });
});

app.get('/api/admin/:tenantId/knowledge', requireAdmin, requireTenant, (req, res) => {
  const t = store.load(req.params.tenantId);
  res.json(t.chunks.map((c) => ({ id: c.id, title: c.title, url: c.url, preview: c.text.slice(0, 160) })));
});

app.delete('/api/admin/:tenantId/knowledge', requireAdmin, requireTenant, (req, res) => {
  const t = store.load(req.params.tenantId);
  t.chunks = [];
  cacheClear(t);
  invalidate(t.id);
  store.save(t.id);
  store.flush();
  res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({ ok: true }));

// Owner-facing. Shows whether the model is actually answering.
app.get('/api/admin/status', requireAdmin, requireOwner, (req, res) => {
  res.json({ ...health.snapshot(), provider: process.env.LLM_BASE_URL, model: process.env.LLM_MODEL,
    fallbackConfigured: Boolean(process.env.LLM_FALLBACK_API_KEY) });
});

app.get('/api/admin/:tenantId/channels', requireAdmin, requireTenant, (req, res) => {
  res.json(notifyStatus(store.load(req.params.tenantId)));
});

// Sends a sample lead to whatever is configured. Without this the first real
// notification is also the first test, and a client finding out it never
// worked is a bad way to learn.
app.post('/api/admin/:tenantId/channels/test', requireAdmin, requireTenant, async (req, res) => {
  const t = store.load(req.params.tenantId);
  const sample = {
    name: 'Test Lead',
    phone: '+15555550123',
    email: 'test@example.com',
    intent: 'checking notifications work',
    firstQuestion: 'This is a test — no action needed.',
    at: new Date().toISOString(),
  };
  try {
    const results = await notifyLead(t, sample);
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Nightly snapshot, in-process so there is nothing extra to configure. Set
// BACKUP_UPLOAD=1 once an off-server target is in .env.
if (process.env.BACKUP_ENABLED !== '0') {
  setInterval(() => {
    try {
      store.flush();
      const r = createBackup();
      console.log(`[backup] ${r.count} files → ${r.name}`);
    } catch (e) { console.error('[backup]', e.message); }
  }, 24 * 3600 * 1000).unref();
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`\n  Chatbot server running on http://localhost:${port}`);
  console.log(`  Dashboard  http://localhost:${port}/dashboard.html`);
  console.log(`  Demo page  http://localhost:${port}/demo.html\n`);
});
