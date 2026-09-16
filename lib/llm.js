// One thin wrapper over any OpenAI-compatible endpoint. Changing provider is
// two lines in .env, which matters: the cheapest good model changes every few
// months and you should never be re-architecting to chase it.

const BASE = () => (process.env.LLM_BASE_URL || '').replace(/\/$/, '');

export async function chat(messages, { model, maxTokens = 400, temperature = 0.2, json = false, isFallback = false } = {}) {
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
    // Rate-limited or provider down — swing to the backup free tier. Different
    // provider, separate quota, so a Groq daily cap doesn't take the bot offline.
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
  const q = question.toLowerCase();
  const longMultiPart = q.length > 180 || (q.match(/\?/g) || []).length > 1;
  const comparative = /\b(compare|difference|versus|vs|which is better|cheapest|best option)\b/.test(q);
  const thinFacts = contextChunks.length >= 4;
  return longMultiPart || comparative || thinFacts;
}
