export async function fetchJson(url, options, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('TIME_BUDGET_EXHAUSTED');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      // Error pages may be HTML/plain text. Preserve the HTTP status and release the body.
      await response.body?.cancel();
      return { response, data: {} };
    }
    // JSON body consumption shares the deadline. Do not swallow abort errors here.
    const data = await response.json();
    return { response, data };
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new Error('REQUEST_TIMEOUT');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
