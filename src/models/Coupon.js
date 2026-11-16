const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, index: true },
    title: { type: String, default: '' },
    description: { type: String, default: '' },
    discountType: { type: String, enum: ['flat', 'percentage'], default: 'flat' },
    discountValue: { type: Number, default: 0 },
    percent: { type: Number, min: 0, max: 100, default: 0 },
    amount: { type: Number, min: 0, default: 0 },
    maxDiscount: { type: Number, default: 250 },
    minOrderAmount: { type: Number, default: 299 },
    applicableService: { type: String, default: 'all' },
    applicableCategory: { type: String, default: 'all' },
    startDate: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    usageLimit: { type: Number, default: 0 }, // 0 = unlimited global redemptions
    perUserLimit: { type: Number, default: 1 }, // default 1 use per customer
    usageCount: { type: Number, default: 0 },
    newCustomerOnly: { type: Boolean, default: false, index: true }, // Only valid for first-time customers
    paymentMethods: { type: [String], default: [] }, // e.g. ['ONLINE', 'COD'] or empty for all
    displayOrder: { type: Number, default: 0, index: true },
    terms: { type: mongoose.Schema.Types.Mixed, default: '' },
    is_visible: { type: Boolean, default: true, index: true },
    active: { type: Boolean, default: true, index: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual field aliases for schema versatility
couponSchema.virtual('minimumOrderValue').get(function () {
  return this.minOrderAmount;
});
couponSchema.virtual('maximumDiscount').get(function () {
  return this.maxDiscount;
});
couponSchema.virtual('totalUsageLimit').get(function () {
  return this.usageLimit;
});
couponSchema.virtual('totalRedeemedCount').get(function () {
  return this.usageCount;
});
couponSchema.virtual('perUserUsageLimit').get(function () {
  return this.perUserLimit;
});

couponSchema.index({ is_visible: 1, active: 1, expiresAt: 1, displayOrder: 1 });
couponSchema.index({ newCustomerOnly: 1, active: 1 });

module.exports = mongoose.model('Coupon', couponSchema);
