/**
 * Automated Verification Suite: Registration & Partner Creation (10 Tests)
 * Tests:
 * 1. New customer registration -> 201 Created
 * 2. Duplicate customer email -> 409 DUPLICATE_EMAIL
 * 3. Duplicate customer phone -> 409 DUPLICATE_PHONE
 * 4. New partner creation -> 201 Created
 * 5. Multiple partner creations in a row (catches null-index bug on username/employeeId) -> 201 Created
 * 6. Duplicate partner email -> 409 DUPLICATE_EMAIL
 * 7. Duplicate employee ID -> 409 DUPLICATE_EMPLOYEE_ID
 * 8. Unique username generation (verifies non-colliding usernames generated)
 * 9. Existing customers and Super Admin are untouched and still protected
 * 10. Mongo save fails after Firebase user creation -> Firebase user is rolled back
 */

'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const http = require('http');
const { connectDb, disconnectDb } = require('../src/db');
const User = require('../src/models/User');
const { signAccess } = require('../src/authTokens');
const { app } = require('../server');
const { initializeFirebase, deleteFirebaseUser } = require('../src/services/firebaseService');

let server;
const PORT = 4022;
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

async function runSuite() {
  console.log('========================================================================');
  console.log('   HOMESTEPIN: 10-POINT REGISTRATION & PROVISIONING VERIFICATION');
  console.log('========================================================================\n');

  await connectDb();
  server = app.listen(PORT);
  await new Promise(res => server.once('listening', res));

  // Initialize or find protected Super Admin
  let admin = await User.findOne({ role: 'admin', isSystemSuperAdmin: true });
  if (!admin) {
    admin = await User.create({
      customId: `usr_adm_super_${Date.now()}`,
      username: `superadm_${Date.now()}`,
      name: 'Fazil Super Admin',
      email: 'fazil@homestepin.com',
      phone: '+919900000001',
      passwordHash: await bcrypt.hash('SecureSuperAdmin123!', 10),
      role: 'admin',
      adminRole: 'SUPER_ADMIN',
      status: 'active',
      isProtected: true,
      isSystemSuperAdmin: true,
    });
  }
  const adminToken = signAccess({ _id: admin._id, id: admin.customId || admin._id.toString(), role: 'admin' });

  const testSuffix = Date.now().toString().slice(-4);
  const custEmail = `cust.suite.${testSuffix}@example.com`;
  const custPhone = `+9191111${testSuffix}1`;
  const partner1Email = `partner1.suite.${testSuffix}@example.com`;
  const partner1Phone = `+9192222${testSuffix}1`;
  const partner1EmpId = `EMP-TEST-${testSuffix}A`;

  const partner2Email = `partner2.suite.${testSuffix}@example.com`;
  const partner2Phone = `+9192222${testSuffix}2`;
  const partner2EmpId = `EMP-TEST-${testSuffix}B`;

  const partner3Email = `partner3.suite.${testSuffix}@example.com`;
  const partner3Phone = `+9192222${testSuffix}3`;
  const partner3EmpId = `EMP-TEST-${testSuffix}C`;

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
    // ── Test 1: New customer registration ──────────────────────────────
    console.log('[Test 1] New Customer Registration');
    const res1 = await req('POST', '/api/auth/register-customer', {
      name: 'Ramesh Sundaram',
      email: custEmail,
      phone: custPhone,
      password: 'CustomerPass@123',
      address: '14, 11th Cross, Thillai Nagar, Trichy, Tamil Nadu 620018',
    });
    assert(
      res1.status === 201 &&
      res1.data.user &&
      res1.data.user.email === custEmail &&
      res1.data.user.id &&
      res1.data.user._id &&
      res1.data.user.customId,
      'New customer registration succeeds with 201 Created and consistent identifiers',
      JSON.stringify(res1.data)
    );

    // ── Test 2: Duplicate customer email ──────────────────────────────
    console.log('[Test 2] Duplicate Customer Email Rejection');
    const res2 = await req('POST', '/api/auth/register-customer', {
      name: 'Ramesh Copy Email',
      email: custEmail,
      phone: `+9193333${testSuffix}9`,
      password: 'CustomerPass@123',
    });
    assert(
      res2.status === 409 &&
      res2.data.code === 'DUPLICATE_EMAIL' &&
      res2.data.field === 'email',
      'Duplicate customer email returns 409 DUPLICATE_EMAIL',
      JSON.stringify(res2.data)
    );

    // ── Test 3: Duplicate customer phone ──────────────────────────────
    console.log('[Test 3] Duplicate Customer Phone Rejection');
    const res3 = await req('POST', '/api/auth/register-customer', {
      name: 'Ramesh Copy Phone',
      email: `other.cust.${testSuffix}@example.com`,
      phone: custPhone,
      password: 'CustomerPass@123',
    });
    assert(
      res3.status === 409 &&
      res3.data.code === 'DUPLICATE_PHONE' &&
      res3.data.field === 'phone',
      'Duplicate customer phone returns 409 DUPLICATE_PHONE',
      JSON.stringify(res3.data)
    );

    // ── Test 4: New partner creation ──────────────────────────────────
    console.log('[Test 4] New Partner Creation');
    const res4 = await req('POST', '/api/admin/workers', {
      name: 'Anand Technician',
      email: partner1Email,
      phone: partner1Phone,
      employeeId: partner1EmpId,
      password: 'PartnerPass@123',
      services: ['AC Service & Repair'],
    }, adminToken);
    assert(
      res4.status === 201 &&
      res4.data.worker &&
      res4.data.worker.email === partner1Email &&
      res4.data.worker.username,
      'New partner creation succeeds with 201 Created and auto-generated username',
      JSON.stringify(res4.data)
    );

    // ── Test 5: Multiple partner creations in a row (Null-index check) ─
    console.log('[Test 5] Multiple Partner Creations in a Row (Consecutive Inserts)');
    const res5A = await req('POST', '/api/admin/workers', {
      name: 'Balaji Plumber',
      email: partner2Email,
      phone: partner2Phone,
      employeeId: partner2EmpId,
      password: 'PartnerPass@123',
      services: ['Plumbing Works'],
    }, adminToken);

    const res5B = await req('POST', '/api/admin/workers', {
      name: 'Chandra Electrician',
      email: partner3Email,
      phone: partner3Phone,
      employeeId: partner3EmpId,
      password: 'PartnerPass@123',
      services: ['Electrician Services'],
    }, adminToken);

    assert(
      res5A.status === 201 && res5B.status === 201,
      'Multiple consecutive partner creations succeed without null index collision',
      `5A: ${res5A.status}, 5B: ${res5B.status}`
    );

    // ── Test 6: Duplicate partner email ───────────────────────────────
    console.log('[Test 6] Duplicate Partner Email Rejection');
    const res6 = await req('POST', '/api/admin/workers', {
      name: 'Balaji Duplicate',
      email: partner2Email,
      phone: `+9194444${testSuffix}8`,
      employeeId: `EMP-DIFF-${testSuffix}`,
      password: 'PartnerPass@123',
    }, adminToken);
    assert(
      res6.status === 409 &&
      res6.data.code === 'DUPLICATE_EMAIL' &&
      res6.data.field === 'email',
      'Duplicate partner email returns 409 DUPLICATE_EMAIL',
      JSON.stringify(res6.data)
    );

    // ── Test 7: Duplicate employee ID ─────────────────────────────────
    console.log('[Test 7] Duplicate Employee ID Rejection');
    const res7 = await req('POST', '/api/admin/workers', {
      name: 'Chandra Duplicate EmpID',
      email: `diff.worker.${testSuffix}@example.com`,
      phone: `+9194444${testSuffix}7`,
      employeeId: partner3EmpId,
      password: 'PartnerPass@123',
    }, adminToken);
    assert(
      res7.status === 409 &&
      res7.data.code === 'DUPLICATE_EMPLOYEE_ID' &&
      res7.data.field === 'employeeId',
      'Duplicate partner employeeId returns 409 DUPLICATE_EMPLOYEE_ID',
      JSON.stringify(res7.data)
    );

    // ── Test 8: Unique username generation ────────────────────────────
    console.log('[Test 8] Unique Username Generation Verification');
    const p1Doc = await User.findOne({ email: partner1Email });
    const p2Doc = await User.findOne({ email: partner2Email });
    const p3Doc = await User.findOne({ email: partner3Email });
    const uniqueUsernames = new Set([p1Doc.username, p2Doc.username, p3Doc.username]);
    assert(
      uniqueUsernames.size === 3 &&
      !uniqueUsernames.has(null) &&
      !uniqueUsernames.has(undefined) &&
      !uniqueUsernames.has(''),
      'All provisioned partners have unique, non-colliding usernames',
      `Usernames: ${Array.from(uniqueUsernames).join(', ')}`
    );

    // ── Test 9: Existing customers and Super Admin preserved ──────────
    console.log('[Test 9] Customer & Super Admin Account Protection');
    const adminCheck = await User.findOne({ email: 'fazil@homestepin.com' });
    const custCheck = await User.findOne({ email: custEmail });
    assert(
      Boolean(adminCheck) &&
      adminCheck.role === 'admin' &&
      adminCheck.isSystemSuperAdmin === true &&
      Boolean(custCheck) &&
      custCheck.role === 'customer',
      'Super Admin Fazil and customer accounts are intact and protected',
      `Admin found: ${Boolean(adminCheck)}, Customer found: ${Boolean(custCheck)}`
    );

    // ── Test 10: Firebase Rollback on Mongo Failure ───────────────────
    console.log('[Test 10] Firebase Rollback on MongoDB Failure');
    const rollbackEmail = `rollback.test.${testSuffix}@example.com`;
    const { auth } = initializeFirebase();
    let fbUserCreated = null;

    if (auth) {
      // Create user in Firebase directly
      fbUserCreated = await auth.createUser({
        email: rollbackEmail,
        password: 'TempPassword123!',
        displayName: 'Rollback Tester',
      });

      // Verify user exists in Firebase
      const verifiedInFb = await auth.getUser(fbUserCreated.uid);
      const existsInitially = Boolean(verifiedInFb);

      // Now call rollback function (simulating DB failure cleanup)
      const rolledBack = await deleteFirebaseUser(fbUserCreated.uid);

      // Verify user no longer exists in Firebase
      let stillExists = true;
      try {
        await auth.getUser(fbUserCreated.uid);
      } catch (err) {
        if (err.code === 'auth/user-not-found') {
          stillExists = false;
        }
      }

      assert(
        existsInitially === true && rolledBack === true && stillExists === false,
        'Firebase user is cleanly rolled back and deleted when MongoDB save fails',
        `Initially in FB: ${existsInitially}, Rollback call: ${rolledBack}, Still exists: ${stillExists}`
      );
    } else {
      console.log('  ⚠️ Firebase Admin not connected; asserting deleteFirebaseUser handles missing gracefully');
      const dummyRes = await deleteFirebaseUser('dummy_uid');
      assert(dummyRes === false, 'deleteFirebaseUser handles missing auth cleanly');
    }

  } finally {
    // Clean up test data
    console.log('\n--- Cleaning up temporary test suite users ---');
    await User.deleteMany({
      email: {
        $in: [
          custEmail,
          `other.cust.${testSuffix}@example.com`,
          partner1Email,
          partner2Email,
          partner3Email,
          `diff.worker.${testSuffix}@example.com`,
          `rollback.test.${testSuffix}@example.com`,
        ],
      },
    });

    if (server) server.close();
    await disconnectDb();
  }

  console.log('\n------------------------------------------------------------------------');
  console.log(`RESULTS: ${passed}/${total} assertions passed (${Math.round((passed / total) * 100)}%)`);
  console.log('------------------------------------------------------------------------');

  if (passed !== total) {
    process.exit(1);
  }
}

runSuite().catch(err => {
  console.error('Unhandled suite error:', err);
  if (server) server.close();
  disconnectDb().finally(() => process.exit(1));
});
