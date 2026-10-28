// Owns session lifecycle and rejection recovery. Native cookie transport is
// checked separately with native-auth-server.mjs in the iOS simulator.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const appOrigin = process.env.INBOX_TEST_ORIGIN ?? 'http://localhost:19069';
try {
  for (const expired of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    let rejectDevices = false;
    let sessionReads = 0;
    await page.route('http://localhost:3000/**', route => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      const reply = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: {
        'access-control-allow-origin': appOrigin,
        'access-control-allow-credentials': 'true',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      }, body: JSON.stringify(data) });
      if (req.method() === 'OPTIONS') return reply({});
      if (path === '/api/auth/get-session') {
        sessionReads++;
        return reply(expired && rejectDevices ? null : {
          user: { id: 'session_fixture', name: 'Session test agent', email: 'agent@example.test' },
          session: { id: 'fixture', token: 'synthetic', expiresAt: '2030-01-01T00:00:00Z' },
        });
      }
      if (path === '/api/auth/config') return reply({ google: true, emailLink: true });
      if (path === '/api/inbox-mobile/projects') return reply({ data: { items: [], nextCursor: null } });
      if (path === '/api/inbox-mobile/devices') {
        rejectDevices = true;
        return reply({ error: { message: 'Request rejected by fixture' } }, 401);
      }
      if (path === '/api/inbox-mobile/diagnostics') return reply({ data: { id: req.postDataJSON().id, status: 'saved' } });
      throw new Error(`Unexpected fixture route ${path}`);
    });
    await page.goto(appOrigin);
    await page.getByRole('heading', { name: 'Workspaces', exact: true }).waitFor();
    const before = sessionReads;
    const verified = page.waitForResponse(response => response.url().includes('/api/auth/get-session'));
    await page.getByRole('button', { name: 'Your account', exact: true }).click();
    await verified;
    if (expired) {
      await page.getByRole('button', { name: 'Continue with Google', exact: true }).waitFor();
      await page.getByText('Your session ended. Sign in again to continue. Your queued replies are still saved on this device.', { exact: true }).waitFor();
    } else {
      // Wait for the challenged session check to finish, rather than asserting
      // the account before the rejected request has had a chance to sign it out.
      await page.getByRole('heading', { name: 'Session test agent', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Continue with Google', exact: true }).count(), 0);
    }
    assert(sessionReads > before, 'An API rejection must recheck the current session');
    await context.close();
  }
  console.log('PASS API 401 keeps a valid login; confirmed expiry returns to login with a recovery message.');
} finally { await browser.close(); }
