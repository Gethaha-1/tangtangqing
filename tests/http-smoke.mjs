// Production Next.js + real PostgreSQL. Auth is an HTTPS protocol fixture,
// NOT a Supabase cloud deployment. All listeners bind only to 127.0.0.1.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { startTestPostgres, vacantPort } from './helpers/postgres.mjs';

const directory = await mkdtemp(join(tmpdir(), 'ttq-http-test-'));
let database, authServer, app;
const logs = [];
try {
  database = await startTestPostgres();
  const keyFile = join(directory, 'key.pem'), certFile = join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  const password = randomBytes(24).toString('hex');
  const signingKey = randomBytes(32);
  const users = ['a','b'].map(id => ({ id: randomUUID(), aud: 'authenticated', role: 'authenticated', email: `test-${id}@example.com`, email_confirmed_at: new Date().toISOString(), user_metadata: { display_name: `测试${id}` }, app_metadata: {}, created_at: new Date().toISOString() }));
  const tokens = new Map(), refreshTokens = new Map();
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  function session(user) {
    const payload = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user.id, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now()/1000)+3600, iat: Math.floor(Date.now()/1000), session_id: randomUUID() })}`;
    const access_token = payload+'.'+createHmac('sha256',signingKey).update(payload).digest('base64url');
    const refresh_token = randomUUID(); tokens.set(access_token,user); refreshTokens.set(refresh_token,user);
    return { access_token, refresh_token, expires_in: 3600, token_type: 'bearer', user };
  }
  authServer = createServer({ key: await readFile(keyFile), cert: await readFile(certFile) }, async (req,res) => {
    const url = new URL(req.url,'https://localhost');
    const reply = (status,body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/auth/v1/token') {
      const chunks=[]; for await (const chunk of req) chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks).toString());
      const user=url.searchParams.get('grant_type')==='refresh_token' ? refreshTokens.get(body.refresh_token) : users.find(user=>user.email===body.email && body.password===password);
      return user ? reply(200,session(user)) : reply(400,{code:'invalid_credentials',msg:'Invalid login credentials'});
    }
    const token=(req.headers.authorization??'').replace(/^Bearer /,'');
    if (url.pathname==='/auth/v1/user') return tokens.has(token) ? reply(200,tokens.get(token)) : reply(401,{code:'bad_jwt',msg:'invalid token'});
    if (url.pathname==='/auth/v1/logout') { tokens.delete(token); res.writeHead(204); return res.end(); }
    reply(404,{error:'not found'});
  });
  await new Promise(resolve=>authServer.listen(0,'127.0.0.1',resolve));
  const port=await vacantPort(), origin=`http://127.0.0.1:${port}`;
  app=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{cwd:process.cwd(),env:{...process.env,NETLIFY:'false',NODE_ENV:'production',NODE_EXTRA_CA_CERTS:certFile,NEXT_TELEMETRY_DISABLED:'1',TTQ_AUTH_MODE:'supabase',TTQ_DATABASE_MODE:'postgres',TTQ_SUPABASE_URL:`https://127.0.0.1:${authServer.address().port}`,TTQ_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_https_protocol_fixture',TTQ_INTERNAL_AUTH_SECRET:randomBytes(32).toString('hex'),TTQ_DATABASE_URL:database.databaseUrl,TTQ_ALLOWED_ORIGINS:origin},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Next.js startup timed out')),20000);
    for(const stream of [app.stdout,app.stderr]) stream.on('data',chunk=>{const text=String(chunk);logs.push(text);if(text.includes('Ready')){clearTimeout(timer);resolve();}});
    app.once('exit',code=>{clearTimeout(timer);reject(new Error(`Next.js exited ${code}`));});
  });
  const info=await fetch(origin+'/api/deployment-info'); assert.equal(info.status,200); assert.equal((await info.json()).deployment,'netlify-supabase');
  const page=await fetch(origin); assert.equal(page.status,200); assert.match(await page.text(),/login-email/);
  assert.equal((await fetch(origin+'/ledger',{redirect:'manual'})).status,307);
  function browser() {
    const jar=new Map();
    return async (path,body,extra={})=>{
      const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',redirect:'manual',headers:{origin,'content-type':'application/json','x-ttq-request':'ledger-v1',cookie:Array.from(jar,([k,v])=>`${k}=${v}`).join('; '),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
      for(const cookie of response.headers.getSetCookie()){const [pair]=cookie.split(';');const at=pair.indexOf('=');jar.set(pair.slice(0,at),pair.slice(at+1));}
      const text=await response.text();return {status:response.status,headers:response.headers,payload:response.headers.get('content-type')?.includes('application/json')?JSON.parse(text):text};
    };
  }
  const a=browser(),b=browser();
  assert.equal((await a('/auth/supabase/signin',{email:users[0].email,password:'wrong'})).status,401);
  assert.equal((await a('/auth/supabase/signin',{email:users[0].email,password})).status,200);
  assert.equal((await b('/auth/supabase/signin',{email:users[1].email,password})).status,200);
  const ledger=await a('/ledger'); assert.equal(ledger.status,200); assert.match(ledger.payload,/\/ledger\/auth-client.js/);
  assert.equal((await a('/ledger/auth-client.js')).status,200);
  const a0=await a('/api/bootstrap',{}),b0=await b('/api/bootstrap',{});
  assert.equal(a0.status,200);assert.equal(b0.status,200);assert.notEqual(a0.payload.fleet.id,b0.payload.fleet.id);
  const batch={operationId:randomUUID(),finalize:true,operations:[{op:'put',type:'vehicle',id:'http-v1',expectedVersion:0,data:{id:'http-v1',name:'HTTP测试车',active:true,plateNo:'',sortOrder:0}}]};
  const saved=await a('/api/sync',batch);assert.equal(saved.status,200,JSON.stringify(saved.payload));
  assert.equal((await a('/api/sync',batch)).payload.replayed,true);
  assert.equal((await a('/api/bootstrap',{})).payload.records.filter(row=>row.type==='vehicle').length,1);
  assert.equal((await b('/api/bootstrap',{})).payload.records.filter(row=>row.type==='vehicle').length,0);
  assert.equal((await a('/api/sync',{...batch,operationId:randomUUID()},{origin:'https://attacker.example'})).status,403);
  assert.equal((await a('/auth/logout',{})).status,200);
  assert.equal((await a('/api/bootstrap',{})).status,401);
  const attacker=browser();assert.equal((await attacker('/api/bootstrap',{}, {'x-ttq-auth-mode':'supabase','x-ttq-auth-issuer':'supabase','x-ttq-auth-subject':users[0].id})).status,401);
  console.log('HTTP smoke PASS: production Next.js, two-account login, protected ledger, PostgreSQL save/replay/readback, isolation, CSRF, logout, forged-header rejection.');
  console.log('Auth used an HTTPS protocol fixture, not live Supabase. Temporary database and listeners are removed.');
} catch(error) {
  console.error(logs.slice(-12).join(''));throw error;
} finally {
  if(app && app.exitCode===null){app.kill('SIGTERM');await new Promise(resolve=>{app.once('exit',resolve);setTimeout(()=>{app.kill('SIGKILL');resolve();},5000).unref();});}
  if(authServer) await new Promise(resolve=>authServer.close(resolve));
  await database?.stop();await rm(directory,{recursive:true,force:true});
}
