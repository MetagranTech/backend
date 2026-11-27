'use strict';

process.env.NODE_ENV = 'development';
const oneSignalService = require('../src/services/oneSignalService');

async function main() {
  console.log('Testing OneSignal Channel Normalization & Delivery Resilience...\n');

  // Test 1: Auto-normalization of legacy android_channel_id
  const res1 = await oneSignalService.sendOneSignalRequest({
    include_aliases: { external_id: ['test_auto_normalized_worker'] },
    target_channel: 'push',
    headings: { en: 'Normalization Test' },
    contents: { en: 'Testing normalization' },
    android_channel_id: 'homestepin_jobs_v2',
  }, 'partner');

  console.log('Test 1 (Auto-normalized android_channel_id -> existing_android_channel_id):');
  console.log('  Success:', res1.success);
  console.log('  Zero Recipients:', res1.isZeroRecipients);
  console.log('  Error:', res1.error);
  if (res1.error && res1.error.includes('Could not find android_channel_id')) {
    throw new Error('FAIL: android_channel_id was not resolved or stripped!');
  }
  console.log('  [PASS] No "Could not find android_channel_id" error!\n');

  // Test 2: Native existing_android_channel_id
  const res2 = await oneSignalService.sendOneSignalRequest({
    include_aliases: { external_id: ['test_existing_channel_worker'] },
    target_channel: 'push',
    headings: { en: 'Existing Channel Test' },
    contents: { en: 'Testing existing_android_channel_id' },
    existing_android_channel_id: 'homestepin_jobs_v2',
  }, 'partner');

  console.log('Test 2 (Direct existing_android_channel_id):');
  console.log('  Success:', res2.success);
  console.log('  Zero Recipients:', res2.isZeroRecipients);
  console.log('  Error:', res2.error);
  if (res2.error && res2.error.includes('Could not find android_channel_id')) {
    throw new Error('FAIL: existing_android_channel_id failed with channel error!');
  }
  console.log('  [PASS] No "Could not find android_channel_id" error!\n');

  // Test 3: Customer App
  const res3 = await oneSignalService.sendOneSignalRequest({
    include_aliases: { external_id: ['test_cust_channel'] },
    target_channel: 'push',
    headings: { en: 'Customer Channel Test' },
    contents: { en: 'Testing customer channel' },
    existing_android_channel_id: 'homestepin_messages_v2',
  }, 'customer');

  console.log('Test 3 (Customer App existing_android_channel_id):');
  console.log('  Success:', res3.success);
  console.log('  Zero Recipients:', res3.isZeroRecipients);
  console.log('  Error:', res3.error);
  if (res3.error && res3.error.includes('Could not find android_channel_id')) {
    throw new Error('FAIL: Customer app failed with channel error!');
  }
  console.log('  [PASS] No "Could not find android_channel_id" error!\n');

  console.log('================================================================');
  console.log('ALL CHANNEL TESTS PASSED - ZERO CHANNEL ERRORS REPORTED');
  console.log('================================================================');
}

main().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
