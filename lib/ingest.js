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

export async function crawl(startUrl, { maxPages = 40, onProgress } = {}) {
  const queue = [startUrl];
  const seen = new Set();
  // Key pages carry the answers visitors actually ask for, so make sure they
  // are fetched even on a site with hundreds of service pages.
  const PRIORITY = /(contact|about|team|staff|hours|location|price|pricing|fee|faq|book|appointment)/i;
  const chunks = [];
  const pages = [];

  while (queue.length && seen.size < maxPages) {
    const url = queue.shift();
    const canonical = url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
    if (seen.has(canonical)) continue;
    seen.add(canonical);

    let html;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'ChatbotIngest/0.1 (+website assistant setup)' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      if (!(res.headers.get('content-type') || '').includes('text/html')) continue;
      html = await res.text();
    } catch {
      continue;
    }

    const { title, text } = extractText(html);
    // A contact page can be little more than an address and a list of hours.
    // Short is not the same as worthless, and that page answers more visitor
    // questions than any service page on the site.
    if (text.length > 80) {
      const c = chunkText(text, title, url);
      chunks.push(...c);
      pages.push({ url, title, chunks: c.length });
      onProgress?.({ url, title, pages: pages.length, chunks: chunks.length });
    }

    for (const l of links(html, url)) {
      if (seen.has(l) || queue.includes(l)) continue;
      // Contact and team pages jump the queue — running out of budget before
      // reaching them is what leaves a bot unable to state its own hours.
      if (PRIORITY.test(l)) queue.unshift(l); else queue.push(l);
    }
  }

  return { pages, chunks };
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
