// Manual native transport/lifecycle regression fixture. No Google credentials.
// Run with: node apps/inbox/tests/native-auth-server.mjs
// Point Metro's EXPO_PUBLIC_API_URL at http://localhost:19072.
// POST /__scenario with {mode} to choose: success, redirect, api-401,
// missing-session, provider-error. GET /__events returns redacted receipts.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

let mode = 'success';
let callbackURL;
let errorCallbackURL;
let token;
const events = [];
const origin = 'http://localhost:19072';
const server = createServer(async (req, res) => {
  const url = new URL(req.url, origin);
  const path = url.pathname;
  const body = await Array.fromAsync(req).then(chunks => Buffer.concat(chunks).toString());
  const json = (data, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  const redirect = location => { res.writeHead(302, { location }); res.end(); };
  if (path === '/__scenario') {
    mode = JSON.parse(body).mode;
    token = undefined;
    events.length = 0;
    return json({ mode });
  }
  if (path === '/__events') return json(events);
  const authenticated = Boolean(token && req.headers.cookie?.includes(`better-auth.session_token=${token}`));
  const event = { path, host: req.headers.host, authenticated };
  events.push(event);
  console.log(JSON.stringify(event));
  if (mode === 'redirect' && req.headers.host.startsWith('localhost') && ['/api/auth/get-session', '/api/inbox-mobile/projects'].includes(path)) {
    res.writeHead(307, { location: `http://127.0.0.1:19072${req.url}` });
    return res.end();
  }
  if (path === '/api/auth/config') return json({ google: true, emailLink: true });
  if (path === '/api/auth/sign-in/social') {
    ({ callbackURL, errorCallbackURL } = JSON.parse(body));
    return json({ url: `${origin}/provider`, redirect: true });
  }
  if (path === '/api/auth/expo-authorization-proxy') return redirect(`${origin}/provider`);
  if (path === '/provider') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><h1>Local authentication fixture</h1><p>No Google account is used.</p><a href="/complete">Complete sign-in</a>');
  }
  if (path === '/complete') {
    const target = new URL(mode === 'provider-error' ? errorCallbackURL : callbackURL);
    if (mode === 'provider-error') target.searchParams.set('error', 'access_denied');
    else if (mode !== 'missing-session') {
      token = randomUUID();
      target.searchParams.set('cookie', `better-auth.session_token=${token}; Path=/; HttpOnly; Max-Age=3600`);
    }
    return redirect(target.toString());
  }
  if (path === '/api/auth/get-session') return json(authenticated ? {
    user: { id: 'native_auth_fixture', name: 'Native test agent', email: 'agent@example.test', emailVerified: true },
    session: { id: 'native_auth_session', userId: 'native_auth_fixture', token, expiresAt: new Date(Date.now() + 3600_000).toISOString() },
  } : null);
  if (path === '/api/auth/sign-out') { token = undefined; return json({ success: true }); }
  if (path === '/api/inbox-mobile/diagnostics') return json({ data: { id: JSON.parse(body).id, status: 'saved' } });
  if (path === '/api/inbox-mobile/devices') return authenticated || req.method === 'DELETE' ? json({ data: [] }) : json({ error: { message: 'Session rejected by fixture' } }, 401);
  if (path === '/api/inbox-mobile/projects') {
    if (!authenticated || mode === 'api-401') return json({ error: { message: 'Session rejected by fixture' } }, 401);
    return json({ data: { items: [{ id: 'native_fixture', name: 'Callback verified', organizationName: 'Local fixture' }], nextCursor: null } });
  }
  return json({ error: { message: 'Unhandled fixture route' } }, 404);
});
server.listen(19072, '0.0.0.0', () => console.log('Native auth fixture listening on port 19072'));
