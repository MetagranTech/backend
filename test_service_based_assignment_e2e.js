/**
 * Test Suite: Service-Based Partner Assignment and Reassignment E2E
 * Validates all 12 core test scenarios:
 * 1. AC Repair booking with 2 AC techs & 1 painter -> only AC techs appear
 * 2. Painting booking with 2 painters & 1 AC tech -> only painters appear
 * 3. Multi-qualified worker (AC + Electrical) -> appears for both AC and Electrical bookings
 * 4. Unverified AC technician -> does NOT appear for AC booking
 * 5. Verified AC technician who is offline / unavailable -> does NOT appear
 * 6. Worker whose account is suspended after loading the dropdown -> backend rejects assignment attempt
 * 7. Attempting to assign an unqualified worker via direct API call -> backend returns validation error
 * 8. Booking with no qualified workers available -> empty state returned
 * 9. Reassigning a booking from Tech A to Tech B -> Tech A notified, Tech B notified, customer notified, history recorded
 * 10. Tech A is excluded from eligible worker list during reassignment of their own booking
 * 11. Worker currently in progress on Booking 1 -> does NOT appear as eligible for Booking 2
 * 12. Concurrent assignment race condition -> one succeeds, the other fails gracefully with 409 Conflict
 */

const http = require('http');
const mongoose = require('mongoose');
const { signAccess } = require('./src/authTokens');

const BASE_URL = 'http://127.0.0.1:4001';

function request(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const data = body ? JSON.stringify(body) : null;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);

    const req = http.request(url, { method, headers }, res => {
      let raw = '';
      res.on('data', chunk => (raw += chunk));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(raw);
        } catch {
          json = raw;
        }
        resolve({ status: res.statusCode, data: json });
      });
    });

    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function assert(condition, message, details = '') {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`, details);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`✅ PASS: ${message}`);
}

async function run() {
  console.log('\n========================================================================');
  console.log('   Service-Based Partner Assignment & Reassignment Test Suite (12 Scenarios)');
  console.log('========================================================================\n');

  const { connectDb } = require('./src/db');
  await connectDb();

  const adminToken = signAccess({ _id: '6ab183a5483c6abee9abe4d0', role: 'admin' });
  const custToken = signAccess({ _id: '6ab183a5483c6abee9abe4d1', role: 'customer' });
  assert(Boolean(adminToken), 'Admin token minted successfully');

  // Load models for fixture setup
  const User = require('./src/models/User');
  const Booking = require('./src/models/Booking');
  const NotificationOutbox = require('./src/models/NotificationOutbox');

  const prefix = `test_sb_${Date.now()}`;

  // Helper to create test worker
  async function createTestWorker(data) {
    return await User.create({
      customId: `${prefix}_${data.id}`,
      name: data.name,
      email: `${prefix}_${data.id}@test.com`,
      phone: `+9199${Math.floor(10000000 + Math.random() * 89999999)}`,
      employeeId: `EMP-${data.id.toUpperCase()}`,
      passwordHash: 'dummy',
      role: 'worker',
      status: data.status || 'active',
      kycStatus: data.kycStatus || 'approved',
      online: data.online !== undefined ? data.online : true,
      services: data.services || [],
      approvedServices: data.approvedServices || data.services || [],
      serviceArea: data.serviceArea || 'Bengaluru',
    });
  }

  // Helper to create test booking
  async function createTestBooking(data) {
    return await Booking.create({
      customId: `BK-${prefix}-${data.id}`,
      customerId: `${prefix}_cust`,
      customerName: 'Test Customer',
      customerPhone: '+919876500001',
      service: data.service,
      category: data.category || 'General',
      address: '123 Test Residency, Indiranagar, Bengaluru',
      area: 'Indiranagar',
      city: 'Bengaluru',
      latitude: 12.9716,
      longitude: 77.5946,
      price: '₹499',
      priceNum: 499,
      status: data.status || 'PENDING',
      providerId: data.providerId || null,
      providerName: data.providerName || null,
      providerPhone: data.providerPhone || null,
    });
  }

  console.log('--- Setting up Test Technicians ---');
  const techAc1 = await createTestWorker({
    id: 'ac_01',
    name: 'Aarav Sharma (AC Pro 1)',
    services: ['AC Service & Repair'],
  });
  const techAc2 = await createTestWorker({
    id: 'ac_02',
    name: 'Kabir Verma (AC Pro 2)',
    services: ['AC Service & Repair'],
  });
  const techPaint1 = await createTestWorker({
    id: 'paint_01',
    name: 'Rohan Mehra (Painter 1)',
    services: ['Home Painting'],
  });
  const techPaint2 = await createTestWorker({
    id: 'paint_02',
    name: 'Deepak Roy (Painter 2)',
    services: ['Home Painting'],
  });
  const techMulti = await createTestWorker({
    id: 'multi_01',
    name: 'Arjun Das (AC & Electrical Specialist)',
    services: ['AC Service & Repair', 'Electrician Services'],
  });
  const techUnverified = await createTestWorker({
    id: 'unverified_ac',
    name: 'Kunal (Pending KYC AC)',
    services: ['AC Service & Repair'],
    kycStatus: 'pending',
  });
  const techOffline = await createTestWorker({
    id: 'offline_ac',
    name: 'Vikas (Offline AC)',
    services: ['AC Service & Repair'],
    online: false,
  });

  console.log('--- Setting up Test Bookings ---');
  const bookingAc = await createTestBooking({
    id: 'ac_repair',
    service: 'AC Service & Repair',
    category: 'AC & Climate',
  });
  const bookingPaint = await createTestBooking({
    id: 'home_paint',
    service: 'Home Painting',
    category: 'Painting',
  });
  const bookingElec = await createTestBooking({
    id: 'electrician',
    service: 'Electrician Services',
    category: 'Electrical',
  });
  const bookingPest = await createTestBooking({
    id: 'pest_control',
    service: 'Pest Control & Sanitization',
    category: 'Pest Control',
  });

  // -------------------------------------------------------------------------
  // Scenario 1: AC Repair booking with 2 AC techs and 1 painter -> only AC techs appear
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 1: AC Repair Booking Dropdown Qualification Check ---');
  const res1 = await request('GET', `/api/admin/bookings/${bookingAc.customId}/eligible-workers`, null, adminToken);
  assert(res1.status === 200, 'GET eligible-workers returns 200 OK');
  const eligibleAcIds = res1.data.eligibleWorkers.map(w => w.id || w.customId);
  assert(eligibleAcIds.includes(techAc1.customId), 'Tech AC 1 appears for AC booking');
  assert(eligibleAcIds.includes(techAc2.customId), 'Tech AC 2 appears for AC booking');
  assert(!eligibleAcIds.includes(techPaint1.customId), 'Painter 1 is strictly EXCLUDED from AC booking dropdown');
  assert(!eligibleAcIds.includes(techPaint2.customId), 'Painter 2 is strictly EXCLUDED from AC booking dropdown');

  // -------------------------------------------------------------------------
  // Scenario 2: Painting booking with 2 painters and 1 AC tech -> only painters appear
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 2: Painting Booking Dropdown Qualification Check ---');
  const res2 = await request('GET', `/api/admin/bookings/${bookingPaint.customId}/eligible-workers`, null, adminToken);
  assert(res2.status === 200, 'GET eligible-workers for painting returns 200 OK');
  const eligiblePaintIds = res2.data.eligibleWorkers.map(w => w.id || w.customId);
  assert(eligiblePaintIds.includes(techPaint1.customId), 'Painter 1 appears for Painting booking');
  assert(eligiblePaintIds.includes(techPaint2.customId), 'Painter 2 appears for Painting booking');
  assert(!eligiblePaintIds.includes(techAc1.customId), 'Tech AC 1 is strictly EXCLUDED from Painting booking');
  assert(!eligiblePaintIds.includes(techAc2.customId), 'Tech AC 2 is strictly EXCLUDED from Painting booking');

  // -------------------------------------------------------------------------
  // Scenario 3: Worker with multiple qualifications (AC + Electrical)
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 3: Multi-Qualified Worker Eligibility ---');
  assert(eligibleAcIds.includes(techMulti.customId), 'Multi-qualified worker appears for AC booking');
  const resElec = await request('GET', `/api/admin/bookings/${bookingElec.customId}/eligible-workers`, null, adminToken);
  const eligibleElecIds = resElec.data.eligibleWorkers.map(w => w.id || w.customId);
  assert(eligibleElecIds.includes(techMulti.customId), 'Multi-qualified worker appears for Electrical booking');
  assert(!eligibleElecIds.includes(techPaint1.customId), 'Painter is excluded from Electrical booking');

  // -------------------------------------------------------------------------
  // Scenario 4: Unverified AC technician -> does NOT appear
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 4: Unverified (Pending KYC) Worker Exclusion ---');
  assert(!eligibleAcIds.includes(techUnverified.customId), 'Unverified AC tech is EXCLUDED from eligible dropdown');

  // -------------------------------------------------------------------------
  // Scenario 5: Verified AC technician who is offline / unavailable -> does NOT appear
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 5: Offline Worker Exclusion ---');
  assert(!eligibleAcIds.includes(techOffline.customId), 'Offline AC tech is EXCLUDED from eligible dropdown');

  // -------------------------------------------------------------------------
  // Scenario 6: Worker suspended after loading dropdown -> backend rejects assignment attempt
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 6: Suspended Worker Assignment Backend Rejection ---');
  // Suspend techAc2
  await User.updateOne({ _id: techAc2._id }, { $set: { status: 'suspended' } });
  const resAssignSuspended = await request(
    'POST',
    `/api/admin/bookings/${bookingAc.customId}/assign`,
    { workerId: techAc2.customId, reason: 'Dispatching suspended tech' },
    adminToken
  );
  assert(
    resAssignSuspended.status === 403 || resAssignSuspended.status === 400,
    `Backend rejects assignment of suspended technician (Status: ${resAssignSuspended.status})`
  );
  assert(
    resAssignSuspended.data.code === 'WORKER_NOT_ACTIVE',
    'Returns expected WORKER_NOT_ACTIVE error code'
  );

  // -------------------------------------------------------------------------
  // Scenario 7: Direct API call assigning an unqualified worker -> backend validation error
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 7: Unqualified Worker Direct Assignment Rejection ---');
  const resAssignUnqualified = await request(
    'POST',
    `/api/admin/bookings/${bookingAc.customId}/assign`,
    { workerId: techPaint1.customId, reason: 'Assigning painter to AC job' },
    adminToken
  );
  assert(
    resAssignUnqualified.status === 400,
    `Backend rejects unqualified technician assignment with 400 (Status: ${resAssignUnqualified.status})`
  );
  assert(
    resAssignUnqualified.data.code === 'WORKER_NOT_QUALIFIED',
    'Returns expected WORKER_NOT_QUALIFIED error code'
  );

  // -------------------------------------------------------------------------
  // Scenario 8: Booking with no qualified workers available -> empty state message
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 8: No Qualified Workers Available (Empty State) ---');
  const resPest = await request('GET', `/api/admin/bookings/${bookingPest.customId}/eligible-workers`, null, adminToken);
  assert(resPest.status === 200, 'GET eligible-workers for pest control returns 200');
  assert(Array.isArray(resPest.data.eligibleWorkers), 'eligibleWorkers is an array');
  assert(resPest.data.eligibleWorkers.length === 0, 'eligibleWorkers is empty list when no qualified worker exists');
  assert(resPest.data.count === 0, 'count is 0');

  // -------------------------------------------------------------------------
  // Scenario 9: Reassigning a booking from Tech A to Tech B
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 9: Complete Reassignment Workflow & Notifications ---');
  // Initial assignment to Tech AC 1
  const resAssignInitial = await request(
    'POST',
    `/api/admin/bookings/${bookingAc.customId}/assign`,
    { workerId: techAc1.customId, reason: 'Initial assignment to Tech AC 1' },
    adminToken
  );
  assert(resAssignInitial.status === 200, 'Initial assignment to Tech AC 1 succeeded');
  assert(resAssignInitial.data.booking.providerName === techAc1.name, 'Booking provider is Tech AC 1');

  // Now reassign to Tech Multi
  const reassignmentReason = 'Customer requested senior multi-skilled technician';
  const resReassign = await request(
    'POST',
    `/api/admin/bookings/${bookingAc.customId}/assign`,
    { workerId: techMulti.customId, reason: reassignmentReason },
    adminToken
  );
  assert(resReassign.status === 200, 'Reassignment to Tech Multi succeeded');
  assert(resReassign.data.booking.providerName === techMulti.name, 'Booking provider is now Tech Multi');

  // Verify History
  const updatedBooking = await Booking.findOne({ customId: bookingAc.customId });
  const lastHistory = updatedBooking.history[updatedBooking.history.length - 1];
  assert(lastHistory.action === 'REASSIGN_WORKER', 'History records REASSIGN_WORKER action');
  assert(lastHistory.note === reassignmentReason, 'History records exact reassignment reason');
  assert(lastHistory.from.includes(techAc1.name), 'History records previous technician name');
  assert(lastHistory.to.includes(techMulti.name), 'History records new technician name');

  // Verify Notifications in Outbox
  const notifsPrevWorker = await NotificationOutbox.find({ recipientId: techAc1._id.toString(), type: 'WORKER_UNASSIGNED' });
  assert(notifsPrevWorker.length > 0, 'Previous worker (Tech AC 1) received WORKER_UNASSIGNED notification');

  const notifsNewWorker = await NotificationOutbox.find({ recipientId: techMulti._id.toString(), type: 'WORKER_ASSIGNED' });
  assert(notifsNewWorker.length > 0, 'New worker (Tech Multi) received WORKER_ASSIGNED notification');

  const notifsCustomer = await NotificationOutbox.find({ recipientId: bookingAc.customerId, type: 'BOOKING_REASSIGNED' });
  assert(notifsCustomer.length > 0, 'Customer received BOOKING_REASSIGNED notification');

  // -------------------------------------------------------------------------
  // Scenario 10: Tech A is excluded from eligible list during reassignment of their own booking
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 10: Currently Assigned Technician Excluded from Reassignment Dropdown ---');
  const resReassignDropdown = await request('GET', `/api/admin/bookings/${bookingAc.customId}/eligible-workers`, null, adminToken);
  const eligibleReassignIds = resReassignDropdown.data.eligibleWorkers.map(w => w.id || w.customId);
  assert(
    !eligibleReassignIds.includes(techMulti.customId) && !eligibleReassignIds.includes(techMulti._id.toString()),
    'Currently assigned technician (Tech Multi) is EXCLUDED from their own reassignment dropdown'
  );
  assert(resReassignDropdown.data.booking.isReassignment === true, 'Response flags booking as isReassignment: true');
  assert(resReassignDropdown.data.booking.currentWorkerName === techMulti.name, 'Response provides current worker name');

  // -------------------------------------------------------------------------
  // Scenario 11: Worker currently in progress on Booking 1 -> NOT eligible for Booking 2
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 11: Incompatible Active Job Engagement Exclusion ---');
  // Mark bookingAc as IN_PROGRESS with Tech Multi
  await Booking.updateOne({ _id: bookingAc._id }, { $set: { status: 'IN_PROGRESS' } });

  // Create another AC booking
  const bookingAc2 = await createTestBooking({
    id: 'ac_repair_2',
    service: 'AC Service & Repair',
    category: 'AC & Climate',
  });

  const resAc2 = await request('GET', `/api/admin/bookings/${bookingAc2.customId}/eligible-workers`, null, adminToken);
  const eligibleAc2Ids = resAc2.data.eligibleWorkers.map(w => w.id || w.customId);
  assert(
    !eligibleAc2Ids.includes(techMulti.customId) && !eligibleAc2Ids.includes(techMulti._id.toString()),
    'Worker currently IN_PROGRESS on Booking 1 is EXCLUDED from eligible workers for Booking 2'
  );

  // Attempt direct assignment of busy worker to Booking 2
  const resAssignBusy = await request(
    'POST',
    `/api/admin/bookings/${bookingAc2.customId}/assign`,
    { workerId: techMulti.customId, reason: 'Double booking busy tech' },
    adminToken
  );
  assert(resAssignBusy.status === 409, `Backend returns 409 Conflict when assigning busy worker (Status: ${resAssignBusy.status})`);
  assert(resAssignBusy.data.code === 'WORKER_BUSY', 'Returns expected WORKER_BUSY code');

  // -------------------------------------------------------------------------
  // Scenario 12: Concurrent assignment race condition -> one succeeds, the other fails with 409 Conflict
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 12: Atomic Concurrency Control (409 Conflict on Race) ---');
  const bookingRace = await createTestBooking({
    id: 'ac_race',
    service: 'AC Service & Repair',
    category: 'AC & Climate',
  });

  // Re-activate techAc1
  await User.updateOne({ _id: techAc1._id }, { $set: { status: 'active', online: true } });

  // Fire two assignment requests concurrently for bookingRace
  const [raceRes1, raceRes2] = await Promise.all([
    request('POST', `/api/admin/bookings/${bookingRace.customId}/assign`, { workerId: techAc1.customId, reason: 'Admin 1 dispatch' }, adminToken),
    request('POST', `/api/admin/bookings/${bookingRace.customId}/assign`, { workerId: techAc1.customId, reason: 'Admin 2 dispatch' }, adminToken),
  ]);

  const statuses = [raceRes1.status, raceRes2.status].sort();
  assert(
    statuses[0] === 200 && (statuses[1] === 400 || statuses[1] === 409),
    `Concurrent race handled atomically: First request succeeded (${statuses[0]}), conflicting request rejected (${statuses[1]})`
  );

  // Clean up test fixtures
  console.log('\n--- Cleaning up Test Fixtures ---');
  await User.deleteMany({ customId: new RegExp(`^${prefix}`) });
  await Booking.deleteMany({ customId: new RegExp(`^BK-${prefix}`) });
  console.log('Test fixtures cleaned up.');

  console.log('\n========================================================================');
  console.log('   ALL 12 SERVICE-BASED ASSIGNMENT TEST SCENARIOS PASSED WITH EVIDENCE!');
  console.log('========================================================================\n');
  process.exit(0);
}

run().catch(err => {
  console.error('\n❌ TEST SUITE FAILED WITH ERROR:', err);
  process.exit(1);
});
