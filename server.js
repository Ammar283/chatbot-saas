import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as store from './lib/store.js';
import * as auth from './lib/auth.js';
import * as health from './lib/health.js';
import { notifyLead, channelsConfigured, notifyStatus } from './lib/notify.js';
import * as brevo from './lib/brevo.js';
import { create as createBackup } from './scripts/backup.js';
import { buildIndex, bm25, fuse, cosine, cacheLookup, cacheStore, cacheClear } from './lib/retrieve.js';
import { chat, embed, needsSmartModel } from './lib/llm.js';
import { buildSystemPrompt, parseReply, isContactable, isComplete, extractFromMessage, cleanLead, fakePhone, fakeEmail, DEFAULT_CONFIRMATION } from './lib/prompt.js';
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
  // Paused: the widget removes itself silently. The visitor sees an ordinary
  // page, not a notice about someone else's unpaid invoice.
  if (s.suspended) return res.json({ suspended: true });
  res.json({
    botName: s.botName, greeting: s.greeting, accent: s.accent,
    logoUrl: s.logoUrl || '', teaser: s.teaser || '',
    autoOpenSeconds: Number(s.autoOpenSeconds) || 0,
    quickReplies: Array.isArray(s.quickReplies) ? s.quickReplies.slice(0, 8) : [],
    footerText: s.footerText ?? 'Powered by aiFrontBot',
    footerUrl: s.footerUrl ?? 'https://aifrontbot.net',
    statusText: s.statusText ?? 'Online now',
    fontFamily: s.fontFamily || '',
    fontUrl: s.fontUrl || '',
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
  // Belt and braces: the widget will not have loaded, but a stale page or a
  // copied key must not keep running up your API bill.
  if (tenant.settings.suspended) {
    return res.status(403).json({ error: 'This assistant is currently unavailable.' });
  }
  if (store.overCap(tenant)) {
    return res.json({ answer: tenant.settings.handoffMessage, handoff: true, suggestions: [] });
  }

  const convId = conversationId || store.id();

  try {
    // 1. Cache. Free, instant, and covers the repeat questions.
    //
    // This used to apply only to the first message of a conversation, which
    // threw away most of its value: a visitor browsing a topic asks the same
    // question in different words several times, and every repeat at turn 8 or
    // turn 15 paid for a full model call. A question that stands on its own can
    // be answered from cache wherever it appears.
    const lastBotTurn = [...history].reverse().find((h) => h.role === 'assistant')?.content || '';
    const cached = cacheLookup(tenant, message);
    if (cached && (history.length === 0 || selfContained(message, lastBotTurn))) {
      store.recordUsage(tenant, { cached: true });
      logTurn(tenant, convId, message, cached, { cached: true }, req.ip);
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
    // Capture contact details from the raw message first — this must not
    // depend on the model call succeeding.
    //
    // And it has to happen BEFORE the prompt is built. Built first, the prompt
    // describes the lead as it was at the START of this turn, so a visitor who
    // has just typed their number is still listed under STILL NEEDED and the
    // model asks for it again. They answer, it asks again, and they leave —
    // the number sitting in the database the whole time.
    const scanned = cleanLead(extractFromMessage(message, asking));
    const gaveDetails = Object.keys(scanned).length > 0;
    const scannedLead = mergeLead(tenant, convId, scanned);
    if (scannedLead) { store.save(tenant.id); notifyOnce(tenant, scannedLead); }

    // Everything known about this visitor including what they just said.
    const leadNow = { ...knownLead, ...scanned };

    // Did they just hand over something unusable? The model has to know before
    // it writes, or it reads the address straight out of their message and
    // confirms it — leaving the visitor told off and thanked in one breath.
    let rejected = rejectionNote(message, asking);
    if (rejected && scanned[rejected.key]) rejected = null;   // it passed after all

    // Said twice, so believe them.
    //
    // Every heuristic has false positives, and a visitor whose real address
    // trips one would otherwise be told "that doesn't look right" forever. One
    // doubtful detail in the list is a far smaller problem than a real customer
    // stuck in a loop, so insisting wins.
    if (rejected) {
      const conv = tenant.conversations.find((c) => c.id === convId);
      if (conv && conv.lastRejected === rejected.value) {
        const forced = mergeLead(tenant, convId, { [rejected.key]: rejected.value });
        if (forced) { store.save(tenant.id); notifyOnce(tenant, forced); }
        leadNow[rejected.key] = rejected.value;
        rejected = null;
      } else if (conv) {
        conv.lastRejected = rejected.value;
        store.save(tenant.id);
      }
    }

    const messages = [
      { role: 'system', content: buildSystemPrompt(tenant, results, leadNow, rejected) },
      // Two exchanges is enough to follow a thread. Six long turns is most of a
      // token budget spent re-reading answers the model itself just wrote.
      ...history.slice(-4).map((h) => ({ role: h.role, content: String(h.content).slice(0, 400) })),
      { role: 'user', content: message.slice(0, 1000) },
    ];

    const model = needsSmartModel(message, results) ? process.env.LLM_MODEL_SMART : process.env.LLM_MODEL;
    // These models spend tokens reasoning before they write, so a ceiling that
    // looks generous for a 60-word answer can still cut the reply off partway
    // through the JSON. Modest headroom, since output counts against the
    // per-minute budget too.
    const out = await chat(messages, { model, json: true, maxTokens: 700 });
    const reply = parseReply(out.text, tenant);

    store.recordUsage(tenant, { inputTokens: out.inputTokens, outputTokens: out.outputTokens });
    // Account-wide, per model — the provider's ceiling is not per workspace.
    store.recordModelUsage(out.model, { inputTokens: out.inputTokens, outputTokens: out.outputTokens });
    health.recordSuccess(reply.grounded);

    // Only cache grounded, standalone answers — never anything conversational.
    if (reply.grounded && !reply.handoff && !gaveDetails
        && (history.length === 0 || selfContained(message, lastBotMessage))) {
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
    }, req.ip);
    store.save(tenant.id);

    // The bot could not answer, and has no way to reach this visitor.
    //
    // This is the most valuable moment in the whole conversation and the one
    // the product was losing: the visitor asked for something specific enough
    // that nobody had written it down, got "I'll check with the team", and
    // closed the tab. No name, no number, nothing to follow up — the enquiry
    // most likely to convert leaves the least behind.
    //
    // The prompt asks the model to do this, but a conversion step this
    // important is not left to whether the model felt like following an
    // instruction. Appended here so it happens either way.
    if (!reply.grounded || reply.handoff) {
      const conv = tenant.conversations.find((c) => c.id === convId);
      // Remember what they asked, so the lead reaches the client as "wants the
      // JetGo 550Mti-RJ" rather than an anonymous name and number.
      if (conv && !reply.grounded && !conv.unanswered) {
        conv.unanswered = message.trim().slice(0, 120);
        store.save(tenant.id);
      }
      const current = tenant.leads.find((l) => l.conversationId === convId) || {};
      // Drop the repeated apology, then any ask for something already on file,
      // then offer the callback ask — which no-ops once there is nothing left
      // to ask for.
      let text = stripKnownAsks(dropRepeats(reply.answer, history), current);
      text = appendCallbackAsk(tenant, text, current, required);
      // Everything was stripped and nothing was added: they are already on file
      // and there is genuinely nothing to ask, so say that rather than nothing.
      reply.answer = text.trim() || 'The team has your details and will come back to you shortly.';
    }

    // The model was told the detail was refused. If it confirmed it anyway —
    // echoing the address back as recorded — that message is worse than useless,
    // so replace it with the truth rather than appending to a contradiction.
    if (rejected && reply.answer.includes(rejected.value)) {
      reply.answer = rejected.say;
    }

    // A blank reply reads as a broken bot. Fall back to something sensible.
    if (!reply.answer.trim()) {
      const merged = { ...leadNow, ...reply.lead };
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
// One lead, one email.
//
// Details arrive a message at a time — name, then phone, then maybe an email —
// so the obvious approach of "notify as soon as we can reach them" fires again
// every time something new turns up, and the client gets the same enquiry two
// or three times with slightly different contents. That reads as a broken
// product, and it buries the second real lead under the duplicate of the first.
//
// So: the moment a lead is reachable, start a short timer. Anything else the
// visitor volunteers lands on the same lead object before it expires, and one
// complete email goes out. If they give everything up front, there is nothing
// left to wait for and it sends immediately.
const pendingNotify = new Map();
const NOTIFY_WAIT_MS = Number(process.env.NOTIFY_WAIT_MS || 90000);

function notifyOnce(tenant, lead) {
  if (lead.notifiedStage === 'sent') return;
  if (!lead.contactable && !lead.complete) return;

  const key = `${tenant.id}:${lead.conversationId}`;

  if (lead.complete) {
    clearTimeout(pendingNotify.get(key));
    pendingNotify.delete(key);
    return fireNotify(tenant, lead, key);
  }
  if (pendingNotify.has(key)) return;   // already waiting; the lead fills in place
  pendingNotify.set(key, setTimeout(() => fireNotify(tenant, lead, key), NOTIFY_WAIT_MS));
}

function fireNotify(tenant, lead, key) {
  if (lead.notifiedStage === 'sent') return;
  lead.notifiedStage = 'sent';
  pendingNotify.delete(key);
  store.save(tenant.id);

  // Deliberately not awaited: the visitor should never wait on an email.
  //
  // If every channel fails, put the marker back. Otherwise one bad afternoon at
  // the email provider means that lead is flagged as notified forever and the
  // client never hears about it — the exact failure this feature exists to stop.
  notifyLead(tenant, lead)
    .then((r) => {
      const bad = r.filter((x) => x.failed);
      if (!bad.length) return;
      console.warn('[notify]', bad);
      if (!r.some((x) => x.sent)) {
        lead.notifiedStage = null;
        store.save(tenant.id);
      }
    })
    .catch((e) => {
      console.warn('[notify]', e.message);
      lead.notifiedStage = null;
      store.save(tenant.id);
    });
}

// A redeploy in the middle of that wait would otherwise drop the notification
// entirely — the visitor has gone, so no later message will retrigger it.
function flushPendingNotifications() {
  for (const [key, timer] of pendingNotify) {
    clearTimeout(timer);
    const [tenantId, convId] = key.split(':');
    const t = store.load(tenantId);
    const lead = t?.leads?.find((l) => l.conversationId === convId);
    if (lead) fireNotify(t, lead, key);
  }
}
process.on('SIGTERM', flushPendingNotifications);
process.on('SIGINT', flushPendingNotifications);

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

// Make sure an "I can't answer that" message ends by asking how to reach them.
//
// Phone comes first deliberately. A question the knowledge base cannot answer
// usually needs a conversation, not an email thread — and a number the client
// can ring while the visitor is still interested is worth more than an address
// they will reply to in three days.
function appendCallbackAsk(tenant, answer, lead, required) {
  // Only what a callback actually needs: a number, and a name to ask for.
  // Email is left to the normal booking flow — once the client can ring them,
  // a third ask stops being helpful and starts being a form.
  const wants = required.includes('phone') ? ['phone', 'name'] : ['email', 'name'];
  const order = wants.filter((f) => required.includes(f));
  const missing = order.find((f) => !String(lead[f] || '').trim());
  if (!missing) return answer;                    // already reachable, nothing to ask

  const text = String(answer || '').trim();
  // The model may have asked already. Two questions in one message reads as a
  // form, and people answer neither.
  if (/\?\s*$/.test(text)) return text;

  const ASK = {
    phone: tenant.settings.unansweredAsk
      || 'What is the best number to reach you on? Someone from the team will call you back with an answer.',
    name: 'Could I take your name so the team can come back to you?',
    email: 'What email should the team send the answer to?',
  };
  return text ? `${text} ${ASK[missing]}` : ASK[missing];
}

// Models restate their last apology every turn while collecting details, so a
// visitor handing over a name and a number reads "I'm sorry, I don't have the
// pricing details" three times in a row. The prompt asks it not to; this makes
// sure. Any sentence the bot has already sent in this conversation is dropped,
// keeping the last one so there is always something to reply to.
// "I'm sorry, I don't have that detail" and "I don't have that information" are
// the same sentence to a reader and different strings to a computer, so exact
// matching alone lets the apology through again in fresh wording. Anything that
// says "I cannot answer this" counts as one statement, however it is phrased.
const CANNOT_ANSWER = /\b(do ?n'?t have|do not have|not sure|can'?t find|cannot find|do ?n'?t know|no information|not available)\b/i;

function dropRepeats(answer, history) {
  const prior = history.filter((h) => h.role === 'assistant').map((h) => String(h.content));
  const said = new Set(
    prior.flatMap((c) => c.split(/(?<=[.!?])\s+/)).map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  const alreadyApologised = prior.some((c) => CANNOT_ANSWER.test(c));
  if (!said.size) return answer;

  const parts = String(answer || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return answer;

  const kept = parts.filter((p, i) => {
    if (i === parts.length - 1) return true;              // always leave something to reply to
    if (said.has(p.toLowerCase())) return false;          // word-for-word repeat
    return !(alreadyApologised && CANNOT_ANSWER.test(p)); // same point, new words
  });
  return kept.join(' ').trim() || answer;
}

// When a detail is rejected, say so.
//
// Dropping it silently and asking the same question again is the loop that made
// a visitor type their number three times and leave: from their side they
// answered, and the assistant simply did not hear them.
//
// Only fires when the message was plainly an attempt at the thing being asked
// for — someone who answers "do you do implants?" to "what is your number?" has
// changed the subject, not failed a validation.
function rejectionNote(message, asking) {
  const text = String(message || '').trim();
  if (!text) return null;

  // An "@" in the message is an attempt at an email whatever the bot last asked
  // for. Tying this to `asking` meant the follow-up — which says "address", not
  // "email" — was not recognised as an email question, so a visitor repeating
  // themselves was silently ignored all over again.
  const addr = text.split(/\s+/).find((w) => w.includes('@'));
  if (addr) {
    const reason = fakeEmail(addr);
    if (reason) {
      return { key: 'email', field: 'email address', value: addr, reason,
        say: 'That email address does not look quite right — could you give me one you actually check?' };
    }
    return null;
  }

  // A message that is mostly digits is an attempt at a number — as is any reply
  // to a question that asked for one.
  const digits = text.replace(/\D/g, '');
  const dense = digits.length / Math.max(1, text.replace(/\s/g, '').length) > 0.6;
  if (digits.length >= 4 && (asking === 'phone' || dense)) {
    const reason = fakePhone(digits);
    if (reason) {
      return { key: 'phone', field: 'phone number', value: text, reason,
        say: 'That phone number does not look quite right — could you check it and include the country code?' };
    }
  }
  return null;
}

// Daily counts for the last N days, oldest first. Cheap: these arrays are
// already in memory and a fortnight is a short loop.
function dailyTrend(tenant, days = 14) {
  const key = (d) => new Date(d).toISOString().slice(0, 10);
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) buckets.push(key(Date.now() - i * 864e5));
  const index = new Map(buckets.map((k, i) => [k, i]));
  const blank = () => buckets.map(() => 0);

  const leads = blank();
  const conversations = blank();
  const messages = blank();

  for (const l of tenant.leads) {
    const i = index.get(key(l.at));
    if (i !== undefined) leads[i] += 1;
  }
  for (const c of tenant.conversations) {
    const i = index.get(key(c.startedAt));
    if (i === undefined) continue;
    conversations[i] += 1;
    messages[i] += (c.turns || []).length;
  }
  return { days: buckets, leads, conversations, messages };
}

// What people are actually asking for, taken from the leads rather than from
// guesswork. Near-identical phrasings are folded together, so "book cleaning"
// and "booking a cleaning" do not occupy two rows of a five-row list.
function topIntents(tenant, limit = 5) {
  const counts = new Map();
  for (const l of tenant.leads) {
    const raw = String(l.intent || '').trim().toLowerCase();
    if (!raw || raw.length < 3) continue;
    const key = raw.replace(/[^a-z0-9 ]/g, '').replace(/\b(a|an|the|for|of|my|to|about)\b/g, '').replace(/\s+/g, ' ').trim();
    if (!key) continue;
    const hit = counts.get(key) || { label: String(l.intent).trim(), n: 0 };
    hit.n += 1;
    counts.set(key, hit);
  }
  const rows = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, limit);
  const total = rows.reduce((n, r) => n + r.n, 0) || 1;
  return rows.map((r) => ({ label: r.label, n: r.n, pct: Math.round((r.n / total) * 100) }));
}

// Remove any question asking for a detail the visitor has already given.
//
// The prompt forbids it, but the model slips — especially once it cannot answer
// something, where it falls back on "could you share your..." as a reflex. To
// the visitor that is the assistant forgetting them: they typed their number a
// minute ago and are being asked for it again. Enforced here so it cannot
// depend on the model's mood.
const ASKS_FOR = {
  name: /\b(full\s+)?name\b/i,
  phone: /\b(phone|mobile|cell|contact\s+number|number)\b/i,
  email: /\be-?mail\b/i,
};

function stripKnownAsks(answer, lead) {
  const held = Object.keys(ASKS_FOR).filter((f) => String(lead[f] || '').trim());
  if (!held.length) return answer;

  const parts = String(answer || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const kept = parts.filter((p) => !(/\?\s*$/.test(p) && held.some((f) => ASKS_FOR[f].test(p))));

  if (kept.length === parts.length) return answer;
  // May come back empty. The caller decides what to put there, because only it
  // knows whether a callback ask is about to be appended — "the team has your
  // details" followed by "what is your number?" is worse than either alone.
  return kept.join(' ');
}

// Can this message be answered without knowing what was said before it?
//
// "What are the benefits of professional whitening?" can, wherever it appears.
// "What about the other one?" cannot, and serving a cached answer to it would
// be a non-sequitur. Deliberately strict: a wrong "no" only costs a model call,
// while a wrong "yes" puts an irrelevant answer in front of a visitor.
function selfContained(message, lastBotMessage = '') {
  const m = String(message || '').trim().toLowerCase();
  if (m.length < 15) return false;
  // Replies to the bot's own question belong to the conversation, not the cache.
  // This also keeps lead capture intact: the bot asks for a name, and the
  // answer must never be served from a cache of someone else's name.
  if (/\?\s*$/.test(String(lastBotMessage).trim())) return false;
  if (/^(yes|no|yeah|yep|nope|ok|okay|sure|thanks|thank you|please|got it)\b/.test(m)) return false;
  // Words that point back at something earlier.
  if (/\b(it|its|that|this|those|these|them|they|the other|another one|same|again|instead)\b/.test(m)) return false;
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
  // The question the bot could not answer is why this person is worth calling.
  // Without it the client gets a name and a number and no idea what to say.
  if (!String(lead.intent || '').trim() && conv?.unanswered) lead.intent = conv.unanswered;
  return lead;
}

// Only ever the first half of the address. It is enough for a client to tell
// two visitors apart or spot a flood from one machine, and it is not a
// personal identifier, so there is nothing here worth leaking or worth a
// deletion request. The full address is never written to disk.
function maskIp(ip) {
  const raw = String(ip || '').replace(/^::ffff:/, '');
  if (!raw) return '';
  if (raw.includes(':')) {
    const parts = raw.split(':').filter(Boolean);
    return parts.length < 2 ? '' : `${parts[0]}:${parts[1]}:xx:xx`;
  }
  const parts = raw.split('.');
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.xx.xx` : '';
}

function logTurn(tenant, convId, question, answer, meta = {}, ip = '') {
  let conv = tenant.conversations.find((c) => c.id === convId);
  if (!conv) {
    conv = { id: convId, startedAt: new Date().toISOString(), turns: [] };
    tenant.conversations.unshift(conv);
    if (tenant.conversations.length > 500) tenant.conversations.length = 500;
  }
  if (!conv.visitor && ip) conv.visitor = maskIp(ip);
  conv.turns.push({ q: question, a: answer, at: new Date().toISOString(), ...meta });
  conv.lastAt = new Date().toISOString();
}

// =======================================================================
// SESSIONS
// =======================================================================

const loginAttempts = new Map();
setInterval(() => loginAttempts.clear(), 15 * 60 * 1000).unref();

// Unauthenticated by necessity — the sign-in page needs it before anyone has
// signed in. Returns only a name, a logo and a colour. Unknown workspaces get
// the defaults rather than a 404, so this cannot be used to discover which
// workspaces exist.
app.get('/api/login-brand', (req, res) => {
  const app_ = store.loadApp();
  const out = {
    productName: app_.loginProductName,
    tagline: app_.loginTagline,
    logoUrl: app_.loginLogoUrl,
    accent: app_.loginAccent,
  };

  const slug = String(req.query.w || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (slug && store.listTenants().some((t) => t.id === slug)) {
    const s = store.load(slug).settings;
    if (s.brandName) out.productName = s.brandName;
    if (s.dashboardLogoUrl) out.logoUrl = s.dashboardLogoUrl;
    if (s.dashboardAccent || s.accent) out.accent = s.dashboardAccent || s.accent;
  }
  res.json(out);
});

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

// How close the account is to the provider's daily ceiling.
//
// The limits differ by provider and by plan, so they are configured rather than
// assumed — wrong numbers here would be worse than none, because they would read
// as reassurance.
app.get('/api/admin/usage', requireAdmin, requireOwner, (req, res) => {
  const history = store.usageHistory(7);
  const today = history[0];
  const limits = {
    tokensPerDay: Number(process.env.PROVIDER_TOKENS_PER_DAY || 200000),
    requestsPerDay: Number(process.env.PROVIDER_REQUESTS_PER_DAY || 1000),
  };
  // Limits are enforced per model, so headroom is per model too: a model that
  // has not been touched today still has its whole allowance.
  const models = Object.entries(today.models).map(([name, m]) => ({
    name,
    tokens: m.tokens,
    requests: m.requests,
    tokensPct: Math.round((m.tokens / limits.tokensPerDay) * 100),
    requestsPct: Math.round((m.requests / limits.requestsPerDay) * 100),
  })).sort((a, b) => b.tokens - a.tokens);

  res.json({ limits, today: { ...today, models }, history });
});

app.get('/api/admin/app-settings', requireAdmin, requireOwner, (req, res) => res.json(store.loadApp()));

app.put('/api/admin/app-settings', requireAdmin, requireOwner, (req, res) => {
  const allowed = ['loginProductName', 'loginTagline', 'loginLogoUrl', 'loginAccent'];
  const patch = {};
  for (const k of allowed) if (k in (req.body || {})) patch[k] = String(req.body[k] ?? '').trim();
  res.json(store.saveApp(patch));
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
      accountId: t.accountId || '',
      chunks: t.chunks.length,
      leads: t.leads.length,
      newLeads: t.leads.filter((l) => l.status === 'new').length,
      messages: usage.messages,
      capUsedPct: Math.round((usage.messages / (t.settings.monthlyMessageCap || 1)) * 100),
      lastActivity: last,
      daysQuiet,
      // No traffic for a fortnight is the earliest churn signal you get.
      suspended: Boolean(t.settings.suspended),
      health: t.settings.suspended ? 'paused'
        : !last ? 'not live' : daysQuiet > 14 ? 'at risk' : daysQuiet > 5 ? 'quiet' : 'active',
    };
  });

  res.json({
    workspaces: rows.length,
    clients: new Set(rows.map((r) => r.account).filter(Boolean)).size,
    totalLeads: rows.reduce((n, r) => n + r.leads, 0),
    newLeads: rows.reduce((n, r) => n + r.newLeads, 0),
    messagesThisMonth: rows.reduce((n, r) => n + r.messages, 0),
    atRisk: rows.filter((r) => r.health === 'at risk').length,
    paused: rows.filter((r) => r.suspended).length,
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

// Hand a workspace to a client login after the fact. Before this, the only
// chance to connect the two was the moment the workspace was created — so a site
// built before the client had an account stayed stranded with no way in.
app.post('/api/admin/tenants/:tenantId/assign', requireAdmin, requireOwner, (req, res) => {
  try {
    const accountId = String(req.body?.accountId || '').trim();
    if (accountId) {
      const a = auth.findById(accountId);
      if (!a) return res.status(400).json({ error: 'That client login no longer exists.' });
      if (a.role === 'owner') {
        return res.status(400).json({ error: 'You already see every workspace. Pick a client login instead.' });
      }
    }
    const t = store.assignTenant(req.params.tenantId, accountId || null);
    res.json({ ok: true, accountId: t.accountId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Pausing keeps everything — leads, knowledge, settings — and only stops the
// bot answering. That is the leverage: their website loses its receptionist,
// while nothing they have built is lost.
app.post('/api/admin/tenants/:tenantId/suspend', requireAdmin, requireOwner, (req, res) => {
  const t = store.load(req.params.tenantId);
  t.settings.suspended = Boolean(req.body?.suspended);
  if (typeof req.body?.message === 'string' && req.body.message.trim()) {
    t.settings.suspendedMessage = req.body.message.trim();
  }
  cacheClear(t);
  store.save(t.id);
  store.flush();
  res.json({ ok: true, suspended: t.settings.suspended, message: t.settings.suspendedMessage });
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
    suspended: Boolean(t.settings.suspended),
    suspendedMessage: t.settings.suspendedMessage || '',
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
    // Daily counts, so each figure can show its own shape rather than being a
    // number with no sense of whether it is rising or dying. The window is the
    // client's choice; 14 keeps the sparklines comparable week to week.
    trend: dailyTrend(t, 14),
    range: dailyTrend(t, Math.min(90, Math.max(7, Number(req.query.days) || 30))),
    // What visitors actually came for, counted from the leads themselves.
    intents: topIntents(t, 5),
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

// Fields only the account owner may change. Hiding the inputs in the dashboard
// is cosmetic — anyone can send a PUT — so the branding is enforced here.
const OWNER_ONLY_SETTINGS = ['footerText', 'footerUrl', 'fontFamily', 'fontUrl', 'suspended', 'suspendedMessage'];

app.put('/api/admin/:tenantId/settings', requireAdmin, requireTenant, (req, res) => {
  const t = store.load(req.params.tenantId);
  const incoming = { ...(req.body || {}) };
  if (!req.isMaster) for (const k of OWNER_ONLY_SETTINGS) delete incoming[k];
  Object.assign(t.settings, incoming);
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

// "It says sent, but nothing arrived." Accepting a message and delivering it
// are different events, and only the provider knows what happened in between.
// This asks them, so the answer is a specific cause rather than a guess.
app.get('/api/admin/:tenantId/channels/diagnose', requireAdmin, requireTenant, requireOwner, async (req, res) => {
  const t = store.load(req.params.tenantId);
  const to = [
    ...String(t.settings.notifyEmail || '').split(/[,\s]+/),
    ...String(process.env.LEAD_COPY_EMAIL || '').split(/[,\s]+/),
  ].filter(Boolean);

  if (process.env.SMTP_HOST) {
    return res.json({
      transport: 'smtp',
      ok: true,
      checks: [{ label: 'Transport', value: `SMTP via ${process.env.SMTP_HOST}`, level: 'ok' }],
      problems: [],
      events: {},
      note: 'SMTP reports success or refusal at send time, so the result of Send a test is already the real answer. There is no separate delivery log to read.',
    });
  }
  if (!process.env.BREVO_API_KEY) {
    return res.json({ transport: 'none', ok: false, checks: [], events: {},
      problems: ['No BREVO_API_KEY and no SMTP_HOST on the server, so nothing can send at all.'] });
  }
  if (!to.length) {
    return res.json({ transport: 'brevo', ok: false, checks: [], events: {},
      problems: ['No notification address is saved for this workspace yet.'] });
  }
  try {
    const out = await brevo.diagnose(to, process.env.NOTIFY_FROM);
    res.json({ transport: 'brevo', ...out });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// A bounce puts an address on Brevo's blocked list, and from then on every send
// is accepted and quietly dropped. Removing it is one call, but only findable
// if you already know the list exists.
app.post('/api/admin/:tenantId/channels/unblock', requireAdmin, requireTenant, requireOwner, async (req, res) => {
  const email = String(req.body?.email || '').trim();
  if (!email) return res.status(400).json({ error: 'Which address should be unblocked?' });
  try {
    await brevo.unblock(email);
    res.json({ ok: true, email });
  } catch (e) {
    res.status(502).json({ error: e.message });
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
