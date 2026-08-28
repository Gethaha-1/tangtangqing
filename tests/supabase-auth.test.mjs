import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseCookieHeader } from '@supabase/ssr';
import { createSupabaseContext, principalFromSupabaseUser, supabaseConfiguration, verifiedSupabasePrincipal } from '../lib/server/supabase-auth.ts';
import { handleSupabaseAction } from '../lib/server/supabase-actions.ts';

const env = { TTQ_SUPABASE_URL: 'https://ttq-test.supabase.co', TTQ_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_protocol_test_only', NODE_ENV: 'test' };
const user = { id: randomUUID(), aud: 'authenticated', role: 'authenticated', email: 'owner@example.com', email_confirmed_at: new Date().toISOString(), user_metadata: { display_name: '测试车主' }, app_metadata: {}, created_at: new Date().toISOString() };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user.id, exp: Math.floor(Date.now()/1000)+3600, role: 'authenticated' })}.protocol-test-only`;
const session = { access_token: token, refresh_token: 'refresh-test-only', expires_in: 3600, token_type: 'bearer', user };
function request(path = '/auth/supabase/signin', body = { email: user.email, password: 'test-password-only' }, headers = {}) {
  return new Request(`https://ledger.example${path}`, { method: 'POST', headers: { origin: 'https://ledger.example', 'content-type': 'application/json', 'x-ttq-request': 'ledger-v1', ...headers }, body: JSON.stringify(body) });
}
function transport(calls) {
  return async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname === '/auth/v1/token') return Response.json(session);
    if (url.pathname === '/auth/v1/user') {
      const bearer = new Headers(options.headers).get('authorization');
      return bearer === `Bearer ${token}` ? Response.json(user) : Response.json({ code: 'bad_jwt', msg: 'invalid token' }, { status: 401 });
    }
    if (url.pathname === '/auth/v1/logout') return new Response(null, { status: 204 });
    throw new Error(`Unexpected Auth API path: ${url.pathname}`);
  };
}
function responseCookieHeader(response) {
  return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
}

test('Supabase config refuses service-role keys and insecure remote endpoints', () => {
  assert.throws(() => supabaseConfiguration({ ...env, TTQ_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_forbidden' }), /管理密钥/);
  assert.throws(() => supabaseConfiguration({ ...env, TTQ_SUPABASE_URL: 'http://remote.example' }), /HTTPS/);
  assert.throws(() => supabaseConfiguration({ ...env, NODE_ENV: 'production', TTQ_SUPABASE_URL: 'http://127.0.0.1:9999' }), /HTTPS/);
});

test('Supabase verified profile cannot choose business identity and unverified users are refused', () => {
  const principal = principalFromSupabaseUser({ ...user, user_metadata: { display_name: '车主', role: 'owner', fleetId: 'attacker' } });
  assert.equal(principal.subject, user.id);
  assert.equal(principal.issuer, 'supabase');
  assert.equal('fleetId' in principal, false);
  assert.equal(principalFromSupabaseUser({ ...user, email_confirmed_at: null }), null);
  assert.equal(principalFromSupabaseUser({ ...user, is_anonymous: true }), null);
  assert.equal(principalFromSupabaseUser({ ...user, id: 'forged\r\nheader' }), null);
});

test('official SSR SDK: login cookies stay HttpOnly, user must be checked with Auth server', async () => {
  const calls = [];
  const context = createSupabaseContext(request(), env, transport(calls));
  await context.client.auth.signInWithPassword({ email: user.email, password: 'test-password-only' });
  const response = context.applyCookies(Response.json({ ok: true }));
  assert.ok(response.headers.getSetCookie().length);
  for (const cookie of response.headers.getSetCookie()) {
    assert.match(cookie, /HttpOnly/i); assert.match(cookie, /Secure/i); assert.match(cookie, /SameSite=Lax/i);
  }
  assert.match(response.headers.get('cache-control'), /no-store/);
  const cookie = responseCookieHeader(response);
  const restored = createSupabaseContext(request('/api/bootstrap', {}, { cookie }), env, transport(calls));
  assert.equal((await verifiedSupabasePrincipal(restored)).subject, user.id);
  assert.ok(calls.includes('/auth/v1/user'));
  const forged = createSupabaseContext(request('/api/bootstrap', {}, { 'x-ttq-auth-subject': user.id }), env, transport(calls));
  assert.equal(await verifiedSupabasePrincipal(forged), null);
});

test('official SSR SDK: forged session cookie cannot authenticate from embedded user metadata', async () => {
  const context = createSupabaseContext(request(), env, transport([]));
  await context.client.auth.signInWithPassword({ email: user.email, password: 'test-password-only' });
  const cookie = responseCookieHeader(context.applyCookies(Response.json({})));
  const parsed = parseCookieHeader(cookie);
  const mutated = parsed.map(({ name, value }) => {
    if (value.startsWith('base64-')) {
      const data = JSON.parse(Buffer.from(value.slice(7), 'base64url'));
      data.access_token = token.replace('protocol-test-only', 'forged');
      return `${name}=${encodeURIComponent('base64-'+encode(data))}`;
    }
    return `${name}=${value}`;
  }).join('; ');
  assert.equal(await verifiedSupabasePrincipal(createSupabaseContext(request('/api/bootstrap', {}, { cookie: mutated }), env, transport([]))), null);
});

test('signin route rejects CSRF before any Supabase request and never returns tokens in JSON', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, env, { TTQ_AUTH_MODE: 'supabase' });
  try {
    const calls = [];
    assert.equal((await handleSupabaseAction(request(undefined, undefined, { origin: 'https://attacker.example' }), 'signin', transport(calls))).status, 403);
    assert.equal(calls.length, 0);
    const response = await handleSupabaseAction(request(), 'signin', transport(calls));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { location: '/ledger' });
    const logout = await handleSupabaseAction(request('/auth/logout', {}, { cookie: responseCookieHeader(response) }), 'signout', transport(calls));
    assert.equal(logout.status, 200);
    assert.ok(logout.headers.getSetCookie().some(cookie => /Max-Age=0/i.test(cookie)));
  } finally {
    for (const key of Object.keys(env).concat('TTQ_AUTH_MODE')) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});

test('expired SSR cookies are refreshed and returned to the caller without caching', async () => {
  const calls=[];
  const initial=createSupabaseContext(request(),env,transport(calls));
  await initial.client.auth.signInWithPassword({email:user.email,password:'test-only'});
  const expired=parseCookieHeader(responseCookieHeader(initial.applyCookies(Response.json({})))).map(({name,value})=>{
    const data=JSON.parse(Buffer.from(value.slice(7),'base64url'));
    data.expires_at=1;
    return `${name}=${encodeURIComponent('base64-'+encode(data))}`;
  }).join('; ');
  const refreshed=createSupabaseContext(request('/api/bootstrap',{}, {cookie:expired}),env,transport(calls));
  assert.equal((await verifiedSupabasePrincipal(refreshed)).subject,user.id);
  assert.ok(refreshed.applyCookies(Response.json({})).headers.getSetCookie().length);
  assert.ok(calls.filter(path=>path==='/auth/v1/token').length>=2);
});

test('Auth server failure cannot fall back to an unverified cookie user', async () => {
  const initial=createSupabaseContext(request(),env,transport([]));
  await initial.client.auth.signInWithPassword({email:user.email,password:'test-only'});
  const cookie=responseCookieHeader(initial.applyCookies(Response.json({})));
  const offline=createSupabaseContext(request('/api/bootstrap',{}, {cookie}),env,async()=>Response.json({msg:'unavailable'},{status:503}));
  await assert.rejects(verifiedSupabasePrincipal(offline), error=>error.code==='auth_mode_unavailable');
});
