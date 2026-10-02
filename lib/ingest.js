// Point this at a client's homepage and it produces their knowledge base.
// This is also your sales weapon: crawl a prospect's site, record 60 seconds
// of the bot answering questions about their own business, send it cold.

import { id } from './store.js';
import { embed } from './llm.js';

const SKIP = /\.(pdf|jpg|jpeg|png|gif|svg|webp|zip|mp4|mp3|css|js|ico|woff2?)$/i;
const JUNK = /(privacy|terms|cookie|login|signin|signup|cart|checkout|wp-admin|\/tag\/|\/author\/)/i;

function extractText(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decode(titleMatch[1]).trim() : '';

  const body = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  const text = decode(body)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 2)
    .join('\n')
    .trim();

  return { title, text };
}

function decode(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

// example.com and www.example.com are the same site, but not the same origin.
// Sites mix the two in their own links, and treating them as different hosts
// silently drops half the pages — including, on one real site, the contact
// page holding the opening hours.
const host = (u) => new URL(u).hostname.replace(/^www\./, '').toLowerCase();

function links(html, base) {
  const found = new Set();
  const baseHost = host(base);
  const re = /href\s*=\s*["']([^"'#]+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const u = new URL(m[1], base);
      if (host(u.href) !== baseHost) continue;
      if (SKIP.test(u.pathname) || JUNK.test(u.pathname)) continue;
      u.hash = '';
      u.search = '';
      found.add(u.href);
    } catch { /* malformed href, skip */ }
  }
  return [...found];
}

// ~800 characters with sentence-aware breaks and one sentence of overlap.
// Small enough that five chunks fit in a cheap context window, large enough
// that a single chunk usually contains a complete answer.
export function chunkText(text, title, url, target = 800) {
  const paras = text.split(/\n+/);
  const out = [];
  let buf = '';
  for (const p of paras) {
    if ((buf + '\n' + p).length > target && buf) {
      out.push(buf.trim());
      const tail = buf.split(/(?<=[.!?])\s+/).slice(-1)[0] || '';
      buf = tail.length < 200 ? tail + '\n' + p : p;
    } else {
      buf += (buf ? '\n' : '') + p;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out
    .filter((t) => t.length > 60)
    .map((t) => ({ id: id(), title: title || url, text: t, url, source: 'crawl' }));
}

// One spelling per page, so the same page cannot enter the queue twice under
// http/https, with or without www, with or without a trailing slash.
const canon = (u) => u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '').toLowerCase();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function crawl(startUrl, {
  maxPages = 40,
  // Pages are fetched in parallel. Sequentially, a 120-page site at half a
  // second a page takes a minute of a request that the host will cut off long
  // before it finishes — and a crawl that gets cut off saves nothing at all.
  concurrency = 6,
  // Hard stops, so a site that links in circles or answers slowly cannot hold
  // the request open indefinitely.
  timeBudgetMs = 150000,
  onProgress,
} = {}) {
  const queue = [startUrl];
  const queued = new Set([canon(startUrl)]);
  const PRIORITY = /(contact|about|team|staff|hours|location|price|pricing|fee|faq|book|appointment)/i;
  const chunks = [];
  const pages = [];
  const started = Date.now();

  // maxPages counts pages that yielded usable text, NOT URLs attempted.
  //
  // Any real site serves a share of dead links, PDFs behind .html-looking paths
  // and near-empty archive stubs. Counting attempts means that share comes
  // straight out of the client's page budget: asking for 120 quietly reads
  // about 95, and the pages that lose out are the ones at the back of the
  // queue. attemptBudget stops a site that is nothing but dead links from
  // running forever.
  let attempts = 0;
  const attemptBudget = Math.max(maxPages * 4, 60);
  let active = 0;

  // The deadline has to reach the fetches themselves. Checked only between
  // pages, it means nothing: a site whose pages hang leaves every worker parked
  // inside a 15-second request, and the crawl overruns its budget by that much
  // again each round.
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(), timeBudgetMs);
  const pageSignal = () => (typeof AbortSignal.any === 'function'
    ? AbortSignal.any([AbortSignal.timeout(15000), deadline.signal])
    : AbortSignal.timeout(15000));

  const exhausted = () =>
    pages.length >= maxPages ||
    attempts >= attemptBudget ||
    Date.now() - started > timeBudgetMs;

  async function worker() {
    while (!exhausted()) {
      const url = queue.shift();
      if (url === undefined) {
        // Nothing waiting, but a worker still in flight may yet add links.
        if (active === 0) return;
        await sleep(30);
        continue;
      }

      attempts += 1;
      active += 1;
      try {
        let html;
        try {
          const res = await fetch(url, {
            headers: { 'User-Agent': 'ChatbotIngest/0.1 (+website assistant setup)' },
            signal: pageSignal(),
          });
          if (!res.ok) continue;
          if (!(res.headers.get('content-type') || '').includes('text/html')) continue;
          html = await res.text();
        } catch {
          continue;                            // unreachable or too slow
        }

        const { title, text } = extractText(html);
        // A contact page can be little more than an address and a list of
        // hours. Short is not the same as worthless, and that page answers more
        // visitor questions than any service page on the site.
        if (text.length > 80 && pages.length < maxPages) {
          const c = chunkText(text, title, url);
          chunks.push(...c);
          pages.push({ url, title, chunks: c.length });
          onProgress?.({ url, title, pages: pages.length, chunks: chunks.length });
        }

        for (const l of links(html, url)) {
          const key = canon(l);
          if (queued.has(key)) continue;
          queued.add(key);
          // Contact and team pages jump the queue — running out of budget
          // before reaching them is what leaves a bot unable to state its own
          // hours.
          if (PRIORITY.test(l)) queue.unshift(l); else queue.push(l);
        }
      } finally {
        active -= 1;
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  } finally {
    clearTimeout(deadlineTimer);   // or the timer holds the process open
  }

  return { pages: pages.slice(0, maxPages), chunks };
}

export async function attachEmbeddings(chunks) {
  if (!process.env.EMBED_API_KEY) return chunks;
  const batchSize = 64;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const vecs = await embed(batch.map((c) => `${c.title}\n${c.text}`));
    if (!vecs) break;
    batch.forEach((c, j) => { c.vector = vecs[j]; });
  }
  return chunks;
}
