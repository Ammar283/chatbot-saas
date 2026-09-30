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
  delivered: ['ok', 'Delivered to the mail server.'],
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
  const q = new URLSearchParams({ email, limit: '20', days: String(days) });
  const body = await get(`/smtp/statistics/events?${q}`);
  return (body.events || []).map((e) => {
    const [level, meaning] = EVENT_MEANING[e.event] || ['unknown', ''];
    return { event: e.event, level, meaning, at: e.date, subject: e.subject || '', reason: e.reason || '' };
  });
}

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
  const out = { ok: true, checks: [], events: {}, problems: [] };

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
      } else {
        const worst = ev.find((e) => e.level === 'problem');
        if (worst) { out.ok = false; out.problems.push(`${addr}: ${worst.meaning}`); }
        else if (ev.every((e) => e.level === 'pending')) {
          out.ok = false;
          out.problems.push(`${addr}: ${ev[0].meaning}`);
        }
      }
    } catch (e) {
      out.events[addr] = [];
      out.checks.push({ label: addr, value: `could not read log: ${e.message}`, level: 'unknown' });
    }
  }

  return out;
}
