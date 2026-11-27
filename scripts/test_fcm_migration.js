'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-key-at-least-32-chars-long';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-key-at-least-32-chars-long';
process.env.PAYMENT_WEBHOOK_SECRET = 'test-payment-webhook-secret-1234';
process.env.OTP_SECRET = 'test-otp-secret-key-at-least-32-chars-long';

const assert = require('assert');
const http = require('http');
const jwt = require('jsonwebtoken');

const { connectDb, disconnectDb } = require('../src/db');
const User = require('../src/models/User');
const fcmService = require('../src/services/fcmService');
const oneSignalService = require('../src/services/oneSignalService');
const { app } = require('../server');

let server;
let baseUrl;
let passed = 0;
let failed = 0;

function signToken(user) {
  return jwt.sign(
    { sub: String(user._id), role: user.role, name: user.name, email: user.email },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: '1h' }
  );
}

async function req(method, path, token, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${name}: ${err.message}`);
    failed++;
  }
}

async function main() {
  console.log('=====================================================================');
  console.log('  HOMESTEPIN: FIREBASE FCM MIGRATION & COEXISTENCE TEST SUITE');
  console.log('=====================================================================\n');

  await connectDb();
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const customer = await User.create({
    customId: 'cust_fcm_1',
    name: 'Customer FCM',
    email: 'cust.fcm@test.local',
    phone: '+919800000001',
    passwordHash: 'hash',
    role: 'customer',
  });
  const partner = await User.create({
    customId: 'wrk_fcm_1',
    name: 'Partner FCM',
    email: 'wrk.fcm@test.local',
    phone: '+919800000002',
    passwordHash: 'hash',
    role: 'worker',
    online: true,
    services: ['AC Service & Repair'],
  });

  const custToken = signToken(customer);
  const partnerToken = signToken(partner);

  await runTest('Missing/invalid FCM credentials handled safely without crashing', async () => {
    const prevProj = process.env.FCM_PROJECT_ID;
    const prevKey = process.env.FCM_PRIVATE_KEY;
    const prevEmail = process.env.FCM_CLIENT_EMAIL;
    const prevJson = process.env.FCM_SERVICE_ACCOUNT_JSON;

    delete process.env.FCM_PROJECT_ID;
    delete process.env.FCM_PRIVATE_KEY;
    delete process.env.FCM_CLIENT_EMAIL;
    delete process.env.FCM_SERVICE_ACCOUNT_JSON;

    const appInst = fcmService.initFcmApp();
    assert.strictEqual(appInst, null);

    // Malformed private key
    process.env.FCM_PROJECT_ID = 'homestepin-bf3b8';
    process.env.FCM_CLIENT_EMAIL = 'test@homestepin-bf3b8.iam.gserviceaccount.com';
    process.env.FCM_PRIVATE_KEY = 'not-a-pem-key';
    const badInst = fcmService.initFcmApp();
    assert.strictEqual(badInst, null);

    const status = fcmService.getFcmStatus();
    assert.strictEqual(status.expectedProjectId, 'homestepin-bf3b8');
    assert.ok(status.error);

    if (prevProj) process.env.FCM_PROJECT_ID = prevProj; else delete process.env.FCM_PROJECT_ID;
    if (prevKey) process.env.FCM_PRIVATE_KEY = prevKey; else delete process.env.FCM_PRIVATE_KEY;
    if (prevEmail) process.env.FCM_CLIENT_EMAIL = prevEmail; else delete process.env.FCM_CLIENT_EMAIL;
    if (prevJson) process.env.FCM_SERVICE_ACCOUNT_JSON = prevJson; else delete process.env.FCM_SERVICE_ACCOUNT_JSON;
  });

  await runTest('Customer and Partner register separate FCM tokens with appType isolation', async () => {
    const fakeCustFcm = 'fcm_cust_token_' + 'a'.repeat(50);
    const fakePartFcm = 'fcm_part_token_' + 'b'.repeat(50);

    const r1 = await req('POST', '/api/notifications/register-device', custToken, {
      token: 'os_sub_cust_1',
      fcmToken: fakeCustFcm,
      appType: 'customer',
      platform: 'android',
      deviceId: 'android_cust_1',
    });
    assert.strictEqual(r1.status, 200);

    const r2 = await req('POST', '/api/notifications/register-device', partnerToken, {
      token: 'os_sub_part_1',
      fcmToken: fakePartFcm,
      appType: 'partner',
      platform: 'android',
      deviceId: 'android_part_1',
    });
    assert.strictEqual(r2.status, 200);

    const custResolved = await fcmService.resolveTargetFcmTokens(String(customer._id), 'customer');
    const custWrongApp = await fcmService.resolveTargetFcmTokens(String(customer._id), 'partner');
    assert.deepStrictEqual(custResolved.tokens, [fakeCustFcm]);
    assert.deepStrictEqual(custWrongApp.tokens, []);

    const partResolved = await fcmService.resolveTargetFcmTokens(String(partner._id), 'partner');
    const partWrongApp = await fcmService.resolveTargetFcmTokens(String(partner._id), 'customer');
    assert.deepStrictEqual(partResolved.tokens, [fakePartFcm]);
    assert.deepStrictEqual(partWrongApp.tokens, []);
  });

  await runTest('FCM dispatch succeeds, prunes invalid tokens, and avoids duplicate OneSignal sends', async () => {
    const staleToken = 'fcm_stale_token_' + 'c'.repeat(50);
    await req('POST', '/api/notifications/register-device', partnerToken, {
      token: 'os_sub_part_2',
      fcmToken: staleToken,
      appType: 'partner',
      platform: 'android',
      deviceId: 'android_part_2',
    });

    const fcmSent = [];
    const oneSignalSent = [];

    fcmService.setTestFcmTransport(async (payload, appType) => {
      fcmSent.push({ payload, appType });
      return {
        successCount: 1,
        failureCount: 1,
        responses: payload.tokens.map(tok =>
          tok === staleToken
            ? { success: false, error: { code: 'messaging/registration-token-not-registered', message: 'Not registered' } }
            : { success: true, messageId: 'projects/homestepin-bf3b8/messages/msg_001' }
        ),
      };
    });

    oneSignalService.setTestOneSignalTransport(async (payload, appType) => {
      oneSignalSent.push({ payload, appType });
      return { success: true, id: 'os_1', recipients: 1 };
    });

    const res = await fcmService.sendToUser(
      String(partner._id),
      { title: 'New Job', body: 'AC Service in Trichy', data: { type: 'NEW_JOB_OFFER', bookingId: 'BK-1' } },
      'partner'
    );

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.provider, 'fcm');
    assert.strictEqual(res.recipients, 1);
    assert.strictEqual(res.prunedTokensCount, 1);
    assert.strictEqual(fcmSent.length, 1);
    assert.strictEqual(oneSignalSent.length, 0, 'OneSignal must not duplicate when FCM succeeds');

    // Verify stale token was pruned from User.fcmTokens
    const afterResolved = await fcmService.resolveTargetFcmTokens(String(partner._id), 'partner');
    assert.ok(!afterResolved.tokens.includes(staleToken));
  });

  await runTest('Logout cleanup removes FCM token from User record', async () => {
    const freshCust = await User.findById(customer._id).lean();
    const custFcm = freshCust.fcmTokens[0].token;
    const delRes = await req('POST', '/api/notifications/unregister-device', custToken, {
      fcmToken: custFcm,
      deviceId: 'android_cust_1',
    });
    assert.strictEqual(delRes.status, 200);
    const after = await fcmService.resolveTargetFcmTokens(String(customer._id), 'customer');
    assert.strictEqual(after.tokens.length, 0);
  });

  await runTest('Public config exposes sanitized FCM status with zero secrets', async () => {
    const res = await req('GET', '/api/notifications/public-config');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.fcm);
    assert.strictEqual(res.body.fcm.expectedProjectId, 'homestepin-bf3b8');
    const serialized = JSON.stringify(res.body);
    assert.ok(!serialized.includes('BEGIN PRIVATE KEY'));
  });

  console.log('\n=====================================================================');
  console.log(`  TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('=====================================================================');

  await new Promise(resolve => server.close(resolve));
  await disconnectDb();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async err => {
  console.error('Fatal FCM test error:', err);
  try { if (server) await new Promise(r => server.close(r)); } catch {}
  try { await disconnectDb(); } catch {}
  process.exit(1);
});
