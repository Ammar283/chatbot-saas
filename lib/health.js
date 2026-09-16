// Silent failure is how you lose a client you would otherwise have kept.
//
// When a key expires or a provider goes down, the bot keeps answering — with
// the handoff message, politely, to every visitor, forever. The client finds
// out before you do. This watches for that and pings you once.

import { notifyOperator } from './notify.js';

const state = {
  consecutiveFailures: 0,
  totalFailures: 0,
  totalCalls: 0,
  lastError: null,
  lastErrorAt: null,
  lastSuccessAt: null,
  alerted: false,
  startedAt: new Date().toISOString(),
  recent: [],          // last 50 answers: true = grounded
};

const FAILURE_THRESHOLD = 5;

export function recordSuccess(grounded) {
  state.consecutiveFailures = 0;
  state.totalCalls++;
  state.lastSuccessAt = new Date().toISOString();
  state.recent.push(Boolean(grounded));
  if (state.recent.length > 50) state.recent.shift();

  if (state.alerted) {
    state.alerted = false;
    notifyOperator('Chatbot recovered', [
      'The language model is responding normally again.',
      `Recovered at ${new Date().toLocaleString()}.`,
    ]).catch(() => {});
  }
}

export function recordFailure(message) {
  state.consecutiveFailures++;
  state.totalFailures++;
  state.totalCalls++;
  state.lastError = String(message || '').slice(0, 300);
  state.lastErrorAt = new Date().toISOString();

  // Alert once per outage, not once per visitor.
  if (state.consecutiveFailures >= FAILURE_THRESHOLD && !state.alerted) {
    state.alerted = true;
    const hint = /401|invalid.?api.?key|unauthor/i.test(state.lastError)
      ? 'The API key looks rejected — check it has not expired or been rotated.'
      : /429|rate.?limit|quota/i.test(state.lastError)
      ? 'Looks like a rate limit or quota. Set LLM_FALLBACK_* to fail over automatically.'
      : /404|model/i.test(state.lastError)
      ? 'The model name may be wrong or retired. Check the provider list.'
      : 'Check the provider status page and your .env values.';

    notifyOperator('Chatbot is failing — every visitor is getting the fallback message', [
      `${state.consecutiveFailures} model calls failed in a row.`,
      '',
      `Last error: ${state.lastError}`,
      '',
      hint,
    ]).catch(() => {});
  }
}

export function snapshot() {
  const answered = state.recent.length;
  const grounded = state.recent.filter(Boolean).length;
  return {
    ...state,
    recent: undefined,
    groundedRatePct: answered ? Math.round((grounded / answered) * 100) : null,
    sampleSize: answered,
    // Healthy bots answer from their knowledge base most of the time. A rate
    // this low usually means an empty knowledge base, not a broken model.
    knowledgeThin: answered >= 20 && grounded / answered < 0.4,
    status: state.consecutiveFailures >= FAILURE_THRESHOLD ? 'failing'
      : state.consecutiveFailures > 0 ? 'degraded'
      : 'ok',
  };
}
