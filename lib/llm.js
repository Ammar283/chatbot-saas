// One thin wrapper over any OpenAI-compatible endpoint. Changing provider is
// two lines in .env, which matters: the cheapest good model changes every few
// months and you should never be re-architecting to chase it.

const BASE = () => (process.env.LLM_BASE_URL || '').replace(/\/$/, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Providers say how long to wait, in a header or in the error text. Guessing
// instead means either retrying too early and being refused again, or sitting
// on a visitor's question for longer than the provider ever asked for.
function retryDelayMs(res, detail) {
  const header = res.headers.get('retry-after');
  if (header && Number.isFinite(Number(header))) return Math.min(Number(header) * 1000, 8000);
  const m = /try again in\s*([\d.]+)\s*(ms|s)\b/i.exec(detail || '');
  if (m) {
    const n = Number(m[1]);
    return Math.min(m[2].toLowerCase() === 'ms' ? n : n * 1000, 8000);
  }
  return 1200;
}

export async function chat(messages, { model, maxTokens = 400, temperature = 0.2, json = false, isFallback = false, attempt = 0 } = {}) {
  const base = isFallback ? process.env.LLM_FALLBACK_BASE_URL : BASE();
  const apiKey = isFallback ? process.env.LLM_FALLBACK_API_KEY : process.env.LLM_API_KEY;
  const body = {
    model: model || (isFallback ? process.env.LLM_FALLBACK_MODEL : process.env.LLM_MODEL),
    messages,
    max_tokens: maxTokens,
    temperature,
  };
  if (json) body.response_format = { type: 'json_object' };

  const res = await fetch(`${String(base).replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // A rate limit is a "wait", not a failure. Treated as a failure, the visitor
    // gets the "I'll pass this to the team" message for a problem that would
    // have cleared itself in a few seconds.
    if (res.status === 429) {
      const smart = process.env.LLM_MODEL_SMART;
      // The big model usually has the smallest quota, so step down to the
      // standard one first. It costs nothing to try and needs no waiting.
      if (smart && body.model === smart && process.env.LLM_MODEL && process.env.LLM_MODEL !== smart) {
        return chat(messages, { model: process.env.LLM_MODEL, maxTokens, temperature, json, isFallback, attempt: attempt + 1 });
      }
      // Then wait exactly as long as the provider asked, and try once more.
      if (attempt < 2) {
        await sleep(retryDelayMs(res, detail));
        return chat(messages, { model, maxTokens, temperature, json, isFallback, attempt: attempt + 1 });
      }
    }
    // Still stuck, or the provider is down — swing to the backup free tier.
    // Different provider, separate quota, so one cap doesn't take the bot offline.
    if ((res.status === 429 || res.status >= 500) && !isFallback && process.env.LLM_FALLBACK_API_KEY) {
      return chat(messages, { maxTokens, temperature, json, isFallback: true });
    }
    // Some models reject response_format. Retry once in plain text — prompt.js
    // already tolerates a non-JSON reply.
    if (res.status === 400 && json) {
      return chat(messages, { model, maxTokens, temperature, json: false, isFallback });
    }
    throw new Error(`LLM request failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  return {
    text: data.choices?.[0]?.message?.content?.trim() || '',
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
    model: body.model,
  };
}

export async function embed(texts) {
  if (!process.env.EMBED_API_KEY || !process.env.EMBED_BASE_URL) return null;
  const res = await fetch(`${process.env.EMBED_BASE_URL.replace(/\/$/, '')}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.EMBED_API_KEY}`,
    },
    body: JSON.stringify({ model: process.env.EMBED_MODEL, input: texts }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.data.map((d) => d.embedding);
}

export function hasSmartModel() {
  return Boolean(process.env.LLM_MODEL_SMART);
}

// Cheap heuristic router. A model call to decide whether to make a model call
// is usually a false economy at this scale, so this stays rule-based.
export function needsSmartModel(question, contextChunks) {
  if (!hasSmartModel()) return false;
  // Set ALWAYS_SMART=true to send every question to the larger model.
  //
  // Quality over throughput, and a defensible choice: the larger model is
  // noticeably better at following the lead-capture rules, which is where the
  // money is. It is safe to turn on because a rate limit is no longer fatal —
  // a 429 steps the request down to LLM_MODEL automatically, so a busy minute
  // costs a slightly weaker answer rather than a broken conversation.
  if (process.env.ALWAYS_SMART === 'true') return true;
  const q = question.toLowerCase();
  const longMultiPart = q.length > 180 || (q.match(/\?/g) || []).length > 1;
  const comparative = /\b(compare|difference|versus|vs|which is better|cheapest|best option)\b/.test(q);
  // Few passages retrieved means the answer has to be pieced together from
  // thin material, which is where a stronger model earns its cost.
  //
  // This used to read `>= 4`, which is the opposite test: retrieval is capped
  // at five passages, so on any real knowledge base nearly every question had
  // four or five and went to the big model. The big model is also the one with
  // the smallest tokens-per-minute allowance, so ordinary traffic walked
  // straight into a rate limit.
  const thinFacts = contextChunks.length <= 1;
  return longMultiPart || comparative || thinFacts;
}
