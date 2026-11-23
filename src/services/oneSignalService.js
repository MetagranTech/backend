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
 * Supports both Customer and Partner apps with separate App IDs and API keys.
 */
function getOneSignalConfig(appType = 'customer') {
  let appId, apiKey;
  if (appType === 'partner' || appType === 'worker') {
    appId = (process.env.ONESIGNAL_PARTNER_APP_ID || config.oneSignalPartnerAppId || '3ad71bb0-508d-4b7d-a09f-64754400c57b').trim();
    apiKey = (process.env.ONESIGNAL_PARTNER_REST_API_KEY || config.oneSignalPartnerRestApiKey || process.env.ONESIGNAL_REST_API_KEY || config.oneSignalRestApiKey || '').trim();
  } else {
    appId = (process.env.ONESIGNAL_APP_ID || config.oneSignalAppId || '28d1903d-40bf-4e76-9e0a-b2b005df2aae').trim();
    apiKey = (process.env.ONESIGNAL_REST_API_KEY || config.oneSignalRestApiKey || '').trim();
  }
  const isConfigured = Boolean(appId && apiKey && !apiKey.startsWith('your_') && !appId.startsWith('your_'));

  return {
    appId,
    apiKey,
    isConfigured,
    appType,
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
 * @param {string} [appType='customer'] Target app: 'customer' or 'partner'
 * @returns {Promise<Object>}
 */
async function sendOneSignalRequest(payload, appType = 'customer') {
  // 1. Intercept in test mode
  if (process.env.NODE_ENV === 'test' && testTransport) {
    let res = await testTransport(payload, appType);
    if (res && res.id && res.recipients === 0) {
      res = {
        ...res,
        success: false,
        recipients: 0,
        error: 'OneSignal provider accepted request but matched 0 device recipients (unregistered or unmapped alias)',
        isZeroRecipients: true,
        isTransient: true,
        isPermanent: false,
      };
    }
    testInbox.push({ payload, appType, res, timestamp: new Date() });
    return res;
  }

  const { appId, apiKey, isConfigured } = getOneSignalConfig(appType);

  if (!isConfigured) {
    console.warn(`[OneSignal Service] Push notification skipped for ${appType}: ONESIGNAL credentials not configured.`);
    return {
      success: false,
      skipped: true,
      reason: 'ONESIGNAL_NOT_CONFIGURED',
      error: `OneSignal credentials not configured for app ${appType}`,
      isPermanent: true,
      isTransient: false,
    };
  }

  const bodyData = JSON.stringify({
    app_id: appId,
    ...payload,
  });

  return new Promise((resolve) => {
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
              const errorMessage = Array.isArray(data?.errors) ? data.errors.join('; ') : (data?.errors || `OneSignal HTTP ${res.statusCode}`);
              const isTransient = res.statusCode === 429 || res.statusCode >= 500;
              const isPermanent = !isTransient;
              return resolve({
                success: false,
                error: errorMessage,
                status: res.statusCode,
                isTransient,
                isPermanent,
                data,
              });
            }
            if (data?.id) {
              const recipientCount = typeof data.recipients === 'number' ? data.recipients : 0;
              if (recipientCount === 0) {
                return resolve({
                  success: false,
                  id: data.id,
                  recipients: 0,
                  error: 'OneSignal provider accepted request but matched 0 device recipients (unregistered or unmapped alias)',
                  isZeroRecipients: true,
                  isTransient: true,
                  isPermanent: false,
                  data,
                });
              }
              resolve({
                success: true,
                id: data.id,
                recipients: recipientCount,
                data,
              });
            } else {
              resolve({
                success: false,
                error: 'Provider response missing notification id',
                isPermanent: true,
                isTransient: false,
                data,
              });
            }
          } catch (e) {
            resolve({
              success: false,
              error: `Invalid JSON response from OneSignal (HTTP ${res.statusCode})`,
              isTransient: res.statusCode >= 500,
              isPermanent: res.statusCode < 500,
            });
          }
        });
      }
    );

    req.on('error', err => {
      resolve({
        success: false,
        error: `Network error: ${err.message}`,
        isTransient: true,
        isPermanent: false,
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        success: false,
        error: 'OneSignal request timed out (10s)',
        isTransient: true,
        isPermanent: false,
      });
    });

    req.write(bodyData);
    req.end();
  });
}

/**
 * Send push notification to a user by MongoDB user ID (using OneSignal External ID alias).
 * Resolves both MongoDB _id and customId aliases to guarantee delivery regardless of client auth format.
 * @param {string} userId MongoDB User _id or customId
 * @param {Object} details { title, body, data, sound }
 * @param {string} [appType='customer'] Target app: 'customer' or 'partner'
 */
async function sendNotificationToUser(userId, { title, body, data = {}, sound = 'default' }, appType = 'customer') {
  if (!userId) return { success: false, reason: 'USER_ID_REQUIRED' };

  const isChatMessage = data?.type === 'CHAT_MESSAGE' || data?.type === 'chat_message';
  const isIncomingCall = data?.type === 'INCOMING_CALL' || data?.type === 'incoming_call';
  const channelId = isChatMessage ? 'homestepin_messages_v2' : 'homestepin_jobs_v2';

  const externalIds = new Set([String(userId)]);
  let userSubscriptions = [];

  // Resolve both MongoDB _id and customId as external_id aliases, and gather confirmed device subscriptions
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection && mongoose.connection.readyState === 1) {
      const User = mongoose.models.User;
      if (User) {
        const isOid = mongoose.Types.ObjectId.isValid(userId) && /^[0-9a-fA-F]{24}$/.test(String(userId));
        const u = await User.findOne({
          $or: [
            ...(isOid ? [{ _id: userId }] : []),
            { customId: userId },
            { id: userId },
          ]
        }).select('_id customId pushSubscriptions role').lean();
        if (u) {
          if (u._id) externalIds.add(String(u._id));
          if (u.customId) externalIds.add(String(u.customId));
          if (Array.isArray(u.pushSubscriptions) && u.pushSubscriptions.length > 0) {
            userSubscriptions = u.pushSubscriptions
              .map(s => s.subscriptionId || s.token)
              .filter(Boolean)
              .map(String);
          }
        }
      }
    }
  } catch (_) {}

  const correlationId = data?.eventId || data?.notificationId || `evt_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  if (process.env.NODE_ENV !== 'test') {
    console.log(`[OneSignal Dispatch] correlationId=${correlationId} appType=${appType} type=${data?.type || 'STANDARD'} aliases=${Array.from(externalIds).length} knownSubscriptions=${userSubscriptions.length}`);
  }

  // 1. Primary Dispatch: Target by external_id aliases
  const primaryResult = await sendOneSignalRequest({
    include_aliases: {
      external_id: Array.from(externalIds),
    },
    target_channel: 'push',
    headings: { en: title },
    contents: { en: body },
    data: {
      ...data,
      correlationId,
    },
    ios_sound: sound,
    android_channel_id: channelId,
    priority: isIncomingCall || data?.priority === 'CRITICAL' ? 10 : 5,
  }, appType);

  // 2. Safe Fallback: If alias dispatch produced 0 recipients, fall back to validated active subscription IDs
  if (!primaryResult.success && primaryResult.isZeroRecipients && userSubscriptions.length > 0) {
    if (process.env.NODE_ENV !== 'test') {
      console.log(`[OneSignal Dispatch Fallback] correlationId=${correlationId} targeting ${userSubscriptions.length} registered subscriptions`);
    }
    const fallbackResult = await sendOneSignalRequest({
      include_subscription_ids: userSubscriptions,
      headings: { en: title },
      contents: { en: body },
      data: {
        ...data,
        correlationId: `${correlationId}_sub_fallback`,
      },
      ios_sound: sound,
      android_channel_id: channelId,
      priority: isIncomingCall || data?.priority === 'CRITICAL' ? 10 : 5,
    }, appType);

    if (fallbackResult.success && fallbackResult.recipients > 0) {
      return {
        ...fallbackResult,
        targetedBy: 'subscription_ids_fallback',
        aliasResult: primaryResult,
      };
    }
    return fallbackResult;
  }

  return primaryResult;
}

/**
 * Send push notification to specific subscription / player IDs.
 * @param {string[]} subscriptionIds List of OneSignal player/subscription IDs
 * @param {Object} details { title, body, data, sound }
 * @param {string} [appType='customer'] Target app: 'customer' or 'partner'
 */
async function sendNotificationToSubscriptions(subscriptionIds, { title, body, data = {}, sound = 'default' }, appType = 'customer') {
  const ids = Array.isArray(subscriptionIds) ? subscriptionIds.filter(Boolean) : [subscriptionIds].filter(Boolean);
  if (!ids.length) return { success: false, reason: 'NO_SUBSCRIPTIONS' };

  const isChatMessage = data?.type === 'CHAT_MESSAGE' || data?.type === 'chat_message';
  const channelId = isChatMessage ? 'homestepin_messages_v2' : 'homestepin_jobs_v2';

  return sendOneSignalRequest({
    include_subscription_ids: ids,
    headings: { en: title },
    contents: { en: body },
    data,
    ios_sound: sound,
    android_channel_id: channelId,
  }, appType);
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
async function notifyBookingCancelled(targetUserId, booking, reason = '', appType = 'customer') {
  return sendNotificationToUser(targetUserId, {
    title: 'Booking Cancelled',
    body: `Booking for ${booking.service} has been cancelled.${reason ? ` Reason: ${reason}` : ''}`,
    data: {
      type: 'BOOKING_CANCELLED',
      bookingId: String(booking._id || booking.id),
    },
  }, appType);
}

/**
 * Helper: Dispatch new job offer to nearby workers.
 */
async function notifyJobOfferToWorkers(workerUserIds, booking) {
  const ids = Array.isArray(workerUserIds) ? workerUserIds : [workerUserIds];
  const validIds = ids
    .filter(id => id !== null && id !== undefined)
    .map(String)
    .map(s => s.trim())
    .filter(s => s.length > 0 && s !== 'null' && s !== 'undefined');

  if (!validIds.length) return { success: false, reason: 'NO_WORKERS' };

  return sendOneSignalRequest({
    include_aliases: {
      external_id: validIds,
    },
    target_channel: 'push',
    headings: { en: 'New Service Request! ⚡' },
    contents: { en: `New booking: ${booking.service} in ${booking.address || booking.area || booking.city || 'Trichy'}` },
    data: {
      type: 'NEW_JOB_OFFER',
      bookingId: String(booking.customId || booking._id || booking.id),
      service: booking.service,
    },
    android_channel_id: 'homestepin_jobs_v2',
    priority: 10,
  }, 'partner');
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
