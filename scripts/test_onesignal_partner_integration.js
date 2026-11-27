/**
 * OneSignal Partner Push Notification Verification Suite
 * Validates Partner App ID separation, dual-app targeting, and endpoint routing.
 */

'use strict';

process.env.NODE_ENV = 'test';

const assert = require('assert');
const oneSignalService = require('../src/services/oneSignalService');
const config = require('../src/config');

async function verifyPartnerOneSignalIntegration() {
  console.log('================================================================');
  console.log('HOMESTEPIN: PARTNER ONESIGNAL CONFIGURATION & DISPATCH AUDIT');
  console.log('================================================================\n');

  // 1. Verify Partner App ID Constant & Resolution
  const partnerAppId = '3ad71bb0-508d-4b7d-a09f-64754400c57b';
  const customerAppId = '28d1903d-40bf-4e76-9e0a-b2b005df2aae';

  const partnerConfig = oneSignalService.getOneSignalConfig('partner');
  assert.strictEqual(partnerConfig.appId, partnerAppId, 'Partner OneSignal App ID must match exactly');
  console.log('✓ Partner OneSignal App ID verified:', partnerConfig.appId);

  const customerConfig = oneSignalService.getOneSignalConfig('customer');
  assert.strictEqual(customerConfig.appId, customerAppId, 'Customer OneSignal App ID must remain unchanged');
  console.log('✓ Customer OneSignal App ID verified:', customerConfig.appId);

  // 2. Attach test transport to intercept mock push payloads
  oneSignalService.setTestOneSignalTransport(async (payload, appType) => {
    return {
      success: true,
      id: `mock-onesignal-${appType}-${Date.now()}`,
      recipients: 1,
      mockPayload: payload,
      appType,
    };
  });

  // 3. Dispatch Job Offer to Workers -> Must target Partner App
  console.log('\nTesting Job Offer Push Dispatch...');
  const offerRes = await oneSignalService.notifyJobOfferToWorkers(['worker_mongoid_101', 'worker_mongoid_102'], {
    _id: 'booking_9999',
    service: 'Deep Home Cleaning',
    address: 'Thillai Nagar, Trichy',
  });

  assert(offerRes.success === true, 'Job offer push must return success');
  const inbox = oneSignalService.getTestInbox();
  const lastEntry = inbox[inbox.length - 1];
  assert.strictEqual(lastEntry.appType, 'partner', 'Job offer must be routed to partner OneSignal app');
  assert.deepStrictEqual(
    lastEntry.payload.include_aliases.external_id,
    ['worker_mongoid_101', 'worker_mongoid_102'],
    'Worker external IDs must match MongoDB worker user IDs'
  );
  assert.strictEqual(lastEntry.payload.existing_android_channel_id || lastEntry.payload.android_channel_id, 'homestepin_jobs_v2', 'Channel must be homestepin_jobs_v2');
  console.log('✓ Job offer dispatch verified with partner routing and channel');

  // 4. Dispatch Direct Worker Alert
  console.log('\nTesting Direct Partner Notification...');
  await oneSignalService.sendNotificationToUser('worker_mongoid_101', {
    title: 'Booking Cancelled',
    body: 'Customer cancelled booking #booking_9999',
    data: { type: 'BOOKING_CANCELLED', bookingId: 'booking_9999' },
  }, 'partner');

  const workerEntry = inbox[inbox.length - 1];
  assert.strictEqual(workerEntry.appType, 'partner', 'Notification must target partner OneSignal app');
  assert.strictEqual(workerEntry.payload.data.bookingId, 'booking_9999', 'bookingId must be preserved in data');
  console.log('✓ Direct partner notification verified with partner appType');

  // 5. Customer Notification Integrity Check
  console.log('\nTesting Customer Notification Regression Check...');
  await oneSignalService.notifyBookingAssigned('customer_mongoid_201', {
    _id: 'booking_9999',
    service: 'Deep Home Cleaning',
  }, { name: 'Karthik S' });

  const updatedInbox = oneSignalService.getTestInbox();
  const custEntry = updatedInbox[updatedInbox.length - 1];
  assert.strictEqual(custEntry.appType, 'customer', 'Customer notification must target customer OneSignal app');
  console.log('✓ Customer notification integrity verified (target customer app)');

  console.log('\n================================================================');
  console.log('ALL PARTNER ONESIGNAL VERIFICATIONS PASSED (100% SUCCESS)');
  console.log('================================================================');
}

verifyPartnerOneSignalIntegration().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
