// Asking Brevo what actually happened to a message.
//
// A send that returns a messageId has only been *accepted*. Everything that
// decides whether a human ever sees it happens afterwards and silently: the
// account can be unverified, the sender unauthenticated, the recipient on a
// suppression list from an old bounce, the mailbox non-existent. None of that
// comes back on the send call, so without this the failure is invisible and the
// only honest answer to "why didn't it arrive" is a shrug.
//
// Brevo records all of it. This reads it back, so the dashboard can say which
// one it was instead of guessing.

const API = 'https://api.brevo.com/v3';
const timeout = (ms) => AbortSignal.timeout(ms);

async function get(path) {
  const key = process.env.BREVO_API_KEY;
  if (!key) throw new Error('No BREVO_API_KEY on the server.');
  const res = await fetch(API + path, {
    headers: { 'api-key': key, Accept: 'application/json' },
    signal: timeout(10000),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  if (!res.ok) {
    const err = new Error(body.message || `Brevo ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// The event a message ended on. Brevo lists newest first, and the last word on
// a message is the one that matters: "requests" then "delivered" is fine,
// "requests" then "hardBounces" is an address that does not exist.
const EVENT_MEANING = {
  // "Delivered" means the receiving server accepted it. Where that server then
  // files it — inbox or spam — is its own decision and is never reported back,
  // so this must not be read as "the client saw it".
  delivered: ['ok', 'Accepted by the receiving mail server. That includes the spam folder — delivery is not the same as reaching the inbox.'],
  opened: ['ok', 'Delivered and opened.'],
  uniqueOpened: ['ok', 'Delivered and opened.'],
  clicks: ['ok', 'Delivered, and a link was clicked.'],
  requests: ['pending', 'Accepted by Brevo but no delivery result yet. If it stays here for more than a few minutes, Brevo is holding it — usually an account still awaiting verification.'],
  deferred: ['pending', 'The receiving server asked Brevo to try again later. Usually temporary.'],
  softBounces: ['problem', 'The mailbox rejected it temporarily — full, or the server was down.'],
  hardBounces: ['problem', 'The address does not exist. Check the spelling, and check that the mailbox has actually been created on that domain.'],
  blocked: ['problem', 'Brevo refused to send. The address is on your blocked list, usually from an earlier bounce or complaint.'],
  spam: ['problem', 'The recipient marked a previous message as spam, so Brevo suppresses this address.'],
  invalid: ['problem', 'Brevo considers the address invalid.'],
  unsubscribed: ['problem', 'This address unsubscribed, so Brevo will not send to it.'],
  error: ['problem', 'Brevo recorded an error for this message.'],
};

export async function recentEvents(email, days = 7) {
  const q = new URLSearchParams({ email, limit: '50', days: String(days) });
  const body = await get(`/smtp/statistics/events?${q}`);
  return (body.events || []).map((e) => {
    const [level, meaning] = EVENT_MEANING[e.event] || ['unknown', ''];
    return {
      event: e.event, level, meaning, at: e.date,
      subject: e.subject || '', reason: e.reason || '', messageId: e.messageId || '',
    };
  });
}

// Only the most recent attempt describes the current state of things.
//
// A week of history contains every failure from every setting you have since
// corrected, and reporting the worst event anywhere in that window means the
// panel keeps accusing you of a problem you already fixed. Brevo returns events
// newest first and tags each with the message it belongs to, so the newest
// message's events are the ones that answer "is it working now".
function latestAttempt(events) {
  if (!events.length) return [];
  const id = events[0].messageId;
  return id ? events.filter((e) => e.messageId === id) : [events[0]];
}

const PENDING_GRACE_MIN = 5;

export async function blockedContacts() {
  try {
    const body = await get('/smtp/blockedContacts?limit=100');
    return (body.contacts || []).map((c) => ({
      email: c.email,
      reason: c.reason?.message || c.reason?.code || 'blocked',
      since: c.blockedAt || null,
    }));
  } catch (e) {
    // Some plans do not expose this list. Not knowing is not a failure.
    if (e.status === 403 || e.status === 404) return null;
    throw e;
  }
}

export async function unblock(email) {
  const key = process.env.BREVO_API_KEY;
  const res = await fetch(`${API}/smtp/blockedContacts/${encodeURIComponent(email)}`, {
    method: 'DELETE',
    headers: { 'api-key': key },
    signal: timeout(10000),
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`Could not unblock (${res.status}): ${(await res.text()).slice(0, 160)}`);
  }
  return true;
}

export async function senders() {
  const body = await get('/senders');
  return (body.senders || []).map((s) => ({ email: s.email, name: s.name, active: Boolean(s.active) }));
}

export async function account() {
  const a = await get('/account');
  const transactional = a.plan?.find?.((p) => p.type === 'sms' ? false : true) || null;
  return {
    email: a.email,
    company: a.companyName,
    plan: Array.isArray(a.plan) ? a.plan.map((p) => `${p.type}${p.credits != null ? ` (${p.credits} credits)` : ''}`).join(', ') : '',
    hasPlan: Boolean(transactional),
  };
}

// One call that answers "why has nothing arrived", for the addresses this
// workspace actually sends to.
export async function diagnose(toAddresses, fromAddress) {
  const out = { ok: true, checks: [], events: {}, problems: [], notes: [] };

  // 1. Is the key live at all, and whose account is it?
  try {
    const a = await account();
    out.checks.push({ label: 'Brevo account', value: a.email + (a.company ? ` (${a.company})` : ''), level: 'ok' });
    if (a.plan) out.checks.push({ label: 'Plan', value: a.plan, level: 'ok' });
  } catch (e) {
    out.ok = false;
    out.problems.push(`The API key was rejected: ${e.message}`);
    return out;
  }

  // 2. Is the From address one Brevo will actually send as? An unverified
  //    sender is the difference between "accepted" and "ever delivered".
  const from = String(fromAddress || '').match(/<([^>]+)>/)?.[1] || String(fromAddress || '').trim();
  try {
    const list = await senders();
    const match = list.find((s) => s.email.toLowerCase() === from.toLowerCase());
    if (!from) {
      out.problems.push('NOTIFY_FROM is not set on the server, so there is no sender address.');
    } else if (!match) {
      out.ok = false;
      out.problems.push(`${from} is not a verified sender on this Brevo account. Verified senders: ${list.map((s) => s.email).join(', ') || 'none'}. Add it under Senders, domains, IPs — or set NOTIFY_FROM to one of those addresses.`);
    } else {
      out.checks.push({ label: 'Sending as', value: `${from} — verified`, level: 'ok' });
    }
  } catch (e) {
    out.checks.push({ label: 'Sending as', value: `${from} (could not check: ${e.message})`, level: 'unknown' });
  }

  // 3. Is any destination on the suppression list? Brevo drops these silently
  //    and still hands back a messageId, which is the cruellest failure mode.
  try {
    const blocked = await blockedContacts();
    if (blocked) {
      const hits = blocked.filter((b) => toAddresses.some((t) => t.toLowerCase() === b.email.toLowerCase()));
      for (const h of hits) {
        out.ok = false;
        out.problems.push(`${h.email} is on your Brevo blocked list (${h.reason}). Nothing will reach it until it is removed.`);
        out.blocked = (out.blocked || []).concat(h.email);
      }
    }
  } catch { /* not fatal */ }

  // 4. What happened to the messages already sent to each address.
  for (const addr of toAddresses) {
    try {
      const ev = await recentEvents(addr);
      out.events[addr] = ev;
      if (!ev.length) {
        out.problems.push(`Brevo has no record of any message to ${addr} in the last 7 days. If you just pressed Send a test, wait a few seconds and check again.`);
        continue;
      }

      const attempt = latestAttempt(ev);
      const failed = attempt.find((e) => e.level === 'problem');
      const landed = attempt.find((e) => e.level === 'ok');
      const ageMin = (Date.now() - new Date(attempt[0].at).getTime()) / 60000;

      if (failed) {
        out.ok = false;
        out.problems.push(`${addr}: ${failed.meaning}${failed.reason ? ` — ${failed.reason}` : ''}`);
      } else if (landed) {
        out.checks.push({
          label: addr,
          value: landed.event === 'opened' ? 'Last message was delivered and opened.' : 'Last message was accepted by the receiving server.',
          level: 'ok',
        });
        if (landed.event !== 'opened') {
          out.notes.push(`${addr}: delivered does not mean it reached the inbox — the receiving provider can still file it as spam. If it is landing in spam, that is a domain authentication problem (SPF, DKIM and DMARC for your sending domain), not a sending problem.`);
        }
      } else if (ageMin > PENDING_GRACE_MIN) {
        out.ok = false;
        out.problems.push(`${addr}: the last message was accepted ${Math.round(ageMin)} minutes ago and Brevo still reports no delivery result. That usually means the account is awaiting verification.`);
      } else {
        out.checks.push({
          label: addr,
          value: 'Last message was sent moments ago — Brevo has not reported the result yet. Check again in a minute.',
          level: 'pending',
        });
      }

      // Older failures are history, not a live fault. Said once, quietly, so a
      // fixed problem stops being reported as a current one.
      const older = ev.filter((e) => !attempt.includes(e) && e.level === 'problem');
      if (older.length) {
        out.notes.push(`${addr}: there ${older.length === 1 ? 'is 1 older failure' : `are ${older.length} older failures`} in the last 7 days, from before the current settings. They are listed below as history and can be ignored while the latest message is fine.`);
      }
    } catch (e) {
      out.events[addr] = [];
      out.checks.push({ label: addr, value: `could not read log: ${e.message}`, level: 'unknown' });
    }
  }

  return out;
}
