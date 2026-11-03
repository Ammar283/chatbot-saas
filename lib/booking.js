// Appointment booking.
//
// Three decisions worth defending:
//
// 1. Every slot is identified by a UTC instant and nothing else. The clinic
//    thinks in "Tuesday at 2pm", the server runs in UTC on Railway, and the
//    visitor could be in another country — so local time is a rendering
//    concern, never a storage one. Storing "2026-11-10 14:00" and hoping
//    everyone agrees what that means is how people turn up an hour early.
//
// 2. Slots are generated from opening hours, not from a connected calendar.
//    No OAuth, no tokens to refresh, no per-client setup, nothing that can be
//    revoked at 9pm on a Friday. The clinic's other diary is reconciled by
//    blocking time in the dashboard and by subscribing to the ICS feed.
//
// 3. Taking a slot is SYNCHRONOUS from the availability check through to the
//    write. Node runs one callback at a time, so a function with no `await`
//    between "is it free" and "it is now mine" cannot be interleaved — two
//    visitors confirming in the same millisecond cannot both win. Put an
//    `await` in the middle of hold() or confirm() and that guarantee is gone.
//    This holds for ONE server process; running two Railway instances against
//    one data directory needs a real lock instead.

const MINUTE = 60000;

export const BOOKING_DEFAULTS = {
  enabled: false,
  // IANA zone of the business, not of the server or the visitor.
  timezone: 'America/Toronto',
  slotMinutes: 30,
  // Gap after each appointment — cleaning down a chair, writing notes.
  bufferMinutes: 0,
  // Nothing bookable sooner than this. A clinic cannot act on a booking made
  // for twenty minutes from now.
  leadTimeHours: 3,
  horizonDays: 21,
  // Chairs, rooms, staff — how many appointments can run at the same time.
  maxPerSlot: 1,
  // Keyed by day of week, 0 = Sunday. Empty array means closed.
  hours: {
    0: [],
    1: [['09:00', '17:00']],
    2: [['09:00', '17:00']],
    3: [['09:00', '17:00']],
    4: [['09:00', '17:00']],
    5: [['09:00', '17:00']],
    6: [],
  },
  address: '',
  // Left empty, a Maps link is built from the address.
  mapsUrl: '',
  bringNote: '',
  reminderHours: 24,
  // Shown on the confirmation, so "we need 24 hours' notice" is on the record.
  cancellationNote: '',
};

export function bookingSettings(tenant) {
  const raw = tenant.settings?.booking || {};
  const hours = { ...BOOKING_DEFAULTS.hours, ...(raw.hours || {}) };
  return { ...BOOKING_DEFAULTS, ...raw, hours };
}

// --- time zones --------------------------------------------------------
//
// Done with Intl rather than a date library: it is in Node already, it knows
// the full IANA database, and it gets daylight saving right — which matters,
// because the clinic's 2pm moves by an hour twice a year while UTC does not.

// How far the named zone is from UTC at that instant, in milliseconds.
function zoneOffset(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  // Reading the wall clock in that zone and treating it as if it were UTC
  // gives a number whose distance from the real instant IS the offset.
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return asUtc - date.getTime();
}

// "10 November 2026, 14:00 in Toronto" -> the UTC instant it refers to.
//
// Two passes on purpose. The first guess uses the offset at the wrong instant,
// which is off by an hour across a daylight-saving boundary; applying the
// offset found at the corrected instant fixes it. Without this, every
// appointment booked across a clock change is an hour out.
export function zonedToUtc(y, m, d, hh, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mi, 0, 0);
  const first = zoneOffset(new Date(guess), tz);
  const corrected = guess - first;
  const second = zoneOffset(new Date(corrected), tz);
  return new Date(second === first ? corrected : guess - second);
}

// The wall-clock parts of an instant, in the named zone.
export function localParts(date, tz) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(date).reduce((acc, x) => (acc[x.type] = x.value, acc), {});
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour) % 24, minute: Number(p.minute),
    weekday: WD[p.weekday],
    date: `${p.year}-${p.month}-${p.day}`,
  };
}

// "Tue 10 Nov, 2:00 pm" in the clinic's zone. Used in emails and in the chat,
// where the visitor needs the CLINIC's time — telling someone in another
// country their appointment is at their own local 9am is a missed appointment.
export function formatSlot(iso, tz, locale = 'en-GB') {
  const d = new Date(iso);
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: tz, weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit',
    }).format(d);
  } catch {
    return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }
}

export function formatDayHeading(iso, tz, locale = 'en-GB') {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: tz, weekday: 'long', day: 'numeric', month: 'long',
    }).format(new Date(iso));
  } catch { return iso.slice(0, 10); }
}

export function formatTimeOnly(iso, tz, locale = 'en-GB') {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: tz, hour: 'numeric', minute: '2-digit',
    }).format(new Date(iso));
  } catch { return iso.slice(11, 16); }
}

// --- slot generation ---------------------------------------------------

const hhmm = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  return m ? { h: Number(m[1]), m: Number(m[2]) } : null;
};

// Every slot the opening hours imply for one local day, free or not.
function slotsForLocalDay(cfg, y, m, d) {
  const probe = zonedToUtc(y, m, d, 12, 0, cfg.timezone);   // midday: never ambiguous
  const weekday = localParts(probe, cfg.timezone).weekday;
  const ranges = cfg.hours?.[weekday] || cfg.hours?.[String(weekday)] || [];
  const step = Math.max(5, Number(cfg.slotMinutes) || 30) + Math.max(0, Number(cfg.bufferMinutes) || 0);
  const length = Math.max(5, Number(cfg.slotMinutes) || 30);

  const out = [];
  for (const range of ranges) {
    const from = hhmm(range?.[0]);
    const to = hhmm(range?.[1]);
    if (!from || !to) continue;
    const open = zonedToUtc(y, m, d, from.h, from.m, cfg.timezone).getTime();
    const close = zonedToUtc(y, m, d, to.h, to.m, cfg.timezone).getTime();
    // An appointment has to FINISH by closing time, so the last slot starts a
    // full appointment-length before the door shuts.
    for (let t = open; t + length * MINUTE <= close; t += step * MINUTE) {
      out.push(new Date(t).toISOString());
    }
  }
  return out.sort();
}

// How many of the clinic's places are taken at that instant.
//
// Overlap, not equality. A 60-minute appointment booked at 2pm must block the
// 2:30 slot too, and a block covering the afternoon must take out everything
// inside it — comparing start times alone would let someone book straight
// through an existing appointment.
function takenAt(tenant, cfg, iso) {
  const start = new Date(iso).getTime();
  const end = start + Math.max(5, Number(cfg.slotMinutes) || 30) * MINUTE;
  const now = Date.now();
  let n = 0;
  for (const b of tenant.bookings || []) {
    // An allowlist, not a skip-list. Only a confirmed appointment or a hold
    // that has not run out actually occupies the chair; cancelled, released
    // and expired rows are history. Written the other way round first, and an
    // expired hold went on blocking its slot for ever — because expireHolds()
    // had changed its status out from under the "is it an expired hold" test.
    // An allowlist also means a status added later cannot silently take a slot
    // off the market.
    const live = b.status === 'confirmed'
      || (b.status === 'held' && new Date(b.holdExpiresAt || 0).getTime() >= now);
    if (!live) continue;
    const bs = new Date(b.at).getTime();
    const be = bs + (Number(b.minutes) || cfg.slotMinutes) * MINUTE;
    if (bs < end && be > start) n += 1;
  }
  return n;
}

function blocked(tenant, cfg, iso) {
  const start = new Date(iso).getTime();
  const end = start + Math.max(5, Number(cfg.slotMinutes) || 30) * MINUTE;
  return (tenant.blocks || []).some((b) => {
    const bs = new Date(b.from).getTime();
    const be = new Date(b.to).getTime();
    return bs < end && be > start;
  });
}

export function isFree(tenant, iso) {
  const cfg = bookingSettings(tenant);
  if (!iso || Number.isNaN(new Date(iso).getTime())) return false;
  const start = new Date(iso).getTime();
  if (start < Date.now() + Math.max(0, Number(cfg.leadTimeHours) || 0) * 3600e3) return false;
  if (start > Date.now() + (Number(cfg.horizonDays) || 21) * 864e5) return false;
  // Must be a slot the opening hours actually produce — otherwise a crafted
  // request could book 3am, or 2:07pm, or a Sunday.
  const p = localParts(new Date(start), cfg.timezone);
  if (!slotsForLocalDay(cfg, p.year, p.month, p.day).includes(new Date(start).toISOString())) return false;
  if (blocked(tenant, cfg, iso)) return false;
  return takenAt(tenant, cfg, iso) < Math.max(1, Number(cfg.maxPerSlot) || 1);
}

// Free slots grouped by local day, which is how a person picks a time.
export function freeSlots(tenant, { days = 14, perDay = 8, maxDays = 5 } = {}) {
  const cfg = bookingSettings(tenant);
  if (!cfg.enabled) return [];
  const out = [];
  const horizon = Math.min(Number(days) || 14, Number(cfg.horizonDays) || 21);
  // Start from the clinic's today, not the server's.
  let cursor = localParts(new Date(), cfg.timezone);
  let probe = zonedToUtc(cursor.year, cursor.month, cursor.day, 12, 0, cfg.timezone);

  for (let i = 0; i < horizon && out.length < maxDays; i++) {
    const day = localParts(new Date(probe.getTime() + i * 864e5), cfg.timezone);
    const free = slotsForLocalDay(cfg, day.year, day.month, day.day).filter((iso) => isFree(tenant, iso));
    if (free.length) {
      out.push({
        date: `${day.year}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`,
        label: formatDayHeading(free[0], cfg.timezone),
        slots: free.slice(0, perDay).map((iso) => ({ at: iso, label: formatTimeOnly(iso, cfg.timezone) })),
      });
    }
  }
  return out;
}

// --- taking a slot -----------------------------------------------------
//
// Nothing below may become async. See the note at the top of the file.

export function expireHolds(tenant) {
  const now = Date.now();
  let changed = 0;
  for (const b of tenant.bookings || []) {
    if (b.status === 'held' && new Date(b.holdExpiresAt || 0).getTime() < now) {
      b.status = 'expired';
      changed += 1;
    }
  }
  return changed;
}

// Reserve a slot while the visitor finishes giving their details. Ten minutes
// is long enough to type a name and a number, short enough that an abandoned
// chat does not cost the clinic the rest of the afternoon.
export function hold(tenant, iso, conversationId, { minutes = 10 } = {}) {
  expireHolds(tenant);
  const cfg = bookingSettings(tenant);
  if (!cfg.enabled) return { error: 'Booking is not switched on for this workspace.' };

  // Already holding something? Move it rather than stacking up reservations.
  const mine = (tenant.bookings || []).find(
    (b) => b.conversationId === conversationId && (b.status === 'held' || b.status === 'confirmed'));
  if (mine?.status === 'confirmed') return { error: 'already-booked', booking: mine };
  if (mine) mine.status = 'released';

  if (!isFree(tenant, iso)) return { error: 'taken' };

  const booking = {
    id: randomId(),
    conversationId,
    at: new Date(iso).toISOString(),
    minutes: Math.max(5, Number(cfg.slotMinutes) || 30),
    status: 'held',
    holdExpiresAt: new Date(Date.now() + minutes * MINUTE).toISOString(),
    createdAt: new Date().toISOString(),
  };
  (tenant.bookings ||= []).unshift(booking);
  return { booking };
}

// Turn a hold into a real appointment. Re-checks availability, because the
// hold may have expired while the visitor was typing.
export function confirm(tenant, conversationId, details = {}) {
  expireHolds(tenant);
  const cfg = bookingSettings(tenant);
  const held = (tenant.bookings || []).find((b) => b.conversationId === conversationId && b.status === 'held');
  if (!held) return { error: 'no-hold' };

  // The hold itself is excluded from the count, or it would block its own
  // confirmation.
  const others = (tenant.bookings || []).filter((b) => b !== held);
  const tmp = { ...tenant, bookings: others };
  if (!isFree(tmp, held.at)) {
    held.status = 'expired';
    return { error: 'taken' };
  }

  held.status = 'confirmed';
  held.confirmedAt = new Date().toISOString();
  held.name = String(details.name || '').slice(0, 80);
  held.phone = String(details.phone || '').slice(0, 30);
  held.email = String(details.email || '').slice(0, 120);
  held.reason = String(details.reason || details.intent || '').slice(0, 160);
  held.leadId = details.leadId || null;
  // Unguessable, and the only thing needed to cancel — so it must never be
  // short enough to try at random.
  held.token = randomId() + randomId();
  delete held.holdExpiresAt;
  return { booking: held, when: formatSlot(held.at, cfg.timezone) };
}

export function release(tenant, conversationId) {
  const held = (tenant.bookings || []).find((b) => b.conversationId === conversationId && b.status === 'held');
  if (held) held.status = 'released';
  return Boolean(held);
}

export function findByToken(tenant, token) {
  if (!token || String(token).length < 16) return null;
  return (tenant.bookings || []).find((b) => b.token === token) || null;
}

export function cancel(tenant, booking, by = 'visitor') {
  if (!booking || booking.status === 'cancelled') return false;
  booking.status = 'cancelled';
  booking.cancelledAt = new Date().toISOString();
  booking.cancelledBy = by;
  return true;
}

export function addBlock(tenant, from, to, reason = '') {
  const f = new Date(from), t = new Date(to);
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) throw new Error('Those dates are not valid.');
  if (t <= f) throw new Error('The end has to be after the start.');
  const block = { id: randomId(), from: f.toISOString(), to: t.toISOString(), reason: String(reason).slice(0, 80) };
  (tenant.blocks ||= []).unshift(block);
  return block;
}

export function upcoming(tenant, { days = 30, includeCancelled = false } = {}) {
  const until = Date.now() + days * 864e5;
  return (tenant.bookings || [])
    .filter((b) => (includeCancelled ? true : b.status === 'confirmed'))
    .filter((b) => new Date(b.at).getTime() <= until)
    .sort((a, b) => a.at.localeCompare(b.at));
}

// --- what the visitor is sent -----------------------------------------

export function mapsLink(cfg) {
  if (cfg.mapsUrl) return cfg.mapsUrl;
  if (!cfg.address) return '';
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(cfg.address);
}

export function confirmationLines(tenant, booking, { manageUrl = '' } = {}) {
  const cfg = bookingSettings(tenant);
  return [
    `Your appointment with ${tenant.name} is confirmed.`,
    '',
    `When: ${formatSlot(booking.at, cfg.timezone)}`,
    cfg.address ? `Where: ${cfg.address}` : null,
    mapsLink(cfg) ? `Directions: ${mapsLink(cfg)}` : null,
    booking.reason ? `For: ${booking.reason}` : null,
    booking.name ? `Booked for: ${booking.name}` : null,
    '',
    cfg.bringNote || null,
    cfg.cancellationNote || null,
    manageUrl ? `Need to change or cancel? ${manageUrl}` : null,
  ].filter((l) => l !== null);
}

export function reminderLines(tenant, booking, { manageUrl = '' } = {}) {
  const cfg = bookingSettings(tenant);
  return [
    `A reminder of your appointment with ${tenant.name}.`,
    '',
    `When: ${formatSlot(booking.at, cfg.timezone)}`,
    cfg.address ? `Where: ${cfg.address}` : null,
    mapsLink(cfg) ? `Directions: ${mapsLink(cfg)}` : null,
    '',
    cfg.bringNote || null,
    manageUrl ? `Can't make it? ${manageUrl}` : null,
  ].filter((l) => l !== null);
}

// Bookings whose reminder is due. The flag lives on the booking rather than in
// memory, so a restart cannot send everyone a second reminder.
export function remindersDue(tenant) {
  const cfg = bookingSettings(tenant);
  const hours = Number(cfg.reminderHours) || 0;
  if (!cfg.enabled || hours <= 0) return [];
  const now = Date.now();
  return (tenant.bookings || []).filter((b) => {
    if (b.status !== 'confirmed' || b.reminderSentAt) return false;
    const at = new Date(b.at).getTime();
    if (at <= now) return false;                       // already happened
    return at - now <= hours * 3600e3;
  });
}

// --- calendar feed -----------------------------------------------------
//
// One-way, no OAuth, nothing to authorise: the clinic subscribes to this URL
// in Google Calendar or Outlook and sees aiFrontBot's bookings beside their
// own. It is the cheap half of the answer to "what if they book someone in by
// phone" — at least both diaries end up in one view.

const icsEscape = (s) => String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
const icsStamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function icsFeed(tenant) {
  const cfg = bookingSettings(tenant);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//aiFrontBot//Bookings//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(tenant.name)} bookings`,
    `X-WR-TIMEZONE:${icsEscape(cfg.timezone)}`,
  ];
  for (const b of tenant.bookings || []) {
    if (b.status !== 'confirmed') continue;
    const end = new Date(new Date(b.at).getTime() + (Number(b.minutes) || cfg.slotMinutes) * MINUTE);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${b.id}@aifrontbot`,
      `DTSTAMP:${icsStamp(b.createdAt || b.at)}`,
      `DTSTART:${icsStamp(b.at)}`,
      `DTEND:${icsStamp(end)}`,
      `SUMMARY:${icsEscape(b.name || 'Appointment')}${b.reason ? ` — ${icsEscape(b.reason)}` : ''}`,
      `DESCRIPTION:${icsEscape([
        b.name ? `Name: ${b.name}` : '',
        b.phone ? `Phone: ${b.phone}` : '',
        b.email ? `Email: ${b.email}` : '',
        b.reason ? `For: ${b.reason}` : '',
        'Booked by the website assistant.',
      ].filter(Boolean).join('\n'))}`,
      cfg.address ? `LOCATION:${icsEscape(cfg.address)}` : null,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  // CRLF is required by RFC 5545; Outlook is unforgiving about it.
  return lines.filter((l) => l !== null).join('\r\n') + '\r\n';
}

function randomId() {
  return Array.from({ length: 8 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
}
