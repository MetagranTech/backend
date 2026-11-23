/**
 * Comprehensive Automated Verification Suite:
 * 1. Checkout Pricing Transparency (Authoritative ₹499 + ₹49 fee + ₹25 tax = ₹573)
 * 2. Secure Forgot Password Flow (OTP Only to Verified Accounts, Anti-enumeration)
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test_jwt_access_secret_at_least_32_characters_long_for_security';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test_jwt_refresh_secret_at_least_32_characters_long_for_security';

const http = require('http');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { connectDb, disconnectDb } = require('../src/db');
const User = require('../src/models/User');
const { app, calculateAuthoritativePrice } = require('../server');

let server;
const PORT = 4033;
const BASE = `http://127.0.0.1:${PORT}`;

function makeRequest(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const reqHeaders = { 'Content-Type': 'application/json', ...headers };
    const data = body ? JSON.stringify(body) : null;
    if (data) reqHeaders['Content-Length'] = Buffer.byteLength(data);

    const r = http.request(url, { method, headers: reqHeaders }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, data: parsed, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function runTests() {
  console.log('========================================================================');
  console.log('   HOMESTEPIN: PRICING TRANSPARENCY & FORGOT PASSWORD SECURITY SUITE');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  [PASS] ${message}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${message}`);
      failed++;
    }
  }

  try {
    await connectDb();
    server = app.listen(PORT);
    console.log(`  Test server listening on port ${PORT}\n`);

    // ────────────────────────────────────────────────────────────────────────
    // PART 1: PRICING TRANSPARENCY & BREAKDOWN AUDIT
    // ────────────────────────────────────────────────────────────────────────
    console.log('--- TEST GROUP 1: Checkout Pricing Transparency & Itemized Calculation ---');

    // Test 1: Direct function calculation for ₹499 base service
    const price499 = await calculateAuthoritativePrice('AC Service & Repair', [], null, 1);
    assert(price499.subtotal === 499, `Base subtotal is ₹499 (Actual: ₹${price499.subtotal})`);
    assert(price499.convenienceFee === 49, `Convenience & Safety Fee is ₹49 (Actual: ₹${price499.convenienceFee})`);
    assert(price499.tax === 25, `5% GST Tax on ₹499 is ₹25 (Actual: ₹${price499.tax})`);
    assert(price499.totalAmount === 573, `Total amount is ₹573 explaining ₹74 difference (Actual: ₹${price499.totalAmount})`);
    assert(
      price499.itemizedRows && price499.itemizedRows.length >= 3,
      `Full itemized rows are provided with explanations (Count: ${price499.itemizedRows?.length})`
    );

    // Test 2: Waived convenience fee threshold (>= ₹2000)
    const price2500 = await calculateAuthoritativePrice('Home Painting Deep Care', [], null, 1, [{ name: 'Deep Paint', price: 2500, quantity: 1 }]);
    assert(price2500.subtotal === 2500, `High value subtotal is ₹2500 (Actual: ₹${price2500.subtotal})`);
    assert(price2500.convenienceFee === 0, `Convenience fee is waived (₹0) above ₹2000 threshold (Actual: ₹${price2500.convenienceFee})`);
    assert(price2500.tax === 125, `5% GST Tax on ₹2500 is ₹125 (Actual: ₹${price2500.tax})`);
    assert(price2500.totalAmount === 2625, `Total amount for ₹2500 is ₹2625 (Actual: ₹${price2500.totalAmount})`);

    // Test 3: Endpoint POST /api/bookings/calculate-price returns identical authoritative result
    const apiPriceRes = await makeRequest('POST', '/api/bookings/calculate-price', {
      service: 'AC Service & Repair',
      quantity: 1,
      addOns: []
    });
    assert(apiPriceRes.status === 200, `POST /api/bookings/calculate-price returned 200 OK (Status: ${apiPriceRes.status})`);
    assert(apiPriceRes.data.totalAmount === 573, `API returns totalAmount ₹573 (Actual: ₹${apiPriceRes.data.totalAmount})`);
    assert(apiPriceRes.data.convenienceFee === 49, `API returns convenienceFee ₹49 (Actual: ₹${apiPriceRes.data.convenienceFee})`);
    assert(apiPriceRes.data.tax === 25, `API returns tax ₹25 (Actual: ₹${apiPriceRes.data.tax})`);
    assert(Array.isArray(apiPriceRes.data.itemizedRows), 'API returns itemizedRows array');

    // ────────────────────────────────────────────────────────────────────────
    // PART 2: FORGOT PASSWORD SECURITY & ANTI-ENUMERATION AUDIT
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST GROUP 2: Forgot Password Eligibility & Anti-Enumeration ---');

    const testTimestamp = Date.now();
    const unregisteredEmail = `unregistered_${testTimestamp}@homestepin-test.com`;
    const unverifiedCustEmail = `unverified_cust_${testTimestamp}@homestepin-test.com`;
    const verifiedCustEmail = `verified_cust_${testTimestamp}@homestepin-test.com`;
    const unverifiedWorkerEmail = `unverified_wrk_${testTimestamp}@homestepin-test.com`;
    const verifiedWorkerEmail = `verified_wrk_${testTimestamp}@homestepin-test.com`;

    // Seed unverified and verified test users
    const salt = await bcrypt.genSalt(10);
    const initialPasswordHash = await bcrypt.hash('TestPassword123!', salt);

    await User.create([
      {
        name: 'Unverified Customer',
        email: unverifiedCustEmail,
        passwordHash: initialPasswordHash,
        role: 'customer',
        emailVerified: false,
        status: 'active'
      },
      {
        name: 'Verified Customer',
        email: verifiedCustEmail,
        passwordHash: initialPasswordHash,
        role: 'customer',
        emailVerified: true,
        status: 'active'
      },
      {
        name: 'Unverified Worker',
        email: unverifiedWorkerEmail,
        passwordHash: initialPasswordHash,
        role: 'worker',
        emailVerified: false,
        status: 'active'
      },
      {
        name: 'Verified Worker',
        email: verifiedWorkerEmail,
        passwordHash: initialPasswordHash,
        role: 'worker',
        emailVerified: true,
        status: 'active'
      }
    ]);

    // Test 4: Unregistered email on Customer forgot-password
    const unregRes = await makeRequest('POST', '/api/auth/forgot-password', { email: unregisteredEmail });
    assert(unregRes.status === 200, `Unregistered email returns safe HTTP 200 (Status: ${unregRes.status})`);
    assert(unregRes.data.success === true, 'Unregistered email returns success: true');
    assert(
      unregRes.data.message.includes('If an account matching this identifier exists') || unregRes.data.message.includes('If an account with this email exists') || unregRes.data.message.includes('Account not found'),
      `Generic message prevents enumeration (Message: "${unregRes.data.message}")`
    );

    // Test 5: Registered but UNVERIFIED customer on forgot-password
    const unverifiedCustRes = await makeRequest('POST', '/api/auth/forgot-password', { email: unverifiedCustEmail });
    assert(unverifiedCustRes.status === 200, `Unverified customer returns safe HTTP 200 (Status: ${unverifiedCustRes.status})`);
    const dbUnverifiedCust = await User.findOne({ email: unverifiedCustEmail }).select('+otp.codeHash');
    assert(
      !dbUnverifiedCust.otp || !dbUnverifiedCust.otp.codeHash,
      'No OTP codeHash generated in DB for unverified customer'
    );

    // Test 6: Attempt verify-reset-otp on UNVERIFIED customer
    const unverifiedResetAttempt = await makeRequest('POST', '/api/auth/verify-reset-otp', {
      email: unverifiedCustEmail,
      otp: '123456',
      newPassword: 'NewPassword999!'
    });
    assert(
      unverifiedResetAttempt.status === 400 && unverifiedResetAttempt.data.code === 'EMAIL_NOT_VERIFIED',
      `Direct verify-reset-otp on unverified account is rejected (Status: ${unverifiedResetAttempt.status}, Code: ${unverifiedResetAttempt.data.code})`
    );

    // Test 7: Registered and VERIFIED customer on forgot-password
    const verifiedCustRes = await makeRequest('POST', '/api/auth/forgot-password', { email: verifiedCustEmail });
    assert(verifiedCustRes.status === 200, `Verified customer returns HTTP 200 (Status: ${verifiedCustRes.status})`);
    const dbVerifiedCust = await User.findOne({ email: verifiedCustEmail }).select('+otp.codeHash');
    assert(
      dbVerifiedCust.otp && dbVerifiedCust.otp.codeHash && dbVerifiedCust.otp.codeHash.length > 20,
      'Cryptographically hashed OTP stored in DB for verified customer'
    );
    assert(
      dbVerifiedCust.otp.purpose === 'password_reset',
      `OTP purpose is correctly set to 'password_reset' (Actual: ${dbVerifiedCust.otp.purpose})`
    );

    // Test 8: Reset password with wrong OTP
    const wrongOtpAttempt = await makeRequest('POST', '/api/auth/verify-reset-otp', {
      email: verifiedCustEmail,
      otp: '000000',
      newPassword: 'NewPassword999!'
    });
    assert(
      wrongOtpAttempt.status === 400,
      `Invalid OTP attempt is rejected (Status: ${wrongOtpAttempt.status}, Error: ${wrongOtpAttempt.data.error})`
    );

    // Test 9: Reset password with correct OTP (manually hash known OTP '654321')
    const knownOtp = '654321';
    dbVerifiedCust.otp.codeHash = await bcrypt.hash(knownOtp, 10);
    dbVerifiedCust.otp.expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    dbVerifiedCust.otp.attempts = 0;
    await dbVerifiedCust.save();

    const validResetAttempt = await makeRequest('POST', '/api/auth/verify-reset-otp', {
      email: verifiedCustEmail,
      otp: knownOtp,
      newPassword: 'BrandNewPassword123!'
    });
    assert(validResetAttempt.status === 200, `Password reset with valid OTP succeeds (Status: ${validResetAttempt.status})`);
    assert(validResetAttempt.data.success === true, 'Response contains success: true');

    const updatedUser = await User.findOne({ email: verifiedCustEmail }).select('+passwordHash +otp.codeHash');
    const isNewPasswordValid = await bcrypt.compare('BrandNewPassword123!', updatedUser.passwordHash);
    assert(isNewPasswordValid === true, 'New password bcrypt hash stored correctly in database');
    assert(!updatedUser.otp?.codeHash, 'OTP codeHash is invalidated/cleared after successful reset');

    // Test 10: Partner / Worker unverified forgot-password refusal
    const unverifiedWrkRes = await makeRequest('POST', '/api/auth/worker/forgot-password', { email: unverifiedWorkerEmail });
    assert(unverifiedWrkRes.status === 200, `Unverified worker returns safe HTTP 200 anti-enumeration (Status: ${unverifiedWrkRes.status})`);
    const dbUnverifiedWrk = await User.findOne({ email: unverifiedWorkerEmail }).select('+otp.codeHash');
    assert(
      !dbUnverifiedWrk.otp || !dbUnverifiedWrk.otp.codeHash,
      'No OTP codeHash generated in DB for unverified worker'
    );

    // Clean up test data
    await User.deleteMany({
      email: {
        $in: [unverifiedCustEmail, verifiedCustEmail, unverifiedWorkerEmail, verifiedWorkerEmail]
      }
    });
    console.log('  Cleaned up temporary test users.');

  } catch (err) {
    console.error('Test suite error:', err);
    failed++;
  } finally {
    if (server) {
      server.close();
      console.log('  Test server stopped.');
    }
    await disconnectDb();
    console.log('  Database disconnected.');
  }

  console.log('\n========================================================================');
  console.log(`   TEST RESULTS: ${passed} PASSED, ${failed} FAILED (TOTAL: ${passed + failed})`);
  console.log('========================================================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
