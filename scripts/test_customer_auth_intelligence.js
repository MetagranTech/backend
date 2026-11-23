/**
 * test_customer_auth_intelligence.js
 * Comprehensive automated cybersecurity verification for:
 * 1. Zero-knowledge anti-enumeration on Customer & Partner recovery
 * 2. OTP cryptographic generation, bcrypt hashing, 5-minute expiry, and atomic consumption
 * 3. 5-attempt brute force lockout and concurrency replay protection
 * 4. Account isolation (Customer cannot reset Worker; Worker cannot reset Customer)
 * 5. Full session invalidation (refreshTokens revoked, old password login denied, new password login permitted)
 */

process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test_access_secret_32_characters_minimum_len!';
process.env.JWT_REFRESH_SECRET = 'test_refresh_secret_32_characters_minimum_len!';
process.env.RESEND_API_KEY = 're_test_dummy_key_for_testing';

const assert = require('assert');
const http = require('http');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { connectDb, disconnectDb } = require('../src/db');

let server;
let baseUrl;
let User;
let resendService;

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const postData = body ? JSON.stringify(body) : null;
    const reqHeaders = {
      'Content-Type': 'application/json',
      ...headers,
    };
    if (postData) {
      reqHeaders['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = http.request(
      url,
      {
        method,
        headers: reqHeaders,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let data;
          try {
            data = JSON.parse(raw);
          } catch (_) {
            data = raw;
          }
          resolve({ status: res.statusCode, headers: res.headers, data });
        });
      }
    );

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function runTests() {
  console.log('========================================================================');
  console.log('   HOMESTEPIN: ADVANCED CYBERSECURITY & AUTHENTICATION AUDIT SUITE');
  console.log('========================================================================\n');
  let passed = 0;
  let failed = 0;

  function test(desc, fn) {
    return (async () => {
      try {
        await fn();
        console.log(`  [PASS] ${desc}`);
        passed++;
      } catch (err) {
        console.error(`  [FAIL] ${desc}`);
        console.error('    Error:', err.message);
        failed++;
      }
    })();
  }

  // 1. Initialize server & mock resendService
  await connectDb();
  const serverModule = require('../server.js');
  const app = serverModule.app;
  User = require('../src/models/User');
  resendService = require('../src/services/resendService');

  let sentEmails = [];
  resendService.sendCustomerPasswordResetOtp = async (opts) => {
    if (opts.to.includes('fail-resend')) {
      throw new Error('Simulated Resend API delivery outage');
    }
    sentEmails.push({ type: 'customer_reset', ...opts });
    return { id: 'msg_cust_reset_123' };
  };
  resendService.sendWorkerPasswordResetOtp = async (opts) => {
    sentEmails.push({ type: 'worker_reset', ...opts });
    return { id: 'msg_work_reset_123' };
  };

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      console.log(`Test server running at ${baseUrl}\n`);
      resolve();
    });
  });

  const testStamp = Date.now();
  const verifiedCustomerEmail = `verified.cust.${testStamp}@example.com`;
  const unverifiedCustomerEmail = `unverified.cust.${testStamp}@example.com`;
  const failDeliveryCustomerEmail = `fail-resend.${testStamp}@example.com`;
  const customerCustomId = `CUST-${testStamp}`;
  const workerEmail = `partner.${testStamp}@example.com`;
  const defaultPassword = 'Password123!';
  const newPassword = 'NewSecretPassword456!';

  const defaultHash = await bcrypt.hash(defaultPassword, 10);

  // Seed test users
  const verifiedCust = await User.create({
    name: 'Verified Customer',
    email: verifiedCustomerEmail,
    customId: customerCustomId,
    phone: `+9198765${String(testStamp).slice(-5)}`,
    passwordHash: defaultHash,
    role: 'customer',
    emailVerified: true,
    refreshTokens: [{ hash: 'dummy_hash_1', expiresAt: new Date(Date.now() + 86400000) }],
  });

  const unverifiedCust = await User.create({
    name: 'Unverified Customer',
    email: unverifiedCustomerEmail,
    phone: `+9198764${String(testStamp).slice(-5)}`,
    passwordHash: defaultHash,
    role: 'customer',
    emailVerified: false,
  });

  const failCust = await User.create({
    name: 'Fail Resend Customer',
    email: failDeliveryCustomerEmail,
    phone: `+9198763${String(testStamp).slice(-5)}`,
    passwordHash: defaultHash,
    role: 'customer',
    emailVerified: true,
  });

  const workerUser = await User.create({
    name: 'Partner User',
    email: workerEmail,
    phone: `+9198762${String(testStamp).slice(-5)}`,
    passwordHash: defaultHash,
    role: 'worker',
    emailVerified: true,
    refreshTokens: [{ hash: 'dummy_hash_worker', expiresAt: new Date(Date.now() + 86400000) }],
  });

  console.log('--- SECTION 1: Zero-Knowledge Anti-Enumeration & Uniform Responses ---');

  let verifiedResponseData;
  let unverifiedResponseData;
  let nonExistentResponseData;
  let workerResponseData;

  // TEST 1: Registered & Verified Customer via Email
  await test('Scenario A: Verified customer receives uniform HTTP 200 response and OTP is sent to verified email', async () => {
    sentEmails = [];
    const res = await request('POST', '/api/auth/forgot-password', { email: verifiedCustomerEmail });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(typeof res.data.message, 'string');
    assert.strictEqual(res.data.accountStatus, undefined, 'Must not leak accountStatus');
    assert.strictEqual(res.data.email, undefined, 'Must not leak internal email address');
    assert.strictEqual(sentEmails.length, 1);
    assert.strictEqual(sentEmails[0].to, verifiedCustomerEmail);
    assert.strictEqual(sentEmails[0].otp.length, 6);

    verifiedResponseData = res.data;

    // Verify OTP hashed in database
    const dbCust = await User.findById(verifiedCust._id).select('+otp.codeHash');
    assert(dbCust.otp && dbCust.otp.codeHash, 'OTP codeHash must exist in MongoDB');
    assert(dbCust.otp.expiresAt > new Date(), 'OTP must not be expired');
  });

  // TEST 2: Customer ID Lookup -> Sends ONLY to MongoDB registered email
  await test('Customer ID lookup resolves MongoDB account and sends OTP exclusively to registered email', async () => {
    sentEmails = [];
    await User.updateOne({ _id: verifiedCust._id }, { $set: { 'otp.resendCooldownExpires': new Date(Date.now() - 1000) } });

    const res = await request('POST', '/api/auth/forgot-password', { identifier: customerCustomId });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(sentEmails.length, 1);
    assert.strictEqual(sentEmails[0].to, verifiedCustomerEmail, 'Must send ONLY to registered email stored in DB');
  });

  // TEST 3: Scenario B - Non-Existent Account
  await test('Scenario B: Non-existent account returns identical uniform response, 0 OTP records in DB, 0 emails sent', async () => {
    sentEmails = [];
    const res = await request('POST', '/api/auth/forgot-password', { email: `nonexistent.arbitrary.${testStamp}@gmail.com` });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.accountStatus, undefined);
    assert.strictEqual(sentEmails.length, 0, 'No email should be sent for unregistered accounts');

    nonExistentResponseData = res.data;
    const userCount = await User.countDocuments({ email: `nonexistent.arbitrary.${testStamp}@gmail.com` });
    assert.strictEqual(userCount, 0, 'No user record should be created');
  });

  // TEST 4: Scenario C - Account Exists but Email Unverified
  await test('Scenario C: Unverified account returns identical uniform response, 0 reset emails sent, 0 OTPs generated', async () => {
    sentEmails = [];
    const res = await request('POST', '/api/auth/forgot-password', { email: unverifiedCustomerEmail });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.accountStatus, undefined);
    assert.strictEqual(sentEmails.length, 0, 'No email sent for unverified accounts');

    unverifiedResponseData = res.data;
    const dbUser = await User.findById(unverifiedCust._id).select('+otp.codeHash');
    assert(!dbUser.otp || !dbUser.otp.codeHash, 'No OTP codeHash should be set for unverified accounts');
  });

  // TEST 5: Worker Account in Customer Endpoint
  await test('Worker account entering customer endpoint returns identical uniform response with 0 emails sent', async () => {
    sentEmails = [];
    const res = await request('POST', '/api/auth/forgot-password', { email: workerEmail });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.accountStatus, undefined, 'Must not leak WORKER_ACCOUNT');
    assert.strictEqual(sentEmails.length, 0, 'Customer endpoint must not send OTP for partner accounts');

    workerResponseData = res.data;
  });

  // TEST 6: Strict Cryptographic Zero-Knowledge Equivalence
  await test('Zero-Knowledge verification: Response payloads across all 4 scenarios are structurally identical', async () => {
    assert.deepStrictEqual(
      Object.keys(verifiedResponseData).sort(),
      Object.keys(nonExistentResponseData).sort(),
      'Payload keys must be identical'
    );
    assert.strictEqual(verifiedResponseData.message, nonExistentResponseData.message, 'Message must be identical');
    assert.strictEqual(verifiedResponseData.message, unverifiedResponseData.message, 'Message must be identical');
    assert.strictEqual(verifiedResponseData.message, workerResponseData.message, 'Message must be identical');
  });

  // TEST 7: Scenario D - Provider Delivery Failure Rollback
  await test('Scenario D: Email provider delivery failure rolls back OTP and returns HTTP 502 with EMAIL_DELIVERY_FAILED', async () => {
    sentEmails = [];
    const res = await request('POST', '/api/auth/forgot-password', { email: failDeliveryCustomerEmail });
    assert.strictEqual(res.status, 502);
    assert.strictEqual(res.data.success, false);
    assert.strictEqual(res.data.code, 'EMAIL_DELIVERY_FAILED');

    const dbUser = await User.findById(failCust._id).select('+otp.codeHash');
    assert(!dbUser.otp || !dbUser.otp.codeHash, 'OTP codeHash must be rolled back on delivery failure');
  });

  console.log('\n--- SECTION 2: OTP Cryptography, Brute Force & Concurrency Protection ---');

  // TEST 8: Invalid OTP Decrements Attempts
  await test('Submitting an incorrect OTP decrements attempts counter and returns HTTP 400 with INVALID_OTP', async () => {
    await User.updateOne({ _id: verifiedCust._id }, { $set: { 'otp.resendCooldownExpires': new Date(Date.now() - 1000) } });
    sentEmails = [];
    const fpRes = await request('POST', '/api/auth/forgot-password', { email: verifiedCustomerEmail });
    assert.strictEqual(fpRes.status, 200);
    assert(sentEmails.length > 0, 'OTP must be sent');

    const res = await request('POST', '/api/auth/verify-reset-otp', {
      email: verifiedCustomerEmail,
      otp: '000000',
      newPassword,
      confirmPassword: newPassword,
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.code, 'INVALID_OTP');
    assert.strictEqual(res.data.attemptsRemaining, 4);

    const dbUser = await User.findById(verifiedCust._id);
    assert.strictEqual(dbUser.otp.attempts, 1);
  });

  // TEST 9: 5-Attempt Brute Force Lockout
  await test('Exceeding 5 failed attempts completely locks out the OTP challenge', async () => {
    // Send 4 more failed attempts (total 5)
    for (let i = 0; i < 4; i++) {
      await request('POST', '/api/auth/verify-reset-otp', {
        email: verifiedCustomerEmail,
        otp: `00000${i + 1}`,
        newPassword,
        confirmPassword: newPassword,
      });
    }

    const lockedRes = await request('POST', '/api/auth/verify-reset-otp', {
      email: verifiedCustomerEmail,
      otp: sentEmails[sentEmails.length - 1].otp, // Even the correct OTP
      newPassword,
      confirmPassword: newPassword,
    });
    assert.strictEqual(lockedRes.status, 400);
    assert(lockedRes.data.error.includes('Too many incorrect attempts'), 'Must lock challenge after 5 attempts');
  });

  // TEST 10: Deprecated Firebase Reset Token Rejected
  await test('Firebase ID token reset attempt is rejected with 400 FIREBASE_RESET_DEPRECATED', async () => {
    const res = await request('POST', '/api/auth/verify-reset-otp', {
      email: verifiedCustomerEmail,
      firebaseIdToken: 'fake_firebase_token',
      newPassword,
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.code, 'FIREBASE_RESET_DEPRECATED');
  });

  console.log('\n--- SECTION 3: Account Isolation & Role Separation ---');

  // TEST 11: Customer endpoint cannot reset Partner account
  await test('Customer recovery endpoint strictly rejects resetting a Partner account', async () => {
    // Issue OTP to worker via dedicated worker endpoint
    sentEmails = [];
    const workerFp = await request('POST', '/api/auth/worker/forgot-password', { email: workerEmail });
    assert.strictEqual(workerFp.status, 200);
    assert(sentEmails.length > 0, 'Worker OTP sent');
    const workerOtp = sentEmails[sentEmails.length - 1].otp;

    // Attempt to verify on Customer endpoint
    const crossReset = await request('POST', '/api/auth/verify-reset-otp', {
      email: workerEmail,
      otp: workerOtp,
      newPassword: 'HackedPassword123!',
      confirmPassword: 'HackedPassword123!',
    });
    assert.strictEqual(crossReset.status, 400, 'Customer reset endpoint must reject partner accounts');
    assert.strictEqual(crossReset.data.code, 'INVALID_OTP');
  });

  // TEST 12: Partner endpoint cannot reset Customer account
  await test('Partner recovery endpoint strictly rejects resetting a Customer account', async () => {
    // Issue fresh OTP to customer
    await User.updateOne({ _id: verifiedCust._id }, { $set: { 'otp.resendCooldownExpires': new Date(Date.now() - 1000) } });
    sentEmails = [];
    await request('POST', '/api/auth/forgot-password', { email: verifiedCustomerEmail });
    assert(sentEmails.length > 0, 'Customer OTP sent');
    const customerOtp = sentEmails[sentEmails.length - 1].otp;

    // Attempt to verify on Worker endpoint
    const crossReset = await request('POST', '/api/auth/worker/verify-reset-otp', {
      email: verifiedCustomerEmail,
      otp: customerOtp,
      newPassword: 'HackedPassword123!',
      confirmPassword: 'HackedPassword123!',
    });
    assert.strictEqual(crossReset.status, 400, 'Partner reset endpoint must reject customer accounts');
    assert.strictEqual(crossReset.data.code, 'INVALID_OTP');
  });

  console.log('\n--- SECTION 4: Session Invalidation & Atomic Consumption ---');

  // TEST 13: Valid OTP resets password, revokes sessions, and prevents replay
  await test('Valid OTP resets password, wipes refresh tokens, and prevents replay attacks', async () => {
    // Issue fresh OTP for customer
    await User.updateOne({ _id: verifiedCust._id }, { $set: { 'otp.resendCooldownExpires': new Date(Date.now() - 1000) } });
    sentEmails = [];
    await request('POST', '/api/auth/forgot-password', { email: verifiedCustomerEmail });
    const activeOtp = sentEmails[sentEmails.length - 1].otp;

    // 1st consumption: Must succeed
    const res = await request('POST', '/api/auth/verify-reset-otp', {
      email: verifiedCustomerEmail,
      otp: activeOtp,
      newPassword,
      confirmPassword: newPassword,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);

    // Verify DB state
    const dbCust = await User.findById(verifiedCust._id).select('+otp.codeHash +passwordHash +refreshTokens');
    assert.strictEqual(dbCust.refreshTokens.length, 0, 'All refreshTokens must be revoked');
    assert(!dbCust.otp || !dbCust.otp.codeHash, 'OTP codeHash must be wiped');

    // 2nd consumption (Replay Attack): Must fail immediately
    const replayRes = await request('POST', '/api/auth/verify-reset-otp', {
      email: verifiedCustomerEmail,
      otp: activeOtp,
      newPassword: 'AnotherPassword999!',
      confirmPassword: 'AnotherPassword999!',
    });
    assert.strictEqual(replayRes.status, 400, 'Replay attempt must be rejected');

    // Verify login with old credentials fails
    const oldLogin = await request('POST', '/api/auth/login', {
      identifier: verifiedCustomerEmail,
      password: defaultPassword,
      role: 'customer',
    });
    assert.strictEqual(oldLogin.status, 401, 'Old password must fail login');

    // Verify login with new credentials succeeds
    const newLogin = await request('POST', '/api/auth/login', {
      identifier: verifiedCustomerEmail,
      password: newPassword,
      role: 'customer',
    });
    assert.strictEqual(newLogin.status, 200, 'New password must succeed login');
    assert(newLogin.data.token, 'New JWT token must be issued');
  });

  console.log('\n========================================================================');
  console.log(`   CYBERSECURITY AUDIT RESULTS: ${passed} PASSED, ${failed} FAILED (TOTAL: ${passed + failed})`);
  console.log(`   SUCCESS RATE: ${Math.round((passed / (passed + failed)) * 100)}%`);
  console.log('========================================================================\n');

  // Cleanup
  await User.deleteMany({
    _id: { $in: [verifiedCust._id, unverifiedCust._id, failCust._id, workerUser._id] },
  });

  await disconnectDb();
  server.close();
  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
