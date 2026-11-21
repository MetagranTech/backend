const mongoose = require('mongoose');

const refreshTokenSchema = new mongoose.Schema(
  {
    hash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    customId: { type: String, unique: true, sparse: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, lowercase: true, trim: true, unique: true, sparse: true },
    username: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true, unique: true, sparse: true },
    employeeId: { type: String, trim: true, uppercase: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, required: true, index: true },
    adminRole: {
      type: String,
      enum: ['SUPER_ADMIN', 'ADMIN', 'BASIC_ADMIN', 'Super Admin', 'Operations Admin'],
      default: 'ADMIN',
      index: true,
    },
    isSystemSuperAdmin: {
      type: Boolean,
      default: false,
      index: true,
    },
    isProtected: {
      type: Boolean,
      default: false,
    },
    createdBy: {
      type: String,
      default: null,
    },
    status: {
      type: String,
      enum: ['active', 'disabled', 'suspended', 'pending_verification'],
      default: 'active',
      index: true,
    },
    emailVerified: {
      type: Boolean,
      default: false,
      index: true,
    },
    phoneVerified: {
      type: Boolean,
      default: false,
      index: true,
    },
    // Deprecated: legacy Firebase UID preserved as unindexed optional field for backward compatibility
    firebaseUid: {
      type: String,
      default: null,
    },
    authProvider: {
      type: String,
      default: 'local',
    },
    mustChangePassword: {
      type: Boolean,
      default: false,
    },
    avatarUrl: String,
    address: String,
    addresses: [
      {
        id: String,
        label: { type: String, default: 'Home' },
        address: { type: String, required: true },
        formattedAddress: String,
        house: String,
        houseNumber: String,
        floor: String,
        line1: String,
        street: String,
        area: String,
        locality: String,
        city: String,
        district: String,
        state: String,
        pincode: String,
        postalCode: String,
        country: { type: String, default: 'India' },
        landmark: String,
        mobileNumber: String,
        latitude: Number,
        longitude: Number,
        accuracy: Number,
        source: { type: String, default: 'GPS' },
        confirmedAt: { type: Date, default: Date.now },
        isDefault: { type: Boolean, default: false },
      },
    ],
    // Worker specific profile metadata
    kycStatus: { type: String, enum: ['unsubmitted', 'pending', 'approved', 'rejected'], default: 'pending' },
    services: [{ type: String }],
    approvedServices: [{ type: String }],
    pendingServices: [{ type: String }],
    serviceArea: { type: String, default: 'Bengaluru' },
    serviceRadiusKm: { type: Number, default: 15 },
    ratingAvg: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
    online: { type: Boolean, default: false, index: true },
    todayEarnings: { type: Number, default: 0 },
    walletBalance: { type: Number, default: 0 },
    otp: {
      codeHash: { type: String, select: false },
      expiresAt: Date,
      purpose: String, // 'email_verification' | 'password_reset'
      attempts: { type: Number, default: 0 },
      resendCooldownExpires: Date,
      resendCount: { type: Number, default: 0 },
    },
    // OneSignal & Device Push Notification Subscriptions
    pushSubscriptions: [
      {
        subscriptionId: { type: String, required: true },
        deviceId: { type: String },
        platform: { type: String, enum: ['android', 'ios', 'web'], default: 'android' },
        lastSeenAt: { type: Date, default: Date.now },
      },
    ],
    fcmTokens: [
      {
        token: { type: String, required: true },
        deviceId: { type: String },
        platform: { type: String, enum: ['android', 'ios', 'web'], default: 'android' },
        lastSeenAt: { type: Date, default: Date.now },
      },
    ],
    soundPreferences: {
      appSounds: { type: Boolean, default: true },
      incomingCallSound: { type: Boolean, default: true },
      outgoingCallSound: { type: Boolean, default: true },
      chatMessageSound: { type: Boolean, default: true },
      bookingNotificationSound: { type: Boolean, default: true },
    },
    refreshTokens: { type: [refreshTokenSchema], default: [], select: false },
    lastLoginAt: Date,
  },
  { timestamps: true }
);

userSchema.index({ role: 1, online: 1 });
userSchema.index({ role: 1, status: 1, online: 1, services: 1 });
userSchema.index(
  { username: 1 },
  { unique: true, partialFilterExpression: { username: { $type: 'string' } } }
);
userSchema.index(
  { employeeId: 1 },
  { unique: true, partialFilterExpression: { employeeId: { $type: 'string' } } }
);

module.exports = mongoose.model('User', userSchema);
