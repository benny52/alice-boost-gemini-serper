import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/index.js';

function setup(t, responder, backend = 'openrouter') {
  const keys = ['LLM_BACKEND', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'SERPER_API_KEY'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.LLM_BACKEND = backend;
  process.env.OPENROUTER_API_KEY = 'artificial-openrouter-key';
  delete process.env.GEMINI_API_KEY;
  delete process.env.SERPER_API_KEY;
  t.after(() => { for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } });
  const logs = [];
  t.mock.method(console, 'info', (...args) => logs.push(args));
  t.mock.method(console, 'warn', (...args) => logs.push(args));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), signal: options.signal });
    return responder ? responder(calls.at(-1)) : completion('Сто.');
  });
  return { calls, logs };
}
function completion(text, { searched = false, citations = searched, finish = 'stop' } = {}) {
  return Response.json({
    id: 'artificial-response', provider: 'DeepInfra', model: 'deepseek/deepseek-v4-flash-0731',
    choices: [{ finish_reason: finish, message: { role: 'assistant', content: text,
      annotations: citations ? [{ type: 'url_citation', url_citation: { url: 'https://example.com/weather', title: 'Искусственный источник', content: 'Тестовый прогноз: ясно.' } }] : [] } }],
    usage: { prompt_tokens: 100, completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 0 }, server_tool_use: { web_search_requests: searched ? 1 : 0 } }
  });
}
async function ask(text, state = {}, extra = {}) {
  let payload;
  await handler({ method: 'POST', body: { request: { command: text }, state: { session: state }, ...extra } }, {
    status(code) { assert.equal(code, 200); return this; }, json(data) { payload = data; return data; }, setHeader() {}
  });
  return payload;
}
const remembered = { history: [{ role: 'user', text: 'Моего кота зовут Барсик.' }, { role: 'model', text: 'Запомнил.' }] };

test('OpenRouter answers through exactly the selected provider and carries history without reasoning output', async t => {
  const { calls, logs } = setup(t, () => completion('Барсик.'));
  const result = await ask('Как зовут моего кота?', remembered);
  assert.equal(result.response.text, 'Барсик.');
  assert.equal(calls.length, 1);
  const { url, body } = calls[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(body.model, 'deepseek/deepseek-v4-flash-0731');
  assert.deepEqual(body.provider.only, ['deepinfra/fp8']);
  assert.equal(body.provider.allow_fallbacks, false);
  assert.equal(body.reasoning.enabled, false);
  assert.equal(body.stream, false);
  assert.ok(body.max_tokens <= 240);
  assert.deepEqual(body.messages.slice(1, 3), [{ role: 'user', content: remembered.history[0].text }, { role: 'assistant', content: 'Запомнил.' }]);
  assert.match(body.messages[0].content, /Супер Гений/);
  assert.match(body.messages[0].content, new RegExp(new Date().toISOString().slice(0,10)));
  assert.equal(result.session_state.history.at(-1).text, result.response.text);
  assert.ok(Buffer.byteLength(JSON.stringify(result.session_state)) <= 1024);
  assert.ok(logs.some(([event, metadata]) => event === 'UPSTREAM_REQUEST' && JSON.parse(metadata).service === 'openrouter'));
  assert.doesNotMatch(JSON.stringify(logs), /artificial-openrouter-key|Барсик/);
});

test('fresh follow-up uses one bounded OpenRouter search with context and no Serper', async t => {
  const { calls } = setup(t, () => completion('В Казани ясно.', { searched: true }));
  const first = await ask('Найди погоду в Казани сегодня');
  const result = await ask('А завтра?', first.session_state);
  assert.equal(result.response.text, 'В Казани ясно.');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.url.startsWith('https://openrouter.ai/')));
  const body = calls[1].body;
  assert.equal(body.tool_choice, 'required');
  assert.equal(body.max_tool_calls, 1);
  assert.deepEqual(body.tools, [{ type: 'openrouter:web_search', parameters: {
    engine: 'exa', mode: 'instant', max_results: 3, max_total_results: 3, max_uses: 1, max_characters: 1200
  } }]);
  assert.match(body.messages.at(-1).content, /Казан/i);
  assert.match(body.messages.at(-1).content, /завтра/i);
});

test('model-initiated search retains its topic for the next question', async t => {
  setup(t, () => completion('Гонка в воскресенье.', { searched: true }));
  const result = await ask('Когда ближайшая гонка Формулы-1?');
  assert.match(result.session_state.search.query, /Формулы-1/);
});

for (const [label, searched] of [['skipped', false], ['empty', true]]) {
  test(`${label} mandatory search cannot turn an unverified answer into a spoken fact`, async t => {
    const { calls, logs } = setup(t, () => completion('Непроверенный прогноз.', { searched, citations: false }));
    const result = await ask('Погода сегодня в Казани', remembered);
    assert.equal(calls.length, 1);
    assert.ok(logs.some(([event]) => event === 'OPENROUTER_SEARCH_UNVERIFIED'));
    assert.doesNotMatch(result.response.text, /Непроверенный прогноз/);
    assert.match(result.response.text, /провер|источник/);
    assert.deepEqual(result.session_state.history, remembered.history);
  });
}

test('an ordinary question can answer without paying for a search', async t => {
  const { calls } = setup(t);
  const result = await ask('Сколько будет 25 умножить на 4?');
  assert.equal(result.response.text, 'Сто.');
  assert.equal(calls[0].body.tool_choice, 'auto');
  assert.ok(!result.session_state.search?.query);
});

for (const [status, code] of [[401,'OPENROUTER_ACCESS_DENIED'], [403,'OPENROUTER_ACCESS_DENIED'], [402,'OPENROUTER_BALANCE'], [429,'OPENROUTER_QUOTA'], [503,'OPENROUTER_REQUEST_FAILED']]) {
  test(`OpenRouter HTTP ${status} preserves memory and never retries or switches provider`, async t => {
    const { calls, logs } = setup(t, () => new Response('private-provider-details', { status }));
    const result = await ask('Продолжи рассказ', remembered);
    assert.equal(calls.length, 1);
    assert.deepEqual(result.session_state.history, remembered.history);
    assert.ok(logs.some(([event]) => event === code));
    assert.doesNotMatch(JSON.stringify(logs), /private-provider-details|artificial-openrouter-key/);
  });
}

for (const [label, response] of [
  ['reasoning only', { choices:[{ finish_reason:'stop', message:{ content:null, reasoning:'private-thought' } }] }],
  ['unfinished answer', { choices:[{ finish_reason:'length', message:{content:'Обрезанный ответ'} }] }],
  ['embedded provider error', { error:{code:503,message:'private-provider-details'} }],
  ['unhandled tool call', { choices:[{finish_reason:'tool_calls',message:{content:'Начинаю поиск',tool_calls:[{type:'function'}]}}] }]
]) {
  test(`${label} is not presented as a successful answer`, async t => {
    const { calls } = setup(t, () => Response.json(response));
    const result = await ask('Продолжи', remembered);
    assert.equal(calls.length,1);
    assert.deepEqual(result.session_state.history, remembered.history);
    assert.doesNotMatch(result.response.text, /private|Обрезанный|Начинаю/);
  });
}

test('missing OpenRouter key fails before any paid call', async t => {
  const { calls } = setup(t);
  delete process.env.OPENROUTER_API_KEY;
  const result = await ask('Погода в Казани');
  assert.equal(calls.length,0);
  assert.match(result.response.text,/настроен/);
});

test('unknown backend fails closed without accidentally spending at another provider', async t => {
  const { calls } = setup(t, undefined, 'typo');
  const result = await ask('Погода в Казани');
  assert.equal(calls.length,0);
  assert.match(result.response.text,/настро/);
});

test('OpenRouter body reading is cancelled within the Alice budget and history survives', { timeout: 5000 }, async t => {
  let aborted = false;
  const { calls } = setup(t, ({signal}) => ({ ok:true,status:200,json:()=>new Promise((resolve,reject)=> {
    signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true});
  }) }));
  const result = await ask('Расскажи о котах', remembered);
  assert.equal(calls.length,1);
  assert.equal(aborted,true);
  assert.match(result.response.text,/Не успела/);
  assert.deepEqual(result.session_state.history,remembered.history);
});

test('real Exa citation shape works even when usage has no search counter', async t => {
  setup(t, () => Response.json({ provider:'DeepInfra', choices:[{
    finish_reason:'stop', message:{role:'assistant',content:'Ответ из источника [1].',annotations:[{
      type:'url_citation',url_citation:{url:'https://example.com/race',title:'Тестовый календарь',content:'Тестовая гонка — 25 октября.'}
    }]}
  }],usage:{cost:0.0071,prompt_tokens:2500,completion_tokens:117,completion_tokens_details:{reasoning_tokens:0}}}));
  const result = await ask('Найди дату гонки');
  assert.equal(result.response.text,'Ответ из источника.');
  assert.equal(result.session_state.history.at(-1).text,result.response.text);
});
test('auto search with an empty citation and missing search counter fails closed', async t => {
  const { calls, logs } = setup(t, () => Response.json({choices:[{
    finish_reason:'stop',message:{content:'Непроверенная дата.',annotations:[{
      type:'url_citation',url_citation:{url:'https://example.com/race',title:'Календарь',content:''}
    }]}
  }],usage:{completion_tokens:10}}));
  const result=await ask('Когда ближайшая гонка Формулы-1?',remembered);
  assert.equal(calls.length,1);
  assert.equal(calls[0].body.tool_choice,'auto');
  assert.ok(logs.some(([event])=>event==='OPENROUTER_SEARCH_UNVERIFIED'));
  assert.doesNotMatch(result.response.text,/Непроверенная дата/);
  assert.deepEqual(result.session_state.history,remembered.history);
});
