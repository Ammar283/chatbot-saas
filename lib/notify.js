// Notifications: the feature that stops churn.
//
// A lead sitting in a dashboard nobody has open may as well not exist. The
// owner never feels the product working, and cancels in month three. A ping
// within seconds of a lead is what makes the invoice feel obvious.
//
// Every channel is plain HTTP. No SMTP library, no SDK, nothing to patch.

const timeout = (ms) => AbortSignal.timeout(ms);

// --- email ------------------------------------------------------------
// Two providers, both free, both plain HTTP.
//
// Brevo is the default recommendation: 300/day, no card, and a sender address
// is verified with a 6-digit code — so a Gmail address works immediately.
// Resend's free tier only delivers to the account owner's own address until a
// custom domain is DNS-verified, which means notifications to a CLIENT would
// silently fail. Fine for your own alerts, wrong for client-facing mail.

function emailBody(lines) {
  return `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.6;color:#16181D">${
    lines.map((l) => (l ? `<p style="margin:0 0 8px">${escapeHtml(l)}</p>` : '<div style="height:8px"></div>')).join('')
  }</div>`;
}

function parseFrom(raw, fallbackName) {
  const m = String(raw || '').match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1] || fallbackName, email: m[2] };
  return { name: fallbackName, email: String(raw || '').trim() };
}

async function sendViaBrevo(to, subject, lines) {
  const from = parseFrom(process.env.NOTIFY_FROM, 'Front Desk');
  if (!from.email) throw new Error('NOTIFY_FROM must contain the verified sender address.');

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': process.env.BREVO_API_KEY,
    },
    signal: timeout(10000),
    body: JSON.stringify({
      sender: from,
      to: to.map((email) => ({ email })),
      subject,
      textContent: lines.join('\n'),
      htmlContent: emailBody(lines),
    }),
  });
  if (!res.ok) throw new Error(`Email failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return { sent: 'email' };
}

async function sendViaResend(to, subject, lines) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    },
    signal: timeout(10000),
    body: JSON.stringify({
      from: process.env.NOTIFY_FROM || 'Front Desk <onboarding@resend.dev>',
      to,
      subject,
      text: lines.join('\n'),
      html: emailBody(lines),
    }),
  });
  if (!res.ok) throw new Error(`Email failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return { sent: 'email' };
}

async function sendEmail(to, subject, lines) {
  if (!to?.length) return { skipped: 'email' };
  if (process.env.BREVO_API_KEY) return sendViaBrevo(to, subject, lines);
  if (process.env.RESEND_API_KEY) return sendViaResend(to, subject, lines);
  return { skipped: 'email' };
}

// --- WhatsApp via Meta Cloud API ---------------------------------------
// Business-initiated messages outside a 24-hour window need an approved
// template. Set WHATSAPP_TEMPLATE once yours is approved; until then this only
// reliably reaches numbers that messaged you recently.
async function sendWhatsApp(to, lines) {
  const token = process.env.META_PAGE_TOKEN;
  const phoneId = process.env.META_PHONE_ID;
  if (!token || !phoneId || !to) return { skipped: 'whatsapp' };

  const number = String(to).replace(/[^\d]/g, '');
  const template = process.env.WHATSAPP_TEMPLATE;

  const body = template
    ? {
        messaging_product: 'whatsapp',
        to: number,
        type: 'template',
        template: {
          name: template,
          language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'en' },
          components: [{ type: 'body', parameters: [{ type: 'text', text: lines.join(' — ').slice(0, 900) }] }],
        },
      }
    : { messaging_product: 'whatsapp', to: number, type: 'text', text: { body: lines.join('\n').slice(0, 3900) } };

  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    signal: timeout(10000),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`WhatsApp failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return { sent: 'whatsapp' };
}

// --- generic webhook ---------------------------------------------------
// Lets a client wire this into Zapier, Make, n8n, Slack or their own CRM
// without you writing an integration per client.
async function sendWebhook(url, payload) {
  if (!url) return { skipped: 'webhook' };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: timeout(10000),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Webhook failed (${res.status})`);
  return { sent: 'webhook' };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// --- public ------------------------------------------------------------

export async function notifyLead(tenant, lead) {
  const s = tenant.settings;
  // The client's own addresses, plus your standing copy. Set once in the
  // server's environment, so every workspace you ever create is covered
  // without touching its settings.
  const clientEmails = String(s.notifyEmail || '').split(/[,\s]+/).filter(Boolean);
  const ownerCopies = String(process.env.LEAD_COPY_EMAIL || '').split(/[,\s]+/).filter(Boolean);
  // Deduped, so an owner who is also the client contact gets one email, not two.
  const emails = [...new Set([...clientEmails, ...ownerCopies].map((e) => e.toLowerCase()))];
  const when = new Date(lead.at || Date.now());

  const lines = [
    `New enquiry from the ${tenant.name} website`,
    '',
    lead.name ? `Name: ${lead.name}` : null,
    lead.phone ? `Phone: ${lead.phone}` : null,
    lead.email ? `Email: ${lead.email}` : null,
    lead.intent ? `Wants: ${lead.intent}` : null,
    lead.firstQuestion ? `Opened with: "${lead.firstQuestion}"` : null,
    '',
    `Received ${when.toLocaleString()}`,
    lead.phone ? `Reply on WhatsApp: https://wa.me/${String(lead.phone).replace(/\D/g, '')}` : null,
  ].filter((l) => l !== null);

  // Prefixed with the business, because your inbox will hold every client's
  // leads and "New enquiry from Ahmed Khan" alone says nothing about which one.
  const subject = `${tenant.name} — new enquiry${lead.name ? ` from ${lead.name}` : ''}${lead.intent ? ` (${lead.intent})` : ''}`;

  // Never let a failing channel block the others, or the chat response.
  const results = await Promise.allSettled([
    sendEmail(emails, subject, lines),
    sendWhatsApp(s.notifyWhatsApp, lines),
    sendWebhook(s.notifyWebhook, { event: 'lead', workspace: tenant.id, business: tenant.name, lead }),
  ]);

  return results.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { failed: ['email', 'whatsapp', 'webhook'][i], error: r.reason?.message });
}

// Alerts to you, not the client. Wired to the health watchdog.
export async function notifyOperator(subject, lines) {
  const emails = String(process.env.OPERATOR_EMAIL || '').split(/[,\s]+/).filter(Boolean);
  const results = await Promise.allSettled([
    sendEmail(emails, subject, lines),
    sendWhatsApp(process.env.OPERATOR_WHATSAPP, [subject, ...lines]),
    sendWebhook(process.env.OPERATOR_WEBHOOK, { event: 'alert', subject, lines }),
  ]);
  return results.map((r) => (r.status === 'fulfilled' ? r.value : { error: r.reason?.message }));
}

export function channelsConfigured(tenant) {
  const s = tenant.settings;
  return {
    email: Boolean((process.env.BREVO_API_KEY || process.env.RESEND_API_KEY) && s.notifyEmail),
    whatsapp: Boolean(process.env.META_PAGE_TOKEN && process.env.META_PHONE_ID && s.notifyWhatsApp),
    webhook: Boolean(s.notifyWebhook),
  };
}

// "Nothing is being sent" is true but unhelpful. Say which half is missing —
// the address in the dashboard, or the credential on the server.
export function notifyStatus(tenant) {
  const s = tenant.settings;
  const out = { live: [], problems: [], notes: [] };

  const hasBrevo = Boolean(process.env.BREVO_API_KEY);
  const hasResend = Boolean(process.env.RESEND_API_KEY);
  const canEmail = hasBrevo || hasResend;
  const ownerCopy = String(process.env.LEAD_COPY_EMAIL || '').split(/[,\s]+/).filter(Boolean);
  if ((s.notifyEmail || ownerCopy.length) && canEmail) {
    out.live.push('email');
    if (ownerCopy.length) out.notes = [`A copy of every lead also goes to ${ownerCopy.join(', ')}.`];
    if (!hasBrevo && hasResend && !process.env.RESEND_DOMAIN_VERIFIED) {
      out.problems.push("Resend's free tier only delivers to your own account address until you verify a domain. To email a client, use a Brevo key instead.");
    }
    if (canEmail && !process.env.NOTIFY_FROM) {
      out.problems.push('NOTIFY_FROM is not set on the server, so email has no sender address.');
    }
  } else if (s.notifyEmail && !canEmail) {
    out.problems.push('Email address is set, but the server has no BREVO_API_KEY or RESEND_API_KEY, so nothing can be sent. Add one and restart.');
  } else if (!s.notifyEmail && canEmail) {
    out.problems.push('The server can send email — add an address above to switch it on.');
  }

  const hasMeta = Boolean(process.env.META_PAGE_TOKEN && process.env.META_PHONE_ID);
  const wa = String(s.notifyWhatsApp || '').replace(/\D/g, '');
  if (wa && hasMeta) {
    out.live.push('WhatsApp');
    // 03xx... is a local format. Meta needs the country code or it silently fails.
    if (wa.startsWith('0')) out.problems.push(`The WhatsApp number starts with 0. Use the international form instead — for a Pakistani number, 92${wa.slice(1)}.`);
  } else if (wa && !hasMeta) {
    out.problems.push('WhatsApp number is set, but the server has no META_PAGE_TOKEN and META_PHONE_ID.');
  }

  if (s.notifyWebhook) out.live.push('webhook');

  return out;
}
