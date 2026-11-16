const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    slug: { type: String, required: true, unique: true, index: true },
    description: String,
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    image: { type: String, default: '' },
    imageUrl: { type: String, default: '' },
    imagePublicId: { type: String, default: '' },
  },
  { timestamps: true },
);

categorySchema.pre('save', function (next) {
  if (this.image && !this.imageUrl) {
    this.imageUrl = this.image;
  } else if (this.imageUrl && !this.image) {
    this.image = this.imageUrl;
  }
  if (typeof next === 'function') next();
});

module.exports = mongoose.model('Category', categorySchema);
