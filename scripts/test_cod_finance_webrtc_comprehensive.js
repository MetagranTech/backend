'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-key-at-least-32-chars-long';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-key-at-least-32-chars-long';
process.env.PAYMENT_WEBHOOK_SECRET = 'test-payment-webhook-secret-1234';
process.env.OTP_SECRET = 'test-otp-secret-key-at-least-32-chars-long';

const assert = require('assert');
const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const { connectDb, disconnectDb } = require('../src/db');
const { connectFinanceDb, disconnectFinanceDb, getFinanceConnection } = require('../src/financeDb');
const { getFinanceModels } = require('../src/models/financeModels');
const financeService = require('../src/services/financeService');

const User = require('../src/models/User');
const Booking = require('../src/models/Booking');
const Payment = require('../src/models/Payment');
const FinanceOutbox = require('../src/models/FinanceOutbox');

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
  console.log('  HOMESTEPIN: COD, DUAL-MONGODB FINANCE & WEBRTC TEST SUITE');
  console.log('=====================================================================\n');

  await connectDb();
  await connectFinanceDb();

  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;

  // Seed users
  const customer = await User.create({
    customId: 'cust_fin_1',
    name: 'Arun Customer',
    email: 'arun.cust@test.local',
    phone: '+919876543210',
    passwordHash: 'hash',
    role: 'customer',
  });
  const partner = await User.create({
    customId: 'wrk_fin_1',
    name: 'Karthik Partner',
    email: 'karthik.wrk@test.local',
    phone: '+919876543211',
    passwordHash: 'hash',
    role: 'worker',
    online: true,
    services: ['AC Service & Repair'],
    serviceArea: 'Trichy',
  });
  const otherPartner = await User.create({
    customId: 'wrk_fin_2',
    name: 'Other Partner',
    email: 'other.wrk@test.local',
    phone: '+919876543212',
    passwordHash: 'hash',
    role: 'worker',
    online: true,
    services: ['AC Service & Repair'],
  });
  const admin = await User.create({
    customId: 'adm_fin_1',
    name: 'Super Admin',
    email: 'admin.fin@test.local',
    phone: '+919876543219',
    passwordHash: 'hash',
    role: 'admin',
    adminRole: 'SUPER_ADMIN',
  });

  const custToken = signToken(customer);
  const partnerToken = signToken(partner);
  const otherPartnerToken = signToken(otherPartner);
  const adminToken = signToken(admin);

  // Historical Razorpay payment record (must remain intact!)
  await Payment.create({
    customId: 'PAY-HIST-001',
    bookingId: 'BK-HIST-001',
    customerId: String(customer._id),
    workerId: String(partner._id),
    amount: 799,
    currency: 'INR',
    status: 'PAID',
    provider: 'Razorpay Gateway',
    razorpayOrderId: 'order_hist_123',
    razorpayPaymentId: 'pay_hist_123',
    method: 'UPI',
  });

  // ── MODULE 1: COD & RAZORPAY REMOVAL TESTS ──────────────────────────
  console.log('--- MODULE 1: COD-ONLY & RAZORPAY REMOVAL ---');

  await runTest('Payment config returns CASH_ON_DELIVERY only', async () => {
    const res = await req('GET', '/api/payments/config');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.paymentMode, 'CASH_ON_DELIVERY');
    assert.strictEqual(res.body.codOnly, true);
    assert.strictEqual(res.body.onlinePaymentsEnabled, false);
  });

  await runTest('Retired Razorpay endpoints return 410 Gone', async () => {
    const r1 = await req('POST', '/api/payments/create-order', custToken, { amount: 500 });
    const r2 = await req('POST', '/api/payments/verify', custToken, {});
    const r3 = await req('POST', '/api/payments/webhook', null, {});
    assert.strictEqual(r1.status, 410);
    assert.strictEqual(r2.status, 410);
    assert.strictEqual(r3.status, 410);
  });

  await runTest('Historical Razorpay payment record preserved intact', async () => {
    const hist = await Payment.findOne({ customId: 'PAY-HIST-001' }).lean();
    assert.ok(hist);
    assert.strictEqual(hist.razorpayPaymentId, 'pay_hist_123');
    assert.strictEqual(hist.status, 'PAID');
  });

  // Create a completed COD booking
  const booking1 = await Booking.create({
    customId: 'BK-COD-TEST-1',
    customer: customer._id,
    customerId: String(customer._id),
    customerName: customer.name,
    worker: partner._id,
    providerId: String(partner._id),
    providerName: partner.name,
    service: 'AC Service & Repair',
    category: 'AC & Climate',
    address: 'Thillai Nagar, Trichy',
    latitude: 10.826,
    longitude: 78.685,
    price: '₹1,000',
    priceNum: 1000,
    status: 'WORK_FINISHED',
    paymentMethod: 'CASH_ON_DELIVERY',
    paymentStatus: 'PENDING',
  });

  // ── MODULE 3 & 4: COMMISSION CONFIG & COD COLLECTION ────────────────
  console.log('\n--- MODULE 3 & 4: DUAL-DB FINANCE, COMMISSION & LEDGER ---');

  await runTest('Finance DB connection is separate and connected', async () => {
    const finConn = getFinanceConnection();
    assert.ok(finConn && finConn.readyState === 1);
    assert.notStrictEqual(finConn, mongoose.connection);
  });

  await runTest('Admin updates configurable platform commission to 12.5%', async () => {
    const res = await req('POST', '/api/admin/finance/commission', adminToken, {
      ratePercent: 12.5,
      effectiveFrom: '2024-01-01T00:00:00.000Z',
      reason: 'Festival promo rate 12.5%',
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.commission.ratePercent, 12.5);
  });

  await runTest('Other partner blocked from confirming COD collection (403)', async () => {
    const res = await req('POST', `/api/bookings/${booking1.customId}/cod/collect`, otherPartnerToken);
    assert.strictEqual(res.status, 403);
  });

  await runTest('Assigned partner confirms COD collection & syncs to Finance DB', async () => {
    const res = await req('POST', `/api/bookings/${booking1.customId}/cod/collect`, partnerToken);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.paymentStatus, 'PAID');
    assert.strictEqual(res.body.amount, 1000);

    // Wait briefly for setImmediate outbox processor
    await financeService.processFinanceOutbox();

    const finModels = getFinanceModels(getFinanceConnection());
    const col = await finModels.CODCollection.findOne({ bookingId: booking1.customId }).lean();
    const earn = await finModels.PartnerEarning.findOne({ bookingId: booking1.customId }).lean();
    assert.ok(col, 'CODCollection created in Finance DB');
    assert.ok(earn, 'PartnerEarning created in Finance DB');
    assert.strictEqual(earn.grossAmount, 1000);
    assert.strictEqual(earn.commissionRatePercent, 12.5);
    assert.strictEqual(earn.commissionAmount, 125);
    assert.strictEqual(earn.netAmount, 875);

    const ledgerEntries = await finModels.FinancialLedger.find({ bookingId: booking1.customId }).lean();
    assert.strictEqual(ledgerEntries.length, 3, '3 append-only ledger entries created');
  });

  await runTest('Duplicate COD collection prevented (409)', async () => {
    const res = await req('POST', `/api/bookings/${booking1.customId}/cod/collect`, partnerToken);
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'COD_ALREADY_COLLECTED');
  });

  await runTest('Duplicate FinanceOutbox event processing is idempotent', async () => {
    await financeService.enqueueCodCollectionEvent({
      booking: booking1,
      payment: { customId: 'COD-DUP', amount: 1000 },
      collectedBy: String(partner._id),
      collectedAt: new Date(),
    });
    await financeService.processFinanceOutbox();
    const finModels = getFinanceModels(getFinanceConnection());
    const acc = await finModels.PartnerFinancialAccount.findOne({ partnerId: String(partner._id) }).lean();
    assert.strictEqual(acc.totalCodCollected, 1000);
    assert.strictEqual(acc.outstandingCommission, 125);
    assert.strictEqual(acc.netEarnings, 875);
  });

  await runTest('Cross-DB reconciliation repairs missing Finance DB records', async () => {
    const booking2 = await Booking.create({
      customId: 'BK-COD-RECON-2',
      customer: customer._id,
      customerId: String(customer._id),
      customerName: customer.name,
      worker: partner._id,
      providerId: String(partner._id),
      providerName: partner.name,
      service: 'AC Service & Repair',
      category: 'AC & Climate',
      address: 'Cantonment, Trichy',
      latitude: 10.81,
      longitude: 78.68,
      price: '₹2,000',
      priceNum: 2000,
      status: 'COMPLETED',
      paymentMethod: 'CASH_ON_DELIVERY',
      paymentStatus: 'PAID',
      codCollectedAt: new Date(),
      codCollectedBy: String(partner._id),
    });

    const res = await req('POST', '/api/admin/finance/reconcile', adminToken);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.result.missingEnqueued >= 1);

    const finModels = getFinanceModels(getFinanceConnection());
    const earn2 = await finModels.PartnerEarning.findOne({ bookingId: booking2.customId }).lean();
    assert.ok(earn2);
    assert.strictEqual(earn2.commissionAmount, 250);
    assert.strictEqual(earn2.netAmount, 1750);
  });

  // ── MODULE 5, 6 & 7: SETTLEMENTS, ADJUSTMENTS & RBAC ────────────────
  console.log('\n--- MODULE 5, 6 & 7: SETTLEMENTS, ADJUSTMENTS & RBAC ---');

  let settlementId1 = null;
  let settlementId2 = null;

  await runTest('Partner submits settlement request (stays PENDING)', async () => {
    const res = await req('POST', '/api/partner/finance/settlements', partnerToken, {
      amount: 125,
      paymentMethod: 'GPAY',
      utrReference: 'UTR412345678901',
      notes: 'Paid ₹125 via GPay',
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.settlement.status, 'PENDING');
    settlementId1 = res.body.settlement.settlementId;

    // Outstanding balance must NOT decrease before admin approval
    const sum = await req('GET', '/api/partner/finance/summary', partnerToken);
    assert.strictEqual(sum.body.outstandingCommission, 375); // 125 + 250
  });

  await runTest('Admin approves settlement -> outstanding commission decreases & duplicate approval prevented', async () => {
    const rev1 = await req('POST', `/api/admin/finance/settlements/${settlementId1}/review`, adminToken, {
      action: 'APPROVE',
    });
    assert.strictEqual(rev1.status, 200);
    assert.strictEqual(rev1.body.settlement.status, 'APPROVED');

    const sum = await req('GET', '/api/partner/finance/summary', partnerToken);
    assert.strictEqual(sum.body.commissionPaid, 125);
    assert.strictEqual(sum.body.outstandingCommission, 250);

    // Duplicate approval must fail with 409
    const revDup = await req('POST', `/api/admin/finance/settlements/${settlementId1}/review`, adminToken, {
      action: 'APPROVE',
    });
    assert.strictEqual(revDup.status, 409);
  });

  await runTest('Partner submits & Admin rejects settlement with mandatory reason', async () => {
    const sub = await req('POST', '/api/partner/finance/settlements', partnerToken, {
      amount: 100,
      paymentMethod: 'UPI',
      utrReference: 'UTR_INVALID_999',
    });
    assert.strictEqual(sub.status, 201);
    settlementId2 = sub.body.settlement.settlementId;

    const rej = await req('POST', `/api/admin/finance/settlements/${settlementId2}/review`, adminToken, {
      action: 'REJECT',
      reason: 'UTR not found in bank statement',
    });
    assert.strictEqual(rej.status, 200);
    assert.strictEqual(rej.body.settlement.status, 'REJECTED');
  });

  await runTest('Admin creates financial adjustment with ledger entry & before/after balances', async () => {
    const res = await req('POST', '/api/admin/finance/adjustments', adminToken, {
      partnerId: String(partner._id),
      type: 'CREDIT',
      amount: 50,
      reason: 'Goodwill waiver for fuel delay',
      idempotencyKey: 'adj_test_001',
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.adjustment.beforeOutstanding, 250);
    assert.strictEqual(res.body.adjustment.afterOutstanding, 200);
  });

  await runTest('Unauthorized RBAC access prevented (Customer/Partner cannot call Admin APIs)', async () => {
    const r1 = await req('GET', '/api/admin/finance/overview', custToken);
    const r2 = await req('GET', '/api/admin/finance/overview', partnerToken);
    const r3 = await req('GET', '/api/partner/finance/summary', custToken);
    assert.strictEqual(r1.status, 403);
    assert.strictEqual(r2.status, 403);
    assert.strictEqual(r3.status, 403);
  });

  await runTest('FinanceOutbox handles temporary Finance DB outage & retries cleanly', async () => {
    const booking3 = await Booking.create({
      customId: 'BK-OUTAGE-TEST-3',
      customer: customer._id,
      customerId: String(customer._id),
      customerName: customer.name,
      worker: partner._id,
      providerId: String(partner._id),
      providerName: partner.name,
      service: 'AC Service & Repair',
      category: 'AC & Climate',
      address: 'Srirangam, Trichy',
      latitude: 10.86,
      longitude: 78.69,
      price: '₹1,000',
      priceNum: 1000,
      status: 'COMPLETED',
      paymentMethod: 'CASH_ON_DELIVERY',
      paymentStatus: 'PENDING',
    });

    // Simulate Finance DB offline during COD collection
    await disconnectFinanceDb();
    const collectRes = await req('POST', `/api/bookings/${booking3.customId}/cod/collect`, partnerToken);
    assert.strictEqual(collectRes.status, 200);

    const pendingJob = await FinanceOutbox.findOne({ bookingId: booking3.customId }).lean();
    assert.ok(pendingJob, 'Outbox event durably persisted in Main DB despite Finance DB outage');

    // Reconnect Finance DB and flush outbox
    await connectFinanceDb();
    await financeService.processFinanceOutbox();

    const syncedJob = await FinanceOutbox.findOne({ bookingId: booking3.customId }).lean();
    assert.strictEqual(syncedJob.status, 'SYNCED');
  });

  // ── MODULE 2: PARTNER-TO-CUSTOMER WEBRTC CALLING SIGNALING TESTS ───
  console.log('\n--- MODULE 2: WEBRTC CALL SIGNALING & IDEMPOTENCY ---');

  await runTest('Partner -> Customer call initiate, idempotent accept, and end', async () => {
    const callBooking = await Booking.create({
      customId: 'BK-WEBRTC-TEST-1',
      customer: customer._id,
      customerId: String(customer._id),
      customerName: customer.name,
      worker: partner._id,
      providerId: String(partner._id),
      providerName: partner.name,
      service: 'AC Service & Repair',
      category: 'AC & Climate',
      address: 'Trichy',
      latitude: 10.82,
      longitude: 78.68,
      price: '₹500',
      priceNum: 500,
      status: 'WORK_STARTED',
    });

    // Partner initiates call to Customer
    const initRes = await req('POST', `/api/bookings/${callBooking.customId}/call/initiate`, partnerToken);
    assert.strictEqual(initRes.status, 200);
    const callSessionId = initRes.body.callSession.callSessionId;
    assert.ok(callSessionId);

    // Customer accepts call
    const acc1 = await req('POST', `/api/bookings/${callBooking.customId}/call/${callSessionId}/accept`, custToken);
    assert.strictEqual(acc1.status, 200);
    assert.strictEqual(acc1.body.status, 'CALL_CONNECTED');

    // Duplicate accept must be idempotent without re-broadcasting
    const acc2 = await req('POST', `/api/bookings/${callBooking.customId}/call/${callSessionId}/accept`, custToken);
    assert.strictEqual(acc2.status, 200);
    assert.strictEqual(acc2.body.alreadyConnected, true);

    // End call
    const endRes = await req('POST', `/api/bookings/${callBooking.customId}/call/${callSessionId}/end`, partnerToken, { reason: 'completed' });
    assert.strictEqual(endRes.status, 200);

    // Accepting an already-ended call must return 409
    const accAfterEnd = await req('POST', `/api/bookings/${callBooking.customId}/call/${callSessionId}/accept`, custToken);
    assert.strictEqual(accAfterEnd.status, 409);
  });

  console.log('\n=====================================================================');
  console.log(`  TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('=====================================================================');

  await new Promise(resolve => server.close(resolve));
  await disconnectFinanceDb();
  await disconnectDb();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async err => {
  console.error('Fatal test suite error:', err);
  try { if (server) await new Promise(r => server.close(r)); } catch {}
  try { await disconnectFinanceDb(); } catch {}
  try { await disconnectDb(); } catch {}
  process.exit(1);
});
