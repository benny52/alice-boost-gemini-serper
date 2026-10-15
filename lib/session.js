const MAX_STATE_BYTES = 1024;
const MAX_HISTORY_MESSAGES = 8;
const MAX_MESSAGE_CHARS = 1200;

export function clipText(value, length) {
  return String(value ?? '').slice(0, length).replace(/[\uD800-\uDBFF]$/, '').toWellFormed();
}

export function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === 'user' || item.role === 'model') && typeof item.text === 'string')
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: clipText(item.text, MAX_MESSAGE_CHARS) }));
}

// Measure the entire serialized state, including escaping and search metadata.
export function packState(history = [], search = {}) {
  const state = { history: safeHistory(history) };
  if (typeof search?.query === 'string' && search.query.trim()) {
    state.search = { query: clipText(search.query.trim(), 200) };
    // Leave room for the latest exchange, even when JSON escaping expands text.
    while (Buffer.byteLength(JSON.stringify(state.search), 'utf8') > 320) {
      state.search.query = clipText(state.search.query, Math.max(0, state.search.query.length - 16));
    }
  }
  const size = () => Buffer.byteLength(JSON.stringify(state), 'utf8');
  while (size() > MAX_STATE_BYTES && state.history.length > 2) {
    state.history.shift();
    if (state.history[0]?.role === 'model') state.history.shift();
  }
  // Keep both sides of the latest exchange, shortening the longer side first.
  while (size() > MAX_STATE_BYTES && state.history.some(item => item.text.length)) {
    const largest = state.history.reduce((a, b) => a.text.length >= b.text.length ? a : b);
    largest.text = clipText(largest.text, Math.max(0, largest.text.length - 16));
  }
  return state;
}

export function readState(value) {
  return packState(value?.history, value?.search);
}
