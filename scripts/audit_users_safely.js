'use strict';

const path = require('path');
const { MongoMemoryServer } = require('../node_modules/mongodb-memory-server');
const mongoose = require('../node_modules/mongoose');

async function check() {
  const dataDir = path.resolve(__dirname, '..', 'data', 'db');
  const server = await MongoMemoryServer.create({
    binary: { version: '4.4.26' },
    instance: { dbPath: dataDir, storageEngine: 'wiredTiger' }
  });
  const uri = server.getUri();
  const conn = await mongoose.createConnection(uri + 'test').asPromise();
  const users = conn.db.collection('users');
  const total = await users.countDocuments();
  const withPass = await users.countDocuments({ passwordHash: { $exists: true, $nin: [null, ''] } });
  const withoutPass = await users.countDocuments({ $or: [{ passwordHash: { $exists: false } }, { passwordHash: null }, { passwordHash: '' }] });
  const withFbUid = await users.countDocuments({ firebaseUid: { $exists: true, $nin: [null, ''] } });
  const withoutFbUid = await users.countDocuments({ $or: [{ firebaseUid: { $exists: false } }, { firebaseUid: null }, { firebaseUid: '' }] });
  const roles = await users.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]).toArray();
  const authProviders = await users.aggregate([{ $group: { _id: '$authProvider', count: { $sum: 1 } } }]).toArray();
  
  console.log('AUDIT_STATS:', JSON.stringify({
    total,
    withPass,
    withoutPass,
    withFbUid,
    withoutFbUid,
    roles,
    authProviders
  }, null, 2));

  await conn.close();
  await server.stop();
  process.exit(0);
}

check().catch(e => {
  console.error(e);
  process.exit(1);
});
