const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const cloudinary = require('cloudinary').v2;
const { connectDb } = require('../src/db');
const mongoose = require('mongoose');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

async function auditCloudinary() {
  console.log('=== AUDITING CLOUDINARY ASSETS ===');
  console.log('Cloud name:', process.env.CLOUDINARY_CLOUD_NAME);

  try {
    // 1. Fetch all assets from Cloudinary
    let allResources = [];
    let nextCursor = null;

    do {
      const result = await cloudinary.api.resources({
        type: 'upload',
        max_results: 100,
        next_cursor: nextCursor,
      });
      allResources = allResources.concat(result.resources);
      nextCursor = result.next_cursor;
    } while (nextCursor);

    console.log(`Total Cloudinary assets found: ${allResources.length}`);

    let totalBytes = 0;
    allResources.forEach((res, i) => {
      totalBytes += res.bytes || 0;
      console.log(`[${i + 1}] public_id: ${res.public_id} | format: ${res.format} | size: ${(res.bytes / 1024).toFixed(1)} KB | folder: ${res.folder || 'root'} | created: ${res.created_at}`);
    });
    console.log(`Total Cloudinary Storage: ${(totalBytes / (1024 * 1024)).toFixed(2)} MB`);

    // 2. Cross-reference with MongoDB
    await connectDb();
    const services = await mongoose.connection.db.collection('services').find().toArray();
    const banners = await mongoose.connection.db.collection('banners').find().toArray();
    const users = await mongoose.connection.db.collection('users').find().toArray();

    const dbPublicIds = new Set();
    const dbUrls = new Set();

    services.forEach(s => {
      if (s.cloudinaryPublicId) dbPublicIds.add(s.cloudinaryPublicId);
      if (s.imageUrl) dbUrls.add(s.imageUrl);
    });
    banners.forEach(b => {
      if (b.cloudinaryPublicId) dbPublicIds.add(b.cloudinaryPublicId);
      if (b.imageUrl) dbUrls.add(b.imageUrl);
      if (b.bgImageUrl) dbUrls.add(b.bgImageUrl);
    });
    users.forEach(u => {
      if (u.avatarUrl) dbUrls.add(u.avatarUrl);
    });

    console.log('\n=== CROSS-REFERENCE WITH MONGODB ===');
    console.log('MongoDB referenced public IDs:', Array.from(dbPublicIds));

    const orphanedAssets = [];
    const referencedAssets = [];

    allResources.forEach(res => {
      const isRefById = dbPublicIds.has(res.public_id);
      const isRefByUrl = dbUrls.has(res.secure_url) || dbUrls.has(res.url);
      if (isRefById || isRefByUrl) {
        referencedAssets.push(res);
      } else {
        orphanedAssets.push(res);
      }
    });

    console.log(`Referenced assets: ${referencedAssets.length}`);
    console.log(`Orphaned/Demo assets: ${orphanedAssets.length}`);
    orphanedAssets.forEach(o => {
      console.log(`  - Orphan: ${o.public_id} (${(o.bytes / 1024).toFixed(1)} KB) URL: ${o.secure_url}`);
    });

    process.exit(0);
  } catch (err) {
    console.error('Cloudinary audit failed:', err);
    process.exit(1);
  }
}

auditCloudinary();

