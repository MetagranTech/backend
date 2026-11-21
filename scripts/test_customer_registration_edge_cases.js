/**
 * Integration Test Suite: Customer Registration & Auth Lifecycle Edge Cases
 * Tests:
 * 1. Customer registration with unique email and phone -> 201
 * 2. Duplicate email validation -> 409 DUPLICATE_EMAIL
 * 3. Duplicate phone validation -> 409 DUPLICATE_PHONE
 * 4. Role conflict (partner email registered as customer) -> 409 ROLE_CONFLICT
 * 5. Deactivated account re-registration attempt -> 403 ACCOUNT_DISABLED
 * 6. Admin Customer Directory listing -> customer is visible
 * 7. OTP verification -> 200, emailVerified = true, returns token and full user identifiers
 * 8. Customer login with valid password -> 200, returns token and consistent user identifiers
 * 9. Profile lookup /api/auth/me -> 200, consistent identifiers (id, _id, customId)
 * 10. Refresh token /api/auth/refresh -> 200, consistent identifiers
 */

'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { connectDb, disconnectDb } = require('../src/db');
const User = require('../src/models/User');
const { signAccess } = require('../src/authTokens');
const { app } = require('../server');
const http = require('http');

let server;
const PORT = 4019;
const BASE = `http://127.0.0.1:${PORT}`;

function req(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const data = body ? JSON.stringify(body) : null;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);

    const r = http.request(url, { method, headers }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function runTests() {
  console.log('========================================================================');
  console.log('   HOMESTEPIN: CUSTOMER REGISTRATION & AUTH LIFECYCLE TESTS');
  console.log('========================================================================\n');

  await connectDb();
  server = app.listen(PORT);
  await new Promise(res => server.once('listening', res));

  // Find or create admin for directory check
  let admin = await User.findOne({ role: 'admin', status: 'active' });
  if (!admin) {
    admin = await User.create({
      customId: `usr_adm_test_${Date.now()}`,
      username: `adm_${Date.now()}`,
      name: 'SuperAdmin Test',
      email: `admin.custtest.${Date.now()}@homestepin.com`,
      phone: `+9199${Math.floor(10000000 + Math.random() * 89999999)}`,
      passwordHash: 'dummy',
      role: 'admin',
      adminRole: 'SUPER_ADMIN',
      status: 'active',
      isProtected: true,
      isSystemSuperAdmin: true,
    });
  }
  const adminToken = signAccess({ _id: admin._id, id: admin.customId || admin._id.toString(), role: 'admin' });

  const testSuffix = Date.now().toString().slice(-4);
  const custPassword = 'SecurePassword@123';
  const c1Email = `cust.test.${testSuffix}@example.com`;
  const c1Phone = `+9191000${testSuffix}1`;
  const c2Email = `cust2.test.${testSuffix}@example.com`;
  const c3Phone = `+9191000${testSuffix}2`;

  // Create a partner worker in DB to test role conflict
  const workerEmail = `partner.forconflict.${testSuffix}@homestepin.com`;
  await User.create({
    customId: `usr_work_conflict_${Date.now()}`,
    username: `workconf_${Date.now()}`,
    name: 'Conflict Worker',
    email: workerEmail,
    phone: `+9192000${testSuffix}9`,
    employeeId: `EMP-CONF-${testSuffix}`,
    passwordHash: await bcrypt.hash('dummy123', 10),
    role: 'worker',
    status: 'active',
  });

  // Create a deactivated customer in DB to test account disabled
  const disabledEmail = `deactivated.cust.${testSuffix}@example.com`;
  await User.create({
    customId: `usr_cust_disabled_${Date.now()}`,
    username: `disabled_${Date.now()}`,
    name: 'Disabled User',
    email: disabledEmail,
    phone: `+9193000${testSuffix}8`,
    passwordHash: await bcrypt.hash('dummy123', 10),
    role: 'customer',
    status: 'disabled',
  });

  let passed = 0;
  let total = 0;

  function assert(condition, testName, extra = '') {
    total++;
    if (condition) {
      console.log(`  \x1b[32m✔ PASS\x1b[0m [${total}] ${testName}`);
      passed++;
    } else {
      console.error(`  \x1b[31m✖ FAIL\x1b[0m [${total}] ${testName} ${extra}`);
    }
  }

  try {
    // 1. Unique customer registration
    console.log('[Test 1] Customer registration with unique email and phone');
    const res1 = await req('POST', '/api/auth/register-customer', {
      name: 'Priya Sharma',
      email: c1Email,
      phone: c1Phone,
      password: custPassword,
      address: '12, 10th Cross, Thillai Nagar, Trichy, Tamil Nadu 620018',
    });
    assert(
      res1.status === 201 &&
      res1.data.user &&
      res1.data.user.id &&
      res1.data.user._id &&
      res1.data.user.customId &&
      res1.data.user.email === c1Email &&
      res1.data.requiresVerification === true,
      'Unique customer registered with 201 Created and consistent identifiers',
      JSON.stringify(res1.data)
    );

    // 2. Duplicate email registration
    console.log('[Test 2] Registration attempt with duplicate email');
    const res2 = await req('POST', '/api/auth/register-customer', {
      name: 'Priya Duplicate Email',
      email: c1Email,
      phone: c3Phone,
      password: custPassword,
    });
    assert(
      res2.status === 409 &&
      res2.data.code === 'DUPLICATE_EMAIL' &&
      res2.data.field === 'email',
      'Duplicate email rejected with 409 DUPLICATE_EMAIL',
      JSON.stringify(res2.data)
    );

    // 3. Duplicate phone registration
    console.log('[Test 3] Registration attempt with duplicate phone number');
    const res3 = await req('POST', '/api/auth/register-customer', {
      name: 'Priya Duplicate Phone',
      email: c2Email,
      phone: c1Phone,
      password: custPassword,
    });
    assert(
      res3.status === 409 &&
      res3.data.code === 'DUPLICATE_PHONE' &&
      res3.data.field === 'phone',
      'Duplicate phone rejected with 409 DUPLICATE_PHONE',
      JSON.stringify(res3.data)
    );

    // 4. Role conflict registration
    console.log('[Test 4] Registration attempt using existing Partner email');
    const res4 = await req('POST', '/api/auth/register-customer', {
      name: 'Role Conflict Test',
      email: workerEmail,
      phone: `+9194000${testSuffix}7`,
      password: custPassword,
    });
    assert(
      res4.status === 409 &&
      res4.data.code === 'ROLE_CONFLICT',
      'Partner email collision returns 409 ROLE_CONFLICT',
      JSON.stringify(res4.data)
    );

    // 5. Deactivated account registration
    console.log('[Test 5] Registration attempt using deactivated account email');
    const res5 = await req('POST', '/api/auth/register-customer', {
      name: 'Disabled Test',
      email: disabledEmail,
      phone: `+9195000${testSuffix}6`,
      password: custPassword,
    });
    assert(
      res5.status === 403 &&
      res5.data.code === 'ACCOUNT_DISABLED',
      'Deactivated account returns 403 ACCOUNT_DISABLED',
      JSON.stringify(res5.data)
    );

    // 6. Admin Customer Directory check
    console.log('[Test 6] Admin Customer Directory lists the registered customer');
    const res6 = await req('GET', '/api/admin/customers', null, adminToken);
    const customers = res6.data.customers || res6.data.items || (Array.isArray(res6.data) ? res6.data : []);
    const foundCust = customers.find(c => c.email === c1Email);
    assert(
      res6.status === 200 && Boolean(foundCust),
      'Customer Directory endpoint successfully returns the registered customer',
      `Status: ${res6.status}, found: ${Boolean(foundCust)}`
    );

    // 7. OTP verification
    console.log('[Test 7] Verify OTP to activate customer account');
    // Fetch customer from DB to get the hashed code (in test environment, verify code)
    // The server generates OTP and stores its hash. Let's set a known OTP on the document to test verification
    const customerDoc = await User.findOne({ email: c1Email }).select('+otp.codeHash');
    const testOtp = '654321';
    const otpHash = await bcrypt.hash(testOtp, 10);
    customerDoc.otp = {
      codeHash: otpHash,
      purpose: 'email_verification',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      attempts: 0,
      resendAvailableAt: new Date(),
    };
    await customerDoc.save();

    const res7 = await req('POST', '/api/auth/verify-customer-otp', {
      email: c1Email,
      otp: testOtp,
    });
    assert(
      res7.status === 200 &&
      res7.data.success === true &&
      res7.data.user &&
      res7.data.user.id &&
      res7.data.user._id &&
      res7.data.user.customId &&
      res7.data.user.emailVerified === true &&
      Boolean(res7.data.token),
      'Customer OTP verified successfully with consistent identifiers and valid token',
      JSON.stringify(res7.data)
    );
    const customerToken = res7.data.token;

    // 8. Customer login with valid password
    console.log('[Test 8] Customer login with email and password');
    const res8 = await req('POST', '/api/auth/login', {
      email: c1Email,
      password: custPassword,
    });
    assert(
      res8.status === 200 &&
      res8.data.user &&
      res8.data.user.id &&
      res8.data.user._id &&
      res8.data.user.customId &&
      res8.data.user.emailVerified === true &&
      Boolean(res8.data.token),
      'Customer login returns 200, JWT token, and consistent identifiers',
      JSON.stringify(res8.data)
    );

    // 9. Profile lookup /api/auth/me
    console.log('[Test 9] Profile lookup /api/auth/me');
    const res9 = await req('GET', '/api/auth/me', null, customerToken);
    assert(
      res9.status === 200 &&
      res9.data.user &&
      res9.data.user.id &&
      res9.data.user._id &&
      res9.data.user.customId &&
      res9.data.user.email === c1Email,
      '/api/auth/me returns consistent user identifiers (id, _id, customId)',
      JSON.stringify(res9.data)
    );

    // 10. Refresh token /api/auth/refresh
    console.log('[Test 10] Token refresh /api/auth/refresh');
    const res10 = await req('POST', '/api/auth/refresh', { token: customerToken });
    assert(
      res10.status === 200 &&
      res10.data.success === true &&
      res10.data.user &&
      res10.data.user.id &&
      res10.data.user._id &&
      res10.data.user.customId,
      '/api/auth/refresh returns 200 and refreshed session with consistent identifiers',
      JSON.stringify(res10.data)
    );

  } finally {
    if (server) {
      server.close();
    }
    await disconnectDb();
  }

  console.log('\n------------------------------------------------------------------------');
  console.log(`RESULTS: ${passed}/${total} assertions passed (${Math.round((passed / total) * 100)}%)`);
  console.log('------------------------------------------------------------------------');

  if (passed !== total) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Unhandled error in test runner:', err);
  if (server) server.close();
  disconnectDb().finally(() => process.exit(1));
});
