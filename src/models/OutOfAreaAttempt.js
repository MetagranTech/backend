const mongoose = require('mongoose');

const outOfAreaAttemptSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: [
        'BOOKING_ATTEMPT',
        'ADDRESS_CREATION_ATTEMPT',
        'ADDRESS_UPDATE_ATTEMPT',
        'ADDRESS_CREATION',
        'ADDRESS_UPDATE',
        'REGISTRATION_ATTEMPT',
        'WORKER_REGISTRATION_ATTEMPT',
        'BOOKING_ADDRESS_UPDATE_ATTEMPT',
        'BOOKING_ADDRESS_UPDATE',
        'COVERAGE_CHECK',
      ],
      required: true,
      index: true,
    },
    userId: { type: String, default: null, index: true },
    userRole: { type: String, default: 'customer' },
    userEmail: { type: String, default: null },
    userPhone: { type: String, default: null },
    address: { type: String, default: '' },
    city: { type: String, default: '' },
    state: { type: String, default: '' },
    pincode: { type: String, default: '' },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    detectedDistanceKm: { type: Number, default: null },
    reason: { type: String, default: 'Outside approved Trichy service boundary' },
    ip: { type: String, default: null },
    source: { type: String, default: 'MOBILE_APP' },
  },
  { timestamps: true }
);

outOfAreaAttemptSchema.index({ createdAt: -1 });

module.exports = mongoose.model('OutOfAreaAttempt', outOfAreaAttemptSchema);
