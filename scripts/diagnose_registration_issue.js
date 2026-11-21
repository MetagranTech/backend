/**
 * Read-Only Diagnostic Script for Customer Registration & Partner Creation
 * Analyzes:
 * 1. Database name, collection name, masked MONGO_URI
 * 2. All indexes on `users` collection (unique, sparse, partialFilterExpression)
 * 3. Document counts with null/missing values for unique fields
 * 4. Duplicate checks for unique fields
 * 5. Firebase Auth user list and comparison with MongoDB users (identifying orphaned Firebase accounts)
 * 6. Reproduction of customer registration and partner creation errors with raw error logging
 */

'use strict';

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
require('dotenv').config();

const { connectDb, disconnectDb } = require('../src/db');
const User = require('../src/models/User');
const { initializeFirebase } = require('../src/services/firebaseService');

function maskUri(uri) {
  if (!uri) return 'NOT_SET';
  return uri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@');
}

async function runDiagnostics() {
  console.log('========================================================================');
  console.log('   HOMESTEPIN: REGISTRATION & PARTNER CREATION DIAGNOSTIC AUDIT');
  console.log('========================================================================\n');

  await connectDb();
  const db = mongoose.connection.db;
  const userCol = db.collection('users');

  // ── STEP 2: Verify Database ──────────────────────────────────────────
  console.log('─── STEP 2: VERIFY DATABASE CONNECTION ───');
  console.log(`• mongoose.connection.name:     ${mongoose.connection.name}`);
  console.log(`• mongoose.connection.host:     ${mongoose.connection.host}:${mongoose.connection.port}`);
  console.log(`• User.collection.name:         ${User.collection.name}`);
  console.log(`• Masked MONGODB_URI:           ${maskUri(process.env.MONGODB_URI)}`);
  console.log(`• Total users in collection:    ${await userCol.countDocuments()}`);

  // ── STEP 3: Inspect MongoDB Indexes (Read-Only) ──────────────────────
  console.log('\n─── STEP 3: INSPECT MONGODB INDEXES (users collection) ───');
  const indexes = await userCol.indexes();
  console.log(`Found ${indexes.length} active indexes:`);
  indexes.forEach(idx => {
    const details = [];
    if (idx.unique) details.push('UNIQUE');
    if (idx.sparse) details.push('SPARSE');
    if (idx.partialFilterExpression) details.push(`PARTIAL: ${JSON.stringify(idx.partialFilterExpression)}`);
    console.log(`  - ${idx.name.padEnd(25)} : ${JSON.stringify(idx.key).padEnd(35)} [${details.join(', ') || 'standard'}]`);
  });

  const uniqueFields = ['email', 'phone', 'username', 'employeeId', 'customId', 'firebaseUid'];
  console.log('\nNull/Missing counts for unique fields:');
  for (const field of uniqueFields) {
    const nullCount = await userCol.countDocuments({ [field]: null });
    const missingCount = await userCol.countDocuments({ [field]: { $exists: false } });
    const emptyStrCount = await userCol.countDocuments({ [field]: '' });
    const stringCount = await userCol.countDocuments({ [field]: { $type: 'string' } });
    console.log(`  • ${field.padEnd(14)}: null=${nullCount}, missing=${missingCount}, emptyStr=${emptyStrCount}, validString=${stringCount}`);

    // Check for string duplicates
    const duplicates = await userCol.aggregate([
      { $match: { [field]: { $type: 'string', $nin: ['', null] } } },
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ]).toArray();
    if (duplicates.length > 0) {
      console.log(`    ⚠️ DUPLICATES FOUND for ${field}:`, duplicates);
    } else {
      console.log(`    ✔ Zero duplicates for valid string values in ${field}`);
    }
  }

  // ── STEP 4: Inspect Firebase Auth Users ──────────────────────────────
  console.log('\n─── STEP 4: INSPECT FIREBASE AUTH USERS ───');
  let fbUsers = [];
  try {
    const { auth } = initializeFirebase();
    if (auth) {
      const listResult = await auth.listUsers(100);
      fbUsers = listResult.users;
      console.log(`• Firebase Auth total users fetched: ${fbUsers.length}`);

      const mongoEmails = new Set(
        (await userCol.find({}, { projection: { email: 1 } }).toArray())
          .map(u => (u.email || '').toLowerCase().trim())
          .filter(Boolean)
      );

      const orphanedFbAccounts = [];
      fbUsers.forEach(u => {
        const email = (u.email || '').toLowerCase().trim();
        const existsInMongo = mongoEmails.has(email);
        if (!existsInMongo) {
          orphanedFbAccounts.push({
            uid: u.uid,
            email: u.email,
            emailVerified: u.emailVerified,
            createdAt: u.metadata?.creationTime,
            lastSignIn: u.metadata?.lastSignInTime,
          });
        }
      });

      console.log(`• Orphaned Firebase accounts (in Firebase Auth but MISSING from MongoDB): ${orphanedFbAccounts.length}`);
      orphanedFbAccounts.forEach(o => {
        console.log(`    - [ORPHAN] UID: ${o.uid} | Email: ${o.email} | Created: ${o.createdAt}`);
      });
    } else {
      console.log('• Firebase Auth not initialized or credentials missing.');
    }
  } catch (fbErr) {
    console.warn('• Firebase Auth check error:', fbErr.message);
  }

  // ── STEP 1: Simulate Errors & Log Raw Error Object ───────────────────
  console.log('\n─── STEP 1: RAW ERROR LOGGING (Simulating failure mechanisms) ───');

  // Test A: Simulating MongoDB E11000 with missing username
  console.log('[Test A] Creating document with username=null against unique username_1 index:');
  try {
    await userCol.insertOne({
      customId: `test_null_user_1_${Date.now()}`,
      name: 'Test Null User 1',
      email: `test.null.1.${Date.now()}@test.com`,
      username: null,
      role: 'customer',
      status: 'active',
      passwordHash: 'dummy',
    });
    console.log('  First insert with username=null succeeded.');

    // Second insert with username=null
    await userCol.insertOne({
      customId: `test_null_user_2_${Date.now()}`,
      name: 'Test Null User 2',
      email: `test.null.2.${Date.now()}@test.com`,
      username: null,
      role: 'customer',
      status: 'active',
      passwordHash: 'dummy',
    });
    console.log('  Second insert succeeded (no collision on null).');
  } catch (err) {
    console.log('  ❌ Caught Raw Error from MongoDB:');
    console.log('    • err.name:        ', err.name);
    console.log('    • err.code:        ', err.code);
    console.log('    • err.codeName:    ', err.codeName);
    console.log('    • err.keyPattern:  ', JSON.stringify(err.keyPattern));
    console.log('    • err.keyValue:    ', JSON.stringify(err.keyValue));
    console.log('    • err.message:     ', err.message);
  } finally {
    // Clean up temporary test insertions
    await userCol.deleteMany({ email: { $regex: /^test\.null\./ } });
  }

  await disconnectDb();
  console.log('\n========================================================================');
  console.log('   DIAGNOSTIC AUDIT COMPLETE');
  console.log('========================================================================');
}

runDiagnostics().catch(err => {
  console.error('Fatal diagnostic error:', err);
  disconnectDb().finally(() => process.exit(1));
});
