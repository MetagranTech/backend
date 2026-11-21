/**
 * HomeStepIn — OneSignal Push Notification Service
 *
 * Dedicated backend service for mobile and web push notifications:
 * - Customer & Partner push notifications
 * - Booking lifecycle alerts (created, assigned, arrived, completed, cancelled)
 * - Payment confirmations
 *
 * Exclusively uses the OneSignal REST API v1 with backend-authenticated REST API key.
 * Secrets are strictly isolated to server environment variables.
 */

'use strict';

const https = require('https');
const config = require('../config');

// In-memory test inbox for deterministic testing (strictly gated to NODE_ENV === 'test')
let testTransport = null;
const testInbox = [];

/**
 * Validate and retrieve OneSignal configuration.
 */
function getOneSignalConfig() {
  const appId = (process.env.ONESIGNAL_APP_ID || config.oneSignalAppId || '').trim();
  const apiKey = (process.env.ONESIGNAL_REST_API_KEY || config.oneSignalRestApiKey || '').trim();
  const isConfigured = Boolean(appId && apiKey && !apiKey.startsWith('your_') && !appId.startsWith('your_'));

  return {
    appId,
    apiKey,
    isConfigured,
  };
}

/**
 * Configure test transport hook for automated testing.
 * Strictly gated to NODE_ENV === 'test'.
 */
function setTestOneSignalTransport(transport) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Test transport hooks are strictly forbidden outside of NODE_ENV === "test"');
  }
  testTransport = transport;
}

/**
 * Retrieve test notifications inbox.
 */
function getTestInbox() {
  return [...testInbox];
}

/**
 * Clear test inbox.
 */
function clearTestInbox() {
  testInbox.length = 0;
}

/**
 * Core dispatch function to OneSignal REST API v1
 * @param {Object} payload OneSignal notification payload
 * @returns {Promise<Object>}
 */
async function sendOneSignalRequest(payload) {
  // 1. Intercept in test mode
  if (process.env.NODE_ENV === 'test' && testTransport) {
    const res = await testTransport(payload);
    testInbox.push({ payload, res, timestamp: new Date() });
    return res;
  }

  const { appId, apiKey, isConfigured } = getOneSignalConfig();

  if (!isConfigured) {
    console.warn('[OneSignal Service] Push notification skipped: ONESIGNAL_APP_ID or ONESIGNAL_REST_API_KEY not configured.');
    return {
      success: false,
      skipped: true,
      reason: 'ONESIGNAL_NOT_CONFIGURED',
    };
  }

  const bodyData = JSON.stringify({
    app_id: appId,
    ...payload,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'onesignal.com',
        path: '/api/v1/notifications',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Authorization': `Basic ${apiKey}`,
          'Content-Length': Buffer.byteLength(bodyData),
        },
        timeout: 10000,
      },
      res => {
        let raw = '';
        res.on('data', chunk => (raw += chunk));
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            if (res.statusCode >= 400) {
              const err = new Error(data?.errors?.[0] || `OneSignal error HTTP ${res.statusCode}`);
              err.status = res.statusCode;
              err.data = data;
              return resolve({ success: false, error: err.message, status: res.statusCode });
            }
            resolve({ success: true, id: data.id, recipients: data.recipients });
          } catch (e) {
            resolve({ success: false, error: `Invalid response from OneSignal: ${raw}` });
          }
        });
      }
    );

    req.on('error', err => {
      console.error('[OneSignal Service] Request error:', err.message);
      resolve({ success: false, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      console.warn('[OneSignal Service] Request timed out.');
      resolve({ success: false, error: 'TIMEOUT' });
    });

    req.write(bodyData);
    req.end();
  });
}

/**
 * Send push notification to a user by MongoDB user ID (using OneSignal External ID alias).
 * @param {string} userId MongoDB User _id or customId
 * @param {Object} details { title, body, data, sound }
 */
async function sendNotificationToUser(userId, { title, body, data = {}, sound = 'default' }) {
  if (!userId) return { success: false, reason: 'USER_ID_REQUIRED' };

  return sendOneSignalRequest({
    include_aliases: {
      external_id: [String(userId)],
    },
    target_channel: 'push',
    headings: { en: title },
    contents: { en: body },
    data,
    ios_sound: sound,
    android_channel_id: 'homestepin_jobs',
  });
}

/**
 * Send push notification to specific subscription / player IDs.
 * @param {string[]} subscriptionIds List of OneSignal player/subscription IDs
 * @param {Object} details { title, body, data, sound }
 */
async function sendNotificationToSubscriptions(subscriptionIds, { title, body, data = {}, sound = 'default' }) {
  const ids = Array.isArray(subscriptionIds) ? subscriptionIds.filter(Boolean) : [subscriptionIds].filter(Boolean);
  if (!ids.length) return { success: false, reason: 'NO_SUBSCRIPTIONS' };

  return sendOneSignalRequest({
    include_subscription_ids: ids,
    headings: { en: title },
    contents: { en: body },
    data,
    ios_sound: sound,
    android_channel_id: 'homestepin_jobs',
  });
}

/**
 * Helper: Notify customer about worker assignment.
 */
async function notifyBookingAssigned(customerUserId, booking, worker) {
  const workerName = worker?.name || 'A partner';
  return sendNotificationToUser(customerUserId, {
    title: 'Technician Assigned! 🔧',
    body: `${workerName} has accepted your booking for ${booking.service}.`,
    data: {
      type: 'BOOKING_ASSIGNED',
      bookingId: String(booking._id || booking.id),
      workerId: String(worker?._id || ''),
    },
  });
}

/**
 * Helper: Notify customer that worker has arrived at their location.
 */
async function notifyWorkerArrived(customerUserId, booking) {
  return sendNotificationToUser(customerUserId, {
    title: 'Technician Has Arrived! 🚪',
    body: `The technician has arrived for your service: ${booking.service}.`,
    data: {
      type: 'WORKER_ARRIVED',
      bookingId: String(booking._id || booking.id),
    },
  });
}

/**
 * Helper: Notify customer that booking is completed.
 */
async function notifyBookingCompleted(customerUserId, booking) {
  return sendNotificationToUser(customerUserId, {
    title: 'Service Completed! ⭐',
    body: `Your service for ${booking.service} is complete. Please rate your experience!`,
    data: {
      type: 'BOOKING_COMPLETED',
      bookingId: String(booking._id || booking.id),
    },
  });
}

/**
 * Helper: Notify user about booking cancellation.
 */
async function notifyBookingCancelled(targetUserId, booking, reason = '') {
  return sendNotificationToUser(targetUserId, {
    title: 'Booking Cancelled',
    body: `Booking for ${booking.service} has been cancelled.${reason ? ` Reason: ${reason}` : ''}`,
    data: {
      type: 'BOOKING_CANCELLED',
      bookingId: String(booking._id || booking.id),
    },
  });
}

/**
 * Helper: Dispatch new job offer to nearby workers.
 */
async function notifyJobOfferToWorkers(workerUserIds, booking) {
  const ids = Array.isArray(workerUserIds) ? workerUserIds : [workerUserIds];
  if (!ids.length) return { success: false, reason: 'NO_WORKERS' };

  return sendOneSignalRequest({
    include_aliases: {
      external_id: ids.map(String),
    },
    target_channel: 'push',
    headings: { en: 'New Service Request! ⚡' },
    contents: { en: `New booking: ${booking.service} in ${booking.address || 'Trichy'}` },
    data: {
      type: 'NEW_JOB_OFFER',
      bookingId: String(booking._id || booking.id),
      service: booking.service,
    },
    android_channel_id: 'homestepin_jobs',
    priority: 10,
  });
}

module.exports = {
  getOneSignalConfig,
  sendOneSignalRequest,
  sendNotificationToUser,
  sendNotificationToSubscriptions,
  notifyBookingAssigned,
  notifyWorkerArrived,
  notifyBookingCompleted,
  notifyBookingCancelled,
  notifyJobOfferToWorkers,
  setTestOneSignalTransport,
  getTestInbox,
  clearTestInbox,
};
