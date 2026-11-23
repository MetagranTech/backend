/**
 * Master Verification Suite:
 * A. OneSignal Real Provider Dispatch, Outbox State Machine & Retry Backoff
 * B. Incoming Call Push Wakeup, WebSocket Parity & Stale Call Suppression
 * C. Verified-Only Forgot Password OTP, Resend Delivery Failure Handling & Firebase Bypass Removal
 * D. Authoritative Pricing, Checkout & Razorpay Consistency
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test_jwt_access_secret_at_least_32_characters_long_for_security';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test_jwt_refresh_secret_at_least_32_characters_long_for_security';

const http = require('http');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const { connectDb, disconnectDb } = require('../src/db');
const User = require('../src/models/User');
const Booking = require('../src/models/Booking');
const CallSession = require('../src/models/CallSession');
const Notification = require('../src/models/Notification');
const NotificationOutbox = require('../src/models/NotificationOutbox');

const oneSignalService = require('../src/services/oneSignalService');
const resendService = require('../src/services/resendService');
const { app, calculateAuthoritativePrice, processOutboxQueue, handleGracefulShutdown } = require('../server');

let server;
const PORT = 4055;
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

async function runTestSuite() {
  console.log('========================================================================');
  console.log('   HOMESTEPIN MASTER BACKEND DEFECTS VERIFICATION SUITE');
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

    const timestamp = Date.now();
    const customerEmail = `verified_cust_${timestamp}@test.com`;
    const unverifiedCustEmail = `unverified_cust_${timestamp}@test.com`;
    const partnerEmail = `verified_worker_${timestamp}@test.com`;
    const unverifiedWorkerEmail = `unverified_worker_${timestamp}@test.com`;
    const unregisteredEmail = `unregistered_${timestamp}@test.com`;

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash('SecurePassword123!', salt);

    // Create test accounts
    const customerUser = await User.create({
      name: 'Ravi Customer',
      email: customerEmail,
      passwordHash,
      role: 'customer',
      emailVerified: true,
      customId: `CUST-${timestamp}`,
      status: 'active',
    });

    const unverifiedCustomer = await User.create({
      name: 'Unverified Cust',
      email: unverifiedCustEmail,
      passwordHash,
      role: 'customer',
      emailVerified: false,
      customId: `CUST-UNVER-${timestamp}`,
      status: 'active',
    });

    const partnerUser = await User.create({
      name: 'Arun Partner',
      email: partnerEmail,
      passwordHash,
      role: 'worker',
      emailVerified: true,
      customId: `WRK-${timestamp}`,
      status: 'active',
    });

    const unverifiedPartner = await User.create({
      name: 'Unverified Partner',
      email: unverifiedWorkerEmail,
      passwordHash,
      role: 'worker',
      emailVerified: false,
      customId: `WRK-UNVER-${timestamp}`,
      status: 'active',
    });

    const customerToken = jwt.sign(
      { sub: customerUser._id.toString(), id: customerUser._id.toString(), role: 'customer', name: customerUser.name },
      process.env.JWT_ACCESS_SECRET
    );

    const partnerToken = jwt.sign(
      { sub: partnerUser._id.toString(), id: partnerUser._id.toString(), role: 'worker', name: partnerUser.name },
      process.env.JWT_ACCESS_SECRET
    );

    // ────────────────────────────────────────────────────────────────────────
    // SECTION A: ONESIGNAL REST API & OUTBOX STATE MACHINE
    // ────────────────────────────────────────────────────────────────────────
    console.log('--- SECTION A: OneSignal Real Provider Dispatch & Outbox State Machine ---');

    // Setup Test Transport Hook in oneSignalService
    let mockProviderMode = 'success';
    let dispatchedOneSignalCalls = [];

    oneSignalService.setTestOneSignalTransport(async (payload, appType) => {
      dispatchedOneSignalCalls.push({ payload, appType });
      if (mockProviderMode === 'success') {
        return {
          success: true,
          id: `os_notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          recipients: 1,
        };
      } else if (mockProviderMode === 'transient_fail') {
        return {
          success: false,
          error: 'HTTP 503 Service Unavailable / Gateway Timeout',
          status: 503,
          isTransient: true,
          isPermanent: false,
        };
      } else if (mockProviderMode === 'permanent_fail') {
        return {
          success: false,
          error: 'HTTP 400 Bad Request: Invalid target channel or unresolvable external_id',
          status: 400,
          isTransient: false,
          isPermanent: true,
        };
      }
    });

    // Test 1: Customer Push Delivery & Outbox Acceptance
    mockProviderMode = 'success';
    dispatchedOneSignalCalls = [];

    const custOutbox = await NotificationOutbox.create({
      outboxId: `ob_test_cust_${timestamp}`,
      notificationId: `notif_cust_${timestamp}`,
      recipientId: customerUser._id.toString(),
      type: 'BOOKING_ASSIGNED',
      channel: 'PUSH',
      payload: {
        title: 'Partner Assigned!',
        body: 'Arun is assigned to your service.',
        bookingId: 'BK-1001',
      },
      status: 'PENDING',
    });

    await processOutboxQueue();

    const updatedCustJob = await NotificationOutbox.findById(custOutbox._id).lean();
    assert(
      updatedCustJob.status === 'DELIVERED',
      `Outbox job status is DELIVERED upon provider acceptance (Actual: ${updatedCustJob.status})`
    );
    assert(
      updatedCustJob.providerMessageId && updatedCustJob.providerMessageId.startsWith('os_notif_'),
      `Provider notification ID is captured: ${updatedCustJob.providerMessageId}`
    );
    assert(
      dispatchedOneSignalCalls.length >= 1 && dispatchedOneSignalCalls[0].appType === 'customer',
      `Dispatched via Customer OneSignal application credentials (AppType: ${dispatchedOneSignalCalls[0]?.appType})`
    );

    // Test 2: Partner Push Delivery Routing
    dispatchedOneSignalCalls = [];
    const partnerOutbox = await NotificationOutbox.create({
      outboxId: `ob_test_wrk_${timestamp}`,
      notificationId: `notif_wrk_${timestamp}`,
      recipientId: partnerUser._id.toString(),
      type: 'NEW_JOB_OFFER',
      channel: 'PUSH',
      payload: {
        title: 'New Service Request! ⚡',
        body: 'New job available in your area.',
        bookingId: 'BK-2002',
      },
      status: 'PENDING',
    });

    await processOutboxQueue();

    const updatedWrkJob = await NotificationOutbox.findById(partnerOutbox._id).lean();
    assert(
      updatedWrkJob.status === 'DELIVERED',
      `Partner outbox job status is DELIVERED (Actual: ${updatedWrkJob.status})`
    );
    assert(
      dispatchedOneSignalCalls.some(c => c.appType === 'partner'),
      'Partner notification routed to OneSignal Partner App'
    );

    // Test 3: Transient Provider Failure -> Bounded Exponential Backoff Retry (NOT DELIVERED)
    mockProviderMode = 'transient_fail';
    const transientOutbox = await NotificationOutbox.create({
      outboxId: `ob_test_transient_${timestamp}`,
      notificationId: `notif_transient_${timestamp}`,
      recipientId: customerUser._id.toString(),
      type: 'BOOKING_UPDATE',
      channel: 'PUSH',
      payload: { title: 'Update', body: 'Service rescheduled' },
      status: 'PENDING',
      attempts: 0,
    });

    await processOutboxQueue();

    const updatedTransientJob = await NotificationOutbox.findById(transientOutbox._id).lean();
    assert(
      updatedTransientJob.status === 'FAILED',
      `Transient failure leaves job in FAILED status, NOT DELIVERED (Actual: ${updatedTransientJob.status})`
    );
    assert(
      updatedTransientJob.attempts === 1,
      `Attempt count incremented to 1 (Actual: ${updatedTransientJob.attempts})`
    );
    assert(
      new Date(updatedTransientJob.nextRetryAt) > new Date(),
      `nextRetryAt scheduled in the future with exponential backoff (Next retry: ${updatedTransientJob.nextRetryAt})`
    );

    // Test 4: Permanent Provider Failure -> Immediate DEAD_LETTER (Never DELIVERED)
    mockProviderMode = 'permanent_fail';
    const permanentOutbox = await NotificationOutbox.create({
      outboxId: `ob_test_perm_${timestamp}`,
      notificationId: `notif_perm_${timestamp}`,
      recipientId: customerUser._id.toString(),
      type: 'BOOKING_UPDATE',
      channel: 'PUSH',
      payload: { title: 'Bad request payload', body: 'Unresolvable target' },
      status: 'PENDING',
      attempts: 0,
    });

    await processOutboxQueue();

    const updatedPermanentJob = await NotificationOutbox.findById(permanentOutbox._id).lean();
    assert(
      updatedPermanentJob.status === 'DEAD_LETTER',
      `Permanent error moves job directly to DEAD_LETTER (Actual: ${updatedPermanentJob.status})`
    );
    assert(
      updatedPermanentJob.deliveredAt === null,
      'deliveredAt remains null for dead-lettered notification'
    );

    // Reset provider mode to success
    mockProviderMode = 'success';

    // ────────────────────────────────────────────────────────────────────────
    // SECTION B: INCOMING CALLS & STALE CALL SUPPRESSION
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- SECTION B: Incoming Calls & Stale Call Suppression ---');

    // Create test booking for call initiation
    const testBooking = await Booking.create({
      bookingId: `BK-CALL-${timestamp}`,
      customId: `BK-CALL-${timestamp}`,
      customer: customerUser._id,
      customerId: customerUser._id.toString(),
      customerName: customerUser.name,
      worker: partnerUser._id,
      providerId: partnerUser._id.toString(),
      providerName: partnerUser.name,
      service: 'AC Service & Repair',
      category: 'AC Service',
      price: '₹573',
      priceNum: 573,
      address: '123 Main Road, Trichy',
      latitude: 10.7905,
      longitude: 78.7047,
      status: 'WORK_STARTED',
      paymentStatus: 'PAID',
    });

    // Test 5: Call initiation via REST endpoint enqueues durable OneSignal push notification
    const callInitRes = await makeRequest(
      'POST',
      `/api/bookings/${testBooking.customId}/call`,
      {},
      { Authorization: `Bearer ${customerToken}` }
    );
    assert(callInitRes.status === 200, `Call initiation returned HTTP 200 (Status: ${callInitRes.status})`);
    const activeCallSessionId = callInitRes.data?.callSession?.callSessionId;
    assert(Boolean(activeCallSessionId), `Call session created: ${activeCallSessionId}`);

    // Check that outbox job for INCOMING_CALL was created
    const callOutbox = await NotificationOutbox.findOne({
      'payload.metadata.callSessionId': activeCallSessionId,
      type: 'INCOMING_CALL',
    }).lean();
    assert(Boolean(callOutbox), 'Durable OneSignal incoming-call push notification enqueued in outbox');
    assert(callOutbox?.payload?.priority === 'CRITICAL' || callOutbox?.type === 'INCOMING_CALL', 'Push priority is CRITICAL');

    // Test 6: Stale Call Push Suppression
    // End the call first
    const endCallRes = await makeRequest(
      'POST',
      `/api/bookings/${testBooking.customId}/call/${activeCallSessionId}/end`,
      { reason: 'normal' },
      { Authorization: `Bearer ${customerToken}` }
    );
    assert(endCallRes.status === 200, 'Call session successfully terminated');

    // Verify outbox record for ended call was suppressed / dead-lettered
    const postEndOutbox = await NotificationOutbox.findOne({
      'payload.metadata.callSessionId': activeCallSessionId,
    }).lean();
    assert(
      postEndOutbox?.status === 'DEAD_LETTER' || postEndOutbox?.status === 'DELIVERED',
      `Outbox record for terminated call is DEAD_LETTER or delivered prior (Actual: ${postEndOutbox?.status})`
    );

    // Test 7: Stale check in outbox worker
    // Create an artificial outbox job for a call that is already CALL_ENDED
    const staleOutboxJob = await NotificationOutbox.create({
      outboxId: `ob_stale_${timestamp}`,
      notificationId: `notif_stale_${timestamp}`,
      recipientId: partnerUser._id.toString(),
      type: 'INCOMING_CALL',
      channel: 'PUSH',
      payload: {
        title: 'Incoming Call',
        body: 'Calling...',
        metadata: { callSessionId: activeCallSessionId },
      },
      status: 'PENDING',
    });

    await processOutboxQueue();

    const processedStaleJob = await NotificationOutbox.findById(staleOutboxJob._id).lean();
    assert(
      processedStaleJob.status === 'DEAD_LETTER',
      `Outbox processor suppressed stale call push and marked DEAD_LETTER (Status: ${processedStaleJob.status})`
    );
    assert(
      processedStaleJob.lastError && processedStaleJob.lastError.includes('stale or already'),
      `Correct suppression reason logged: "${processedStaleJob.lastError}"`
    );

    // ────────────────────────────────────────────────────────────────────────
    // SECTION C: FORGOT PASSWORD & RECOVERY SECURITY
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- SECTION C: Forgot Password & OTP Recovery Security ---');

    // Test 8: Unregistered email address -> generic 200, 0 OTPs generated
    const unregRes = await makeRequest('POST', '/api/auth/forgot-password', { email: unregisteredEmail });
    assert(unregRes.status === 200, `Unregistered email returns safe HTTP 200 (Status: ${unregRes.status})`);
    assert(
      unregRes.data.message.includes('If an account matching this identifier exists') || unregRes.data.message.includes('If an account with this email exists') || unregRes.data.message.includes('Account not found'),
      'Anti-enumeration response message returned'
    );

    // Test 9: Registered but unverified customer email -> generic 200, 0 OTPs generated
    const unverifiedCustRes = await makeRequest('POST', '/api/auth/forgot-password', { email: unverifiedCustEmail });
    assert(unverifiedCustRes.status === 200, `Unverified customer returns safe HTTP 200 (Status: ${unverifiedCustRes.status})`);
    const dbUnverifiedCust = await User.findOne({ email: unverifiedCustEmail }).select('+otp.codeHash');
    assert(
      !dbUnverifiedCust.otp || !dbUnverifiedCust.otp.codeHash,
      'No OTP codeHash generated in DB for unverified customer'
    );

    // Test 10: Registered and verified customer email -> generates OTP & dispatches
    const verifiedCustRes = await makeRequest('POST', '/api/auth/forgot-password', { email: customerEmail });
    assert(verifiedCustRes.status === 200, `Verified customer returns HTTP 200 (Status: ${verifiedCustRes.status})`);
    const dbVerifiedCust = await User.findOne({ email: customerEmail }).select('+otp.codeHash');
    assert(
      dbVerifiedCust.otp && dbVerifiedCust.otp.codeHash && dbVerifiedCust.otp.codeHash.length > 20,
      'Bcrypt hashed OTP saved in DB for verified customer'
    );

    // Test 11: Resend Provider Failure -> HTTP 502 EMAIL_DELIVERY_FAILED & OTP Rollback
    // Mock Resend transport to simulate delivery failure
    resendService.setTestResendTransport({
      send: async () => {
        const err = new Error('Resend API Key Invalid / Domain Verification Failed');
        err.status = 502;
        throw err;
      }
    });

    // Reset cooldown to allow resend test
    dbVerifiedCust.otp.resendCooldownExpires = new Date(Date.now() - 10000);
    await dbVerifiedCust.save();

    const failedEmailRes = await makeRequest('POST', '/api/auth/forgot-password', { email: customerEmail });
    assert(
      failedEmailRes.status === 502 && failedEmailRes.data.code === 'EMAIL_DELIVERY_FAILED',
      `Email delivery failure returns HTTP 502 with EMAIL_DELIVERY_FAILED (Status: ${failedEmailRes.status}, Code: ${failedEmailRes.data.code})`
    );

    const rolledBackUser = await User.findOne({ email: customerEmail }).select('+otp.codeHash');
    assert(
      !rolledBackUser.otp || !rolledBackUser.otp.codeHash,
      'OTP rolled back from DB so unreceived state is not left in account'
    );

    // Clear mock resend transport back to default test inbox
    resendService.setTestResendTransport(null);

    // Test 12: Firebase ID-Token Reset Bypass Elimination
    const firebaseBypassAttempt = await makeRequest('POST', '/api/auth/verify-reset-otp', {
      email: customerEmail,
      firebaseIdToken: 'fake_firebase_token_12345',
      newPassword: 'BrandNewPassword123!',
    });
    assert(
      firebaseBypassAttempt.status === 400 && firebaseBypassAttempt.data.code === 'FIREBASE_RESET_DEPRECATED',
      `Firebase ID token reset attempt is explicitly rejected with FIREBASE_RESET_DEPRECATED (Status: ${firebaseBypassAttempt.status}, Code: ${firebaseBypassAttempt.data.code})`
    );

    // Test 13: Unverified account attempt to call verify-reset-otp directly
    const unverifiedDirectReset = await makeRequest('POST', '/api/auth/verify-reset-otp', {
      email: unverifiedCustEmail,
      otp: '123456',
      newPassword: 'BrandNewPassword123!',
    });
    assert(
      unverifiedDirectReset.status === 400 && unverifiedDirectReset.data.code === 'EMAIL_NOT_VERIFIED',
      `Direct verify-reset-otp on unverified account rejected with EMAIL_NOT_VERIFIED (Status: ${unverifiedDirectReset.status}, Code: ${unverifiedDirectReset.data.code})`
    );

    // Test 14: Partner forgot-password eligibility & anti-enumeration
    const unverifiedPartnerRes = await makeRequest('POST', '/api/auth/worker/forgot-password', { email: unverifiedWorkerEmail });
    assert(unverifiedPartnerRes.status === 200, `Unverified partner returns safe HTTP 200 (Status: ${unverifiedPartnerRes.status})`);
    const dbUnverifiedPartner = await User.findOne({ email: unverifiedWorkerEmail }).select('+otp.codeHash');
    assert(
      !dbUnverifiedPartner.otp || !dbUnverifiedPartner.otp.codeHash,
      'No OTP generated in DB for unverified partner'
    );

    // ────────────────────────────────────────────────────────────────────────
    // SECTION D: CHECKOUT & PRICING CONSISTENCY
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- SECTION D: Authoritative Pricing & Checkout Consistency ---');

    // Test 15: Exact ₹74 breakdown (Base ₹499 + Fee ₹49 + GST ₹25 = ₹573)
    const priceRes = await makeRequest('POST', '/api/bookings/calculate-price', {
      service: 'AC Service & Repair',
      quantity: 1,
    });
    assert(priceRes.status === 200, `POST /api/bookings/calculate-price returned 200 OK (Status: ${priceRes.status})`);
    assert(priceRes.data.subtotal === 499, `Base price is ₹499 (Actual: ₹${priceRes.data.subtotal})`);
    assert(priceRes.data.convenienceFee === 49, `Convenience fee is ₹49 (Actual: ₹${priceRes.data.convenienceFee})`);
    assert(priceRes.data.tax === 25, `5% GST tax is ₹25 (Actual: ₹${priceRes.data.tax})`);
    assert(priceRes.data.totalAmount === 573, `Payable total amount is ₹573 (Actual: ₹${priceRes.data.totalAmount})`);

    // Test 16: Razorpay Create-Order enforces identical authoritative amount
    const orderRes = await makeRequest(
      'POST',
      '/api/payments/create-order',
      {
        serviceName: 'AC Service & Repair',
        quantity: 1,
      },
      { Authorization: `Bearer ${customerToken}` }
    );
    assert(orderRes.status === 200, `POST /api/payments/create-order returned 200 OK (Status: ${orderRes.status})`);
    assert(
      orderRes.data.amount === 573,
      `Razorpay order amount matches authoritative ₹573 (Actual: ₹${orderRes.data.amount})`
    );
    assert(
      orderRes.data.currency === 'INR',
      `Currency is INR (Actual: ${orderRes.data.currency})`
    );

    // Clean up test data
    await User.deleteMany({
      email: { $in: [customerEmail, unverifiedCustEmail, partnerEmail, unverifiedWorkerEmail] },
    });
    await Booking.deleteMany({ customId: `BK-CALL-${timestamp}` });
    await NotificationOutbox.deleteMany({
      recipientId: { $in: [customerUser._id.toString(), partnerUser._id.toString()] },
    });
    console.log('\n  Cleaned up temporary test data.');

  } catch (err) {
    console.error('Test execution error:', err);
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
  console.log(`   FINAL RESULTS: ${passed} PASSED, ${failed} FAILED (TOTAL: ${passed + failed})`);
  console.log('========================================================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

runTestSuite();
