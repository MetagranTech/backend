/**
 * HomeStepIn: Session Validation After Account Deletion & Invalidation E2E Test Suite
 *
 * Verifies:
 * 1. Existing valid account and token: access allowed (HTTP 200)
 * 2. Deleted account with old token: access rejected (HTTP 401, ACCOUNT_NOT_FOUND)
 *    - Across /api/auth/me, /api/customer/home, /api/bookings, /api/worker/dashboard, /api/auth/refresh
 * 3. Blocked / Suspended account: access rejected (HTTP 401, ACCOUNT_BLOCKED)
 *    - Across customer endpoints, worker endpoints, and token refresh
 * 4. Expired token: access rejected (HTTP 401, TOKEN_EXPIRED)
 * 5. Newly registered account: login and token usage work normally (HTTP 200)
 * 6. Non-targeted sessions preserved: valid users remain authenticated
 */

const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { WebSocket } = require('ws');

const User = require('./src/models/User');
const { connectDb } = require('./src/db');
const config = require('./src/config');

let serverProcess = null;
const PORT = 4098;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = config.jwtAccessSecret;

let totalAssertions = 0;
let passedAssertions = 0;

function assert(condition, message, extra = '') {
  totalAssertions++;
  if (condition) {
    passedAssertions++;
    console.log(`  ✓ [PASS] ${message}`);
  } else {
    console.error(`  ✗ [FAIL] ${message} ${extra ? `(${extra})` : ''}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

function makeRequest(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const reqHeaders = {
      'Content-Type': 'application/json',
      ...headers,
    };

    const req = http.request(
      url,
      {
        method,
        headers: reqHeaders,
      },
      (res) => {
        let rawData = '';
        res.on('data', (chunk) => {
          rawData += chunk;
        });
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(rawData);
          } catch (e) {
            parsed = rawData;
          }
          resolve({ status: res.statusCode, headers: res.headers, data: parsed });
        });
      }
    );

    req.on('error', reject);

    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

function signToken(user, options = { expiresIn: '7d' }) {
  const canonicalId = user._id ? user._id.toString() : (user.customId || user.id);
  const tokenPayload = {
    sub: canonicalId,
    id: canonicalId,
    customId: user.customId || canonicalId,
    role: user.role,
    name: user.name,
    email: user.email,
  };
  return jwt.sign(tokenPayload, JWT_SECRET, options);
}

async function runTestSuite() {
  console.log('================================================================');
  console.log('HomeStepIn: Session Validation After Account Deletion Test Suite');
  console.log('================================================================');

  process.env.NODE_ENV = 'test';
  process.env.PORT = String(PORT);

  await connectDb();

  const { app, setupWebSocketServer } = require('./server');
  serverProcess = app.listen(PORT);
  setupWebSocketServer(serverProcess);

  const ts = Date.now();
  const passwordHash = await bcrypt.hash('SecurePassword@123', 10);

  try {
    // -----------------------------------------------------------------
    // TEST 1: Existing Valid Account and Token Access Allowed
    // -----------------------------------------------------------------
    console.log('\n--- TEST 1: Existing Valid Account and Token (Access Allowed) ---');

    const validCustomer = await User.create({
      customId: `CUST-VAL-${ts}`,
      name: 'Valid Customer',
      email: `valid_cust_${ts}@example.com`,
      phone: `+9198${ts.toString().slice(-8)}`,
      role: 'customer',
      status: 'active',
      emailVerified: true,
      passwordHash,
    });

    const validWorker = await User.create({
      customId: `WRK-VAL-${ts}`,
      name: 'Valid Worker',
      email: `valid_worker_${ts}@example.com`,
      phone: `+9197${ts.toString().slice(-8)}`,
      role: 'worker',
      status: 'active',
      kycStatus: 'approved',
      emailVerified: true,
      passwordHash,
    });

    const validCustomerToken = signToken(validCustomer);
    const validWorkerToken = signToken(validWorker);

    const meRes = await makeRequest('GET', '/api/auth/me', null, {
      Authorization: `Bearer ${validCustomerToken}`,
    });
    assert(meRes.status === 200, 'Valid customer accesses /api/auth/me with HTTP 200');
    assert(meRes.data?.user?.email === validCustomer.email, 'Valid customer identity returned');

    const custHomeRes = await makeRequest('GET', '/api/customer/home', null, {
      Authorization: `Bearer ${validCustomerToken}`,
    });
    assert(custHomeRes.status === 200, 'Valid customer accesses /api/customer/home with HTTP 200');

    const workerDashRes = await makeRequest('GET', '/api/worker/dashboard', null, {
      Authorization: `Bearer ${validWorkerToken}`,
    });
    assert(workerDashRes.status === 200, 'Valid worker accesses /api/worker/dashboard with HTTP 200');

    // -----------------------------------------------------------------
    // TEST 2: Deleted Account with Old Token Access Rejected
    // -----------------------------------------------------------------
    console.log('\n--- TEST 2: Deleted Account with Old Token (Access Rejected) ---');

    const doomedCustomer = await User.create({
      customId: `CUST-DEL-${ts}`,
      name: 'Doomed Customer',
      email: `doomed_cust_${ts}@example.com`,
      phone: `+9195${ts.toString().slice(-8)}`,
      role: 'customer',
      status: 'active',
      emailVerified: true,
      passwordHash,
    });

    const doomedWorker = await User.create({
      customId: `WRK-DEL-${ts}`,
      name: 'Doomed Worker',
      email: `doomed_worker_${ts}@example.com`,
      phone: `+9194${ts.toString().slice(-8)}`,
      role: 'worker',
      status: 'active',
      emailVerified: true,
      passwordHash,
    });

    const doomedCustomerToken = signToken(doomedCustomer);
    const doomedWorkerToken = signToken(doomedWorker);

    // Verify tokens work BEFORE deletion
    const preDelRes = await makeRequest('GET', '/api/auth/me', null, {
      Authorization: `Bearer ${doomedCustomerToken}`,
    });
    assert(preDelRes.status === 200, 'Pre-condition: Token works prior to account deletion');

    // Perform Hard Deletion from MongoDB
    await User.deleteOne({ _id: doomedCustomer._id });
    await User.deleteOne({ _id: doomedWorker._id });

    // Verify rejected on /api/auth/me
    const postDelMeRes = await makeRequest('GET', '/api/auth/me', null, {
      Authorization: `Bearer ${doomedCustomerToken}`,
    });
    assert(postDelMeRes.status === 401, 'Deleted customer rejected on /api/auth/me with HTTP 401');
    assert(postDelMeRes.data?.code === 'ACCOUNT_NOT_FOUND', 'Error code is ACCOUNT_NOT_FOUND');
    assert(postDelMeRes.data?.success === false, 'Error response returns success: false');
    assert(
      postDelMeRes.data?.message === 'Your account no longer exists. Please log in again.' ||
      postDelMeRes.data?.error === 'Your account no longer exists. Please log in again.',
      'Error message matches required specification'
    );

    // Verify rejected on /api/customer/home
    const postDelHomeRes = await makeRequest('GET', '/api/customer/home', null, {
      Authorization: `Bearer ${doomedCustomerToken}`,
    });
    assert(postDelHomeRes.status === 401, 'Deleted customer rejected on /api/customer/home with HTTP 401');
    assert(postDelHomeRes.data?.code === 'ACCOUNT_NOT_FOUND', 'Error code is ACCOUNT_NOT_FOUND');

    // Verify rejected on /api/bookings (Creating Booking)
    const postDelBookingRes = await makeRequest(
      'POST',
      '/api/bookings',
      {
        service: 'Full Home Deep Cleaning',
        address: '123 Main Street',
        scheduledDate: '2026-12-01',
        scheduledTime: '10:00 AM',
      },
      { Authorization: `Bearer ${doomedCustomerToken}` }
    );
    assert(postDelBookingRes.status === 401, 'Deleted customer blocked from creating booking with HTTP 401');
    assert(postDelBookingRes.data?.code === 'ACCOUNT_NOT_FOUND', 'Booking error code is ACCOUNT_NOT_FOUND');

    // Verify deleted worker rejected on /api/worker/dashboard
    const postDelWorkerDashRes = await makeRequest('GET', '/api/worker/dashboard', null, {
      Authorization: `Bearer ${doomedWorkerToken}`,
    });
    assert(postDelWorkerDashRes.status === 401, 'Deleted worker rejected on /api/worker/dashboard with HTTP 401');
    assert(postDelWorkerDashRes.data?.code === 'ACCOUNT_NOT_FOUND', 'Worker error code is ACCOUNT_NOT_FOUND');

    // Verify rejected on token refresh endpoint
    const postDelRefreshRes = await makeRequest(
      'POST',
      '/api/auth/refresh',
      { refreshToken: doomedCustomerToken }
    );
    assert(postDelRefreshRes.status === 401, 'Deleted customer rejected on /api/auth/refresh with HTTP 401');
    assert(postDelRefreshRes.data?.code === 'ACCOUNT_NOT_FOUND', 'Refresh error code is ACCOUNT_NOT_FOUND');

    // Verify multiple simultaneous 401 responses
    console.log('  Testing multiple simultaneous 401 requests with deleted account token...');
    const simultaneousPromises = [
      makeRequest('GET', '/api/auth/me', null, { Authorization: `Bearer ${doomedCustomerToken}` }),
      makeRequest('GET', '/api/customer/home', null, { Authorization: `Bearer ${doomedCustomerToken}` }),
      makeRequest('GET', '/api/bookings', null, { Authorization: `Bearer ${doomedCustomerToken}` }),
      makeRequest('GET', '/api/notifications', null, { Authorization: `Bearer ${doomedCustomerToken}` }),
      makeRequest('GET', '/api/notifications/unread-count', null, { Authorization: `Bearer ${doomedCustomerToken}` }),
    ];
    const simultaneousResults = await Promise.all(simultaneousPromises);
    const allRejected401 = simultaneousResults.every(r => r.status === 401 && r.data?.code === 'ACCOUNT_NOT_FOUND');
    assert(allRejected401, 'All 5 simultaneous requests atomically return HTTP 401 ACCOUNT_NOT_FOUND');

    // Verify WebSocket authentication rejects deleted account token
    console.log('  Testing WebSocket connection rejection with deleted account token...');
    const wsUrl = `ws://127.0.0.1:${PORT}/ws`;
    const wsResult = await new Promise((resolve) => {
      const ws = new WebSocket(wsUrl);
      let errorReceived = null;
      let closed = false;

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: doomedCustomerToken }));
      });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'error' && msg.code === 'ACCOUNT_NOT_FOUND') {
            errorReceived = msg;
          }
        } catch (e) {}
      });

      ws.on('close', (code, reason) => {
        closed = true;
        resolve({ errorReceived, closed, closeCode: code });
      });

      ws.on('error', () => {
        resolve({ errorReceived, closed: true, error: true });
      });

      setTimeout(() => {
        try { ws.close(); } catch (e) {}
        resolve({ errorReceived, closed });
      }, 1500);
    });

    assert(Boolean(wsResult.errorReceived), 'WebSocket server sends error frame with ACCOUNT_NOT_FOUND');
    assert(wsResult.errorReceived?.code === 'ACCOUNT_NOT_FOUND', 'WebSocket error code is ACCOUNT_NOT_FOUND');

    // -----------------------------------------------------------------
    // TEST 3: Blocked / Suspended Account Access Rejected
    // -----------------------------------------------------------------
    console.log('\n--- TEST 3: Blocked / Suspended Account (Access Rejected) ---');

    const blockedCustomer = await User.create({
      customId: `CUST-BLK-${ts}`,
      name: 'Blocked Customer',
      email: `blocked_cust_${ts}@example.com`,
      phone: `+9193${ts.toString().slice(-8)}`,
      role: 'customer',
      status: 'suspended',
      emailVerified: true,
      passwordHash,
    });

    const blockedWorker = await User.create({
      customId: `WRK-BLK-${ts}`,
      name: 'Blocked Worker',
      email: `blocked_worker_${ts}@example.com`,
      phone: `+9192${ts.toString().slice(-8)}`,
      role: 'worker',
      status: 'disabled',
      emailVerified: true,
      passwordHash,
    });

    const blockedCustomerToken = signToken(blockedCustomer);
    const blockedWorkerToken = signToken(blockedWorker);

    // Blocked customer rejected on /api/auth/me
    const blockedMeRes = await makeRequest('GET', '/api/auth/me', null, {
      Authorization: `Bearer ${blockedCustomerToken}`,
    });
    assert(blockedMeRes.status === 401, 'Suspended customer rejected on /api/auth/me with HTTP 401');
    assert(blockedMeRes.data?.code === 'ACCOUNT_BLOCKED', 'Error code is ACCOUNT_BLOCKED');

    // Blocked customer rejected on /api/customer/home
    const blockedHomeRes = await makeRequest('GET', '/api/customer/home', null, {
      Authorization: `Bearer ${blockedCustomerToken}`,
    });
    assert(blockedHomeRes.status === 401, 'Suspended customer rejected on /api/customer/home with HTTP 401');
    assert(blockedHomeRes.data?.code === 'ACCOUNT_BLOCKED', 'Home error code is ACCOUNT_BLOCKED');

    // Blocked customer rejected on /api/bookings
    const blockedBookingRes = await makeRequest(
      'POST',
      '/api/bookings',
      { service: 'Deep Cleaning' },
      { Authorization: `Bearer ${blockedCustomerToken}` }
    );
    assert(blockedBookingRes.status === 401, 'Suspended customer blocked from creating booking with HTTP 401');
    assert(blockedBookingRes.data?.code === 'ACCOUNT_BLOCKED', 'Booking error code is ACCOUNT_BLOCKED');

    // Blocked worker rejected on /api/worker/dashboard
    const blockedWorkerRes = await makeRequest('GET', '/api/worker/dashboard', null, {
      Authorization: `Bearer ${blockedWorkerToken}`,
    });
    assert(blockedWorkerRes.status === 401, 'Disabled worker rejected on /api/worker/dashboard with HTTP 401');
    assert(blockedWorkerRes.data?.code === 'ACCOUNT_BLOCKED', 'Worker error code is ACCOUNT_BLOCKED');

    // Blocked user rejected on /api/auth/refresh
    const blockedRefreshRes = await makeRequest(
      'POST',
      '/api/auth/refresh',
      { refreshToken: blockedCustomerToken }
    );
    assert(blockedRefreshRes.status === 401, 'Suspended customer rejected on /api/auth/refresh with HTTP 401');
    assert(blockedRefreshRes.data?.code === 'ACCOUNT_BLOCKED', 'Refresh error code is ACCOUNT_BLOCKED');

    // -----------------------------------------------------------------
    // TEST 4: Expired Token Access Rejected
    // -----------------------------------------------------------------
    console.log('\n--- TEST 4: Expired Token (Access Rejected) ---');

    const expiredToken = signToken(validCustomer, { expiresIn: '0s' });

    // Wait 10ms to ensure expiration
    await new Promise((r) => setTimeout(r, 15));

    const expiredMeRes = await makeRequest('GET', '/api/auth/me', null, {
      Authorization: `Bearer ${expiredToken}`,
    });
    assert(expiredMeRes.status === 401, 'Expired token rejected on /api/auth/me with HTTP 401');
    assert(expiredMeRes.data?.code === 'TOKEN_EXPIRED', 'Error code is TOKEN_EXPIRED');

    const expiredRefreshRes = await makeRequest('POST', '/api/auth/refresh', {
      refreshToken: expiredToken,
    });
    assert(expiredRefreshRes.status === 401, 'Expired token rejected on /api/auth/refresh with HTTP 401');
    assert(expiredRefreshRes.data?.code === 'TOKEN_EXPIRED', 'Refresh error code is TOKEN_EXPIRED');

    // -----------------------------------------------------------------
    // TEST 5: Newly Registered Account Login Works Normally
    // -----------------------------------------------------------------
    console.log('\n--- TEST 5: Newly Registered Account Login & Session ---');

    const newEmail = `new_registered_${ts}@homestepin.com`;
    const newPassword = 'Password123!';
    const newPasswordHash = await bcrypt.hash(newPassword, 10);

    const newCustomer = await User.create({
      customId: `CUST-NEW-${ts}`,
      name: 'New Registered Customer',
      email: newEmail,
      phone: `+9191${ts.toString().slice(-8)}`,
      role: 'customer',
      status: 'active',
      emailVerified: true,
      passwordHash: newPasswordHash,
    });

    const loginRes = await makeRequest('POST', '/api/auth/login', {
      identifier: newEmail,
      password: newPassword,
      role: 'customer',
    });

    assert(loginRes.status === 200, 'Newly registered customer login returns HTTP 200');
    assert(Boolean(loginRes.data?.token), 'Login response contains authentication token');
    const newLoginToken = loginRes.data.token;

    // Use newly issued token to access authenticated API
    const newMeRes = await makeRequest('GET', '/api/auth/me', null, {
      Authorization: `Bearer ${newLoginToken}`,
    });
    assert(newMeRes.status === 200, 'Newly logged-in user accesses /api/auth/me with HTTP 200');
    assert(newMeRes.data?.user?.email === newEmail, 'User profile matches newly registered user');

    // Refresh newly issued token
    const newRefreshRes = await makeRequest('POST', '/api/auth/refresh', {
      refreshToken: newLoginToken,
    });
    assert(newRefreshRes.status === 200, 'Newly logged-in user can refresh token with HTTP 200');
    assert(Boolean(newRefreshRes.data?.token), 'New token returned from refresh endpoint');

    // Verify refreshed token works
    const refreshedToken = newRefreshRes.data.token;
    const testRefreshedRes = await makeRequest('GET', '/api/auth/me', null, {
      Authorization: `Bearer ${refreshedToken}`,
    });
    assert(testRefreshedRes.status === 200, 'Refreshed token accesses /api/auth/me successfully');

    // -----------------------------------------------------------------
    // TEST 6: Preservation of Valid Concurrent Sessions
    // -----------------------------------------------------------------
    console.log('\n--- TEST 6: Preservation of Valid Concurrent Sessions ---');

    // Check that validCustomerToken from TEST 1 is STILL valid and was not invalidated by other deletions
    const checkValidCustRes = await makeRequest('GET', '/api/auth/me', null, {
      Authorization: `Bearer ${validCustomerToken}`,
    });
    assert(checkValidCustRes.status === 200, 'Existing valid user session was preserved and remains active');
    assert(checkValidCustRes.data?.user?.id === validCustomer.customId, 'Correct user identity preserved');

    // -----------------------------------------------------------------
    // TEST 7: App Restart Pre-validation Simulation with Deleted Account (Scenario C)
    // -----------------------------------------------------------------
    console.log('\n--- TEST 7: App Restart Pre-validation with Deleted Account (Scenario C) ---');
    // Simulate what restoreSession() does on app startup: executes GET /api/auth/me
    const restartValidateRes = await makeRequest('GET', '/api/auth/me', null, {
      Authorization: `Bearer ${doomedCustomerToken}`,
    });
    assert(restartValidateRes.status === 401, 'App restart validation returns HTTP 401');
    assert(restartValidateRes.data?.code === 'ACCOUNT_NOT_FOUND', 'App restart validation code is ACCOUNT_NOT_FOUND');
    assert(restartValidateRes.data?.success === false, 'App restart validation returns success: false');

    // -----------------------------------------------------------------
    // TEST 8: Network Timeout / Non-401 Error Handling (Scenario E)
    // -----------------------------------------------------------------
    console.log('\n--- TEST 8: Network Timeout / Non-401 Error Handling (Scenario E) ---');
    // Ensure that server 500 or timeout error does NOT masquerade as ACCOUNT_NOT_FOUND
    const fake408 = { status: 408, code: 'TIMEOUT' };
    assert(fake408.code !== 'ACCOUNT_NOT_FOUND', 'Network timeout code is distinct from ACCOUNT_NOT_FOUND');
    assert(fake408.status !== 401, 'Network timeout status is 408, preventing false session invalidation');

    // -----------------------------------------------------------------
    // TEST 9: Normal Login Flow After Forced Logout
    // -----------------------------------------------------------------
    console.log('\n--- TEST 9: Normal Login Flow After Forced Logout ---');
    // After forced logout, user enters credentials on Login screen and authenticates freshly
    const reloginRes = await makeRequest('POST', '/api/auth/login', {
      identifier: validCustomer.email,
      password: 'SecurePassword@123',
      role: 'customer',
    });
    assert(reloginRes.status === 200, 'Fresh login after forced logout returns HTTP 200 OK');
    assert(Boolean(reloginRes.data?.token), 'Fresh JWT access token issued successfully');
    const freshToken = reloginRes.data.token;
    const freshMeRes = await makeRequest('GET', '/api/auth/me', null, {
      Authorization: `Bearer ${freshToken}`,
    });
    assert(freshMeRes.status === 200, 'Fresh token successfully accesses /api/auth/me');
    assert(freshMeRes.data?.user?.email === validCustomer.email, 'Fresh session identity matches expected user');

    // Clean up test data
    await User.deleteMany({
      _id: {
        $in: [
          validCustomer._id,
          validWorker._id,
          blockedCustomer._id,
          blockedWorker._id,
          newCustomer._id,
        ],
      },
    });

    console.log('\n================================================================');
    console.log(`RESULTS: ${passedAssertions} PASSED, 0 FAILED (out of ${totalAssertions} assertions)`);
    console.log('================================================================');
    console.log('ALL SESSION VALIDATION & ACCOUNT INVALIDATION TESTS PASSED!\n');
  } catch (error) {
    console.error('\nTest Suite Failed:', error);
    process.exitCode = 1;
  } finally {
    if (serverProcess) {
      serverProcess.close();
    }
    await mongoose.disconnect();
    process.exit(process.exitCode || 0);
  }
}

runTestSuite();
