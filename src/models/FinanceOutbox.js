const mongoose = require('mongoose');

const financeOutboxSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    eventType: {
      type: String,
      enum: ['COD_COLLECTION', 'BOOKING_REVERSAL', 'BOOKING_REFUND'],
      required: true,
    },
    bookingId: { type: String, required: true, index: true },
    partnerId: { type: String, required: true, index: true },
    customerId: { type: String, default: null },
    amount: { type: Number, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: ['PENDING', 'PROCESSING', 'SYNCED', 'FAILED'],
      default: 'PENDING',
      index: true,
    },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 20 },
    nextRetryAt: { type: Date, default: Date.now, index: true },
    lastError: { type: String, default: null },
    syncedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

financeOutboxSchema.index({ status: 1, nextRetryAt: 1 });

module.exports = mongoose.model('FinanceOutbox', financeOutboxSchema);
