/**
 * HomeStepIn: OneSignal Service & Push Notification Lifecycle E2E Test Suite
 */

'use strict';

process.env.NODE_ENV = 'test';

const assert = require('assert');
const oneSignalService = require('../src/services/oneSignalService');
const { connectDb, disconnectDb } = require('../src/db');
const User = require('../src/models/User');

async function runTests() {
  console.log('================================================================');
  console.log('HomeStepIn: OneSignal Push Notification Service Test Suite');
  console.log('================================================================\n');

  let passed = 0;
  let total = 0;
  function pass(desc) {
    total++;
    passed++;
    console.log(`  ✓ [PASS] ${desc}`);
  }

  // 1. OneSignal Configuration Helper
  console.log('TEST 1: Configuration Validation');
  const cfg = oneSignalService.getOneSignalConfig('customer');
  assert(typeof cfg.isConfigured === 'boolean', 'isConfigured is boolean');
  assert(cfg.appId === '28d1903d-40bf-4e76-9e0a-b2b005df2aae', 'Customer OneSignal App ID matches');
  const partnerCfg = oneSignalService.getOneSignalConfig('partner');
  assert(partnerCfg.appId === '3ad71bb0-508d-4b7d-a09f-64754400c57b', 'Partner OneSignal App ID matches');
  pass('Configuration validation returns status object with correct Customer and Partner App IDs');

  // 2. Test Transport Interceptor
  console.log('\nTEST 2: Test Transport Interceptor');
  oneSignalService.setTestOneSignalTransport(async (payload) => {
    return {
      success: true,
      id: `onesignal-mock-${Date.now()}`,
      recipients: 1,
      mockPayload: payload,
    };
  });
  pass('Test transport hook successfully attached');

  // 3. User Push Dispatch via OneSignal External ID
  console.log('\nTEST 3: Direct User Notification by User ID');
  const res1 = await oneSignalService.sendNotificationToUser('usr_test_12345', {
    title: 'Test Notification',
    body: 'Hello from HomeStepIn OneSignal service',
    data: { test: true },
  });
  assert(res1.success === true, 'Notification dispatched successfully');
  assert(res1.id.startsWith('onesignal-mock-'), 'Generated OneSignal mock ID');
  const inbox = oneSignalService.getTestInbox();
  assert(inbox.length === 1, 'Notification captured in test inbox');
  assert(inbox[0].payload.include_aliases.external_id[0] === 'usr_test_12345', 'Targeted user external_id matches');
  assert(inbox[0].payload.headings.en === 'Test Notification', 'Heading matches');
  pass('sendNotificationToUser targets user external_id correctly');

  // 4. Subscription ID Targeting
  console.log('\nTEST 4: Target by Subscription IDs');
  const res2 = await oneSignalService.sendNotificationToSubscriptions(['sub_abc_123', 'sub_def_456'], {
    title: 'Subscription Alert',
    body: 'Direct device notification',
  });
  assert(res2.success === true, 'Dispatched to subscription IDs');
  const lastPayload = oneSignalService.getTestInbox().slice(-1)[0].payload;
  assert(lastPayload.include_subscription_ids.length === 2, 'Two subscription IDs targeted');
  pass('sendNotificationToSubscriptions targets device tokens correctly');

  // 5. Booking Assigned Alert
  console.log('\nTEST 5: Booking Assigned Alert Formatting');
  await oneSignalService.notifyBookingAssigned('cust_101', { _id: 'book_999', service: 'AC Deep Cleaning' }, { name: 'Karthik S' });
  const assignPayload = oneSignalService.getTestInbox().slice(-1)[0].payload;
  assert(assignPayload.headings.en.includes('Technician Assigned'), 'Heading indicates technician assigned');
  assert(assignPayload.contents.en.includes('Karthik S'), 'Body includes worker name');
  assert(assignPayload.contents.en.includes('AC Deep Cleaning'), 'Body includes service name');
  assert(assignPayload.data.type === 'BOOKING_ASSIGNED', 'Metadata type is BOOKING_ASSIGNED');
  pass('notifyBookingAssigned formats correctly');

  // 6. Worker Arrived Alert
  console.log('\nTEST 6: Worker Arrived Alert Formatting');
  await oneSignalService.notifyWorkerArrived('cust_101', { _id: 'book_999', service: 'AC Deep Cleaning' });
  const arrivedPayload = oneSignalService.getTestInbox().slice(-1)[0].payload;
  assert(arrivedPayload.headings.en.includes('Arrived'), 'Heading indicates arrival');
  assert(arrivedPayload.data.type === 'WORKER_ARRIVED', 'Metadata type is WORKER_ARRIVED');
  pass('notifyWorkerArrived formats correctly');

  // 7. Booking Completed Alert
  console.log('\nTEST 7: Booking Completed Alert Formatting');
  await oneSignalService.notifyBookingCompleted('cust_101', { _id: 'book_999', service: 'AC Deep Cleaning' });
  const compPayload = oneSignalService.getTestInbox().slice(-1)[0].payload;
  assert(compPayload.headings.en.includes('Completed'), 'Heading indicates completion');
  assert(compPayload.data.type === 'BOOKING_COMPLETED', 'Metadata type is BOOKING_COMPLETED');
  pass('notifyBookingCompleted formats correctly');

  // 8. Booking Cancelled Alert
  console.log('\nTEST 8: Booking Cancelled Alert Formatting');
  await oneSignalService.notifyBookingCancelled('cust_101', { _id: 'book_999', service: 'AC Deep Cleaning' }, 'Customer rescheduled');
  const cancPayload = oneSignalService.getTestInbox().slice(-1)[0].payload;
  assert(cancPayload.headings.en.includes('Cancelled'), 'Heading indicates cancellation');
  assert(cancPayload.contents.en.includes('Customer rescheduled'), 'Includes cancellation reason');
  pass('notifyBookingCancelled formats correctly');

  // 9. Dispatch Job Offers to Multiple Workers
  console.log('\nTEST 9: Dispatch Job Offers to Multiple Workers');
  await oneSignalService.notifyJobOfferToWorkers(['work_1', 'work_2', 'work_3'], {
    _id: 'book_999',
    service: 'Plumbing Repair',
    address: 'Thillai Nagar, Trichy',
  });
  const offerPayload = oneSignalService.getTestInbox().slice(-1)[0].payload;
  assert(offerPayload.include_aliases.external_id.length === 3, 'Dispatches to 3 worker aliases');
  assert(offerPayload.headings.en.includes('New Service Request'), 'Heading indicates new service request');
  assert(offerPayload.contents.en.includes('Trichy'), 'Body mentions service address');
  pass('notifyJobOfferToWorkers targets multiple workers simultaneously');

  // 10. Database Schema Push Subscription Registration
  console.log('\nTEST 10: Database Push Subscription Storage');
  await connectDb();
  const testWorker = await User.create({
    customId: `usr_work_test_${Date.now()}`,
    username: `work_test_${Date.now()}`,
    name: 'OneSignal Test Worker',
    email: `onesignal.worker.${Date.now()}@example.com`,
    passwordHash: 'hashed_password_sample_12345',
    role: 'worker',
    status: 'active',
    pushSubscriptions: [
      {
        subscriptionId: 'onesignal_sub_test_token_123',
        deviceId: 'android_dev_test',
        platform: 'android',
        lastSeenAt: new Date(),
      },
    ],
  });

  const fetched = await User.findById(testWorker._id);
  assert(fetched.pushSubscriptions.length === 1, 'pushSubscriptions saved to MongoDB');
  assert(fetched.pushSubscriptions[0].subscriptionId === 'onesignal_sub_test_token_123', 'subscriptionId stored accurately');
  assert(fetched.pushSubscriptions[0].platform === 'android', 'Platform stored accurately');
  pass('User model cleanly persists OneSignal pushSubscriptions');

  await User.deleteOne({ _id: testWorker._id });
  await disconnectDb();

  console.log('\n================================================================');
  console.log(`RESULTS: ${passed} PASSED, 0 FAILED (out of ${total} assertions)`);
  console.log('================================================================\n');
  console.log('ALL ONESIGNAL PUSH NOTIFICATION TESTS PASSED WITH 100% SUCCESS!');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test failure:', err);
  process.exit(1);
});
