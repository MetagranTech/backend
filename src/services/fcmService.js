'use strict';

const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const config = require('../config');

const FCM_APP_NAME = 'homestepin-fcm';
const EXPECTED_PROJECT_ID = 'homestepin-bf3b8';

let fcmApp = null;
let initError = null;
let testMessagingTransport = null;

function setTestFcmTransport(transport) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('FCM test transport is strictly forbidden outside NODE_ENV === "test"');
  }
  testMessagingTransport = transport;
}

function normalizePrivateKey(rawValue) {
  let key = String(rawValue || '').trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }
  return key.replace(/\\n/g, '\n').trim();
}

function getCredentialsFromEnv() {
  const rawJson = (process.env.FCM_SERVICE_ACCOUNT_JSON || config.fcmServiceAccountJson || '').trim();
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      if (parsed && parsed.project_id && parsed.client_email && parsed.private_key) {
        return {
          projectId: String(parsed.project_id).trim(),
          clientEmail: String(parsed.client_email).trim(),
          privateKey: String(parsed.private_key).replace(/\\n/g, '\n').trim(),
        };
      }
      throw new Error('FCM_SERVICE_ACCOUNT_JSON is missing required fields (project_id, client_email, private_key).');
    } catch (err) {
      throw new Error(`Invalid FCM_SERVICE_ACCOUNT_JSON: ${err.message}`);
    }
  }

  const projectId = (process.env.FCM_PROJECT_ID || config.fcmProjectId || '').trim();
  const clientEmail = (process.env.FCM_CLIENT_EMAIL || config.fcmClientEmail || '').trim();
  const privateKey = normalizePrivateKey(process.env.FCM_PRIVATE_KEY || config.fcmPrivateKey || '');

  if (!projectId || !clientEmail || !privateKey) {
    return null;
  }

  if (!privateKey.includes('BEGIN PRIVATE KEY')) {
    throw new Error('FCM_PRIVATE_KEY is malformed (missing PEM header).');
  }

  return { projectId, clientEmail, privateKey };
}

function initFcmApp() {
  try {
    const existing = getApps().find(a => a && a.name === FCM_APP_NAME);
    if (existing) {
      fcmApp = existing;
      initError = null;
      return fcmApp;
    }

    const creds = getCredentialsFromEnv();
    if (!creds) {
      initError = 'FCM credentials not configured (FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY or FCM_SERVICE_ACCOUNT_JSON missing).';
      return null;
    }

    fcmApp = initializeApp(
      {
        credential: cert({
          projectId: creds.projectId,
          clientEmail: creds.clientEmail,
          privateKey: creds.privateKey,
        }),
      },
      FCM_APP_NAME
    );
    initError = null;
    console.log(`[FCM Service] Initialized dedicated Firebase Admin app '${FCM_APP_NAME}' for project '${creds.projectId}'.`);
    return fcmApp;
  } catch (err) {
    // Never log private key or credential strings
    initError = err.message || 'Failed to initialize FCM Firebase Admin app.';
    fcmApp = null;
    console.warn(`[FCM Service Warning] Initialization skipped: ${initError}`);
    return null;
  }
}

function isConfigured() {
  if (process.env.NODE_ENV === 'test' && testMessagingTransport) {
    return true;
  }
  if (!fcmApp) {
    initFcmApp();
  }
  return Boolean(fcmApp);
}

function getFcmStatus() {
  const credsConfigured = Boolean(
    process.env.FCM_SERVICE_ACCOUNT_JSON ||
    (process.env.FCM_PROJECT_ID && process.env.FCM_CLIENT_EMAIL && process.env.FCM_PRIVATE_KEY) ||
    config.fcmServiceAccountJson ||
    (config.fcmProjectId && config.fcmClientEmail && config.fcmPrivateKey)
  );
  return {
    appName: FCM_APP_NAME,
    expectedProjectId: EXPECTED_PROJECT_ID,
    configured: credsConfigured,
    initialized: Boolean(fcmApp || getApps().find(a => a && a.name === FCM_APP_NAME)),
    error: initError,
  };
}

function stringifyDataValues(dataObj) {
  const out = {};
  if (!dataObj || typeof dataObj !== 'object') return out;
  for (const [k, v] of Object.entries(dataObj)) {
    if (v === undefined || v === null) continue;
    out[String(k)] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}

function isInvalidTokenErrorCode(code) {
  return [
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
    'messaging/mismatched-credential',
  ].includes(code);
}

async function resolveTargetFcmTokens(userId, appType = 'customer') {
  const mongoose = require('mongoose');
  if (!mongoose.connection || mongoose.connection.readyState !== 1) return { user: null, tokens: [] };
  const User = mongoose.models.User;
  if (!User) return { user: null, tokens: [] };

  const isOid = mongoose.Types.ObjectId.isValid(userId) && /^[0-9a-fA-F]{24}$/.test(String(userId));
  const user = await User.findOne({
    $or: [
      ...(isOid ? [{ _id: userId }] : []),
      { customId: userId },
      { id: userId },
      { employeeId: userId },
    ],
  }).select('_id customId role fcmTokens');

  if (!user || !Array.isArray(user.fcmTokens) || user.fcmTokens.length === 0) {
    return { user, tokens: [] };
  }

  const normalizedAppType = appType === 'worker' ? 'partner' : appType;
  const userRoleApp = (user.role === 'worker' || user.role === 'partner') ? 'partner' : 'customer';

  // Role & app separation: only match tokens registered for this appType (or legacy untagged tokens if role matches)
  const tokens = user.fcmTokens
    .filter(t => {
      if (!t || !t.token) return false;
      const tok = String(t.token).trim();
      // Skip synthetic placeholder tokens (dev_android_...)
      if (!tok || tok.startsWith('dev_')) return false;
      if (t.appType) {
        return t.appType === normalizedAppType;
      }
      return userRoleApp === normalizedAppType;
    })
    .map(t => String(t.token).trim());

  return { user, tokens: Array.from(new Set(tokens)) };
}

async function pruneInvalidTokens(user, invalidTokens) {
  if (!user || !Array.isArray(invalidTokens) || invalidTokens.length === 0) return 0;
  try {
    const mongoose = require('mongoose');
    const User = mongoose.models.User;
    if (!User) return 0;
    const res = await User.updateOne(
      { _id: user._id },
      { $pull: { fcmTokens: { token: { $in: invalidTokens } } } }
    );
    return res.modifiedCount || 0;
  } catch (err) {
    console.warn('[FCM Token Prune Warning]:', err.message);
    return 0;
  }
}

async function sendToUser(userId, { title, body, data = {}, sound = 'default' }, appType = 'customer') {
  if (!userId) return { success: false, reason: 'USER_ID_REQUIRED', provider: 'fcm' };

  if (!isConfigured()) {
    return {
      success: false,
      skipped: true,
      provider: 'fcm',
      reason: 'FCM_NOT_CONFIGURED',
      error: initError || 'FCM is not configured.',
    };
  }

  const { user, tokens } = await resolveTargetFcmTokens(userId, appType);
  if (tokens.length === 0) {
    return {
      success: false,
      skipped: true,
      provider: 'fcm',
      reason: 'NO_FCM_TOKENS',
      recipients: 0,
    };
  }

  const eventType = String(data?.type || 'NOTIFICATION');
  const isChatMessage = eventType.toUpperCase() === 'CHAT_MESSAGE';
  const isIncomingCall = eventType.toUpperCase() === 'INCOMING_CALL';
  const channelId = isChatMessage ? 'homestepin_messages_v2' : 'homestepin_jobs_v2';
  const correlationId = String(data?.eventId || data?.notificationId || `fcm_${Date.now()}`);

  const messagePayload = {
    tokens,
    notification: {
      title: String(title || 'HomeStepIn'),
      body: String(body || ''),
    },
    data: stringifyDataValues({
      ...data,
      correlationId,
      appType: appType === 'worker' ? 'partner' : appType,
    }),
    android: {
      priority: isIncomingCall || data?.priority === 'CRITICAL' ? 'high' : 'high',
      notification: {
        channelId,
        sound: sound === null ? undefined : (isChatMessage ? 'homestepin_message' : 'homestepin_notification'),
      },
    },
  };

  try {
    let response;
    if (process.env.NODE_ENV === 'test' && testMessagingTransport) {
      response = await testMessagingTransport(messagePayload, appType);
    } else {
      const messaging = getMessaging(fcmApp);
      response = await messaging.sendEachForMulticast(messagePayload);
    }

    const invalidTokens = [];
    const messageIds = [];
    if (Array.isArray(response?.responses)) {
      response.responses.forEach((r, idx) => {
        if (r.success && r.messageId) {
          messageIds.push(r.messageId);
        } else if (r.error && isInvalidTokenErrorCode(r.error.code)) {
          invalidTokens.push(tokens[idx]);
        }
      });
    }

    if (invalidTokens.length > 0) {
      await pruneInvalidTokens(user, invalidTokens);
    }

    const successCount = Number(response?.successCount || 0);
    if (successCount > 0) {
      return {
        success: true,
        provider: 'fcm',
        id: messageIds[0] || correlationId,
        recipients: successCount,
        failureCount: Number(response?.failureCount || 0),
        prunedTokensCount: invalidTokens.length,
      };
    }

    return {
      success: false,
      provider: 'fcm',
      recipients: 0,
      failureCount: Number(response?.failureCount || tokens.length),
      prunedTokensCount: invalidTokens.length,
      error: response?.responses?.[0]?.error?.message || 'FCM rejected all target tokens.',
    };
  } catch (err) {
    return {
      success: false,
      provider: 'fcm',
      recipients: 0,
      error: err.message || 'FCM sendEachForMulticast failed.',
    };
  }
}

module.exports = {
  FCM_APP_NAME,
  initFcmApp,
  isConfigured,
  getFcmStatus,
  sendToUser,
  resolveTargetFcmTokens,
  pruneInvalidTokens,
  setTestFcmTransport,
};
