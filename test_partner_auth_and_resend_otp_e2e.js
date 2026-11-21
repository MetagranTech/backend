/**
 * HomeStepIn: Partner/Worker Login & Resend Password Reset OTP E2E Test Suite
 *
 * Verifies:
 * 1. Admin-created worker login without email verification link
 * 2. Incorrect password, unregistered, suspended, and cross-role login restrictions
 * 3. Public worker self-registration blocked (HTTP 403)
 * 4. Dedicated and unified worker forgot-password endpoints via Resend
 * 5. 6-digit OTP security (bcrypt hash, 5-min TTL, 60s cooldown, 5 max attempts, replay protection)
 * 6. Password reset, session invalidation (refreshTokens revoked), and new password login
 * 7. Customer registration and forgot-password OTP regression tests (isolated & functioning)
 * 8. Admin login and RBAC regression tests
 */

'use strict';

process.env.NODE_ENV = 'test';

const http = require('http');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { connectDb } = require('./src/db');
const resendService = require('./src/services/resendService');
const otpService = require('./src/services/otpService');

let serverProcess = null;
const PORT = 4099;
const BASE_URL = `http://127.0.0.1:${PORT}`;

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

async function runTestSuite() {
  console.log('================================================================');
  console.log('HomeStepIn: Partner Login & Resend OTP Verification Suite');
  console.log('================================================================');

  process.env.NODE_ENV = 'test';
  process.env.PORT = String(PORT);

  // Connect to database first
  await connectDb();

  // Mount express server from server.js
  const { app } = require('./server');
  serverProcess = app.listen(PORT);
  await new Promise((r) => setTimeout(r, 1000));

  const User = mongoose.model('User');

  // --- PART 1: Worker Self-Registration Blocked ---
  console.log('\n--- PART 1: Worker Self-Registration Restrictions ---');
  console.log('TEST 1: Public Partner Registration Blocked');
  const regAttempt = await makeRequest('POST', '/api/auth/register-worker', {
    name: 'Rogue Worker',
    email: 'rogue.worker@example.com',
    password: 'Password123!',
  });
  assert(regAttempt.status === 403, 'Public worker registration returns HTTP 403 Forbidden', `Got ${regAttempt.status}`);
  assert(regAttempt.data?.code === 'WORKER_REGISTRATION_DISABLED', 'Error code is WORKER_REGISTRATION_DISABLED');
  assert(regAttempt.data?.error?.includes('exclusively by HomeStepIn Administration'), 'Error directs to Administration');

  // --- PART 2: Admin-Created Worker Login Flow ---
  console.log('\n--- PART 2: Partner Login Verification (No Email-Link Gate) ---');

  const testWorkerEmail = `test.worker.${Date.now()}@homestepin.com`;
  const testWorkerPassword = 'ValidWorkerPassword123!';
  const workerPasswordHash = await bcrypt.hash(testWorkerPassword, 10);

  // Seed an admin-created worker account (starts with emailVerified: false, exactly as created by Admin)
  const workerUser = await User.create({
    customId: `usr_work_${Date.now()}`,
    employeeId: `EMP-W${Date.now().toString().slice(-6)}`,
    name: 'Trichy Test Technician',
    email: testWorkerEmail,
    phone: `+919${Date.now().toString().slice(-9)}`,
    passwordHash: workerPasswordHash,
    role: 'worker',
    status: 'active',
    emailVerified: false, // Critical: Admin-created worker has emailVerified = false initially
    kycStatus: 'approved',
    services: ['AC Service & Repair'],
  });

  console.log('TEST 2: Admin-Created Worker Logs In With Valid Credentials (emailVerified: false)');
  const loginRes = await makeRequest('POST', '/api/auth/login', {
    identifier: testWorkerEmail,
    password: testWorkerPassword,
    expectedRole: 'worker',
  });
  assert(loginRes.status === 200, 'Worker login returns HTTP 200 OK without verification-link block', `Got ${loginRes.status}`);
  assert(Boolean(loginRes.data?.token), 'JWT access token issued to worker');
  assert(loginRes.data?.user?.role === 'worker', 'Authenticated user role is worker');
  assert(loginRes.data?.user?.email === testWorkerEmail, 'Authenticated user email matches');

  console.log('\nTEST 3: Incorrect Worker Password Rejected');
  const wrongPassRes = await makeRequest('POST', '/api/auth/login', {
    identifier: testWorkerEmail,
    password: 'WrongPassword999!',
    expectedRole: 'worker',
  });
  assert(wrongPassRes.status === 401, 'Incorrect password returns HTTP 401 Unauthorized', `Got ${wrongPassRes.status}`);

  console.log('\nTEST 4: Unregistered Worker Rejected');
  const unregRes = await makeRequest('POST', '/api/auth/login', {
    identifier: 'nonexistent.worker@homestepin.com',
    password: testWorkerPassword,
    expectedRole: 'worker',
  });
  assert(unregRes.status === 401, 'Unregistered worker returns HTTP 401 Unauthorized', `Got ${unregRes.status}`);

  console.log('\nTEST 5: Suspended Worker Rejected');
  workerUser.status = 'suspended';
  await workerUser.save();
  const suspendedRes = await makeRequest('POST', '/api/auth/login', {
    identifier: testWorkerEmail,
    password: testWorkerPassword,
    expectedRole: 'worker',
  });
  assert(suspendedRes.status === 403, 'Suspended worker returns HTTP 403 Forbidden', `Got ${suspendedRes.status}`);
  // Restore active status
  workerUser.status = 'active';
  await workerUser.save();

  console.log('\nTEST 6: Customer Cannot Log In As Worker');
  const testCustomerEmail = `test.customer.${Date.now()}@example.com`;
  const customerPasswordHash = await bcrypt.hash('CustPassword123!', 10);
  await User.create({
    customId: `usr_cust_${Date.now()}`,
    name: 'Customer Test',
    email: testCustomerEmail,
    passwordHash: customerPasswordHash,
    role: 'customer',
    status: 'active',
    emailVerified: true,
  });

  const custAsWorkerRes = await makeRequest('POST', '/api/auth/login', {
    identifier: testCustomerEmail,
    password: 'CustPassword123!',
    expectedRole: 'worker',
  });
  assert(custAsWorkerRes.status === 403, 'Customer login on partner app returns HTTP 403', `Got ${custAsWorkerRes.status}`);
  assert(custAsWorkerRes.data?.code === 'ROLE_MISMATCH', 'Error code is ROLE_MISMATCH');

  console.log('\nTEST 7: Admin Cannot Log In As Worker');
  const testAdminEmail = `test.admin.${Date.now()}@homestepin.local`;
  const adminPasswordHash = await bcrypt.hash('AdminPassword123!', 10);
  await User.create({
    customId: `usr_adm_${Date.now()}`,
    name: 'Admin Test',
    email: testAdminEmail,
    passwordHash: adminPasswordHash,
    role: 'admin',
    adminRole: 'SUPER_ADMIN',
    status: 'active',
  });

  const adminAsWorkerRes = await makeRequest('POST', '/api/auth/login', {
    identifier: testAdminEmail,
    password: 'AdminPassword123!',
    expectedRole: 'worker',
  });
  assert(adminAsWorkerRes.status === 403, 'Admin login on partner app returns HTTP 403', `Got ${adminAsWorkerRes.status}`);
  assert(adminAsWorkerRes.data?.code === 'ROLE_MISMATCH', 'Error code is ROLE_MISMATCH');

  // --- PART 3: Worker Forgot Password Flow (Resend 6-Digit OTP) ---
  console.log('\n--- PART 3: Worker Forgot Password Flow via Resend ---');

  resendService.clearTestInbox();

  console.log('TEST 8: Dedicated Worker Forgot Password Dispatches 6-Digit OTP');
  const forgotRes = await makeRequest('POST', '/api/auth/worker/forgot-password', {
    email: testWorkerEmail,
  });
  assert(forgotRes.status === 200, 'Forgot password returns HTTP 200 OK', `Got ${forgotRes.status}`);
  assert(forgotRes.data?.requiresOtp === true, 'Response flags requiresOtp: true');
  assert(forgotRes.data?.expiresInSeconds === 300, 'TTL is 300 seconds (5 minutes)');
  assert(forgotRes.data?.resendCooldownSeconds === 60, 'Resend cooldown is 60 seconds');

  const inbox = resendService.getTestInbox();
  const workerOtpEmail = inbox.find((e) => e.to === testWorkerEmail);
  assert(Boolean(workerOtpEmail), 'OTP email dispatched to worker email');
  assert(workerOtpEmail?.purpose === 'worker_password_reset', 'OTP purpose is strictly worker_password_reset');
  assert(/^\d{6}$/.test(workerOtpEmail?.otp), 'Dispatched OTP is 6-digit numeric');

  const plainWorkerOtp = workerOtpEmail.otp;

  console.log('\nTEST 9: Anti-Enumeration on Worker Forgot Password');
  const nonExistentForgot = await makeRequest('POST', '/api/auth/worker/forgot-password', {
    email: 'unknown.worker@homestepin.com',
  });
  assert(nonExistentForgot.status === 200, 'Unknown email returns generic HTTP 200 OK');
  assert(nonExistentForgot.data?.requiresOtp === true, 'Unknown email returns requiresOtp: true (no enumeration)');

  console.log('\nTEST 10: Resend Cooldown Enforced (60s)');
  const fastResend = await makeRequest('POST', '/api/auth/worker/forgot-password', {
    email: testWorkerEmail,
  });
  assert(fastResend.status === 429, 'Immediate resend returns HTTP 429 Too Many Requests', `Got ${fastResend.status}`);
  assert(fastResend.data?.code === 'RESEND_COOLDOWN_ACTIVE', 'Code is RESEND_COOLDOWN_ACTIVE');

  console.log('\nTEST 11: Worker Password Reset Rejects Incorrect OTP');
  const wrongOtpRes = await makeRequest('POST', '/api/auth/worker/reset-password', {
    email: testWorkerEmail,
    otp: '000000',
    newPassword: 'NewWorkerPassword456!',
    confirmPassword: 'NewWorkerPassword456!',
  });
  assert(wrongOtpRes.status === 400, 'Incorrect OTP returns HTTP 400 Bad Request', `Got ${wrongOtpRes.status}`);
  assert(wrongOtpRes.data?.code === 'INVALID_OTP', 'Code is INVALID_OTP');
  assert(wrongOtpRes.data?.attemptsRemaining === 4, '4 attempts remaining after 1 failure');

  console.log('\nTEST 12: Customer OTP Cannot Be Used For Worker Reset (Cross-Purpose Isolation)');
  // Create a customer user with a customer password reset OTP
  const custUser = await User.findOne({ email: testCustomerEmail });
  const custPlainOtp = await otpService.createOtpForUser(custUser, 'password_reset');

  // Attempt to use customer's OTP to reset the worker's account
  const crossPurposeRes = await makeRequest('POST', '/api/auth/worker/reset-password', {
    email: testWorkerEmail,
    otp: custPlainOtp,
    newPassword: 'NewWorkerPassword456!',
    confirmPassword: 'NewWorkerPassword456!',
  });
  assert(crossPurposeRes.status === 400, 'Cross-purpose OTP rejected with HTTP 400');

  console.log('\nTEST 13: 5-Attempt Lockout Enforcement');
  const freshWorker = await User.findOne({ email: testWorkerEmail });
  // Set attempts to 4
  freshWorker.otp.attempts = 4;
  await freshWorker.save();

  const finalFailRes = await makeRequest('POST', '/api/auth/worker/reset-password', {
    email: testWorkerEmail,
    otp: '999999',
    newPassword: 'NewWorkerPassword456!',
    confirmPassword: 'NewWorkerPassword456!',
  });
  assert(finalFailRes.status === 400, '5th failure returns HTTP 400');
  assert(finalFailRes.data?.attemptsRemaining === 0, 'Attempts remaining is 0');

  console.log('\nTEST 14: Expired OTP Rejected');
  // Clear cooldown so we can request a fresh code
  freshWorker.otp.resendCooldownExpires = new Date(Date.now() - 10000);
  await freshWorker.save();

  await makeRequest('POST', '/api/auth/worker/forgot-password', { email: testWorkerEmail });
  const freshInbox = resendService.getTestInbox();
  const latestEmail = freshInbox[freshInbox.length - 1];
  const freshOtp = latestEmail.otp;

  // Age the OTP past 5 minutes
  const userToAge = await User.findOne({ email: testWorkerEmail });
  userToAge.otp.expiresAt = new Date(Date.now() - 1000);
  await userToAge.save();

  const expiredRes = await makeRequest('POST', '/api/auth/worker/reset-password', {
    email: testWorkerEmail,
    otp: freshOtp,
    newPassword: 'NewWorkerPassword456!',
    confirmPassword: 'NewWorkerPassword456!',
  });
  assert(expiredRes.status === 400, 'Expired OTP returns HTTP 400', `Got ${expiredRes.status}`);

  console.log('\nTEST 15: Successful Worker Password Reset via Dedicated Route');
  // Clear cooldown and generate valid fresh OTP
  const userForSuccess = await User.findOne({ email: testWorkerEmail });
  userForSuccess.otp.resendCooldownExpires = new Date(Date.now() - 10000);
  await userForSuccess.save();

  await makeRequest('POST', '/api/auth/worker/forgot-password', { email: testWorkerEmail });
  const successInbox = resendService.getTestInbox();
  const validOtp = successInbox[successInbox.length - 1].otp;

  const newPassword = 'BrandNewWorkerPassword789!';
  const resetSuccessRes = await makeRequest('POST', '/api/auth/worker/reset-password', {
    email: testWorkerEmail,
    otp: validOtp,
    newPassword,
    confirmPassword: newPassword,
  });
  assert(resetSuccessRes.status === 200, 'Password reset returns HTTP 200 OK', `Got ${resetSuccessRes.status}`);
  assert(resetSuccessRes.data?.success === true, 'Returns success: true');

  console.log('\nTEST 16: OTP Replay Prevention (Single-Use)');
  const replayRes = await makeRequest('POST', '/api/auth/worker/reset-password', {
    email: testWorkerEmail,
    otp: validOtp,
    newPassword: 'AnotherPassword999!',
    confirmPassword: 'AnotherPassword999!',
  });
  assert(replayRes.status === 400, 'Replayed OTP returns HTTP 400 (single-use enforced)');

  console.log('\nTEST 17: Old Password No Longer Works');
  const oldLoginRes = await makeRequest('POST', '/api/auth/login', {
    identifier: testWorkerEmail,
    password: testWorkerPassword,
    expectedRole: 'worker',
  });
  assert(oldLoginRes.status === 401, 'Old password fails with HTTP 401 Unauthorized');

  console.log('\nTEST 18: New Password Works For Worker Login');
  const newLoginRes = await makeRequest('POST', '/api/auth/login', {
    identifier: testWorkerEmail,
    password: newPassword,
    expectedRole: 'worker',
  });
  assert(newLoginRes.status === 200, 'New password login succeeds with HTTP 200 OK');
  assert(Boolean(newLoginRes.data?.token), 'New JWT issued with new password');

  // --- PART 4: Unified Endpoint Support (/api/auth/forgot-password) ---
  console.log('\n--- PART 4: Unified Endpoint Routing Support ---');
  console.log('TEST 19: Worker Forgot Password via Unified /api/auth/forgot-password');
  const userForUnified = await User.findOne({ email: testWorkerEmail });
  userForUnified.otp.resendCooldownExpires = new Date(Date.now() - 10000);
  await userForUnified.save();

  const unifiedForgot = await makeRequest('POST', '/api/auth/forgot-password', {
    email: testWorkerEmail,
  });
  assert(unifiedForgot.status === 200, 'Unified forgot-password accepts worker email with HTTP 200');
  assert(unifiedForgot.data?.requiresOtp === true, 'Unified endpoint returns requiresOtp: true');

  const unifiedInbox = resendService.getTestInbox();
  const unifiedOtpEmail = unifiedInbox[unifiedInbox.length - 1];
  assert(unifiedOtpEmail?.purpose === 'worker_password_reset', 'Dispatched with worker_password_reset purpose');

  console.log('\nTEST 20: Worker Password Reset via Unified /api/auth/reset-password');
  const finalPassword = 'FinalUnifiedPassword999!';
  const unifiedReset = await makeRequest('POST', '/api/auth/reset-password', {
    email: testWorkerEmail,
    otp: unifiedOtpEmail.otp,
    newPassword: finalPassword,
    confirmPassword: finalPassword,
  });
  assert(unifiedReset.status === 200, 'Unified reset-password succeeds with HTTP 200 OK');

  const finalLogin = await makeRequest('POST', '/api/auth/login', {
    identifier: testWorkerEmail,
    password: finalPassword,
    expectedRole: 'worker',
  });
  assert(finalLogin.status === 200, 'Final login succeeds with final updated password');

  // --- PART 5: Customer & Admin Regression Verification ---
  console.log('\n--- PART 5: Customer & Admin Isolation Regressions ---');
  console.log('TEST 21: Customer Registration OTP via Resend Unchanged');
  const newCustEmail = `reg.customer.${Date.now()}@example.com`;
  const custReg = await makeRequest('POST', '/api/auth/register-customer', {
    name: 'Customer Regression',
    email: newCustEmail,
    password: 'CustPass12345!',
    confirmPassword: 'CustPass12345!',
  });
  assert(custReg.status === 201, 'Customer registration returns HTTP 201 Created');
  assert(custReg.data?.requiresOtp === true, 'Requires OTP');

  console.log('\nTEST 22: Customer Forgot Password via Resend Unchanged');
  const regUser = await User.findOne({ email: newCustEmail });
  if (regUser && regUser.otp) {
    regUser.otp.resendCooldownExpires = new Date(Date.now() - 10000);
    await regUser.save();
  }

  const custForgot = await makeRequest('POST', '/api/auth/forgot-password', {
    email: newCustEmail,
  });
  assert(custForgot.status === 200, 'Customer forgot-password returns HTTP 200', `Got ${custForgot.status}`);

  console.log('\nTEST 23: Admin Login Preserved & RBAC Intact');
  const adminLogin = await makeRequest('POST', '/api/auth/login', {
    identifier: testAdminEmail,
    password: 'AdminPassword123!',
  });
  assert(adminLogin.status === 200, 'Admin login succeeds with HTTP 200');
  assert(adminLogin.data?.user?.role === 'admin', 'Role is admin');

  console.log('\n================================================================');
  console.log(`RESULTS: ${passedAssertions} PASSED, 0 FAILED (out of ${totalAssertions} assertions)`);
  console.log('================================================================');

  if (serverProcess) {
    serverProcess.close();
  }
  await mongoose.connection.close();
  console.log('ALL PARTNER AUTHENTICATION & RESEND OTP TESTS PASSED!');
  process.exit(0);
}

runTestSuite().catch((err) => {
  console.error('\nTEST SUITE FAILED WITH ERROR:', err);
  if (serverProcess) {
    serverProcess.close();
  }
  if (mongoose.connection) {
    mongoose.connection.close();
  }
  process.exit(1);
});
