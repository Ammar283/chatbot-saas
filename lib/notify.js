// Notifications: the feature that stops churn.
//
// A lead sitting in a dashboard nobody has open may as well not exist. The
// owner never feels the product working, and cancels in month three. A ping
// within seconds of a lead is what makes the invoice feel obvious.
//
// Every channel is plain HTTP. No SMTP library, no SDK, nothing to patch.

const timeout = (ms) => AbortSignal.timeout(ms);

// --- email via Resend (free tier, HTTP API, no dependency) --------------
async function sendEmail(to, subject, lines) {
  if (!process.env.RESEND_API_KEY || !to?.length) return { skipped: 'email' };
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
      html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6">${
        lines.map((l) => (l ? `<p style="margin:0 0 8px">${escapeHtml(l)}</p>` : '')).join('')
      }</div>`,
    }),
  });
  if (!res.ok) throw new Error(`Email failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return { sent: 'email' };
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
  const emails = String(s.notifyEmail || '').split(/[,\s]+/).filter(Boolean);
  const when = new Date(lead.at || Date.now());

  const lines = [
    `New enquiry from your website`,
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

  const subject = `New enquiry${lead.name ? ` from ${lead.name}` : ''}${lead.intent ? ` — ${lead.intent}` : ''}`;

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
    email: Boolean(process.env.RESEND_API_KEY && s.notifyEmail),
    whatsapp: Boolean(process.env.META_PAGE_TOKEN && process.env.META_PHONE_ID && s.notifyWhatsApp),
    webhook: Boolean(s.notifyWebhook),
  };
}

// "Nothing is being sent" is true but unhelpful. Say which half is missing —
// the address in the dashboard, or the credential on the server.
export function notifyStatus(tenant) {
  const s = tenant.settings;
  const out = { live: [], problems: [] };

  const hasResend = Boolean(process.env.RESEND_API_KEY);
  if (s.notifyEmail && hasResend) out.live.push('email');
  else if (s.notifyEmail && !hasResend) out.problems.push('Email address is set, but the server has no RESEND_API_KEY, so nothing can be sent. Add it and restart.');
  else if (!s.notifyEmail && hasResend) out.problems.push('The server can send email — add an address above to switch it on.');

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
