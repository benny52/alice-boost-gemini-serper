import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/index.js';

const oldPair = [{role:'user',text:'Моего кота зовут Барсик.'},{role:'model',text:'Запомнил.'}];
function completion(text='Хорошо.', searched=false) {
  return Response.json({choices:[{finish_reason:'stop',message:{content:text,
    annotations:searched ? [{type:'url_citation',url_citation:{url:'https://example.com/weather',content:'Искусственный прогноз.'}}] : []
  }}]});
}
function fixture(t, options={}) {
  const names = ['MEMORY_BACKEND','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','LLM_BACKEND','OPENROUTER_API_KEY','GEMINI_API_KEY'];
  const original = Object.fromEntries(names.map(k=>[k,process.env[k]]));
  Object.assign(process.env,{MEMORY_BACKEND:'supabase',SUPABASE_URL:'https://artificial-project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY:'sb_secret_artificial-test-key',LLM_BACKEND:'openrouter',OPENROUTER_API_KEY:'artificial-model-key',GEMINI_API_KEY:'artificial-gemini-key'});
  t.after(()=>{for(const k of names) {if(original[k]===undefined) delete process.env[k];else process.env[k]=original[k];}});
  const rows = new Map(), calls=[], logs=[];
  t.mock.method(console,'info',(...a)=>logs.push(a));
  t.mock.method(console,'warn',(...a)=>logs.push(a));
  const answer = options.answer || (()=>'Хорошо.');
  t.mock.method(globalThis,'fetch', async (url, init={})=>{
    const u = new URL(url), body=init.body ? JSON.parse(init.body) : undefined;
    const call={url:u,method:init.method || 'GET',body,headers:init.headers,signal:init.signal,redirect:init.redirect};
    calls.push(call);
    if(u.hostname === 'openrouter.ai') {
      if(options.model) return options.model(call);
      return completion(answer(call),Boolean(body.plugins?.length));
    }
    if(u.hostname === 'generativelanguage.googleapis.com') return Response.json({candidates:[{content:{parts:[{text:'Хорошо.'}]},finishReason:'STOP'}]});
    assert.equal(u.origin,'https://artificial-project.supabase.co');
    assert.equal(u.pathname,'/rest/v1/alice_memory');
    assert.equal(init.headers.apikey,'sb_secret_artificial-test-key');
    assert.equal(init.headers.Authorization,undefined);
    assert.equal(init.redirect,'error');
    if(options.db) {
      const overridden = await options.db(call, rows);
      if(overridden !== undefined) return overridden;
    }
    const id = call.method === 'POST' ? body.conversation_id : u.searchParams.get('conversation_id')?.replace(/^eq\./,'');
    assert.match(id,/^[a-f0-9]{64}$/);
    if(call.method === 'GET') return Response.json(rows.has(id) ? [structuredClone(rows.get(id))] : []);
    assert.match(init.headers.Prefer,/return=representation/);
    if(call.method === 'POST') {
      if(rows.has(id)) return new Response('private-db-error',{status:409});
      rows.set(id,structuredClone(body));
    } else {
      assert.equal(call.method,'PATCH');
      const revision = Number(u.searchParams.get('revision')?.replace(/^eq\./,''));
      if(rows.get(id)?.revision !== revision) return Response.json([]);
      rows.set(id,{...rows.get(id),...structuredClone(body)});
    }
    return Response.json([{revision:rows.get(id).revision}]);
  });
  return {rows,calls,logs,modelCalls:()=>calls.filter(c=>c.url.hostname==='openrouter.ai'),dbCalls:()=>calls.filter(c=>c.url.hostname.endsWith('.supabase.co'))};
}
async function ask(text, {user='user-one',app='app-one',skill='skill-one',state={},isNew=false}={}) {
  let result;
  await handler({method:'POST',body:{version:'1.0',request:{command:text},
    session:{new:isNew,skill_id:skill,...(user?{user:{user_id:user}}:{}),...(app?{application:{application_id:app}}:{})},
    state:{session:state}}},{
      status(code){assert.equal(code,200);return this;},json(body){result=body;return body;},setHeader(){}
    });
  assert.ok(Buffer.byteLength(JSON.stringify(result.session_state))<=1024);
  return result;
}
const pendingBody = signal => ({ok:true,status:200,json:()=>new Promise((_,reject)=>{
  if(signal.aborted) return reject(signal.reason);
  signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
})});

test('persistent conversation survives a new Alice session without Yandex state',async t=>{
  const f=fixture(t,{answer:call=>call.body.messages.some(m=>m.role==='user'&&m.content.includes('Барсик')) ? 'Барсик.' : 'Не знаю.'});
  await ask(oldPair[0].text);
  const result=await ask('Как зовут моего кота?',{isNew:true});
  assert.equal(result.response.text,'Барсик.');
  assert.equal(f.rows.size,1);
  assert.equal([...f.rows.values()][0].history.length,4);
  assert.equal(f.dbCalls().length,4);
  assert.doesNotMatch(JSON.stringify(f.logs),/Барсик|user-one|app-one|skill-one|artificial.*key/);
});
test('database keeps four full pairs while Alice state stays below one KiB',async t=>{
  const f=fixture(t,{answer:()=>('Длинный русский ответ. ').repeat(20)});
  for(let n=1;n<=5;n++) await ask('Реплика номер '+n+'. '+('Подробность. ').repeat(25));
  const row=[...f.rows.values()][0];
  assert.equal(row.history.length,8);
  assert.match(row.history[0].text,/номер 2/);
  assert.ok(Buffer.byteLength(JSON.stringify(row.history))>1024);
  await ask('Продолжи');
  const messages=f.modelCalls().at(-1).body.messages;
  assert.equal(messages.filter(m=>m.role==='assistant').length,4);
  assert.ok(messages.some(m=>m.content===row.history[0].text));
});
test('skill and user identity separate histories; application is the anonymous fallback',async t=>{
  const f=fixture(t);
  await ask('Первый',{user:'first',app:'same'});
  await ask('Второй',{user:'second',app:'same'});
  await ask('Третий',{user:'first',skill:'other'});
  await ask('Четвёртый',{user:null,app:'first'});
  await ask('Пятый',{user:null,app:'second'});
  assert.equal(f.rows.size,5);
  for(const call of f.modelCalls()) assert.equal(call.body.messages.length,2);
  const noIdentity=await ask('Привет',{user:null,app:null});
  assert.equal(f.rows.size,5);
  assert.equal(f.dbCalls().length,10);
  assert.match(noIdentity.response.text,/памят/);
});
test('stored search context carries the city into a follow-up without session state',async t=>{
  const f=fixture(t,{answer:()=>'В Казани ясно.'});
  await ask('Найди погоду в Казани сегодня');
  await ask('А завтра?',{isNew:true});
  const next=f.modelCalls().at(-1).body;
  assert.equal(next.plugins[0].engine,'exa');
  assert.match(next.messages.at(-1).content,/Казан/i);
  assert.match(next.messages.at(-1).content,/завтра/i);
});
for(const command of ['Забудь всё','Забудь разговор','Начнём сначала']) {
  test('clear persists an empty revision and does not call the model: '+command,async t=>{
    const f=fixture(t);
    const old=await ask(oldPair[0].text);
    const before=[...f.rows.values()][0].revision;
    const cleared=await ask(command);
    assert.match(cleared.response.text,/новый разговор|очищ/);
    assert.deepEqual(cleared.session_state.history,[]);
    assert.equal(f.modelCalls().length,1);
    const row=[...f.rows.values()][0];
    assert.deepEqual(row.history,[]);
    assert.deepEqual(row.search,{});
    assert.ok(row.revision>before);
    await ask('Как зовут кота?',{isNew:true,state:old.session_state});
    assert.ok(!f.modelCalls().at(-1).body.messages.some(m=>m.content.includes('Барсик')));
  });
}
test('an empty persistent record never imports stale Yandex history',async t=>{
  const f=fixture(t);
  await ask('Продолжи',{state:{history:oldPair}});
  assert.ok(!f.modelCalls()[0].body.messages.some(m=>m.content.includes('Барсик')));
});
test('clearing a missing record creates a tombstone to reject an older insertion',async t=>{
  const f=fixture(t);
  await ask('забудь все');
  assert.equal(f.rows.size,1);
  assert.deepEqual([...f.rows.values()][0].history,[]);
  assert.equal(f.modelCalls().length,0);
});
test('model failure leaves persistent history unchanged',async t=>{
  let failing=false;
  const f=fixture(t,{model:()=>failing?new Response('private-model-error',{status:429}):completion()});
  await ask(oldPair[0].text);
  const snapshot=structuredClone([...f.rows.values()][0]);
  failing=true;
  await ask('Продолжи');
  assert.deepEqual([...f.rows.values()][0],snapshot);
  assert.equal(f.dbCalls().filter(c=>c.method!=='GET').length,1);
});
test('database read failure may answer from session state but never overwrites the database',async t=>{
  const f=fixture(t,{db:call=>call.method==='GET'?new Response('private-db-error',{status:503}):undefined});
  const result=await ask('Продолжи',{state:{history:oldPair}});
  assert.match(result.response.text,/памят/);
  assert.equal(f.dbCalls().length,1);
  assert.equal(f.modelCalls().length,1);
  assert.ok(f.modelCalls()[0].body.messages.some(m=>m.content.includes('Барсик')));
  assert.doesNotMatch(JSON.stringify(f.logs),/private-db-error|sb_secret/);
});
test('database read body timeout is cancelled and the answer still returns', {timeout:2000},async t=>{
  let signal;
  const f=fixture(t,{db:call=>{if(call.method==='GET'){signal=call.signal;return pendingBody(signal);}}});
  const result=await ask('Привет');
  assert.equal(signal.aborted,true);
  assert.match(result.response.text,/памят/);
  assert.equal(f.modelCalls().length,1);
  assert.equal(f.dbCalls().length,1);
});
test('write timeout returns an answer without falsely confirming persistence', {timeout:2000},async t=>{
  let signal;
  const f=fixture(t,{db:call=>{if(call.method!=='GET'){signal=call.signal;return pendingBody(signal);}}});
  const result=await ask('Привет');
  assert.equal(signal.aborted,true);
  assert.match(result.response.text,/Хорошо/);
  assert.match(result.response.text,/памят/);
  assert.deepEqual(result.session_state.history,[]);
  assert.equal(f.dbCalls().length,2);
});
test('a concurrent revision cannot be overwritten by the stale model answer',async t=>{
  let conflict=false;
  const f=fixture(t,{db:(call,rows)=>{
    if(conflict&&call.method==='PATCH') {
      const row=[...rows.values()][0];row.revision++;row.history=structuredClone(oldPair);
    }
  }});
  await ask('Привет');
  conflict=true;
  const result=await ask('Продолжи');
  assert.match(result.response.text,/памят/);
  assert.deepEqual([...f.rows.values()][0].history,oldPair);
  assert.equal(f.dbCalls().filter(c=>c.method==='PATCH').length,1);
});
test('a failed clear does not claim success or call the model',async t=>{
  let fail=false;
  const f=fixture(t,{db:call=>fail&&call.method!=='GET'?new Response('private-db-error',{status:503}):undefined});
  await ask('Привет');
  const row=structuredClone([...f.rows.values()][0]);
  fail=true;
  const result=await ask('забудь всё');
  assert.match(result.response.text,/Не удалось.*очист/);
  assert.deepEqual([...f.rows.values()][0],row);
  assert.equal(f.modelCalls().length,1);
});
test('malformed database data is not treated as an empty history to overwrite',async t=>{
  const f=fixture(t,{db:call=>call.method==='GET'?Response.json([{history:'broken',search:{},revision:1}]):undefined});
  const result=await ask('Привет');
  assert.match(result.response.text,/памят/);
  assert.equal(f.dbCalls().length,1);
});
for(const invalid of ['missing-key','unsafe-url','unknown-mode']) {
  test('invalid explicit memory configuration stops before external calls: '+invalid,async t=>{
    const f=fixture(t);
    if(invalid==='missing-key') delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    if(invalid==='unsafe-url') process.env.SUPABASE_URL='https://unrelated.example';
    if(invalid==='unknown-mode') process.env.MEMORY_BACKEND='typo';
    const result=await ask('Привет');
    assert.equal(f.calls.length,0);
    assert.match(result.response.text,/настро/);
  });
}
test('session mode preserves the original no-database behavior',async t=>{
  const f=fixture(t);
  process.env.MEMORY_BACKEND='session';
  const result=await ask('Продолжи',{state:{history:oldPair}});
  assert.equal(f.dbCalls().length,0);
  assert.doesNotMatch(result.response.text,/памят/);
  assert.ok(f.modelCalls()[0].body.messages.some(m=>m.content.includes('Барсик')));
});
test('a long answer keeps the persistence warning inside the Alice text limit',async t=>{
  const f=fixture(t,{answer:()=>('Длинный русский ответ. ').repeat(100),
    db:call=>call.method!=='GET'?new Response('unavailable',{status:503}):undefined});
  const result=await ask('Продолжи');
  assert.ok(result.response.text.length<=1024);
  assert.match(result.response.text,/памят/);
  assert.deepEqual(result.session_state.history,[]);
});

test('model time excludes the pending memory write and final response reserve',async t=>{
  let elapsed=0;
  const base=Date.now();
  t.mock.method(Date,'now',()=>base+elapsed);
  const f=fixture(t,{
    db:call=>{
      if(call.method==='GET') elapsed+=300;
      else return pendingBody(call.signal);
    },
    model:()=>{elapsed+=2700;return completion();}
  });
  const result=await ask('Продолжи');
  const diagnostics=f.logs.filter(x=>x[0]==='UPSTREAM_REQUEST').map(x=>JSON.parse(x[1]));
  assert.equal(diagnostics.find(x=>x.service==='openrouter').timeout_ms,2750);
  const write=diagnostics.filter(x=>x.service==='supabase').at(-1);
  assert.equal(write.timeout_ms,350);
  assert.equal(write.outcome,'timeout');
  assert.match(result.response.text,/памят/);
});

for(const existing of [false,true]) {
  test('an answer started before clear cannot restore history, existing row: '+existing,async t=>{
    let waiting=false, release, entered;
    const started=new Promise(resolve=>{entered=resolve;});
    const f=fixture(t,{model:async ()=>{
      if(waiting) {
        entered();
        await new Promise(resolve=>{release=resolve;});
      }
      return completion();
    }});
    if(existing) await ask('Предыдущий разговор');
    waiting=true;
    const pending=ask('Моего кота зовут Барсик.');
    await started;
    await ask('Забудь всё');
    release();
    const result=await pending;
    const row=[...f.rows.values()][0];
    assert.deepEqual(row.history,[]);
    assert.deepEqual(row.search,{});
    assert.match(result.response.text,/памят/);
  });
}

test('greeting restores history without a model request',async t=>{
  const f=fixture(t);
  await ask(oldPair[0].text);
  const result=await ask('',{isNew:true});
  assert.equal(f.modelCalls().length,1);
  assert.match(JSON.stringify(result.session_state),/Барсик/);
});

test('legacy service role JWT uses the bearer header; anon JWT is rejected',async t=>{
  fixture(t);
  const jwtRole=role=>'header.'+Buffer.from(JSON.stringify({role})).toString('base64url')+'.signature';
  const {memoryConfig}=await import('../lib/memory.js');
  process.env.SUPABASE_SERVICE_ROLE_KEY=jwtRole('service_role');
  const config=memoryConfig();
  assert.equal(config.headers.Authorization,'Bearer '+config.headers.apikey);
  process.env.SUPABASE_SERVICE_ROLE_KEY=jwtRole('anon');
  assert.throws(()=>memoryConfig(),/MEMORY_CONFIG/);
});

test('Gemini receives the persisted conversation too',async t=>{
  const f=fixture(t);
  process.env.LLM_BACKEND='gemini';
  await ask(oldPair[0].text);
  await ask('Как зовут моего кота?',{isNew:true});
  const requests=f.calls.filter(c=>c.url.hostname==='generativelanguage.googleapis.com');
  assert.equal(requests.length,2);
  assert.ok(requests[1].body.contents.some(m=>m.parts.some(p=>p.text.includes('Барсик'))));
  assert.equal([...f.rows.values()][0].history.length,4);
});

test('local HTTP restores, isolates and clears history without paid services', {timeout:7000},async t=>{
  fixture(t,{answer:call=>call.body.messages.some(m=>m.role==='user'&&m.content.includes('Барсик')) ? 'Барсик.' : 'Не знаю.'});
  const {createLocalServer}=await import('../server.mjs');
  const http=await import('node:http');
  const server=createLocalServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const post=(command,user='http-artificial-user')=>new Promise((resolve,reject)=>{
    const payload=JSON.stringify({version:'1.0',request:{command},session:{new:true,skill_id:'http-artificial-skill',user:{user_id:user}}});
    const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/api',method:'POST',
      headers:{'content-type':'application/json','content-length':Buffer.byteLength(payload)}},res=>{
      let raw='';
      res.setEncoding('utf8');
      res.on('data',chunk=>{raw+=chunk;});
      res.on('error',reject);
      res.on('end',()=>{
        try {assert.equal(res.statusCode,200);resolve(JSON.parse(raw));} catch(error){reject(error);}
      });
    });
    req.setTimeout(5000,()=>req.destroy(new Error('LOCAL_SMOKE_TIMEOUT')));
    req.on('error',reject);
    req.end(payload);
  });
  try {
    await post('Моего кота зовут Барсик.');
    assert.equal((await post('Как зовут моего кота?')).response.text,'Барсик.');
    assert.equal((await post('Как зовут моего кота?','http-other-user')).response.text,'Не знаю.');
    assert.match((await post('Забудь всё')).response.text,/новый разговор/);
    assert.equal((await post('Как зовут моего кота?')).response.text,'Не знаю.');
  } finally {
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  }
  assert.equal(server.listening,false);
});
