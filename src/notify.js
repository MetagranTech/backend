const Notification = require('./models/Notification');
const AuditLog = require('./models/AuditLog');
const oneSignalService = require('./services/oneSignalService');
const fcmService = require('./services/fcmService');

async function notify(userId, { title, body, type, booking, data, dedupeKey }) {
  if (dedupeKey) {
    const existing = await Notification.findOne({ dedupeKey });
    if (existing) return existing;
  }
  const doc = await Notification.create({
    user: userId,
    title,
    body,
    type,
    booking,
    data,
    dedupeKey,
  });
  const io = global.__hsiIo;
  if (io) io.to(`user:${userId}`).emit('notification', serializeNotification(doc));

  // Dispatch background push notification: FCM first (when configured + token present), OneSignal fallback
  if (userId) {
    const User = require('./models/User');
    User.findById(userId)
      .select('role')
      .lean()
      .then(async u => {
        const appType = u?.role === 'worker' ? 'partner' : 'customer';
        const pushPayload = {
          title,
          body,
          data: {
            ...(data || {}),
            type,
            bookingId: booking ? String(booking) : null,
            notificationId: String(doc._id),
            eventId: dedupeKey || String(doc._id),
          },
        };

        const fcmRes = await fcmService.sendToUser(userId, pushPayload, appType).catch(() => null);
        if (fcmRes && fcmRes.success && fcmRes.recipients > 0) {
          return fcmRes;
        }
        return oneSignalService.sendNotificationToUser(userId, pushPayload, appType);
      })
      .catch(err => console.warn('[Push Notification Dispatch Warning]:', err.message));
  }

  return doc;
}

function serializeNotification(n) {
  return {
    id: String(n._id),
    title: n.title,
    body: n.body,
    type: n.type,
    bookingId: n.booking ? String(n.booking) : null,
    read: n.read,
    createdAt: n.createdAt,
    data: n.data || {},
  };
}

async function audit({ actor, role, action, booking, targetType, targetId, meta }) {
  await AuditLog.create({ actor, role, action, booking, targetType, targetId, meta });
}

module.exports = { notify, serializeNotification, audit };
