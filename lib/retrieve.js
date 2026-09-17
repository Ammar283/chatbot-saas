// Retrieval runs keyword-first on purpose.
//
// For one business's website — a few hundred chunks — BM25 matches or beats
// embeddings on the queries that actually arrive ("do you deliver to DHA",
// "what are your fees"), and it costs nothing per query. Embeddings are an
// opt-in upgrade that catches paraphrase, not a requirement to ship.

const STOP = new Set(
  ('a an the and or but if then than that this these those is are was were be been being do does did ' +
   'have has had i you he she it we they me my your our their of to in on at for with from by as ' +
   'about into over after before can could will would should may might just so very there here what ' +
   'which who whom how when where why not no yes hi hello please thanks thank ok okay').split(' ')
);

// Roman Urdu and Urdu queries are common in Pakistani traffic and tokenise
// fine on whitespace; we only strip Latin punctuation so Urdu script survives.
export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

// Visitors and websites use different words for the same thing. A dental site
// writes "Dr. Navin Ratra" and "Focus:", the visitor asks about "doctors" and
// "speciality"; a site writes "Hours", the visitor asks about "timing". Pure
// keyword matching fails every one of those, so both sides are expanded with a
// small synonym map before scoring.
const SYNONYMS = [
  ['doctor', 'doctors', 'dr', 'dentist', 'dentists', 'physician', 'practitioner', 'surgeon', 'specialist', 'team', 'staff'],
  ['speciality', 'specialty', 'specialties', 'specialises', 'specializes', 'focus', 'expertise', 'field'],
  ['hours', 'hour', 'timing', 'timings', 'time', 'times', 'open', 'opening', 'closed', 'closing', 'schedule', 'availability'],
  ['price', 'prices', 'pricing', 'cost', 'costs', 'fee', 'fees', 'charge', 'charges', 'rate', 'rates', 'much', 'afford'],
  // On a small-business site the address, phone and hours all live on one
  // "contact" page, so these belong in one group or a location question never
  // finds the page that answers it.
  ['address', 'location', 'located', 'directions', 'parking', 'find', 'contact', 'phone', 'call', 'number', 'reach', 'email', 'street', 'suite', 'road', 'avenue', 'map'],
  ['book', 'booking', 'appointment', 'appointments', 'schedule', 'reserve', 'consultation', 'visit'],
  ['insurance', 'coverage', 'covered', 'claim', 'benefits', 'financing', 'payment', 'plan', 'plans'],
  ['emergency', 'urgent', 'emergencies', 'same-day', 'walk-in'],
  ['experience', 'qualified', 'years', 'education', 'training', 'credentials', 'reputation'],
];

const EXPAND = new Map();
for (const group of SYNONYMS) {
  for (const word of group) {
    const set = EXPAND.get(word) || new Set();
    group.forEach((w) => set.add(w));
    EXPAND.set(word, set);
  }
}

// Expanded terms score lower than a literal hit, so a page that really is
// about pricing still beats one that merely mentions a related word.
export function expandQuery(tokens) {
  const out = new Map();
  for (const t of tokens) {
    out.set(t, 1);
    for (const syn of EXPAND.get(t) || []) if (!out.has(syn)) out.set(syn, 0.45);
  }
  return out;
}

export function buildIndex(chunks) {
  const df = new Map();
  let totalLen = 0;
  const docs = chunks.map((c) => {
    // Title twice and the URL slug once: "/meet-the-team/" tells us what a page
    // is about even when its body never uses the visitor's words.
    const slug = String(c.url || '').replace(/^https?:\/\/[^/]+/, '').replace(/[/_-]+/g, ' ');
    const tokens = tokenize(`${c.title} ${c.title} ${slug} ${c.text}`);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    totalLen += tokens.length;
    return { ...c, tf, len: tokens.length };
  });
  return { docs, df, avgdl: docs.length ? totalLen / docs.length : 0, N: docs.length };
}

export function bm25(index, query, k = 5) {
  const { docs, df, avgdl, N } = index;
  if (!N) return [];
  const weighted = expandQuery(tokenize(query));
  const k1 = 1.5;
  const b = 0.75;

  const scored = docs.map((d) => {
    let score = 0;
    for (const [t, weight] of weighted) {
      const f = d.tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
      score += weight * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avgdl)));
    }
    return { chunk: d, score };
  });

  const hits = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  if (hits.length) return hits;

  // Nothing matched. Rather than hand the model an empty context — which makes
  // it say "I'll check with the team" for a question the site does answer —
  // fall back to the pages that carry general information. Shortest URL path
  // is a good proxy: "/contact-us/" and "/" outrank "/porcelain-veneers/".
  return docs
    .map((d) => ({ chunk: d, score: 0, fallback: true, depth: String(d.url || '').split('/').filter(Boolean).length }))
    .sort((a, b) => a.depth - b.depth)
    .slice(0, Math.min(3, k));
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// Reciprocal rank fusion — merges keyword and vector rankings without needing
// the two score scales to be comparable.
export function fuse(lists, k = 60) {
  const scores = new Map();
  for (const list of lists) {
    list.forEach((item, rank) => {
      const key = item.chunk.id;
      scores.set(key, (scores.get(key) || 0) + 1 / (k + rank + 1));
      if (!scores.has(key + ':ref')) scores.set(key + ':ref', item.chunk);
    });
  }
  return [...scores.entries()]
    .filter(([key]) => !key.endsWith(':ref'))
    .sort((a, b) => b[1] - a[1])
    .map(([key, score]) => ({ chunk: scores.get(key + ':ref'), score }));
}

// --- answer cache ------------------------------------------------------
// Roughly half of small-business traffic is the same six questions. Serving
// those from cache is the single biggest lever on your API bill.

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export function cacheLookup(tenant, question, threshold = 0.82) {
  const q = tokenize(question);
  if (q.length < 2) return null;
  for (const entry of tenant.cache) {
    if (jaccard(q, entry.tokens) >= threshold) {
      entry.hits = (entry.hits || 0) + 1;
      return entry.answer;
    }
  }
  return null;
}

export function cacheStore(tenant, question, answer) {
  const tokens = tokenize(question);
  if (tokens.length < 2) return;
  tenant.cache.unshift({ q: question, tokens, answer, hits: 0, at: Date.now() });
  if (tenant.cache.length > 300) tenant.cache.length = 300;
}

export function cacheClear(tenant) {
  tenant.cache = [];
}
