const mongoose = require('mongoose');

const serviceAreaSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    city: { type: String, required: true, trim: true, default: 'Tiruchirappalli' },
    aliasCities: [{ type: String, lowercase: true, trim: true }],
    state: { type: String, required: true, trim: true, default: 'Tamil Nadu' },
    country: { type: String, required: true, trim: true, default: 'India' },
    timezone: { type: String, default: 'Asia/Kolkata' },
    currency: { type: String, default: 'INR' },
    status: { type: String, enum: ['active', 'disabled'], default: 'active', index: true },
    isDefault: { type: Boolean, default: false },
    boundaryType: { type: String, enum: ['polygon', 'radius'], default: 'polygon' },
    center: {
      latitude: { type: Number, required: true, default: 10.8050 },
      longitude: { type: Number, required: true, default: 78.6856 },
    },
    radiusKm: { type: Number, default: 18 },
    polygon: {
      type: {
        type: String,
        enum: ['Polygon'],
        default: 'Polygon',
      },
      coordinates: {
        type: [[[Number]]], // Array of arrays of [longitude, latitude]
        default: [
          [
            [78.6400, 10.8700], // Srirangam North / Kollidam
            [78.7100, 10.8750], // Thiruvanaikoil / Kallanai Road
            [78.7650, 10.8300], // Ariyamangalam / Kattur East
            [78.7850, 10.7950], // Tiruverumbur / BHEL Township
            [78.7600, 10.7450], // Airport / Mathur / Gundur
            [78.7100, 10.7250], // Panjappur / Madurai Road
            [78.6500, 10.7450], // Karumandapam / Dindigul Road
            [78.6150, 10.8000], // Vayalur Road / Somarasampettai
            [78.6250, 10.8450], // Woraiyur West
            [78.6400, 10.8700], // Close loop
          ],
        ],
      },
    },
    approvedPincodes: [{ type: String, trim: true }],
    approvedLocalities: [{ type: String, trim: true }],
    description: { type: String, default: 'Exclusive HomeStepIn Tiruchirappalli (Trichy) Urban Service Area' },
  },
  { timestamps: true }
);

serviceAreaSchema.index({ 'polygon': '2dsphere' });
serviceAreaSchema.index({ status: 1, city: 1 });

module.exports = mongoose.model('ServiceArea', serviceAreaSchema);
