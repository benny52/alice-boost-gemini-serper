import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import handler from '../api/index.js';

function setup(t, responder) {
  const original = { gemini: process.env.GEMINI_API_KEY, serper: process.env.SERPER_API_KEY };
  process.env.GEMINI_API_KEY = 'artificial-gemini-key';
  process.env.SERPER_API_KEY = 'artificial-serper-key';
  t.after(() => {
    for (const [key, value] of [['GEMINI_API_KEY', original.gemini], ['SERPER_API_KEY', original.serper]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const service = url.startsWith('https://google.serper.dev/') ? 'search' : url.startsWith('https://generativelanguage.googleapis.com/') ? 'gemini' : null;
    assert.ok(service, 'Unexpected external service');
    const call = { service, body: JSON.parse(options.body), signal: options.signal };
    calls.push(call);
    return responder ? responder(call) : modelReply('Короткий ответ.');
  });
  return calls;
}
const modelReply = text => Response.json({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] });
const searchReply = () => Response.json({ organic: [{ title: 'Тестовый источник', snippet: 'Сведения для теста.', link: 'https://example.com/source' }] });
const waitForAbort = signal => new Promise((resolve, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});
async function ask(text, state = {}, session = {}) {
  let payload;
  await handler({ method: 'POST', body: { version: '1.0', request: { command: text }, state: { session: state }, session } }, {
    status(code) { assert.equal(code, 200); return this; }, json(value) { payload = value; return value; }, setHeader() {}
  });
  return payload;
}
const byteSize = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

test('several short Russian exchanges stay within the 1 KiB state contract', async t => {
  setup(t, () => modelReply('Для прогулки выберите удобную обувь и возьмите воду. Начните с короткого маршрута по парку, а затем постепенно увеличивайте расстояние.'));
  let state = {};
  for (const question of ['Как подготовиться к прогулке?', 'Что взять с собой?', 'Как выбрать маршрут?', 'Сколько времени гулять?']) {
    const result = await ask(question, state);
    state = result.session_state;
    assert.ok(byteSize(state) <= 1024, `state contains ${byteSize(state)} bytes`);
    assert.ok(state.history.some(item => item.role === 'user' && item.text.includes(question)));
  }
});

test('a very long unicode exchange retains both roles without exceeding the state limit', async t => {
  setup(t, () => modelReply('Ответ 🧑‍🚀 '.repeat(300)));
  const state = (await ask('Объясни 🧑‍🚀 '.repeat(300))).session_state;
  assert.ok(byteSize(state) <= 1024);
  assert.deepEqual(state.history.map(item => item.role), ['user', 'model']);
  for (const item of state.history) assert.equal(item.text.isWellFormed(), true);
});

test('an error response also compacts legacy oversized history', async t => {
  setup(t, () => Response.json({}, { status: 429 }));
  const old = { history: Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'model' : 'user', text: 'Память '.repeat(170) })) };
  const result = await ask('Продолжи рассказ', old);
  assert.ok(byteSize(result.session_state) <= 1024);
  assert.match(result.response.text, /лимит/);
});

test('the dated Marvel question from the original guide really uses search', async t => {
  const calls = setup(t, call => call.service === 'search' ? searchReply() : modelReply('Тестовый ответ.'));
  await ask('Какой фильм Marvel вышел в августе 2026 года?');
  assert.deepEqual(calls.map(call => call.service), ['search', 'gemini']);
  assert.match(calls[0].body.q, /Marvel/);
});

test('a fictional story about weather does not spend a search request', async t => {
  const calls = setup(t, call => call.service === 'search' ? searchReply() : modelReply('Жила-была туча.'));
  await ask('Расскажи сказку про погоду');
  assert.deepEqual(calls.map(call => call.service), ['gemini']);
});

test('weather follow-up keeps the city and replaces the relative date', async t => {
  const calls = setup(t, call => call.service === 'search' ? searchReply() : modelReply('В Москве ясно.'));
  const first = await ask('Какая погода сегодня в Москве?');
  const second = await ask('А завтра?', first.session_state);
  const query = calls.filter(call => call.service === 'search').at(-1)?.body.q;
  assert.equal(calls.filter(call => call.service === 'search').length, 2);
  assert.match(query, /москв/i);
  assert.match(query, /завтра/i);
  assert.doesNotMatch(query, /сегодня/i);
  assert.ok(byteSize(second.session_state) <= 1024);
});

test('weather city follow-up does not ask for both old and new cities', async t => {
  const calls = setup(t, call => call.service === 'search' ? searchReply() : modelReply('В Москве ясно.'));
  const first = await ask('Какая погода сегодня в Москве?');
  await ask('А в Санкт-Петербурге?', first.session_state);
  const query = calls.filter(call => call.service === 'search').at(-1)?.body.q;
  assert.match(query, /Санкт-Петербурге/);
  assert.match(query, /погод/i);
  assert.doesNotMatch(query, /москв/i);
});

test('a pronoun follow-up can use the previously named film', async t => {
  const calls = setup(t, call => call.service === 'search' ? searchReply() : modelReply('Фильм «Тестовая премьера» вышел в августе.'));
  const first = await ask('Какой фильм Marvel вышел в августе 2026 года?');
  await ask('А когда он вышел?', first.session_state);
  const searches = calls.filter(call => call.service === 'search');
  assert.equal(searches.length, 2);
  assert.match(searches[1].body.q, /Тестовая премьера/);
});

test('a new unrelated topic does not inherit a previous search requirement', async t => {
  const calls = setup(t, call => call.service === 'search' ? searchReply() : modelReply('Тестовый ответ.'));
  const first = await ask('Какая погода сегодня в Москве?');
  const result = await ask('Сколько будет 25 умножить на 4?', first.session_state);
  assert.equal(calls.filter(call => call.service === 'search').length, 1);
  assert.ok(!result.session_state.search?.query);
});

for (const scenario of ['http-error', 'empty', 'missing-key']) {
  test(`fresh facts are not generated when search has ${scenario}`, async t => {
    const calls = setup(t, call => call.service === 'search' ? Response.json({ organic: [] }, { status: scenario === 'http-error' ? 503 : 200 }) : modelReply('Непроверенный прогноз.'));
    if (scenario === 'missing-key') delete process.env.SERPER_API_KEY;
    const result = await ask('Какая погода сегодня в Москве?');
    assert.equal(calls.filter(call => call.service === 'gemini').length, 0);
    assert.doesNotMatch(result.response.text, /Непроверенный прогноз/);
    assert.match(result.response.text, /поиск|провер|источник/i);
  });
}

test('a search timeout explicitly reports that fresh facts could not be checked', { timeout: 5000 }, async t => {
  const calls = setup(t, call => call.service === 'search' ? waitForAbort(call.signal) : modelReply('Непроверенный прогноз.'));
  const result = await ask('Какая погода сегодня?');
  assert.equal(calls.filter(call => call.service === 'gemini').length, 0);
  assert.match(result.response.text, /не успел|не удалось/i);
});

for (const stage of ['headers', 'body']) {
  test(`Gemini cancellation during ${stage} reports a timeout and preserves memory`, { timeout: 5000 }, async t => {
    setup(t, call => stage === 'headers' ? waitForAbort(call.signal) : { ok: true, status: 200, json: () => waitForAbort(call.signal) });
    const result = await ask('Продолжи рассказ', { history: [{ role: 'user', text: 'Придумай героя' }, { role: 'model', text: 'Героя зовут Тест.' }] });
    assert.match(result.response.text, /не успел/i);
    assert.ok(result.session_state.history.some(item => item.text.includes('Героя зовут Тест')));
    assert.ok(byteSize(result.session_state) <= 1024);
  });
}

test('a new session does not accidentally reuse supplied stale state', async t => {
  setup(t);
  const result = await ask('', { history: [{ role: 'user', text: 'Чужая старая тема' }] }, { new: true });
  assert.deepEqual(result.session_state.history, []);
});

test('escaped search metadata cannot break the byte limit even without history', async t => {
  setup(t);
  const result = await ask('', { history: [], search: { query: '\u0001'.repeat(200) } });
  assert.ok(byteSize(result.session_state) <= 1024);
});

test('arithmetic with a year-shaped number works without a search key', async t => {
  const calls = setup(t, () => modelReply('2027'));
  delete process.env.SERPER_API_KEY;
  const result = await ask('Сколько будет 2026 плюс 1?');
  assert.equal(result.response.text, '2027');
  assert.deepEqual(calls.map(call => call.service), ['gemini']);
});

for (const text of ['А в Санкт-Петербурге завтра?', 'А завтра в Санкт-Петербурге?']) {
  test(`combined weather update preserves the topic: ${text}`, async t => {
    const calls = setup(t, call => call.service === 'search' ? searchReply() : modelReply('В Москве ясно.'));
    const first = await ask('Какая погода сегодня в Москве?');
    await ask(text, first.session_state);
    const query = calls.filter(call => call.service === 'search').at(-1).body.q;
    assert.match(query, /погод/i);
    assert.match(query, /Санкт-Петербурге/);
    assert.match(query, /завтра/i);
    assert.doesNotMatch(query, /сегодня|москв/i);
  });
}

test('a non-JSON quota response still explains the quota failure', async t => {
  setup(t, () => new Response('Too many requests', { status: 429 }));
  const result = await ask('Расскажи сказку');
  assert.match(result.response.text, /лимит/);
});

test('timing: a slow successful search reaches Gemini with its sources', { timeout: 6000 }, async t => {
  const calls = setup(t, async call => {
    await delay(call.service === 'search' ? 1100 : 1600, undefined, { signal: call.signal });
    return call.service === 'search' ? searchReply() : modelReply('Ответ по тестовому источнику.');
  });
  const result = await ask('Найди дату тестового события');
  assert.equal(result.response.text, 'Ответ по тестовому источнику.');
  assert.deepEqual(calls.map(call => call.service), ['search', 'gemini']);
  assert.match(calls[1].body.contents.at(-1).parts[0].text, /Сведения для теста/);
  assert.equal(result.session_state.history.at(-1).text, result.response.text);
});

test('timing: Gemini can use the remaining time when search is unnecessary', { timeout: 6000 }, async t => {
  const calls = setup(t, async call => {
    await delay(2900, undefined, { signal: call.signal });
    return modelReply('Сто.');
  });
  const result = await ask('Сколько будет 25 умножить на 4?');
  assert.equal(result.response.text, 'Сто.');
  assert.deepEqual(calls.map(call => call.service), ['gemini']);
});

test('timing: combined search and generation still respect the response deadline', { timeout: 6000 }, async t => {
  const calls = setup(t, async call => {
    await delay(call.service === 'search' ? 1100 : 3000, undefined, { signal: call.signal });
    return call.service === 'search' ? searchReply() : modelReply('Слишком поздний ответ.');
  });
  const history = [{ role: 'user', text: 'Назови героя' }, { role: 'model', text: 'Героя зовут Тест.' }];
  const startedAt = performance.now();
  const result = await ask('Найди дату тестового события', { history });
  const elapsedMs = performance.now() - startedAt;
  assert.deepEqual(calls.map(call => call.service), ['search', 'gemini']);
  assert.equal(calls[1].signal.aborted, true);
  assert.match(result.response.text, /не успела подготовить/i);
  assert.deepEqual(result.session_state.history, history);
  assert.ok(elapsedMs < 4000, `response missed its deadline: ${elapsedMs} ms`);
});
