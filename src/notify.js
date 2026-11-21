const Notification = require('./models/Notification');
const AuditLog = require('./models/AuditLog');
const oneSignalService = require('./services/oneSignalService');

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

  // Dispatch background push notification via OneSignal (non-blocking)
  if (userId) {
    oneSignalService
      .sendNotificationToUser(userId, {
        title,
        body,
        data: {
          ...(data || {}),
          type,
          bookingId: booking ? String(booking) : null,
          notificationId: String(doc._id),
        },
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
