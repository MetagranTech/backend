'use strict';

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { connectDb } = require('../src/db');
const User = require('../src/models/User');

async function run() {
  await connectDb();
  const total = await User.countDocuments();
  const withPass = await User.countDocuments({ passwordHash: { $exists: true, $nin: [null, ''] } });
  const withoutPass = await User.countDocuments({ $or: [{ passwordHash: { $exists: false } }, { passwordHash: null }, { passwordHash: '' }] });
  const withFbUid = await User.countDocuments({ firebaseUid: { $exists: true, $nin: [null, ''] } });
  const authProviders = await User.aggregate([{ $group: { _id: '$authProvider', count: { $sum: 1 } } }]);
  const roles = await User.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]);
  
  console.log('AUDIT_RESULT:', JSON.stringify({
    dbHost: mongoose.connection.host,
    dbName: mongoose.connection.name,
    total,
    withPass,
    withoutPass,
    withFbUid,
    authProviders,
    roles
  }, null, 2));

  process.exit(0);
}

run().catch(err => {
  console.error('Audit script error:', err);
  process.exit(1);
});
