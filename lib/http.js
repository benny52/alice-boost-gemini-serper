export async function fetchJson(url, options, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('TIME_BUDGET_EXHAUSTED');
  const startedAt = performance.now();
  const target = String(url);
  const service = target.startsWith('https://generativelanguage.googleapis.com/') ? 'gemini'
    : target.startsWith('https://google.serper.dev/') ? 'serper' : target.startsWith('https://openrouter.ai/') ? 'openrouter'
    : /^https:\/\/[a-z0-9-]+\.supabase\.co\//.test(target) ? 'supabase' : 'external';
  let httpStatus = null;
  let outcome = 'network_error';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    httpStatus = response.status;
    if (!response.ok) {
      outcome = 'http_error';
      // Error pages may be HTML/plain text. Preserve the HTTP status and release the body.
      await response.body?.cancel();
      return { response, data: {} };
    }
    // JSON body consumption shares the deadline. Do not swallow abort errors here.
    outcome = 'response_error';
    const data = await response.json();
    outcome = 'ok';
    return { response, data };
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      outcome = 'timeout';
      throw new Error('REQUEST_TIMEOUT');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    // Allowlisted metadata only: never log URLs, headers, payloads or raw error messages.
    console.info('UPSTREAM_REQUEST', JSON.stringify({
      service, elapsed_ms: Math.round(performance.now() - startedAt), timeout_ms: timeoutMs,
      http_status: httpStatus, outcome
    }));
  }
}
