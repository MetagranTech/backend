/**
 * HomeStepIn — Flipkart-Style Coupon, Offers, Discount & Redemption System Test Suite
 *
 * Tests:
 * 1. Fixed Discounts (SAVE100)
 * 2. Percentage Discounts (SAVE20) with Maximum Discount Cap
 * 3. Minimum Order Value Threshold Validation
 * 4. First-Order Coupon (FIRST100) and Cross-Device Re-use Prevention
 * 5. Single-Use and Multi-Use Per Customer Limits
 * 6. Global Total Redemption Limits
 * 7. Reservation Lifecycle (10-minute hold, apply, remove, expire)
 * 8. Atomic Concurrency Protection (Parallel race condition guards)
 * 9. Booking Cancellation Rollback
 * 10. Admin Coupon Management & Analytics Endpoints
 * 11. Partner/Worker Auth Regression Check
 */

process.env.NODE_ENV = 'test';
process.env.PORT = '0'; // ephemeral port

const http = require('http');
const jwt = require('jsonwebtoken');
const { connectDb, disconnectDb } = require('./src/db');
const { app } = require('./server');
const Coupon = require('./src/models/Coupon');
const CouponUsage = require('./src/models/CouponUsage');
const Booking = require('./src/models/Booking');
const User = require('./src/models/User');
const config = require('./src/config');
const couponService = require('./src/services/couponService');

let server;
let baseUrl;
let passedAssertions = 0;
let failedAssertions = 0;

function assert(condition, description) {
  if (condition) {
    passedAssertions++;
    console.log(`  ✓ ${description}`);
  } else {
    failedAssertions++;
    console.error(`  ✗ FAIL: ${description}`);
  }
}

function makeRequest(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = http.request(
      url,
      {
        method,
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode, data: parsed });
        });
      }
    );

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function createTestToken(userId, role = 'customer', email = 'test@example.com') {
  return jwt.sign(
    { sub: userId, id: userId, role, email, name: 'Test User' },
    config.jwtAccessSecret,
    { expiresIn: '1h' }
  );
}

async function runTestSuite() {
  console.log('\n============================================================');
  console.log(' HomeStepIn — Flipkart-Style Coupon System E2E Test Suite');
  console.log('============================================================\n');

  try {
    await connectDb();
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // Clean up test records
    await Coupon.deleteMany({ code: { $in: ['TEST_SAVE100', 'TEST_SAVE20', 'TEST_FIRST100', 'TEST_GLOBAL2', 'TEST_MULTI2', 'TEST_MIN500'] } });
    await CouponUsage.deleteMany({ couponCode: { $in: ['TEST_SAVE100', 'TEST_SAVE20', 'TEST_FIRST100', 'TEST_GLOBAL2', 'TEST_MULTI2', 'TEST_MIN500'] } });
    await Booking.deleteMany({ customerId: { $regex: /^cust_coupon_/ } });
    await User.deleteMany({ email: { $regex: /coupon_test/ } });
    await User.deleteMany({ customId: { $in: ['admin_user_001', 'cust_coupon_1', 'cust_coupon_2', 'cust_coupon_3'] } });
    await User.create([
      { customId: 'admin_user_001', name: 'Coupon Admin', email: 'coupon_admin@homestepin.com', role: 'admin', isSystemSuperAdmin: true, status: 'active', passwordHash: 'hash' },
      { customId: 'cust_coupon_1', name: 'Coupon Cust 1', email: 'coupon_cust1@example.com', role: 'customer', status: 'active', passwordHash: 'hash' },
      { customId: 'cust_coupon_2', name: 'Coupon Cust 2', email: 'coupon_cust2@example.com', role: 'customer', status: 'active', passwordHash: 'hash' },
      { customId: 'cust_coupon_3', name: 'Coupon Cust 3', email: 'coupon_cust3@example.com', role: 'customer', status: 'active', passwordHash: 'hash' },
    ]);

    const adminToken = createTestToken('admin_user_001', 'admin', 'admin@homestepin.com');
    const customer1Token = createTestToken('cust_coupon_1', 'customer', 'customer1@example.com');
    const customer2Token = createTestToken('cust_coupon_2', 'customer', 'customer2@example.com');
    const customer3Token = createTestToken('cust_coupon_3', 'customer', 'customer3@example.com');

    // ──────────────────────────────────────────────────────────
    // 1. FIXED DISCOUNT (TEST_SAVE100)
    // ──────────────────────────────────────────────────────────
    console.log('[Test Group 1] Fixed Discount (TEST_SAVE100)');
    const createFlatRes = await makeRequest(
      'POST',
      '/api/admin/coupons',
      {
        code: 'TEST_SAVE100',
        title: 'Flat ₹100 OFF',
        discountType: 'flat',
        discountValue: 100,
        amount: 100,
        minOrderAmount: 300,
        usageLimit: 0,
        perUserLimit: 1,
      },
      adminToken
    );
    assert(createFlatRes.status === 201, 'Admin successfully creates TEST_SAVE100 coupon');

    // Validate coupon on ₹500 order
    const valFlat = await makeRequest(
      'POST',
      '/api/coupons/validate',
      { code: 'TEST_SAVE100', amount: 500 },
      customer1Token
    );
    assert(valFlat.status === 200 && valFlat.data.valid === true, 'TEST_SAVE100 is valid on ₹500 order');
    assert(valFlat.data.discount === 100, 'Discount is exactly ₹100');
    assert(valFlat.data.finalAmount === 400, 'Final subtotal is ₹400');

    // ──────────────────────────────────────────────────────────
    // 2. PERCENTAGE DISCOUNT (TEST_SAVE20) & MAX DISCOUNT CAP
    // ──────────────────────────────────────────────────────────
    console.log('\n[Test Group 2] Percentage Discount with Max Discount Cap (TEST_SAVE20)');
    const createPercentRes = await makeRequest(
      'POST',
      '/api/admin/coupons',
      {
        code: 'TEST_SAVE20',
        title: '20% Instant Discount',
        discountType: 'percentage',
        discountValue: 20,
        percent: 20,
        minOrderAmount: 200,
        maxDiscount: 150, // cap at ₹150
        usageLimit: 0,
        perUserLimit: 1,
      },
      adminToken
    );
    assert(createPercentRes.status === 201, 'Admin successfully creates TEST_SAVE20 coupon');

    // On ₹500 subtotal: 20% of 500 = 100 (below cap of 150)
    const valPercent1 = await makeRequest(
      'POST',
      '/api/coupons/validate',
      { code: 'TEST_SAVE20', amount: 500 },
      customer1Token
    );
    assert(valPercent1.status === 200 && valPercent1.data.discount === 100, '20% on ₹500 gives ₹100 discount');

    // On ₹1000 subtotal: 20% of 1000 = 200 -> capped at ₹150!
    const valPercentCap = await makeRequest(
      'POST',
      '/api/coupons/validate',
      { code: 'TEST_SAVE20', amount: 1000 },
      customer1Token
    );
    assert(valPercentCap.status === 200 && valPercentCap.data.discount === 150, '20% on ₹1000 is capped at maxDiscount of ₹150');

    // ──────────────────────────────────────────────────────────
    // 3. MINIMUM ORDER VALUE THRESHOLD
    // ──────────────────────────────────────────────────────────
    console.log('\n[Test Group 3] Minimum Order Value Threshold (TEST_MIN500)');
    await makeRequest(
      'POST',
      '/api/admin/coupons',
      {
        code: 'TEST_MIN500',
        title: '₹50 OFF on ₹500+',
        discountType: 'flat',
        discountValue: 50,
        minOrderAmount: 500,
      },
      adminToken
    );

    // Order of ₹400 should be rejected
    const valBelowMin = await makeRequest(
      'POST',
      '/api/coupons/validate',
      { code: 'TEST_MIN500', amount: 400 },
      customer1Token
    );
    assert(valBelowMin.status === 400 && valBelowMin.data.valid === false, 'Order below minOrderAmount is rejected');
    assert(valBelowMin.data.code === 'MIN_ORDER_NOT_MET', 'Returns MIN_ORDER_NOT_MET error code');

    // Order of ₹550 should be accepted
    const valAboveMin = await makeRequest(
      'POST',
      '/api/coupons/validate',
      { code: 'TEST_MIN500', amount: 550 },
      customer1Token
    );
    assert(valAboveMin.status === 200 && valAboveMin.data.valid === true, 'Order meeting minOrderAmount is accepted');

    // ──────────────────────────────────────────────────────────
    // 4. FIRST-ORDER COUPON (TEST_FIRST100) & CROSS-DEVICE RE-USE
    // ──────────────────────────────────────────────────────────
    console.log('\n[Test Group 4] First-Order Coupon (TEST_FIRST100)');
    const createFirstRes = await makeRequest(
      'POST',
      '/api/admin/coupons',
      {
        code: 'TEST_FIRST100',
        title: 'First Order Special ₹100 OFF',
        discountType: 'flat',
        discountValue: 100,
        amount: 100,
        minOrderAmount: 200,
        newCustomerOnly: true, // First order only!
        perUserLimit: 1,
      },
      adminToken
    );
    assert(createFirstRes.status === 201, 'Admin successfully creates first-order TEST_FIRST100 coupon');

    // Customer 1 has 0 bookings -> should succeed!
    const valFirstCustomer = await makeRequest(
      'POST',
      '/api/coupons/validate',
      { code: 'TEST_FIRST100', amount: 400 },
      customer1Token
    );
    assert(valFirstCustomer.status === 200 && valFirstCustomer.data.valid === true, 'New customer (0 bookings) can validate FIRST100');

    // Create a previous completed booking for Customer 2
    await Booking.create({
      customId: `BK-TEST-PRIOR-${Date.now()}`,
      customerId: 'cust_coupon_2',
      customerName: 'Customer Two',
      service: 'AC Service & Repair',
      category: 'Appliance Repair',
      address: '123 Main St, Trichy',
      latitude: 10.7905,
      longitude: 78.7047,
      price: '₹499',
      priceNum: 499,
      status: 'COMPLETED',
    });

    // Customer 2 has a prior completed booking -> must be rejected!
    const valExistingCustomer = await makeRequest(
      'POST',
      '/api/coupons/validate',
      { code: 'TEST_FIRST100', amount: 400 },
      customer2Token
    );
    assert(valExistingCustomer.status === 400 && valExistingCustomer.data.valid === false, 'Existing customer with prior booking is rejected for FIRST100');
    assert(valExistingCustomer.data.code === 'FIRST_ORDER_ONLY', 'Returns FIRST_ORDER_ONLY error code');

    // Re-login / cross-device check: customer2 trying with a newly minted token from another device
    const customer2NewDeviceToken = createTestToken('cust_coupon_2', 'customer', 'customer2@example.com');
    const valCrossDevice = await makeRequest(
      'POST',
      '/api/coupons/validate',
      { code: 'TEST_FIRST100', amount: 400 },
      customer2NewDeviceToken
    );
    assert(valCrossDevice.status === 400 && valCrossDevice.data.code === 'FIRST_ORDER_ONLY', 'Cross-device check: FIRST100 remains blocked regardless of client device');

    // ──────────────────────────────────────────────────────────
    // 5. RESERVATION LIFECYCLE (Apply, Remove, Expiration)
    // ──────────────────────────────────────────────────────────
    console.log('\n[Test Group 5] Reservation Lifecycle (Apply, Remove, Hold)');
    // Customer 1 applies TEST_SAVE100 -> creates 10-minute hold reservation
    const applyRes = await makeRequest(
      'POST',
      '/api/coupons/apply',
      { code: 'TEST_SAVE100', amount: 500 },
      customer1Token
    );
    assert(applyRes.status === 200 && applyRes.data.success === true, 'Customer 1 applies TEST_SAVE100 creating reservation');
    assert(Boolean(applyRes.data.reservationId), 'ReservationId is issued');
    const resId = applyRes.data.reservationId;

    // Check DB state: status should be 'reserved'
    const resDoc = await CouponUsage.findOne({ reservationId: resId });
    assert(resDoc && resDoc.status === 'reserved', 'Reservation record stored in DB with status "reserved"');

    // Customer removes coupon
    const removeRes = await makeRequest(
      'POST',
      '/api/coupons/remove',
      { reservationId: resId },
      customer1Token
    );
    assert(removeRes.status === 200 && removeRes.data.success === true, 'Customer 1 removes coupon successfully');

    // Check DB state: status should be 'released'
    const releasedDoc = await CouponUsage.findOne({ reservationId: resId });
    assert(releasedDoc && releasedDoc.status === 'released', 'Reservation status updated to "released" on removal');

    // Customer can re-apply after releasing!
    const reapplyRes = await makeRequest(
      'POST',
      '/api/coupons/apply',
      { code: 'TEST_SAVE100', amount: 500 },
      customer1Token
    );
    assert(reapplyRes.status === 200 && reapplyRes.data.success === true, 'Customer 1 can re-apply coupon after releasing reservation');

    // ──────────────────────────────────────────────────────────
    // 6. SINGLE-USE ENFORCEMENT & BOOKING CANCELLATION ROLLBACK
    // ──────────────────────────────────────────────────────────
    console.log('\n[Test Group 6] Final Redemption & Booking Cancellation Rollback');
    // Finalize redemption via service
    const finalRedemption = await couponService.finalizeCouponRedemption({
      reservationId: reapplyRes.data.reservationId,
      couponCode: 'TEST_SAVE100',
      customerId: 'cust_coupon_1',
      bookingId: 'BK-TEST-REDEEM-001',
      discountAmount: 100,
      originalAmount: 500,
      finalAmount: 400,
    });
    assert(finalRedemption.success === true, 'Coupon redemption finalized on booking completion');

    // Coupon usage count in Coupon doc should be 1
    const couponAfterRedeem = await Coupon.findOne({ code: 'TEST_SAVE100' });
    assert(couponAfterRedeem.usageCount === 1, 'Coupon usageCount incremented to 1');

    // Attempting to apply again by Customer 1 should now be rejected as COUPON_ALREADY_USED
    const tryReuse = await makeRequest(
      'POST',
      '/api/coupons/apply',
      { code: 'TEST_SAVE100', amount: 500 },
      customer1Token
    );
    assert(tryReuse.status === 400 && tryReuse.data.code === 'COUPON_ALREADY_USED', 'Customer 1 is blocked from re-using single-use coupon');

    // Now roll back redemption (e.g. customer cancels booking)
    const rollbackRes = await couponService.rollbackCouponRedemption({
      bookingId: 'BK-TEST-REDEEM-001',
      couponCode: 'TEST_SAVE100',
    });
    assert(rollbackRes.success === true, 'Coupon redemption successfully rolled back on booking cancellation');

    const couponAfterRollback = await Coupon.findOne({ code: 'TEST_SAVE100' });
    assert(couponAfterRollback.usageCount === 0, 'Coupon usageCount decremented back to 0 on cancellation');

    // Customer 1 can now use TEST_SAVE100 again!
    const canUseAgain = await makeRequest(
      'POST',
      '/api/coupons/apply',
      { code: 'TEST_SAVE100', amount: 500 },
      customer1Token
    );
    assert(canUseAgain.status === 200 && canUseAgain.data.success === true, 'Customer 1 can apply coupon again after cancellation rollback');

    // ──────────────────────────────────────────────────────────
    // 7. MULTI-USE PER CUSTOMER (perUserLimit = 2)
    // ──────────────────────────────────────────────────────────
    console.log('\n[Test Group 7] Multi-Use Per Customer Limits (TEST_MULTI2)');
    await makeRequest(
      'POST',
      '/api/admin/coupons',
      {
        code: 'TEST_MULTI2',
        title: 'Use Twice ₹30 OFF',
        discountType: 'flat',
        discountValue: 30,
        minOrderAmount: 200,
        perUserLimit: 2, // Allowed twice!
      },
      adminToken
    );

    // Use 1
    const use1 = await couponService.finalizeCouponRedemption({
      couponCode: 'TEST_MULTI2',
      customerId: 'cust_coupon_1',
      bookingId: 'BK-MULTI-1',
      discountAmount: 30,
      originalAmount: 300,
      finalAmount: 270,
    });
    assert(use1.success === true, 'Customer 1 first use of multi-use coupon succeeds');

    // Use 2
    const use2 = await couponService.finalizeCouponRedemption({
      couponCode: 'TEST_MULTI2',
      customerId: 'cust_coupon_1',
      bookingId: 'BK-MULTI-2',
      discountAmount: 30,
      originalAmount: 300,
      finalAmount: 270,
    });
    assert(use2.success === true, 'Customer 1 second use of multi-use coupon succeeds');

    // Use 3 should fail
    let use3Failed = false;
    try {
      await couponService.finalizeCouponRedemption({
        couponCode: 'TEST_MULTI2',
        customerId: 'cust_coupon_1',
        bookingId: 'BK-MULTI-3',
        discountAmount: 30,
        originalAmount: 300,
        finalAmount: 270,
      });
    } catch (e) {
      use3Failed = true;
      assert(e.code === 'COUPON_ALREADY_USED', 'Third use fails with COUPON_ALREADY_USED');
    }
    assert(use3Failed, 'Customer 1 blocked on 3rd attempt exceeding perUserLimit of 2');

    // ──────────────────────────────────────────────────────────
    // 8. GLOBAL USAGE LIMIT (TEST_GLOBAL2)
    // ──────────────────────────────────────────────────────────
    console.log('\n[Test Group 8] Global Usage Limit (TEST_GLOBAL2)');
    await makeRequest(
      'POST',
      '/api/admin/coupons',
      {
        code: 'TEST_GLOBAL2',
        title: 'First 2 Users Only ₹50 OFF',
        discountType: 'flat',
        discountValue: 50,
        minOrderAmount: 200,
        usageLimit: 2, // Only 2 redemptions globally!
        perUserLimit: 1,
      },
      adminToken
    );

    // User 1 redeems slot 1
    const globalRedeem1 = await couponService.finalizeCouponRedemption({
      couponCode: 'TEST_GLOBAL2',
      customerId: 'cust_coupon_1',
      bookingId: 'BK-GLOBAL-1',
      discountAmount: 50,
      originalAmount: 300,
      finalAmount: 250,
    });
    assert(globalRedeem1.success === true, 'Global redemption 1 of 2 succeeds');

    // User 2 redeems slot 2
    const globalRedeem2 = await couponService.finalizeCouponRedemption({
      couponCode: 'TEST_GLOBAL2',
      customerId: 'cust_coupon_2',
      bookingId: 'BK-GLOBAL-2',
      discountAmount: 50,
      originalAmount: 300,
      finalAmount: 250,
    });
    assert(globalRedeem2.success === true, 'Global redemption 2 of 2 succeeds');

    // User 3 attempts redemption -> should fail because global limit of 2 is reached!
    let global3Failed = false;
    try {
      await couponService.finalizeCouponRedemption({
        couponCode: 'TEST_GLOBAL2',
        customerId: 'cust_coupon_3',
        bookingId: 'BK-GLOBAL-3',
        discountAmount: 50,
        originalAmount: 300,
        finalAmount: 250,
      });
    } catch (e) {
      global3Failed = true;
      assert(e.code === 'USAGE_LIMIT_EXCEEDED', '3rd global redemption fails with USAGE_LIMIT_EXCEEDED');
    }
    assert(global3Failed, 'Global usage limit of 2 is strictly enforced');

    // ──────────────────────────────────────────────────────────
    // 9. ATOMIC CONCURRENCY PROTECTION (Parallel Race Condition Guard)
    // ──────────────────────────────────────────────────────────
    console.log('\n[Test Group 9] Atomic Concurrency Protection');
    // Create coupon with 1 slot left
    await makeRequest(
      'POST',
      '/api/admin/coupons',
      {
        code: 'TEST_RACE1',
        title: 'Race Condition Test',
        discountType: 'flat',
        discountValue: 50,
        minOrderAmount: 200,
        usageLimit: 1, // Only 1 slot!
      },
      adminToken
    );

    // Fire 5 simultaneous parallel requests to redeem TEST_RACE1
    const parallelAttempts = [1, 2, 3, 4, 5].map((i) =>
      couponService
        .finalizeCouponRedemption({
          couponCode: 'TEST_RACE1',
          customerId: `cust_race_${i}`,
          bookingId: `BK-RACE-${i}`,
          discountAmount: 50,
          originalAmount: 300,
          finalAmount: 250,
        })
        .then((res) => ({ success: true, i }))
        .catch((err) => ({ success: false, i, error: err.message, code: err.code }))
    );

    const raceResults = await Promise.all(parallelAttempts);
    const successfulRedemptions = raceResults.filter((r) => r.success);
    const rejectedRedemptions = raceResults.filter((r) => !r.success);

    assert(successfulRedemptions.length === 1, `Exactly 1 parallel request succeeded (got ${successfulRedemptions.length})`);
    assert(rejectedRedemptions.length === 4, `Remaining 4 parallel requests were atomically blocked (got ${rejectedRedemptions.length})`);

    const raceCouponDoc = await Coupon.findOne({ code: 'TEST_RACE1' });
    assert(raceCouponDoc.usageCount === 1, 'Coupon usageCount is exactly 1 (no double increment)');

    await Coupon.deleteOne({ code: 'TEST_RACE1' });
    await CouponUsage.deleteMany({ couponCode: 'TEST_RACE1' });

    // ──────────────────────────────────────────────────────────
    // 10. ADMIN ANALYTICS & OVERVIEW ENDPOINTS
    // ──────────────────────────────────────────────────────────
    console.log('\n[Test Group 10] Admin Analytics & Overview Endpoints');
    const analyticsRes = await makeRequest(
      'GET',
      '/api/admin/coupons/TEST_GLOBAL2/analytics',
      null,
      adminToken
    );
    assert(analyticsRes.status === 200 && analyticsRes.data.success === true, 'Admin gets analytics for TEST_GLOBAL2');
    assert(analyticsRes.data.analytics.totalRedemptions === 2, 'Analytics shows 2 total redemptions');
    assert(analyticsRes.data.analytics.totalDiscountGranted === 100, 'Analytics shows ₹100 total discount granted');

    const overviewRes = await makeRequest(
      'GET',
      '/api/admin/coupons-overview',
      null,
      adminToken
    );
    assert(overviewRes.status === 200 && overviewRes.data.success === true, 'Admin gets coupons overview');
    assert(overviewRes.data.overview.totalRedemptions >= 4, 'Overview tracks overall platform redemptions');

    // ──────────────────────────────────────────────────────────
    // 11. PARTNER/WORKER AUTH REGRESSION VERIFICATION
    // ──────────────────────────────────────────────────────────
    console.log('\n[Test Group 11] Partner/Worker Auth Regression Protection');
    // Ensure partner self-registration remains disabled
    const partnerReg = await makeRequest('POST', '/api/auth/register-worker', {
      name: 'Test Partner',
      email: 'rogue_worker@example.com',
      password: 'Password123!',
    });
    assert(partnerReg.status === 403, 'Partner self-registration is strictly disabled (HTTP 403)');

    // Ensure worker forgot password returns OTP requirement
    const workerForgot = await makeRequest('POST', '/api/auth/worker/forgot-password', {
      email: 'worker@homestepin.com',
    });
    assert(workerForgot.status === 200 && workerForgot.data.requiresOtp === true, 'Worker forgot password returns 200 with requiresOtp: true');

    // ──────────────────────────────────────────────────────────
    // CLEANUP
    // ──────────────────────────────────────────────────────────
    await Coupon.deleteMany({ code: { $in: ['TEST_SAVE100', 'TEST_SAVE20', 'TEST_FIRST100', 'TEST_GLOBAL2', 'TEST_MULTI2', 'TEST_MIN500'] } });
    await CouponUsage.deleteMany({ couponCode: { $in: ['TEST_SAVE100', 'TEST_SAVE20', 'TEST_FIRST100', 'TEST_GLOBAL2', 'TEST_MULTI2', 'TEST_MIN500'] } });
    await Booking.deleteMany({ customerId: { $regex: /^cust_coupon_/ } });

    console.log('\n============================================================');
    console.log(` Results: ${passedAssertions} passed, ${failedAssertions} failed`);
    console.log('============================================================\n');

    if (failedAssertions > 0) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('Fatal test error:', err);
    process.exitCode = 1;
  } finally {
    if (server) server.close();
    await disconnectDb();
  }
}

runTestSuite();
