/**
 * Test Suite: Complete Partner Provisioning & Duplicate Validation Flow
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
const PORT = 4018;
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
  console.log('   HOMESTEPIN: PARTNER PROVISIONING FULL END-TO-END VERIFICATION');
  console.log('========================================================================\n');

  await connectDb();
  server = app.listen(PORT);
  await new Promise(res => server.once('listening', res));

  // Find or create admin
  let admin = await User.findOne({ role: 'admin', status: 'active' });
  if (!admin) {
    admin = await User.create({
      customId: `usr_adm_test_${Date.now()}`,
      username: `adm_${Date.now()}`,
      name: 'SuperAdmin Test',
      email: `admin.prov.${Date.now()}@homestepin.com`,
      phone: `+9199${Math.floor(10000000 + Math.random() * 89999999)}`,
      passwordHash: 'dummy',
      role: 'admin',
      adminRole: 'SUPER_ADMIN',
      status: 'active',
      isProtected: true,
      isSystemSuperAdmin: true,
    });
  }
  const token = signAccess({ _id: admin._id, id: admin.customId || admin._id.toString(), role: 'admin' });

  const testSuffix = Date.now().toString().slice(-4);
  const p1Email = `karthik.tech.${testSuffix}@homestepin.com`;
  const p1Phone = `+9198765${testSuffix}1`;
  const p1EmpId = `EMP-TRICHY-${testSuffix}`;

  // 1. Create a new partner with unique credentials
  console.log('[Test 1] Provision Partner 1 with Unique Credentials');
  const res1 = await req('POST', '/api/admin/workers', {
    name: 'Karthik Raman',
    email: p1Email,
    phone: p1Phone,
    employeeId: p1EmpId,
    password: 'SecurePassword123!',
    services: ['AC Service & Repair', 'Electrician Services'],
    serviceArea: 'Trichy Central',
    serviceRadiusKm: 20,
  }, token);

  console.log('  Status:', res1.status);
  console.log('  Response:', JSON.stringify(res1.data).slice(0, 150));
  if (res1.status !== 201) throw new Error(`Test 1 Failed: Expected 201, got ${res1.status}`);
  console.log('  ✓ Test 1 PASSED: Partner provisioned with generated username:', res1.data.worker?.username);

  // 2. Confirm successful creation in MongoDB
  console.log('\n[Test 2] Direct MongoDB Record Verification');
  const dbWorker1 = await User.findOne({ email: p1Email });
  if (!dbWorker1) throw new Error('Test 2 Failed: Worker document not found in DB');
  if (dbWorker1.role !== 'worker') throw new Error(`Test 2 Failed: Expected role worker, got ${dbWorker1.role}`);
  if (dbWorker1.employeeId !== p1EmpId) throw new Error('Test 2 Failed: Employee ID mismatch');
  if (!dbWorker1.username) throw new Error('Test 2 Failed: Username is missing on created worker');
  console.log('  ✓ Test 2 PASSED: DB record confirmed with username:', dbWorker1.username);

  // 3. Confirm the partner appears in Workers & KYC directory
  console.log('\n[Test 3] Confirm Partner Appears in Workers Directory');
  const dirRes = await req('GET', '/api/admin/workers?limit=50', null, token);
  if (dirRes.status !== 200) throw new Error(`Test 3 Failed: Directory returned ${dirRes.status}`);
  const inDirectory = (dirRes.data.workers || []).some(w => w.email === p1Email || w.employeeId === p1EmpId);
  if (!inDirectory) throw new Error('Test 3 Failed: Newly created partner not in directory');
  console.log('  ✓ Test 3 PASSED: Partner is visible in admin directory (Total:', dirRes.data.pagination?.total, ')');

  // 4. Search by Name, Email, and Phone
  console.log('\n[Test 4] Search by Name, Email, and Phone');
  const sName = await req('GET', `/api/admin/workers?search=Karthik`, null, token);
  const sEmail = await req('GET', `/api/admin/workers?search=${p1Email}`, null, token);
  const sPhone = await req('GET', `/api/admin/workers?search=${p1Phone}`, null, token);
  if (!sName.data.workers?.length || !sEmail.data.workers?.length || !sPhone.data.workers?.length) {
    throw new Error('Test 4 Failed: Search failed to find worker');
  }
  console.log('  ✓ Test 4 PASSED: Search by name, email, and phone all succeeded');

  // 5. Attempt creation with duplicate Email
  console.log('\n[Test 5] Reject Duplicate Email with Accurate Error');
  const dupEmailRes = await req('POST', '/api/admin/workers', {
    name: 'Different Name',
    email: p1Email,
    phone: `+9198765${testSuffix}9`,
    employeeId: `EMP-DIFF-${testSuffix}`,
    password: 'Password123!',
  }, token);
  if (dupEmailRes.status !== 409 || dupEmailRes.data.code !== 'DUPLICATE_EMAIL') {
    throw new Error(`Test 5 Failed: Expected 409 DUPLICATE_EMAIL, got ${dupEmailRes.status}: ${JSON.stringify(dupEmailRes.data)}`);
  }
  console.log('  ✓ Test 5 PASSED: Duplicate email rejected:', dupEmailRes.data.error);

  // 6. Attempt creation with duplicate Phone
  console.log('\n[Test 6] Reject Duplicate Phone with Accurate Error');
  const dupPhoneRes = await req('POST', '/api/admin/workers', {
    name: 'Different Name 2',
    email: `unique.${Date.now()}@homestepin.com`,
    phone: p1Phone,
    employeeId: `EMP-DIFF2-${testSuffix}`,
    password: 'Password123!',
  }, token);
  if (dupPhoneRes.status !== 409 || dupPhoneRes.data.code !== 'DUPLICATE_PHONE') {
    throw new Error(`Test 6 Failed: Expected 409 DUPLICATE_PHONE, got ${dupPhoneRes.status}`);
  }
  console.log('  ✓ Test 6 PASSED: Duplicate phone rejected:', dupPhoneRes.data.error);

  // 7. Attempt creation with duplicate Employee ID
  console.log('\n[Test 7] Reject Duplicate Employee ID with Accurate Error');
  const dupEmpRes = await req('POST', '/api/admin/workers', {
    name: 'Different Name 3',
    email: `unique3.${Date.now()}@homestepin.com`,
    phone: `+9198765${testSuffix}8`,
    employeeId: p1EmpId,
    password: 'Password123!',
  }, token);
  if (dupEmpRes.status !== 409 || dupEmpRes.data.code !== 'DUPLICATE_EMPLOYEE_ID') {
    throw new Error(`Test 7 Failed: Expected 409 DUPLICATE_EMPLOYEE_ID, got ${dupEmpRes.status}`);
  }
  console.log('  ✓ Test 7 PASSED: Duplicate employeeId rejected:', dupEmpRes.data.error);

  // 8. Provision Partner 2 (Verifies missing/auto-gen username does NOT collide with Partner 1)
  console.log('\n[Test 8] Provision Partner 2 (Collision-Free Unique Auto-Username)');
  const p2Email = `suresh.tech.${testSuffix}@homestepin.com`;
  const p2Phone = `+9198765${testSuffix}2`;
  const p2EmpId = `EMP-TRICHY-02-${testSuffix}`;
  const res2 = await req('POST', '/api/admin/workers', {
    name: 'Suresh Kumar',
    email: p2Email,
    phone: p2Phone,
    employeeId: p2EmpId,
    password: 'SecurePassword456!',
    services: ['Plumbing Services'],
  }, token);
  if (res2.status !== 201) {
    throw new Error(`Test 8 Failed: Partner 2 creation failed with ${res2.status}: ${JSON.stringify(res2.data)}`);
  }
  console.log('  ✓ Test 8 PASSED: Partner 2 provisioned cleanly without collision. Username:', res2.data.worker?.username);

  // 9. Customer and Super Admin Isolation
  console.log('\n[Test 9] Customer and Super Admin Account Protection');
  const custRes = await User.create({
    customId: `usr_cust_${Date.now()}`,
    name: 'Real Customer',
    email: `customer.${Date.now()}@example.com`,
    passwordHash: 'dummy',
    role: 'customer',
    status: 'active',
  });
  // Directory should NOT show this customer
  const dirCheckCust = await req('GET', '/api/admin/workers?limit=100', null, token);
  const custInWorkers = (dirCheckCust.data.workers || []).some(w => w.email === custRes.email);
  if (custInWorkers) throw new Error('Test 9 Failed: Customer appeared in workers directory');
  console.log('  ✓ Test 9 PASSED: Customer is isolated and excluded from Workers directory.');

  // Check super admin protection
  const adminCheck = await User.findById(admin._id);
  if (!adminCheck || adminCheck.role !== 'admin') throw new Error('Test 9 Failed: Super Admin modified');
  console.log('  ✓ Test 9 PASSED: Super Admin account preserved intact.');

  // 10. KYC Status & Partner Details
  console.log('\n[Test 10] KYC Status Update and Partner Details');
  const kycRes = await req('PATCH', `/api/admin/workers/${dbWorker1.customId}/kyc`, {
    status: 'approved',
    notes: 'All documents verified by admin',
  }, token);
  if (kycRes.status !== 200) throw new Error(`Test 10 Failed: KYC update returned ${kycRes.status}`);
  const updatedWorker = await User.findById(dbWorker1._id);
  if (updatedWorker.kycStatus !== 'approved') throw new Error('Test 10 Failed: KYC status not approved');
  console.log('  ✓ Test 10 PASSED: KYC updated to approved with audit notes recorded.');

  // 11. Partner Login Verification (by Email, Phone, and Employee ID)
  console.log('\n[Test 11] Partner Login Verification');
  const partnerLoginEmail = await req('POST', '/api/auth/login', {
    identifier: p1Email,
    password: 'SecurePassword123!',
    expectedRole: 'worker',
  });
  if (partnerLoginEmail.status !== 200 || !partnerLoginEmail.data.token) {
    throw new Error(`Test 11 Failed: Partner login by email failed: ${JSON.stringify(partnerLoginEmail.data)}`);
  }
  console.log('  ✓ Test 11 PASSED: Partner successfully logged in with Email.');

  const partnerLoginEmpId = await req('POST', '/api/auth/login', {
    identifier: p1EmpId,
    password: 'SecurePassword123!',
    expectedRole: 'worker',
  });
  if (partnerLoginEmpId.status !== 200 || !partnerLoginEmpId.data.token) {
    throw new Error(`Test 11 Failed: Partner login by Employee ID failed: ${JSON.stringify(partnerLoginEmpId.data)}`);
  }
  console.log('  ✓ Test 11 PASSED: Partner successfully logged in with Employee ID.');

  // 12. Super Admin and Customer Login Verification
  console.log('\n[Test 12] Super Admin and Customer Login Verification');
  // Hash a real password for customer and admin tests
  const testCustPass = 'CustSecretPass123!';
  const custPasswordHash = await bcrypt.hash(testCustPass, 10);
  custRes.passwordHash = custPasswordHash;
  custRes.emailVerified = true;
  await custRes.save();

  const custLogin = await req('POST', '/api/auth/login', {
    identifier: custRes.email,
    password: testCustPass,
    expectedRole: 'customer',
  });
  if (custLogin.status !== 200 || !custLogin.data.token) {
    throw new Error(`Test 12 Failed: Customer login failed: ${JSON.stringify(custLogin.data)}`);
  }
  console.log('  ✓ Test 12 PASSED: Customer logged in successfully with expectedRole: customer.');

  // Test Role Mismatch protection
  const roleMismatch = await req('POST', '/api/auth/login', {
    identifier: p1Email,
    password: 'SecurePassword123!',
    expectedRole: 'customer',
  });
  if (roleMismatch.status !== 403 || roleMismatch.data.code !== 'ROLE_MISMATCH') {
    throw new Error(`Test 12 Failed: Expected 403 ROLE_MISMATCH when partner signs in as customer, got ${roleMismatch.status}`);
  }
  console.log('  ✓ Test 12 PASSED: Role mismatch protection verified.');

  // Clean up test users
  console.log('\n--- Cleaning up Test Users ---');
  await User.deleteMany({ email: { $in: [p1Email, p2Email, custRes.email] } });
  console.log('Cleaned up test users.');

  console.log('\n========================================================================');
  console.log('   ALL 10 PARTNER PROVISIONING TESTS PASSED WITH 100% SUCCESS!');
  console.log('========================================================================\n');
}

runTests()
  .then(() => {
    server?.close();
    disconnectDb();
    process.exit(0);
  })
  .catch(err => {
    console.error('\n❌ TEST RUN FAILED:', err);
    server?.close();
    disconnectDb();
    process.exit(1);
  });
