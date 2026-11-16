const mongoose = require('mongoose');

const couponUsageSchema = new mongoose.Schema(
  {
    couponId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon', required: true, index: true },
    couponCode: { type: String, required: true, uppercase: true, index: true },
    customerId: { type: String, required: true, index: true },
    bookingId: { type: String, default: null, index: true },
    reservationId: { type: String, default: null, index: true },
    discountAmount: { type: Number, required: true, min: 0 },
    originalAmount: { type: Number, default: 0 },
    finalAmount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['reserved', 'redeemed', 'released', 'expired'],
      default: 'redeemed',
      index: true,
    },
    redemptionIndex: { type: Number, default: 1 },
    reservedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null, index: true },
    redeemedAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },
    usedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Compound index enforcing atomic uniqueness for active reservations and redemptions per customer redemption slot
couponUsageSchema.index(
  { couponCode: 1, customerId: 1, redemptionIndex: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['reserved', 'redeemed'] } } }
);
couponUsageSchema.index({ bookingId: 1, couponCode: 1 });
couponUsageSchema.index({ customerId: 1, status: 1 });
couponUsageSchema.index({ reservationId: 1, customerId: 1 });

module.exports = mongoose.model('CouponUsage', couponUsageSchema);
