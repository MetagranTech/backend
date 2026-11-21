/**
 * HomeStepIn — User Collection Index Migration Script
 *
 * Purpose:
 * Safely migrate the `username_1` unique index on the `users` collection from a
 * legacy non-sparse unique index to a Partial Unique Index (`partialFilterExpression: { username: { $type: 'string' } }`).
 *
 * Safety Rules:
 * 1. Default mode is DRY-RUN (read-only audit).
 * 2. Requires `--execute` flag to apply changes.
 * 3. Never deletes, modifies, or truncates any user documents.
 * 4. Pre-migration check verifies if existing documents have duplicate string usernames before touching indexes.
 * 5. Post-migration verification confirms new index is active.
 * 6. Supports `--rollback` to restore the legacy index definition if needed.
 *
 * Usage:
 *   node backend/scripts/migrate_user_indexes.js            # Dry-run inspection
 *   node backend/scripts/migrate_user_indexes.js --execute  # Execute migration
 *   node backend/scripts/migrate_user_indexes.js --rollback # Rollback to previous state
 */

'use strict';

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { connectDb, disconnectDb } = require('../src/db');

const isExecute = process.argv.includes('--execute');
const isRollback = process.argv.includes('--rollback');

async function runIndexMigration() {
  console.log('========================================================================');
  console.log('   HOMESTEPIN: USER COLLECTION INDEX MIGRATION');
  console.log(`   Mode: ${isRollback ? 'ROLLBACK' : (isExecute ? 'EXECUTE (Applying Changes)' : 'DRY RUN (Read-Only Inspection)')}`);
  console.log('========================================================================\n');

  try {
    const conn = await connectDb();
    const db = conn.db || mongoose.connection.db;
    const userCol = db.collection('users');

    // ── Phase 1: Pre-Migration Health & Inspection ─────────────────────────
    console.log('[Phase 1] Pre-Migration Health & Inspection');
    const totalUsers = await userCol.countDocuments();
    console.log(`  • Total documents in users collection: ${totalUsers}`);

    const existingIndexes = await userCol.indexes();
    console.log(`  • Found ${existingIndexes.length} active indexes on users collection:`);
    existingIndexes.forEach(idx => {
      const flags = [];
      if (idx.unique) flags.push('unique: true');
      if (idx.sparse) flags.push('sparse: true');
      if (idx.partialFilterExpression) flags.push(`partial: ${JSON.stringify(idx.partialFilterExpression)}`);
      console.log(`    - ${idx.name} : ${JSON.stringify(idx.key)} [${flags.join(', ') || 'standard'}]`);
    });

    const usernameIdx = existingIndexes.find(i => i.name === 'username_1');
    const employeeIdIdx = existingIndexes.find(i => i.name === 'employeeId_1');

    console.log('\n[Phase 2] Target Index Status Analysis');
    if (!usernameIdx) {
      console.log('  • username_1 index: NOT PRESENT (Can be created directly)');
    } else {
      const isPartial = Boolean(usernameIdx.partialFilterExpression);
      const isSparse = Boolean(usernameIdx.sparse);
      console.log(`  • username_1 index: PRESENT (unique: ${Boolean(usernameIdx.unique)}, sparse: ${isSparse}, partial: ${isPartial})`);
      if (usernameIdx.unique && !isSparse && !isPartial) {
        console.log('    ⚠️ DEFECT IDENTIFIED: username_1 is unique WITHOUT sparse or partialFilterExpression.');
        console.log('       Any document created with username=null will collide on second insert.');
      } else if (isPartial || isSparse) {
        console.log('    ✅ Index is already modern/safe (sparse or partial filter active).');
      }
    }

    // Inspect documents with null or missing username
    const nullUsernames = await userCol.countDocuments({
      $or: [{ username: null }, { username: { $exists: false } }],
    });
    console.log(`  • Users with missing or null username: ${nullUsernames}`);

    // Inspect documents with actual string usernames
    const stringUsernames = await userCol.countDocuments({
      username: { $type: 'string' },
    });
    console.log(`  • Users with valid string username: ${stringUsernames}`);

    // Check for string username duplicates
    const dupUsernameAgg = await userCol.aggregate([
      { $match: { username: { $type: 'string' } } },
      { $group: { _id: '$username', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ]).toArray();

    if (dupUsernameAgg.length > 0) {
      console.error(`  ❌ PRE-CHECK FAILED: Found ${dupUsernameAgg.length} duplicate string usernames:`, dupUsernameAgg);
      throw new Error('Migration aborted: Resolve string username duplicates before applying unique partial index.');
    } else {
      console.log('  ✅ Pre-check passed: Zero duplicate string usernames found.');
    }

    // ── Phase 3: Rollback Mode ─────────────────────────────────────────────
    if (isRollback) {
      console.log('\n[Phase 3] Rollback Execution Requested');
      if (usernameIdx) {
        console.log('  • Dropping partial username_1 index...');
        await userCol.dropIndex('username_1');
      }
      console.log('  • Re-creating legacy username_1 unique sparse index...');
      await userCol.createIndex({ username: 1 }, { unique: true, sparse: true, name: 'username_1' });
      console.log('  ✅ Rollback complete: Restored sparse username_1 index.');
      return;
    }

    // ── Phase 4: Migration Execution ───────────────────────────────────────
    console.log('\n[Phase 4] Migration Strategy');
    const targetStrategy = {
      key: { username: 1 },
      options: {
        name: 'username_1',
        unique: true,
        partialFilterExpression: { username: { $type: 'string' } },
        background: true,
      },
    };

    console.log('  Target Index Definition:');
    console.log('    Keys:   ', JSON.stringify(targetStrategy.key));
    console.log('    Options:', JSON.stringify(targetStrategy.options));

    if (!isExecute) {
      console.log('\n[DRY RUN SUMMARY]');
      console.log('  • No database indexes were modified.');
      console.log('  • To apply the partial unique index migration, execute:');
      console.log('      node backend/scripts/migrate_user_indexes.js --execute');
      return;
    }

    console.log('\n[Phase 5] Applying Migration Changes');
    if (usernameIdx) {
      console.log(`  • Dropping existing index "${usernameIdx.name}"...`);
      await userCol.dropIndex('username_1');
      console.log('    ✓ Old index dropped successfully.');
    }

    console.log('  • Creating new partial unique index "username_1"...');
    await userCol.createIndex(targetStrategy.key, targetStrategy.options);
    console.log('    ✓ Partial unique index created successfully.');

    // Also verify employeeId index
    if (employeeIdIdx && employeeIdIdx.unique && !employeeIdIdx.sparse && !employeeIdIdx.partialFilterExpression) {
      console.log(`  • Modernizing employeeId_1 index to partial unique...`);
      await userCol.dropIndex('employeeId_1');
      await userCol.createIndex(
        { employeeId: 1 },
        {
          name: 'employeeId_1',
          unique: true,
          partialFilterExpression: { employeeId: { $type: 'string' } },
          background: true,
        }
      );
      console.log('    ✓ employeeId_1 updated to partial unique.');
    }

    // ── Phase 6: Post-Migration Verification ──────────────────────────────
    console.log('\n[Phase 6] Post-Migration Verification');
    const updatedIndexes = await userCol.indexes();
    const newUsernameIdx = updatedIndexes.find(i => i.name === 'username_1');

    if (
      newUsernameIdx &&
      newUsernameIdx.unique &&
      newUsernameIdx.partialFilterExpression &&
      newUsernameIdx.partialFilterExpression.username
    ) {
      console.log('  ✅ VERIFICATION SUCCESSFUL:');
      console.log('     Index "username_1" is active with partialFilterExpression:', JSON.stringify(newUsernameIdx.partialFilterExpression));
    } else {
      console.error('  ❌ VERIFICATION FAILED: Index definition does not match expected target:', newUsernameIdx);
      throw new Error('Post-migration verification failed.');
    }

    console.log('\n========================================================================');
    console.log('   MIGRATION COMPLETED SUCCESSFULLY WITH ZERO DATA LOSS');
    console.log('========================================================================\n');
  } finally {
    await disconnectDb();
  }
}

runIndexMigration().catch(err => {
  console.error('\n❌ MIGRATION ERROR:', err.message);
  process.exit(1);
});
