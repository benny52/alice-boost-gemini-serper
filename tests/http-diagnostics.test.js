import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson } from '../lib/http.js';

function captureLogs(t) {
  const logs = [];
  t.mock.method(console, 'info', (...args) => logs.push(args));
  return logs;
}
function diagnostic(logs) {
  assert.equal(logs.length, 1, 'one safe diagnostic must be emitted per external request');
  assert.equal(logs[0][0], 'UPSTREAM_REQUEST');
  const record = JSON.parse(logs[0][1]);
  assert.deepEqual(Object.keys(record).sort(), ['elapsed_ms', 'http_status', 'outcome', 'service', 'timeout_ms']);
  assert.ok(Number.isInteger(record.elapsed_ms) && record.elapsed_ms >= 0);
  return record;
}

test('HTTP failures retain their status in diagnostics without exposing request or provider contents', async t => {
  const logs = captureLogs(t);
  t.mock.method(globalThis, 'fetch', async () => new Response('private-provider-details', { status: 503 }));
  const result = await fetchJson('https://generativelanguage.googleapis.com/v1beta/models/test:generateContent?key=artificial-secret', { method: 'POST', headers: { 'x-goog-api-key': 'artificial-secret' }, body: 'private-conversation' }, 1000);
  assert.equal(result.response.status, 503);
  assert.deepEqual(result.data, {});
  const record = diagnostic(logs);
  assert.equal(record.service, 'gemini');
  assert.equal(record.http_status, 503);
  assert.equal(record.outcome, 'http_error');
  assert.doesNotMatch(JSON.stringify(logs), /artificial-secret|private-conversation|private-provider-details|googleapis/);
});

test('successful search diagnostics do not change the returned data', async t => {
  const logs = captureLogs(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ organic: [{ title: 'Artificial source' }] }));
  const result = await fetchJson('https://google.serper.dev/search', { method: 'POST' }, 1000);
  assert.deepEqual(result.data, { organic: [{ title: 'Artificial source' }] });
  const record = diagnostic(logs);
  assert.equal(record.service, 'serper');
  assert.equal(record.http_status, 200);
  assert.equal(record.outcome, 'ok');
});

test('body timeout diagnostics preserve the received status and report cancellation', { timeout: 1000 }, async t => {
  const logs = captureLogs(t);
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => ({ ok: true, status: 200, json: () => new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) }));
  await assert.rejects(fetchJson('https://generativelanguage.googleapis.com/v1beta/models/test:generateContent', {}, 30), { message: 'REQUEST_TIMEOUT' });
  const record = diagnostic(logs);
  assert.equal(record.http_status, 200);
  assert.equal(record.outcome, 'timeout');
  assert.equal(record.timeout_ms, 30);
});

test('network failure diagnostics omit raw error details and show that no HTTP status was received', async t => {
  const logs = captureLogs(t);
  const error = new Error('private-network-details');
  t.mock.method(globalThis, 'fetch', async () => { throw error; });
  await assert.rejects(fetchJson('https://generativelanguage.googleapis.com/v1beta/models/test:generateContent', {}, 1000), value => value === error);
  const record = diagnostic(logs);
  assert.equal(record.http_status, null);
  assert.equal(record.outcome, 'network_error');
  assert.doesNotMatch(JSON.stringify(logs), /private-network-details/);
});

test('a failed response body is recorded without mistaking it for malformed JSON', async t => {
  const logs = captureLogs(t);
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.error(new TypeError('private-body-error')); }
  }), { status: 200 }));
  await assert.rejects(fetchJson('https://generativelanguage.googleapis.com/v1beta/models/test:generateContent', {}, 1000), { name: 'TypeError' });
  const record = diagnostic(logs);
  assert.equal(record.http_status, 200);
  assert.equal(record.outcome, 'response_error');
  assert.doesNotMatch(JSON.stringify(logs), /private-body-error/);
});
