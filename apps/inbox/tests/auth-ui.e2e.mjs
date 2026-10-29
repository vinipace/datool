// Owns the signed-out UI contract; ui.e2e.mjs owns the authenticated inbox.
// API responses are synthetic. This does not prove email delivery or OAuth completion.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const screenshots = fileURLToPath(new URL('../../../artifacts/inbox-mobile/login/', import.meta.url));
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let providers = { google: true, emailLink: true };
let configFails = false;
let configOffline = false;
let releaseConfig;
const configReady = new Promise(resolve => { releaseConfig = resolve; });
let releaseEmail;
let emailStarted;
let failEmail = true;
const emails = [];
const diagnostics = [];
await page.route('http://localhost:3000/**', async route => {
  const req = route.request();
  const path = new URL(req.url()).pathname;
  const respond = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: {
    'access-control-allow-origin': 'http://localhost:19069', 'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS',
  }, body: JSON.stringify(data) });
  if (req.method() === 'OPTIONS') return respond({});
  if (path === '/api/inbox-mobile/diagnostics') {
    const report = req.postDataJSON();
    assert.equal(req.headers().cookie, undefined);
    assert.equal(req.headers().authorization, undefined);
    diagnostics.push(report);
    return respond({ data: { id: report.id, status: 'saved' } });
  }
  if (path === '/api/auth/get-session') return respond(null);
  if (path === '/api/auth/config') {
    await configReady;
    if (configOffline) return route.abort('internetdisconnected');
    return configFails ? respond({ error: { message: 'Connection unavailable' } }, 503) : respond(providers);
  }
  if (path === '/api/auth/sign-in/magic-link') {
    emails.push(req.postDataJSON());
    await new Promise(resolve => { releaseEmail = resolve; emailStarted(); });
    return failEmail ? respond({ message: 'Email could not be sent. Try again.', code: 'SEND_FAILED' }, 503) : respond({ status: true });
  }
  if (path === '/api/auth/sign-in/social') return respond({ message: 'Google sign-in was interrupted. Please try again.', code: 'OAUTH_FAILED' }, 400);
  throw new Error(`Unexpected auth fixture request: ${path}`);
});
async function shot(name) {
  await page.screenshot({ path: screenshots + name + '.png' });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
}
const button = name => page.getByRole('button', { name, exact: true });
const email = () => page.getByRole('textbox', { name: 'Work email', exact: true });
async function startEmail(title) {
  const started = new Promise(resolve => { emailStarted = resolve; });
  await button(title).click();
  let timeout;
  try {
    await Promise.race([started, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('The sign-in action did not request an email')), 15000);
    })]);
  } finally { clearTimeout(timeout); }
}
try {
  await page.goto('http://localhost:19069');
  await page.getByText('Getting sign-in options…', { exact: true }).waitFor({ timeout: 30000 });
  await shot('loading'); releaseConfig();
  await button('Continue with email').waitFor();
  await page.waitForFunction(() => [...document.images].every(image => image.complete));
  await shot('welcome-phone');
  const diagnosticResponse = page.waitForResponse(response => response.url().endsWith('/api/inbox-mobile/diagnostics') && response.status() === 200);
  await button('Continue with Google').click();
  await page.getByText('Google sign-in was interrupted. Please try again.', { exact: true }).waitFor();
  await diagnosticResponse;
  assert(diagnostics.some(report => report.stage === 'google_sign_in' && report.code === 'OAUTH_FAILED' && report.httpStatus === 400));
  assert(!JSON.stringify(diagnostics).includes('Google sign-in was interrupted'));
  assert.equal(await button('Continue with email').isEnabled(), true);
  await shot('google-retry');
  await button('Continue with email').click();
  await email().waitFor(); await shot('email-phone');
  await button('Send sign-in link').click();
  await page.getByText('Enter a valid email address.', { exact: true }).waitFor();
  assert.equal(emails.length, 0);
  await email().fill('taylor@example.test');
  await startEmail('Send sign-in link');
  await button('Sending link…').waitFor();
  assert.equal(await email().isEditable(), false);
  assert.equal(await button('Back to sign in').isEnabled(), false);
  releaseEmail();
  await page.getByText('Email could not be sent. Try again.', { exact: true }).waitFor();
  assert.equal(await email().inputValue(), 'taylor@example.test');
  assert.equal(emails[0].email, 'taylor@example.test');
  assert.equal(new URL(emails[0].callbackURL).origin, 'http://localhost:19069');
  await shot('email-retry');
  failEmail = false;
  await startEmail('Send sign-in link');
  releaseEmail();
  await button('Use a different email').waitFor();
  await page.getByText('taylor@example.test', { exact: true }).waitFor();
  await shot('email-sent');
  await startEmail('Resend sign-in link');
  await button('Sending link…').waitFor();
  releaseEmail();
  await button('Resend sign-in link').waitFor();
  assert.equal(emails.length, 3);
  assert(emails.every(request => request.email === 'taylor@example.test'));
  await button('Use a different email').click();
  assert.equal(await email().inputValue(), 'taylor@example.test');
  await page.setViewportSize({ width: 320, height: 568 }); await shot('email-small-phone');
  await email().focus();
  await page.setViewportSize({ width: 320, height: 360 });
  await button('Send sign-in link').scrollIntoViewIfNeeded();
  const send = await button('Send sign-in link').boundingBox();
  assert(send.y >= 0 && send.y + send.height <= 360, 'Submit remains reachable with reduced viewport');
  await shot('email-reduced-viewport');
  await page.setViewportSize({ width: 320, height: 568 });
  await button('Back to sign in').click(); await button('Continue with email').waitFor(); await shot('welcome-small-phone');
  await page.setViewportSize({ width: 768, height: 1024 }); await shot('welcome-tablet');
  await page.setViewportSize({ width: 390, height: 844 });
  configFails = true; await page.reload();
  await button('Try again').waitFor(); await shot('connection-error');
  configFails = false; providers = { google: false, emailLink: true };
  await button('Try again').click(); await button('Continue with email').waitFor();
  assert.equal(await button('Continue with Google').count(), 0);
  providers = { google: false, emailLink: false }; await page.reload();
  await page.getByText('Sign-in isn’t available yet. Ask your Datool administrator to enable Google or email sign-in.', { exact: true }).waitFor();
  await shot('no-providers');
  assert.equal(await button('Continue with email').count(), 0);
  providers = { google: true, emailLink: true };
  await page.goto('http://localhost:19069/sign-in?error=state_mismatch');
  await page.getByText('Google sign-in expired. Please try again.', { exact: true }).waitFor();
  await button('Continue with Google').waitFor();
  await shot('google-callback-error');
  // Keep the bundled UI reachable while the phone reports no network. A
  // manual retry must work even if the connectivity signal remains stale.
  providers = { google: true, emailLink: true }; configOffline = true;
  await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }));
  await page.reload();
  await page.getByText('You’re offline. Connect to the internet to sign in.', { exact: true }).waitFor();
  await button('Try again').waitFor(); await shot('offline-sign-in');
  assert.equal(await page.getByText('Getting sign-in options…', { exact: true }).count(), 0);
  configOffline = false;
  await button('Try again').click();
  await button('Continue with Google').waitFor();
  await button('Continue with email').waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS login UI: provider loading/error/recovery, offline startup and retry with stale connectivity, Google interruption and callback errors, credential-free diagnostic reporting, invalid email, pending guard, failure preserves draft, success/resend/change email, navigation, small phone/tablet and reduced viewport. Synthetic API only; no email sent.');
} catch (error) {
  await page.screenshot({ path: screenshots + 'failure.png' });
  console.error('Page errors:', errors);
  throw error;
} finally {
  await browser.close();
}
