import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import handler from '../api/index.js';
import { createLocalServer } from '../server.mjs';

const skill = '11111111-1111-4111-8111-111111111111';
const sounds = [
  { id: '7ef4d4b4-7d2b-4b73-b7b4-d58720cdd134', text: 'Импортирую установки, начинаю калибровку виртуальной среды.' },
  { id: 'f2a36d8a-1c1a-4721-9f07-02260b2f9e21', text: 'Мы подключены и готовы.' },
  { id: '935124cd-41bd-4cb7-8784-5563e7292b4e', text: 'Всегда к вашим услугам, сэр.' }
];
const launch = (session = {}, request = {}) => ({
  version: '1.0',
  session: { new: true, skill_id: skill, ...session },
  request: { command: '', original_utterance: '', ...request }
});
function fixture(t) {
  const values = {
    MEMORY_BACKEND: 'session',
    LLM_BACKEND: 'openrouter', OPENROUTER_API_KEY: 'artificial-greeting-test-key'
  };
  const previous = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  for (const [k, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[k]; else process.env[k] = value;
  }
  t.after(() => { for (const [k, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[k]; else process.env[k] = value;
  } });
  t.mock.method(console, 'info', () => {});
  t.mock.method(console, 'warn', () => {});
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    calls.push(JSON.parse(options.body));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Четыре.' } }] });
  });
  return calls;
}
async function ask(body) {
  let result;
  await handler({ method: 'POST', body }, {
    status(code) { assert.equal(code, 200); return this; },
    json(value) { result = value; return value; }, setHeader() {}
  });
  return result;
}
function checkAudio(result, sound) {
  assert.equal(result.response.text, sound.text);
  assert.equal(result.response.tts, '<speaker audio="dialogs-upload/' + skill + '/' + sound.id + '.opus">');
  assert.equal(result.response.end_session, false);
  assert.equal(result.version, '1.0');
  assert.deepEqual(result.session_state.history, []);
  assert.ok(Buffer.byteLength(JSON.stringify(result.session_state), 'utf8') <= 1024);
}

test('new launches can play each built-in recording without environment setup without calling a model', async t => {
  const calls = fixture(t);
  const random = t.mock.method(Math, 'random', () => 0);
  for (const [index, point] of [0, 0.5, 0.999999].entries()) {
    random.mock.mockImplementation(() => point);
    checkAudio(await ask(launch()), sounds[index]);
  }
  assert.equal(calls.length, 0);
});

test('an empty command remains a launch even when the activation phrase is present', async t => {
  const calls = fixture(t);
  t.mock.method(Math, 'random', () => 0);
  checkAudio(await ask(launch({}, { original_utterance: 'Алиса, включи навык Супер Гений' })), sounds[0]);
  assert.equal(calls.length, 0);
});

test('launch with a question skips audio and answers the actual question', async t => {
  const calls = fixture(t);
  const result = await ask(launch({}, { command: 'Сколько будет два плюс два?', original_utterance: 'Алиса, спроси у Супер Гения, сколько будет два плюс два?' }));
  assert.equal(result.response.text, 'Четыре.');
  assert.equal(result.response.tts, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].messages.at(-1).content, 'Сколько будет два плюс два?');
  assert.deepEqual(calls[0].plugins, []);
  assert.equal(result.session_state.history.length, 2);
});

test('missing command still falls back to the supplied question', async t => {
  const calls = fixture(t);
  const body = launch();
  body.request = { original_utterance: 'Сколько будет два плюс два?' };
  assert.equal((await ask(body)).response.text, 'Четыре.');
  assert.equal(calls.length, 1);
});

test('an empty turn inside an existing session does not replay the recording', async t => {
  const calls = fixture(t);
  const body = launch({ new: false });
  body.state = { session: { history: [{ role: 'user', text: 'Вопрос.' }, { role: 'model', text: 'Ответ.' }] } };
  const result = await ask(body);
  assert.equal(result.response.tts, undefined);
  assert.match(result.response.text, /Привет/);
  assert.deepEqual(result.session_state.history, body.state.session.history);
  assert.equal(calls.length, 0);
});

test('missing or invalid skill id never produces a broken audio reference', async t => {
  fixture(t);
  for (const id of [undefined, 'bad"><speaker audio="other']) {
    const result = await ask(launch({ skill_id: id }));
    assert.equal(result.response.tts, undefined);
    assert.match(result.response.text, /Привет/);
  }
});

test('audio greeting keeps a memory warning audible when identity is absent', async t => {
  fixture(t);
  const names = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  const old = Object.fromEntries(names.map(k => [k, process.env[k]]));
  t.after(() => { for (const k of names) {
    if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k];
  } });
  Object.assign(process.env, { MEMORY_BACKEND: 'supabase', SUPABASE_URL: 'https://artificial-project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_artificial-greeting-key' });
  t.mock.method(Math, 'random', () => 0);
  const result = await ask(launch());
  assert.equal(result.response.text, sounds[0].text + ' Память сейчас недоступна.');
  assert.ok(result.response.tts.endsWith(' Память сейчас недоступна.'));
});

function post(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { assert.equal(res.statusCode, 200); resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(2000, () => req.destroy(new Error('LOCAL_TEST_TIMEOUT')));
    req.end(JSON.stringify(body));
  });
}
test('local HTTP returns an audio launch then a normal answer and closes its server', { timeout: 5000 }, async t => {
  const calls = fixture(t);
  t.mock.method(Math, 'random', () => 0.5);
  const server = createLocalServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    checkAudio(await post(port, launch()), sounds[1]);
    const answer = await post(port, launch({}, { command: 'Сколько будет два плюс два?' }));
    assert.equal(answer.response.text, 'Четыре.');
    assert.equal(answer.response.tts, undefined);
    assert.equal(calls.length, 1);
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
  assert.equal(server.listening, false);
});